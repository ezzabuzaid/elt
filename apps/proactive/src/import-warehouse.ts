import { DatabaseSync, type SQLTagStore } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import type { Warehouse } from '@workspace/eca';

// The read-only handle a condition gets: one query surface over every import,
// each named by its connector, as in messages.messages.
export type Query = Pick<SQLTagStore, 'all' | 'get'>;

// Node's SQLite attaches at most 10 databases to one connection, and there are
// more imports than that. So an import is attached the first time a query
// names it, and the one attached longest ago is detached to make room.
const maxAttached = 10;

// proactive's imports as eca reads them. A run of proactive makes one import
// pass after its rules took their baseline, and that pass is the warehouse's
// one commit.
export class ImportWarehouse implements Warehouse<Query>, Disposable {
  readonly sql: Query;
  readonly #database = new DatabaseSync(':memory:');
  readonly #imports: Readonly<Record<string, string>>;
  readonly #attached: string[] = [];
  readonly #pass: () => Promise<void>;

  constructor(
    imports: Readonly<Record<string, string>>,
    pass: () => Promise<void>,
  ) {
    this.#imports = imports;
    this.#pass = pass;
    const store = this.#database.createTagStore();
    this.sql = {
      all: (strings, ...values) =>
        this.#attaching(() => store.all(strings, ...values)),
      get: (strings, ...values) =>
        this.#attaching(() => store.get(strings, ...values)),
    };
  }

  // Runs a query, attaching each import it names that is not attached yet. An
  // import nobody has, or a table its import lacks, fails as the query would.
  #attaching<Result>(query: () => Result): Result {
    for (;;) {
      try {
        return query();
      } catch (error) {
        const name =
          error instanceof Error
            ? /no such table: ([^.\s]+)\./.exec(error.message)?.[1]
            : undefined;
        const path = name === undefined ? undefined : this.#imports[name];
        if (
          name === undefined ||
          path === undefined ||
          this.#attached.includes(name)
        )
          throw error;
        const oldest =
          this.#attached.length === maxAttached
            ? this.#attached.shift()
            : undefined;
        if (oldest !== undefined)
          this.#database.exec(`DETACH DATABASE ${quoted(oldest)}`);
        this.#database
          .prepare(`ATTACH DATABASE ? AS ${quoted(name)}`)
          .run(`${pathToFileURL(path).href}?mode=ro`);
        this.#attached.push(name);
      }
    }
  }

  async *commits(signal: AbortSignal): AsyncGenerator<undefined> {
    await this.#pass();
    if (!signal.aborted) yield;
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
