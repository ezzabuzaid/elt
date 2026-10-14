import { DatabaseSync, type SQLTagStore } from 'node:sqlite';

import { TooManyDatabasesError } from './too-many-databases-error.ts';

// The read-only handle a statement runs on. It names each database as a
// schema, as in mail.messages.
export type Query = Pick<SQLTagStore, 'all' | 'get'>;

// The host's port: the path of the SQLite file a name stands for, or
// undefined when the host has no database by that name.
export type Locate = (name: string) => string | undefined;

// SQLite's error for the first schema a statement reads that is not attached.
const missingDatabase = /^no such table: ([^.]+)\./;

// One read-only handle over every database the host can locate, past the
// limit on how many one SQLite connection attaches at once. Each statement
// attaches the databases it names and detaches them when it ends.
export class Federation implements Disposable {
  readonly sql: Query;
  readonly #connection = new DatabaseSync(':memory:', { readOnly: true });
  readonly #locate: Locate;

  constructor(options: { readonly locate: Locate }) {
    this.#locate = options.locate;
    const store = this.#connection.createTagStore();
    this.sql = {
      all: (strings, ...values) =>
        this.#statement(() => store.all(strings, ...values)),
      get: (strings, ...values) =>
        this.#statement(() => store.get(strings, ...values)),
    };
  }

  // SQLite says which database is missing, so the statement is never parsed
  // here. A name the host cannot locate, or a table its database lacks, fails
  // as the statement would. Nothing stays attached, so the next statement asks
  // the host again where each database is.
  #statement<Result>(run: () => Result): Result {
    const attached: string[] = [];
    try {
      for (;;) {
        try {
          return run();
        } catch (error) {
          const name =
            error instanceof Error
              ? missingDatabase.exec(error.message)?.[1]
              : undefined;
          if (name === undefined || attached.includes(name)) throw error;
          const path = this.#locate(name);
          if (path === undefined) throw error;
          const { attach } = this.#connection.limits;
          if (attached.length === attach)
            throw new TooManyDatabasesError(attach, [...attached, name]);
          this.#connection
            .prepare(`ATTACH DATABASE ? AS ${quoted(name)}`)
            .run(path);
          attached.push(name);
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
