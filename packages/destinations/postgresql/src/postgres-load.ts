import type postgres from 'postgres';

import type { PipelineClock } from '@eltjs/elt';

import {
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
// number for each commit. No transaction stays open between commits, so
// reading the source holds no locks on the targets and keeps nothing from
// vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: PostgresSession;
  readonly #clock: PipelineClock;
  readonly #connector: string;
  readonly #id: string;
  // When the load began, which each row it writes keeps in loaded_at.
  readonly loadedAt: string;

  private constructor(
    connection: PostgresSession,
    { clock, connection: connector }: Owner,
    id: string,
    loadedAt: Date,
  ) {
    this.#connection = connection;
    this.#clock = clock;
    this.#connector = connector;
    this.#id = id;
    this.loadedAt = loadedAt.toISOString();
  }

  get sql(): Transaction {
    return this.#connection.sql;
  }

  static async open(url: string, owner: Owner): Promise<PostgresLoad> {
    const connection = new PostgresSession(url, 'elt');
    try {
      const loadedAt = new Date(owner.clock.Date.now());
      await installNumbering(connection.sql);
      const id = await openLoad(connection.sql, owner.connection, loadedAt);
      return new PostgresLoad(connection, owner, id, loadedAt);
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

  // A transaction that is a commit of this load, with its number.
  async commit<T>(
    work: (sql: Transaction, committedIn: number) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transaction(async (sql) =>
        work(
          sql,
          await commitNumber(
            sql,
            { load: this.#id, connector: this.#connector },
            new Date(this.#clock.Date.now()),
          ),
        ),
      );
    } catch (error) {
      await releaseGate(this.sql);
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await closeLoad(this.sql, this.#id, new Date(this.#clock.Date.now()));
    } finally {
      await this.#connection[Symbol.asyncDispose]();
    }
  }
}

// What opens a load: the clock that dates it, and the connection it records.
type Owner = { readonly clock: PipelineClock; readonly connection: string };
