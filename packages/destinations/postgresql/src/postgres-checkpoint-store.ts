import { type CheckpointSession, CheckpointStore } from 'elt';
import type postgres from 'postgres';
import { Connection, schemaLock, schemaName, server } from './connection.ts';
import { quote } from './identifier.ts';

// Checkpoints kept beside the data they describe, in `_mac_elt_checkpoints`
// of one schema, so dropping the schema resets both. Each acknowledged
// checkpoint is saved as soon as the load commits it; a crash in between
// replays that unit, which deduplication absorbs.
export class PostgresCheckpointStore extends CheckpointStore {
  readonly schema: string;
  readonly #url: string;

  constructor({ url, schema }: { url: string; schema: string }) {
    super();
    server(url);
    this.schema = schemaName(schema);
    this.#url = url;
    Object.freeze(this);
  }

  get #table(): string {
    return `${quote(this.schema)}."_mac_elt_checkpoints"`;
  }

  // The run's lock is a session lock on its own connection, so no
  // transaction stays open while the load runs; each save autocommits.
  protected override async session<T>(
    id: string,
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    await using connection = new Connection(this.#url, 'elt-checkpoints');
    const { sql } = connection;
    await this.#create(sql);
    // Two-key locks never collide with the writers' one-key schema lock. A
    // replication already running fails fast; others run in parallel.
    const key = [`mac-elt-checkpoints:${this.schema}`, id];
    const [lock] = await sql.unsafe(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS "locked"',
      key,
    );
    if (lock?.locked !== true)
      throw new TypeError(`Checkpoint ${id} is in use by another run`);
    try {
      return await work({
        read: async () => {
          const [saved] = await sql.unsafe(
            `SELECT "binding"::text AS "binding", "state"::text AS "state" FROM ${this.#table} WHERE "id" = $1`,
            [id],
          );
          return saved === undefined
            ? undefined
            : { binding: String(saved.binding), state: String(saved.state) };
        },
        save: async ({ binding, state }) => {
          await sql.unsafe(
            `INSERT INTO ${this.#table} ("id", "binding", "state") VALUES ($1, $2::text::json, $3::text::json) ON CONFLICT ("id") DO UPDATE SET "state" = excluded."state"`,
            [id, binding, state],
          );
        },
        remove: async () => {
          await sql.unsafe(`DELETE FROM ${this.#table} WHERE "id" = $1`, [id]);
        },
      });
    } finally {
      await sql.unsafe(
        'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
        key,
      );
    }
  }

  // Committed before any run holds its lock: a writer creating the same
  // schema would otherwise wait on this transaction while it waits on the
  // writer, a hang Postgres cannot see.
  async #create(sql: postgres.Sql): Promise<void> {
    const [found] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [this.#table],
    );
    if (found?.exists === true) return;
    await sql.begin(async (transaction) => {
      await transaction.unsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [schemaLock(this.schema)],
      );
      await transaction.unsafe(
        `CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`,
      );
      // JSON keeps the exact text: JSONB refuses \u0000 and lone surrogates,
      // which checkpoint state may carry.
      await transaction.unsafe(
        `CREATE TABLE IF NOT EXISTS ${this.#table} ("id" TEXT PRIMARY KEY, "binding" JSON NOT NULL, "state" JSON NOT NULL)`,
      );
    });
  }
}
