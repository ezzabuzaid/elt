import type postgres from 'postgres';

import { PostgresSession, schemaLock } from './postgres-session.ts';

// The load's one connection, inside one commit's transaction or on its own.
export type Transaction = postgres.Sql;

// A run's one connection to a schema. The schema lock keeps every other load
// out until it closes, as SQLite's BEGIN IMMEDIATE does per file; readers
// never wait on it. No transaction stays open between commits, so reading the
// source holds no locks on the targets and keeps nothing from vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: PostgresSession;
  readonly schema: string;
  readonly loadedAt: string;

  private constructor(
    connection: PostgresSession,
    schema: string,
    loadedAt: string,
  ) {
    this.#connection = connection;
    this.schema = schema;
    this.loadedAt = loadedAt;
  }

  get sql(): Transaction {
    return this.#connection.sql;
  }

  static async open(url: string, schema: string): Promise<PostgresLoad> {
    const connection = new PostgresSession(url, 'elt');
    try {
      const [clock] = await connection.sql.unsafe(
        'SELECT clock_timestamp()::text AS "loadedAt"',
      );
      // Closing this connection releases the session lock, including on errors.
      await connection.sql.unsafe(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [schemaLock(schema)],
      );
      return new PostgresLoad(connection, schema, String(clock?.loadedAt));
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  // What work does becomes durable and visible together, or not at all.
  async transaction<T>(work: (sql: Transaction) => Promise<T>): Promise<T> {
    await this.sql.unsafe('BEGIN');
    try {
      const result = await work(this.sql);
      await this.sql.unsafe('COMMIT');
      return result;
    } catch (error) {
      await this.sql.unsafe('ROLLBACK');
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#connection[Symbol.asyncDispose]();
  }
}
