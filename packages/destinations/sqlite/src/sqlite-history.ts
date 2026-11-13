import { createHash, hash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

import { SQLiteFileStore } from './sqlite-file-store.ts';
import { identifiers, quote } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

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
  readonly #table: Pick<SQLiteTable, 'name' | 'location'>;

  constructor(table: Pick<SQLiteTable, 'name' | 'location'>) {
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

// Deletes, in each history, the rows that only a reading before commit
// through reads: each row that a commit up to it replaced. The stored files
// that only those rows refer to go in the same transaction, so the chunks of
// the file stay the files that a row refers to. The rows of a reload's hidden
// target refer to no such file: each file id is given once, and a hidden row
// reaches a history only after its reload ends and drops the hidden target.
export function expireHistory(database: DatabaseSync, through: number): void {
  const exists = (name: string) =>
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = lower(?)`,
      )
      .get(name) !== undefined;
  if (!exists(histories)) return;
  const pairs = database
    .prepare(`SELECT "target", "history" FROM ${quote(histories)}`)
    .all()
    .map((row) => ({
      target: String(row.target),
      history: String(row.history),
    }));
  for (const { target, history } of pairs) {
    if (!exists(history)) continue;
    const current = new Set(
      exists(target)
        ? names(database, target).map((name) => identifiers.key(name))
        : [],
    );
    for (const column of names(database, history)) {
      const chunks = SQLiteFileStore.tableName(
        { location: target },
        { name: column },
      );
      if (!exists(chunks)) continue;
      const value = quote(column);
      const kept = [
        ...(current.has(identifiers.key(column))
          ? [`SELECT ${value} FROM ${quote(target)} WHERE ${value} IS NOT NULL`]
          : []),
        `SELECT ${value} FROM ${quote(history)} WHERE "replaced_in" > ? AND ${value} IS NOT NULL`,
      ];
      database
        .prepare(
          `DELETE FROM ${quote(chunks)} WHERE "file" IN (SELECT ${value} FROM ${quote(history)} WHERE "replaced_in" <= ?) AND "file" NOT IN (${kept.join(' UNION ')})`,
        )
        .run(through, through);
    }
    database
      .prepare(`DELETE FROM ${quote(history)} WHERE "replaced_in" <= ?`)
      .run(through);
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
  columns: readonly { readonly name: string }[],
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
