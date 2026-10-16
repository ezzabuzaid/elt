import {
  DatabaseSync,
  type DatabaseSyncOptions,
  type SQLOutputValue,
  type SQLTagStore,
} from 'node:sqlite';

import { TooManyDatabasesError } from './too-many-databases-error.ts';

// The read-only handle a statement runs on. It names each database as a
// schema, as in mail.messages.
export type Query = Pick<SQLTagStore, 'all' | 'get'>;

// Column positions preserve duplicate names, and headings survive empty results.
export type QueryResult = {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<number, SQLOutputValue>>[];
};

// The host's port: the path of the SQLite file a name stands for, or
// undefined when the host has no database by that name.
export type Locate = (name: string) => string | undefined;

export type FederationOptions = Pick<DatabaseSyncOptions, 'timeout'> & {
  readonly main: string;
  readonly locate: Locate;
};

// SQLite's error for the first schema a statement reads that is not attached.
const missingDatabase = /^no such table: ([^.]+)\./;

// One read-only handle over main and every database the host can locate, past
// the limit on how many one SQLite connection attaches at once. Main stays
// open; each statement attaches and detaches the additional databases it names.
export class Federation implements Disposable {
  readonly sql: Query;
  readonly #connection: DatabaseSync;
  readonly #locate: Locate;

  constructor({ main, locate, ...options }: FederationOptions) {
    this.#locate = locate;
    this.#connection = new DatabaseSync(main, {
      ...options,
      readOnly: true,
    });
    const store = this.#connection.createTagStore();
    this.sql = {
      all: (strings, ...values) =>
        this.#statement([], () => store.all(strings, ...values)),
      get: (strings, ...values) =>
        this.#statement([], () => store.get(strings, ...values)),
    };
  }

  // Loads connection-local SQL, such as a file defining temporary views.
  // SQLite resolves the databases those views name when a query reads them.
  exec(sql: string): void {
    this.#connection.exec(sql);
  }

  // Runs one SQL string with the named databases visible, in that order, for
  // unqualified tables and schema PRAGMAs as well as qualified table names.
  // SQLite judges the tail: comments and empty statements are allowed, but a
  // second statement, even malformed, is rejected before the first executes.
  query(sql: string, names: readonly string[]): QueryResult {
    return this.#statement(names, () => {
      const statement = this.#connection.prepare(sql);
      let another: boolean;
      try {
        this.#connection.prepare(sql.slice(statement.sourceSQL.length));
        another = true;
      } catch (error) {
        another = !(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ERR_INVALID_ARG_VALUE'
        );
      }
      if (another) throw new Error('Run one SQL statement at a time');
      statement.setReturnArrays(true);
      return {
        columns: statement.columns().map(({ name }) => name),
        rows: statement.all(),
      };
    });
  }

  // SQLite says which database is missing, so the statement is never parsed
  // here. A name the host cannot locate, or a table its database lacks, fails
  // as the statement would. No additional database stays attached, so the next
  // statement asks the host again where each additional database is.
  #statement<Result>(names: readonly string[], run: () => Result): Result {
    const attached: string[] = [];
    const attach = (name: string): boolean => {
      const path = this.#locate(name);
      if (path === undefined) return false;
      const { attach: limit } = this.#connection.limits;
      if (attached.length === limit)
        throw new TooManyDatabasesError(limit, [...attached, name]);
      this.#connection
        .prepare(`ATTACH DATABASE ? AS ${quoted(name)}`)
        .run(path);
      attached.push(name);
      return true;
    };
    try {
      for (const name of names)
        if (!attach(name)) throw new Error(`Unknown database ${name}`);
      for (;;) {
        try {
          return run();
        } catch (error) {
          const name =
            error instanceof Error
              ? missingDatabase.exec(error.message)?.[1]
              : undefined;
          if (name === undefined || attached.includes(name) || !attach(name))
            throw error;
        }
      }
    } finally {
      for (const name of attached)
        this.#connection.exec(`DETACH DATABASE ${quoted(name)}`);
    }
  }

  [Symbol.dispose](): void {
    this.#connection.close();
  }
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
