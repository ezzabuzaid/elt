import type { DatabaseSync } from 'node:sqlite';

import { type ColumnDescription, describe } from './sqlite-descriptions.ts';
import { identifiers, quote } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

// The view readers see a target through: exactly the stream's columns and
// loaded_at, none of the internal ones, over the raw table, made, dropped and
// described in the commits of the target.
export class SQLiteReaderView {
  readonly #name: string;
  readonly #raw: string;
  readonly #definition: string;

  // shown: the quoted columns the view lists, in order.
  constructor(table: SQLiteTable, shown: readonly string[]) {
    this.#name = table.name;
    this.#raw = table.quotedRaw;
    this.#definition = `CREATE VIEW ${quote(table.name)} AS SELECT ${shown.join(', ')} FROM ${this.#raw}`;
    Object.freeze(this);
  }

  // Refuses, before anything is read, a relation of the view's name that a
  // load did not make, rather than adopting or destroying it: not a view, or a
  // view of other columns or another table. A stale table's view still
  // selects the stored columns, which evolving the table replaces.
  refuse(database: DatabaseSync, stale: boolean): void {
    const existing = database
      .prepare(
        'SELECT "type", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)',
      )
      .get(this.#name);
    if (existing === undefined) return;
    // The names in it, as SQLite compares them: a target named in another
    // ASCII case is the same target.
    const sql = identifiers.key(String(existing.sql));
    const ours = stale
      ? sql.startsWith(
          identifiers.key(`CREATE VIEW ${quote(this.#name)} AS SELECT `),
        ) && sql.endsWith(identifiers.key(` FROM ${this.#raw}`))
      : sql === identifiers.key(this.#definition);
    if (existing.type !== 'view' || !ours)
      throw new TypeError(
        `${quote(this.#name)} is not a view of exactly ${this.#raw}; drop it or delete the database`,
      );
  }

  // Made only when absent: its definition changes only with the columns of
  // the raw table, and each commit that changes them drops it first, so a
  // commit that changes no column leaves the schema as it is. refuse refused
  // any view not a load's own.
  install(database: DatabaseSync): void {
    if (
      database
        .prepare('SELECT 1 FROM sqlite_schema WHERE lower("name") = lower(?)')
        .get(this.#name) === undefined
    )
      database.exec(this.#definition);
  }

  drop(database: DatabaseSync): void {
    database.exec(`DROP VIEW IF EXISTS ${quote(this.#name)}`);
  }

  describe(
    database: DatabaseSync,
    description: string,
    columns: Readonly<Record<string, ColumnDescription>>,
  ): void {
    describe(database, this.#name, description, columns);
  }
}
