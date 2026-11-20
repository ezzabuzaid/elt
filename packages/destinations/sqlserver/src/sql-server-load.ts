import type { PipelineClock } from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import { connect, transaction } from './sql-server-connection.ts';
import {
  type LoadOwner,
  closeLoad,
  commitNumber,
  databaseCopy,
  installNumbering,
  openLoad,
} from './sql-server-numbering.ts';

// A run's one connection to the database, and its record in the numbering of
// the database: open from the start of the load until it is disposed, with a
// number for each commit. The stage of each stream is a #temp table of this
// connection. No transaction stays open between commits.
export class SqlServerLoad implements AsyncDisposable {
  readonly connection: SqlServerConnection;
  readonly #clock: PipelineClock;
  readonly #retention: Temporal.Duration;
  readonly #owner: LoadOwner;
  readonly #id: string;
  // When the load began, which each row it writes keeps in loaded_at.
  readonly loadedAt: string;

  private constructor(
    connection: SqlServerConnection,
    owner: LoadOwner,
    { clock, retention }: Retaining,
    id: string,
    loadedAt: Date,
  ) {
    this.connection = connection;
    this.#clock = clock;
    this.#retention = retention;
    this.#owner = owner;
    this.#id = id;
    this.loadedAt = loadedAt.toISOString();
  }

  // Checks the engine and the row versioning of the database first, so a
  // database that the destination cannot load fails before a row is read.
  static async open(
    database: SqlServerDatabase,
    owner: LoadOwner,
    retaining: Retaining,
  ): Promise<SqlServerLoad> {
    const connection = await connect(database);
    try {
      const loadedAt = new Date(retaining.clock.Date.now());
      await installNumbering(connection, await databaseCopy(connection));
      const id = await openLoad(connection, owner, loadedAt);
      return new SqlServerLoad(connection, owner, retaining, id, loadedAt);
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  transaction<T>(work: () => Promise<T>): Promise<T> {
    return transaction(this.connection, work);
  }

  // A transaction that is a commit of this load, with its number.
  commit<T>(work: (committedIn: number) => Promise<T>): Promise<T> {
    return this.transaction(async () =>
      work(
        await commitNumber(
          this.connection,
          { load: this.#id, owner: this.#owner },
          new Date(this.#clock.Date.now()),
          this.#retention,
        ),
      ),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await closeLoad(
        this.connection,
        this.#id,
        new Date(this.#clock.Date.now()),
      );
    } finally {
      await this.connection[Symbol.asyncDispose]();
    }
  }
}

// What a load keeps of its destination: the clock that dates it, and how
// long the history keeps a position readable.
type Retaining = {
  readonly clock: PipelineClock;
  readonly retention: Temporal.Duration;
};
