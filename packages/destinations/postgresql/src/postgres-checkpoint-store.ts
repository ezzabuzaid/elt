import type postgres from 'postgres';

import {
  type CheckpointEntry,
  type CheckpointSession,
  CheckpointStore,
  type FailureType,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import { failureType } from './postgres-failure-type.ts';
import { inWarehouse, warehouse } from './postgres-schemas.ts';
import {
  PostgresSession,
  connectionUrl,
  lockSchema,
} from './postgres-session.ts';

// The checkpoints of every copy into the database, beside the data they
// describe, in `_warehouse._elt_checkpoints`, by the id of the copy. Each
// acknowledged checkpoint is saved as soon as the load commits it; a crash in
// between replays that unit, which deduplication absorbs.
const table = inWarehouse('_elt_checkpoints');
// The keyed entries of each checkpoint, by space (ADR 0035 of elt), unique by
// the SHA-256 of the UTF-8 of each part of their key, as the SQL Server store
// keeps them: a btree row holds at most about 2.7 KB, so a long key or space
// as its own text would fail the save after the destination committed. The
// texts stay beside their digests, for reads and for the clear of a scope.
const entriesTable = inWarehouse('_elt_checkpoint_entries');
const digest = (text: string) => `sha256(convert_to(${text}, 'UTF8'))`;

// Entries as one JSON array parameter of [space, key] or [space, key, value]
// rows, which json_array_elements reads in one statement. value is the
// entry's JSON text as a string: json_array_elements refuses a \u0000
// escape anywhere in the array it reads, and a string value may hold U+0000.
const rows = (entries: readonly Omit<CheckpointEntry, 'value'>[]) =>
  JSON.stringify(entries.map(({ space, key }) => [space, key]));
const putRows = (entries: readonly CheckpointEntry[]) =>
  JSON.stringify(entries.map(({ space, key, value }) => [space, key, value]));

export class PostgresCheckpointStore extends CheckpointStore {
  readonly #url: string;

  constructor({ url }: { url: string }) {
    super();
    this.#url = connectionUrl(url);
    Object.freeze(this);
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }

  // Each replication's lock is a session lock on the run's own connection, so
  // no transaction stays open while the load runs; each save commits in a
  // transaction of its own.
  protected override async session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    await using connection = new PostgresSession(this.#url, 'elt-checkpoints');
    const { sql } = connection;
    await this.#create(sql);
    // Two-key locks never collide with the one-key schema lock of DDL. A
    // replication already running fails the run fast; others run in parallel.
    // Taken in sorted order, so two runs never wait on each other.
    const namespace = 'elt-checkpoints';
    const held: string[] = [];
    try {
      for (const id of ids) {
        const [lock] = await sql.unsafe(
          'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS "locked"',
          [namespace, id],
        );
        if (lock?.locked !== true)
          throw new TypeError(`Checkpoint ${id} is in use by another run`);
        held.push(id);
      }
      return await work({
        read: async (id) => {
          const [saved] = await sql.unsafe(
            `SELECT "binding"::text AS "binding", "reloading" FROM ${table} WHERE "id" = $1`,
            [id],
          );
          return saved === undefined
            ? undefined
            : {
                binding: String(saved.binding),
                reloading: saved.reloading === true,
              };
        },
        state: async (id) => {
          const [saved] = await sql.unsafe(
            `SELECT "state"::text AS "state" FROM ${table} WHERE "id" = $1`,
            [id],
          );
          return saved === undefined ? undefined : String(saved.state);
        },
        entries: async (id, space) =>
          (
            await sql.unsafe(
              `SELECT "key", "value"::text AS "value" FROM ${entriesTable} WHERE "id_hash" = ${digest('$1')} AND "space_hash" = ${digest('$2')}`,
              [id, space],
            )
          ).map(({ key, value }): [string, string] => [
            String(key),
            String(value),
          ]),
        save: async (id, { binding, reloading, state, entries }) => {
          await sql.begin(async (transaction) => {
            await transaction.unsafe(
              `INSERT INTO ${table} ("id", "binding", "reloading", "state") VALUES ($1, $2::text::json, $3, $4::text::json) ON CONFLICT ("id") DO UPDATE SET "binding" = excluded."binding", "reloading" = excluded."reloading", "state" = excluded."state"`,
              [id, binding, reloading, state],
            );
            if (entries.kind === 'replace')
              await transaction.unsafe(
                `DELETE FROM ${entriesTable} WHERE "id_hash" = ${digest('$1')}`,
                [id],
              );
            else {
              if (entries.clear.length > 0)
                await transaction.unsafe(
                  `DELETE FROM ${entriesTable} WHERE "id_hash" = ${digest('$1')} AND EXISTS (SELECT 1 FROM json_array_elements_text($2::text::json) AS scope WHERE starts_with("space", scope))`,
                  [id, JSON.stringify(entries.clear)],
                );
              if (entries.remove.length > 0)
                await transaction.unsafe(
                  `DELETE FROM ${entriesTable} WHERE "id_hash" = ${digest('$1')} AND ("space_hash", "key_hash") IN (SELECT ${digest('row->>0')}, ${digest('row->>1')} FROM json_array_elements($2::text::json) AS row)`,
                  [id, rows(entries.remove)],
                );
            }
            if (entries.put.length > 0)
              await transaction.unsafe(
                `INSERT INTO ${entriesTable} ("id_hash", "space_hash", "key_hash", "id", "space", "key", "value") SELECT ${digest('$1')}, ${digest('row->>0')}, ${digest('row->>1')}, $1, row->>0, row->>1, (row->>2)::json FROM json_array_elements($2::text::json) AS row ON CONFLICT ("id_hash", "space_hash", "key_hash") DO UPDATE SET "value" = excluded."value"`,
                [id, putRows(entries.put)],
              );
          });
        },
        reloaded: async (id) => {
          await sql.unsafe(
            `UPDATE ${table} SET "reloading" = false WHERE "id" = $1`,
            [id],
          );
        },
        remove: async (id) => {
          await sql.begin(async (transaction) => {
            await transaction.unsafe(
              `DELETE FROM ${entriesTable} WHERE "id_hash" = ${digest('$1')}`,
              [id],
            );
            await transaction.unsafe(`DELETE FROM ${table} WHERE "id" = $1`, [
              id,
            ]);
          });
        },
      });
    } finally {
      for (const id of held)
        await sql.unsafe(
          'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
          [namespace, id],
        );
    }
  }

  // Two runs create the table at once, and Postgres refuses the second CREATE
  // with a duplicate key; the lock of _warehouse makes them take turns.
  async #create(sql: postgres.Sql): Promise<void> {
    const [found] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS "exists"',
      [table, entriesTable],
    );
    if (found?.exists === true) return;
    await sql.begin(async (transaction) => {
      await lockSchema(transaction, warehouse);
      await transaction.unsafe(
        `CREATE SCHEMA IF NOT EXISTS ${quote(warehouse)}`,
      );
      // JSON keeps the exact text: JSONB refuses \u0000 and lone surrogates,
      // which checkpoint state may carry.
      await transaction.unsafe(
        `CREATE TABLE IF NOT EXISTS ${table} ("id" TEXT PRIMARY KEY, "binding" JSON NOT NULL, "reloading" BOOLEAN NOT NULL, "state" JSON NOT NULL)`,
      );
      await transaction.unsafe(
        `CREATE TABLE IF NOT EXISTS ${entriesTable} ("id_hash" BYTEA NOT NULL, "space_hash" BYTEA NOT NULL, "key_hash" BYTEA NOT NULL, "id" TEXT NOT NULL, "space" TEXT NOT NULL, "key" TEXT NOT NULL, "value" JSON NOT NULL, PRIMARY KEY ("id_hash", "space_hash", "key_hash"))`,
      );
    });
  }
}
