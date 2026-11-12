import { createHash, hash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

import type { SQLiteColumn } from './sqlite-column.ts';
import { identifiers } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const histories = '_elt_histories';

// Which table keeps the replaced rows of which target, by the target's
// location, so a reader finds the history of each target.
const registry = new Declaration(
  [
    `CREATE TABLE ${quote(histories)} ("target" TEXT PRIMARY KEY, "history" TEXT NOT NULL) STRICT`,
  ],
  { rows: 'replace' },
);

// The rows of a target that commits replaced or removed, each with the
// number of the commit that did, as a SQL Server temporal table keeps them
// beside its current table. Its columns declare no type, so each value keeps
// the type it had in the target whatever the target declares later. It takes
// each column of the target that it does not have, and never drops one.
export class SQLiteHistory {
  readonly name: string;
  readonly #table: SQLiteTable;

  constructor(table: SQLiteTable) {
    this.#table = table;
    this.name = `_elt_history_${hash('sha256', table.location)}`;
  }

  // Made with the target, with written, the quoted columns that each row of
  // the target holds, and recorded as its history. SQLite cannot add a
  // column named rowid, _rowid_ or oid to a table, so the history has the
  // target's columns from the start.
  create(database: DatabaseSync, written: readonly string[]): void {
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${quote(this.name)} ("replaced_in" INTEGER NOT NULL, ${written.join(', ')})`,
    );
    database.exec(
      `CREATE INDEX IF NOT EXISTS ${quote(`${this.name}_replaced_in`)} ON ${quote(this.name)} ("replaced_in")`,
    );
    registry.apply(database);
    database
      .prepare(
        `INSERT INTO ${quote(histories)} ("target", "history") VALUES (?, ?) ON CONFLICT ("target") DO UPDATE SET "history" = excluded."history"`,
      )
      .run(this.#table.location, this.name);
  }

  // Copies the rows of the target that rows selects into the history, as
  // replaced in commit replacedIn. rows is the FROM clause of a SELECT in
  // which "_elt_old" names the target.
  keep(
    database: DatabaseSync,
    replacedIn: number,
    rows: string,
    params: readonly SQLInputValue[] = [],
  ): void {
    const columns = names(database, this.#table.name);
    const kept = new Set(
      names(database, this.name).map((name) => identifiers.key(name)),
    );
    for (const column of columns)
      if (!kept.has(identifiers.key(column)))
        database.exec(
          `ALTER TABLE ${quote(this.name)} ADD COLUMN ${quote(column)}`,
        );
    database
      .prepare(
        `INSERT INTO ${quote(this.name)} (${columns.map(quote).join(', ')}, "replaced_in") SELECT ${columns.map((column) => `"_elt_old".${quote(column)}`).join(', ')}, ? ${rows}`,
      )
      .run(replacedIn, ...params);
  }
}

function names(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA main.table_info(${quote(table)})`)
    .all()
    .map(({ name }) => String(name));
}

// The SHA-256 of the values of a staged row, which names its version: a
// commit that finds the stored row with the same hash leaves it as it is.
// Each value that is not null counts with its column's name and its type, so
// a column the stream adds, null in each stored row, makes no new version. A
// stored file counts as the SHA-256 of its bytes, not as its id.
export function rowHash(
  columns: readonly SQLiteColumn[],
  values: readonly SQLInputValue[],
): string {
  const digest = createHash('sha256');
  const add = (tag: string, data: string | NodeJS.ArrayBufferView) => {
    const bytes =
      typeof data === 'string'
        ? Buffer.from(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    digest.update(`${tag}${bytes.byteLength}:`);
    digest.update(bytes);
  };
  columns.forEach((column, index) => {
    const value = values[index];
    if (value === null || value === undefined) return;
    add('c', column.name);
    if (typeof value === 'string') add('t', value);
    else if (typeof value === 'bigint') add('n', String(value));
    else if (typeof value === 'number')
      add('n', Number.isInteger(value) ? String(BigInt(value)) : String(value));
    else add('b', value);
  });
  return digest.digest('hex');
}
