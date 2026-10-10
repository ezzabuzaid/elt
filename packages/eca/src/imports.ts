import { DatabaseSync, constants } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import type { Condition, Match } from './rule.ts';

// The tables a condition read, by the name of the import that holds them.
export type Reads = ReadonlyMap<string, ReadonlySet<string>>;

// The imports attached read-only under their names to one connection, so a
// condition reads messages.messages and cannot change what it reads. SQLite
// tells the authorizer each table a statement reads, through any view, while
// it prepares the statement.
export class Imports implements Disposable {
  readonly #database = new DatabaseSync(':memory:');
  #reading: Map<string, Set<string>> | null = null;

  constructor(paths: Readonly<Record<string, string>>) {
    for (const [name, path] of Object.entries(paths))
      this.#database
        .prepare(`ATTACH DATABASE ? AS "${name.replaceAll('"', '""')}"`)
        .run(`${pathToFileURL(path).href}?mode=ro`);
    this.#database.setAuthorizer((action, table, _column, name) => {
      if (
        this.#reading !== null &&
        action === constants.SQLITE_READ &&
        table !== null &&
        name !== null
      )
        this.#reading.set(
          name,
          (this.#reading.get(name) ?? new Set()).add(table),
        );
      return constants.SQLITE_OK;
    });
  }

  // A fresh tag store each time: a store reuses the statements it prepared,
  // and a reused statement reports no reads.
  evaluate<Data>(condition: Condition<Data>): {
    readonly matches: readonly Match<Data>[];
    readonly reads: Reads;
  } {
    const reads = new Map<string, Set<string>>();
    this.#reading = reads;
    try {
      return {
        matches: condition.evaluate(this.#database.createTagStore()),
        reads,
      };
    } finally {
      this.#reading = null;
    }
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
