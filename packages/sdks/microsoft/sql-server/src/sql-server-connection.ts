import { EventEmitter } from 'node:events';

import sql from 'mssql';

import { SqlServerUnavailableError } from './errors.ts';
import { connectionFailure, readError } from './sql-server-request.ts';

// One session of SQL Server: its #temp tables, its session context, its
// session locks and a transaction over several statements stay from the first
// statement to the last. It never connects again: when the server or the
// network ends the session, 'end' tells the owner, whose session state is
// gone, and each later statement fails.
export class SqlServerConnection
  extends EventEmitter<{ end: []; error: [Error] }>
  implements AsyncDisposable
{
  readonly #pool: sql.ConnectionPool;
  readonly #location: string;
  // Aborts once the session ends, by the server or by its owner.
  readonly #ended = new AbortController();

  private constructor(pool: sql.ConnectionPool, location: string) {
    super();
    this.#pool = pool;
    this.#location = location;
  }

  // A pool of exactly one connection, so each statement runs on it. The pool
  // makes one connection to test the login and closes it before it makes the
  // one that the session keeps; only that one ends the session.
  static async open(
    config: sql.config,
    location: string,
  ): Promise<SqlServerConnection> {
    let testing = true;
    const pool = new sql.ConnectionPool({
      ...config,
      pool: { min: 1, max: 1 },
      validateConnection: false,
      beforeConnect: (tedious) => {
        config.beforeConnect?.(tedious);
        if (!testing) tedious.once('end', () => connection.#end());
      },
    });
    const connection = new SqlServerConnection(pool, location);
    // The pool's own error reaches each statement too, so it is passed on only
    // to an owner that listens for it.
    pool.on('error', (error: Error) => {
      if (connection.listenerCount('error') > 0)
        connection.emit('error', error);
    });
    try {
      await pool.connect();
    } catch (cause) {
      throw connectionFailure(location, cause);
    }
    testing = false;
    try {
      await connection.query('SELECT 1');
      return connection;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  // Runs one batch, and gives the rows of each of its result sets in order.
  // Each parameter is an nvarchar(max), or NULL, which the batch casts. A
  // batch with parameters runs through sp_executesql, which must end with the
  // transaction count it began with and drops each #temp table it makes at its
  // end; a batch with none runs as it is, so it can begin or end a
  // transaction, or make a #temp table that the session keeps. The signal
  // cancels the batch: the driver sends SQL Server's attention and settles
  // once the server confirms it, so the session is free for the next batch.
  async query(
    text: string,
    parameters: Readonly<Record<string, string | null>> = {},
    options?: { readonly signal?: AbortSignal },
  ): Promise<Record<string, unknown>[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    if (this.#ended.signal.aborted)
      throw new SqlServerUnavailableError(
        this.#location,
        new Error('The session of this connection ended'),
      );
    const request = this.#pool.request();
    const named = Object.entries(parameters);
    for (const [name, value] of named)
      request.input(name, sql.NVarChar(sql.MAX), value);
    const cancel = () => request.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const { recordsets } = await (named.length === 0
        ? request.batch<Record<string, unknown>>(text)
        : request.query<Record<string, unknown>>(text));
      return recordsets.flat();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw readError(error, this.#location);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  #end(): void {
    if (this.#ended.signal.aborted) return;
    this.#ended.abort();
    this.emit('end');
  }

  close(): void {
    void this[Symbol.asyncDispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#ended.abort();
    await this.#pool.close();
  }
}
