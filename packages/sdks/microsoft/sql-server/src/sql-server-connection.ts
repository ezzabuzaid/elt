import { EventEmitter } from 'node:events';

import sql from 'mssql';

import { SqlServerUnavailableError } from './errors.ts';
import {
  type SqlServerRead,
  connectionFailure,
  readError,
} from './sql-server-request.ts';

// How long a session runs nothing before it runs SELECT 1. Azure SQL's
// gateway ends a session that runs nothing for a time: Microsoft documents 30
// minutes, and on 2026-11-22 a session from a Mac that ran nothing for 20
// minutes ended while one idle for 10 minutes did not, though the driver sends
// TCP keepalives every 30 seconds. A minute is ten times below the shortest
// limit seen.
const idleMs = 60_000;

// One session of SQL Server: its #temp tables, its session context, its
// session locks and a transaction over several statements stay from the first
// statement to the last. A session that runs nothing for a minute on the
// clock of its owner runs SELECT 1, so a gateway that ends idle sessions
// keeps it while its owner holds it. It never connects again: when the server
// or the network ends the session, 'end' tells the owner, whose session state
// is gone, and each later statement fails.
export class SqlServerConnection
  extends EventEmitter<{ end: []; error: [Error] }>
  implements AsyncDisposable
{
  readonly #pool: sql.ConnectionPool;
  readonly #location: string;
  readonly #clock: SqlServerRead['clock'];
  // Aborts once the session ends, by the server or by its owner.
  readonly #ended = new AbortController();
  // The statements that run now, and the wait for the next SELECT 1 while
  // none runs.
  #running = 0;
  #idle: unknown;

  private constructor(
    pool: sql.ConnectionPool,
    location: string,
    clock: SqlServerRead['clock'],
  ) {
    super();
    this.#pool = pool;
    this.#location = location;
    this.#clock = clock;
  }

  // A pool of exactly one connection, so each statement runs on it. The pool
  // makes one connection to test the login and closes it before it makes the
  // one that the session keeps; only that one ends the session.
  static async open(
    config: sql.config,
    location: string,
    clock: SqlServerRead['clock'],
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
    const connection = new SqlServerConnection(pool, location, clock);
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
      await connection[Symbol.asyncDispose]();
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
    this.#clock.clearTimeout(this.#idle);
    this.#running++;
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
      this.#running--;
      if (this.#running === 0 && !this.#ended.signal.aborted)
        this.#idle = this.#clock.setTimeout(() => void this.#beat(), idleMs);
    }
  }

  async #beat(): Promise<void> {
    try {
      await this.query('SELECT 1');
    } catch {
      // It needs no handling of its own: it fails because the session ended,
      // which 'end' tells the owner, or because the owner disposed the
      // connection.
    }
  }

  #end(): void {
    if (this.#ended.signal.aborted) return;
    this.#ended.abort();
    this.#clock.clearTimeout(this.#idle);
    this.emit('end');
  }

  close(): void {
    void this[Symbol.asyncDispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#ended.abort();
    this.#clock.clearTimeout(this.#idle);
    await this.#pool.close();
  }
}
