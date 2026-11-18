import type postgres from 'postgres';

import type { PipelineClock } from '@eltjs/elt';

import {
  type LoadOwner,
  closeLoad,
  commitNumber,
  installNumbering,
  openLoad,
  releaseGate,
} from './postgres-numbering.ts';
import { PostgresSession } from './postgres-session.ts';

// The load's one connection, inside one commit's transaction or on its own.
export type Transaction = postgres.Sql;

// A run's one connection to the database, and its record in the numbering of the
// database: open from the start of the load until it is disposed, with a
// number for each commit. A connection's pass loads, and so does a refresh
// of a derived dataset. No transaction stays open between commits, so
// reading the source holds no locks on the targets and keeps nothing from
// vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: PostgresSession;
  readonly #clock: PipelineClock;
  readonly #retention: Temporal.Duration;
  readonly #owner: LoadOwner;
  readonly #id: string;
  // When the load began, which each row it writes keeps in loaded_at.
  readonly loadedAt: string;

  private constructor(
    connection: PostgresSession,
    owner: LoadOwner,
    { clock, retention }: Retaining,
    id: string,
    loadedAt: Date,
  ) {
    this.#connection = connection;
    this.#clock = clock;
    this.#retention = retention;
    this.#owner = owner;
    this.#id = id;
    this.loadedAt = loadedAt.toISOString();
  }

  get sql(): Transaction {
    return this.#connection.sql;
  }

  static async open(
    url: string,
    owner: LoadOwner,
    retaining: Retaining,
  ): Promise<PostgresLoad> {
    const connection = new PostgresSession(url, 'elt');
    try {
      const loadedAt = new Date(retaining.clock.Date.now());
      await installNumbering(connection.sql);
      const id = await openLoad(connection.sql, owner, loadedAt);
      return new PostgresLoad(connection, owner, retaining, id, loadedAt);
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  // What work does becomes durable and visible together, or not at all. A
  // failure lets go of the gate a commit number holds while it is taken.
  async transaction<T>(work: (sql: Transaction) => Promise<T>): Promise<T> {
    await this.sql.unsafe('BEGIN');
    try {
      const result = await work(this.sql);
      await this.sql.unsafe('COMMIT');
      return result;
    } catch (error) {
      await this.sql.unsafe('ROLLBACK');
      await releaseGate(this.sql);
      throw error;
    }
  }

  // Makes the transaction it runs in a commit of this load, and gives its
  // number.
  number(sql: Transaction): Promise<number> {
    return commitNumber(
      sql,
      { load: this.#id, owner: this.#owner },
      new Date(this.#clock.Date.now()),
      this.#retention,
    );
  }

  // A transaction that is a commit of this load, with its number.
  commit<T>(
    work: (sql: Transaction, committedIn: number) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (sql) => work(sql, await this.number(sql)));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await closeLoad(this.sql, this.#id, new Date(this.#clock.Date.now()));
    } finally {
      await this.#connection[Symbol.asyncDispose]();
    }
  }
}

// What a load keeps of its destination: the clock that dates it, and how
// long the history keeps a position readable.
type Retaining = {
  readonly clock: PipelineClock;
  readonly retention: Temporal.Duration;
};
