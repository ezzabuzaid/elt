import sql from 'mssql';

import { connectionFailure, readError } from './sql-server-request.ts';

// Connections of the database that statements borrow, for work whose
// statements each stand alone, such as a lease that its holder renews every
// few seconds. The pool keeps an idle connection for 5 minutes (ADR 0001) and
// runs SELECT 1 on it before it lends it, so statements a few seconds apart
// log in once, and a connection that the server or a gateway ended is
// replaced.
export class SqlServerPool implements AsyncDisposable {
  readonly #pool: sql.ConnectionPool;
  readonly #location: string;

  private constructor(pool: sql.ConnectionPool, location: string) {
    this.#pool = pool;
    this.#location = location;
  }

  // Opens the pool, which logs in once to check the login.
  static async open(
    config: sql.config,
    location: string,
  ): Promise<SqlServerPool> {
    const pool = new sql.ConnectionPool(config);
    // The error of a connection reaches the statement that borrowed it too,
    // so the pool passes it on only to the sessions that listen.
    pool.on('error', () => {});
    try {
      await pool.connect();
    } catch (cause) {
      throw connectionFailure(location, cause);
    }
    return new SqlServerPool(pool, location);
  }

  async connect(): Promise<SqlServerPoolSession> {
    return new SqlServerPoolSession(this.#pool, this.#location);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#pool.close();
  }
}

// Each statement of the session runs on a connection that the pool lends for
// that statement alone and takes back when it ends, so the session keeps no
// state from one statement to the next: no #temp table, no session lock, no
// transaction. It has the shape of the session of SqlServerStore of
// @zukhruf/mutex/sqlserver.
export class SqlServerPoolSession {
  readonly #pool: sql.ConnectionPool;
  readonly #location: string;
  readonly #listeners = new Set<(error: Error) => void>();
  readonly #closed = new AbortController();

  constructor(pool: sql.ConnectionPool, location: string) {
    this.#pool = pool;
    this.#location = location;
  }

  // Runs one batch, and gives the rows of each of its result sets in order.
  // Each parameter is an nvarchar(max), which the batch casts.
  async query(
    text: string,
    parameters: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>[]> {
    if (this.#closed.signal.aborted)
      throw new TypeError('This session of the pool is closed');
    const request = this.#pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, sql.NVarChar(sql.MAX), value);
    try {
      const { recordsets } = await request.query<Record<string, unknown>>(text);
      return recordsets.flat();
    } catch (error) {
      throw readError(error, this.#location);
    }
  }

  // The errors of the pool's connections, while the session is open.
  on(event: 'error', listener: (error: Error) => void): this {
    this.#pool.on(event, listener);
    this.#listeners.add(listener);
    return this;
  }

  close(): void {
    this.#closed.abort();
    for (const listener of this.#listeners) this.#pool.off('error', listener);
    this.#listeners.clear();
  }
}
