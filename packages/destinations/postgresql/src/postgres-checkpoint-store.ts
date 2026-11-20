import type postgres from 'postgres';

import {
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
  // no transaction stays open while the load runs; each save autocommits.
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
        save: async (id, { binding, reloading, state }) => {
          await sql.unsafe(
            `INSERT INTO ${table} ("id", "binding", "reloading", "state") VALUES ($1, $2::text::json, $3, $4::text::json) ON CONFLICT ("id") DO UPDATE SET "binding" = excluded."binding", "reloading" = excluded."reloading", "state" = excluded."state"`,
            [id, binding, reloading, state],
          );
        },
        reloaded: async (id) => {
          await sql.unsafe(
            `UPDATE ${table} SET "reloading" = false WHERE "id" = $1`,
            [id],
          );
        },
        remove: async (id) => {
          await sql.unsafe(`DELETE FROM ${table} WHERE "id" = $1`, [id]);
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
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [table],
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
    });
  }
}
