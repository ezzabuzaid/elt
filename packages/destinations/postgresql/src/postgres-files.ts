import { DatabaseFiles, type FailureType } from '@eltjs/elt';

import { failureType } from './postgres-failure-type.ts';
import { inWarehouse, warehouse } from './postgres-schemas.ts';
import { PostgresSession, lockSchema, makeSchema } from './postgres-session.ts';

const table = inWarehouse('_elt_files');

// The files of a copy in the database of its destination, in
// _warehouse._elt_files, which readers of marts do not see (ADR 0010).
export class PostgresFiles extends DatabaseFiles<PostgresSession> {
  override readonly identity = JSON.stringify({ type: 'postgres-files' });
  readonly #url: string;

  constructor(url: string) {
    super('_warehouse._elt_files');
    this.#url = url;
    Object.freeze(this);
  }

  // Two sessions make the table at once, and Postgres refuses the second
  // CREATE with a duplicate key; the lock of _warehouse makes them take turns.
  protected override async connect(): Promise<PostgresSession> {
    const session = new PostgresSession(this.#url, 'elt-files');
    try {
      const { sql } = session;
      const [found] = await sql.unsafe(
        'SELECT to_regclass($1) IS NOT NULL AS "exists"',
        [table],
      );
      if (found?.exists !== true) {
        await makeSchema(sql, warehouse);
        await sql.begin(async (transaction) => {
          await lockSchema(transaction, warehouse);
          await transaction.unsafe(
            `CREATE TABLE IF NOT EXISTS ${table} ("scope" TEXT NOT NULL, "name" TEXT NOT NULL, "n" BIGINT NOT NULL, "bytes" BYTEA NOT NULL, PRIMARY KEY ("scope", "name", "n"))`,
          );
        });
      }
      return session;
    } catch (error) {
      await session[Symbol.asyncDispose]();
      throw error;
    }
  }

  protected override async write(
    { sql }: PostgresSession,
    scope: string,
    name: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<void> {
    await sql.unsafe(
      `INSERT INTO ${table} ("scope", "name", "n", "bytes") VALUES ($1, $2, $3, $4)`,
      [scope, name, n, Buffer.from(bytes)],
    );
  }

  protected override async rename(
    { sql }: PostgresSession,
    scope: string,
    from: string,
    to: string,
  ): Promise<void> {
    await sql.unsafe(
      `UPDATE ${table} SET "name" = $3 WHERE "scope" = $1 AND "name" = $2 AND NOT EXISTS (SELECT 1 FROM ${table} WHERE "scope" = $1 AND "name" = $3)`,
      [scope, from, to],
    );
  }

  protected override async remove(
    { sql }: PostgresSession,
    scope: string,
    names: readonly string[],
  ): Promise<void> {
    await sql.unsafe(
      `DELETE FROM ${table} WHERE "scope" = $1 AND "name" IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
      [scope, JSON.stringify(names)],
    );
  }

  protected override async names(
    { sql }: PostgresSession,
    scope: string,
  ): Promise<readonly string[]> {
    return (
      await sql.unsafe(
        `SELECT "name" FROM ${table} WHERE "scope" = $1 AND "n" = 0`,
        [scope],
      )
    ).map(({ name }) => String(name));
  }

  protected override async read(
    { sql }: PostgresSession,
    scope: string,
    name: string,
    n: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    const [row] = await sql.unsafe(
      `SELECT substring("bytes" FROM 1 FOR $4::int) AS "bytes" FROM ${table} WHERE "scope" = $1 AND "name" = $2 AND "n" = $3`,
      [scope, name, n, length],
    );
    if (row === undefined) return undefined;
    if (!(row.bytes instanceof Uint8Array))
      throw new TypeError(`Chunk ${n} of stored file ${name} is not BYTEA`);
    return row.bytes;
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }
}
