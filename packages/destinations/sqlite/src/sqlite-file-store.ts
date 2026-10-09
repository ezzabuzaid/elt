import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { FileContent } from '@workspace/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { identifiers } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tablePrefix = '_elt_files_';
const chunks =
  '("file" INTEGER NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("file", "n")) STRICT';

// A file column's bytes, in ordered chunks: SQLite caps one BLOB at 1e9 bytes
// and a whole-file BLOB would hold the file in memory. The row keeps the
// file's id; triggers drop a row's chunks in the same transaction as the row.
// A load stages chunks in a connection-private TEMP table and publishes them
// inside a commit, so a load holds no transaction while it reads files.
export class SQLiteFileStore {
  static readonly chunkSize = 4 * 1024 * 1024;
  readonly name: string;
  readonly #database: DatabaseSync;
  readonly #table: SQLiteTable;
  readonly #column: SQLiteColumn;
  readonly #staged: string;

  constructor(
    database: DatabaseSync,
    table: SQLiteTable,
    column: SQLiteColumn,
  ) {
    this.#database = database;
    this.#table = table;
    this.#column = column;
    this.name = SQLiteFileStore.tableName(table, column);
    this.#staged = quote(
      `${tablePrefix}stage_${this.name.slice(tablePrefix.length)}`,
    );
  }

  // A hash of the table and column, as SQLite compares them: joined as text,
  // table a_b with column c and table a with column b_c would share chunks
  // and prune each other's.
  static tableName(
    table: SQLiteTable,
    column: Pick<SQLiteColumn, 'name'>,
  ): string {
    const key = createHash('sha256')
      .update(JSON.stringify([table.location, identifiers.key(column.name)]))
      .digest('hex')
      .slice(0, 40);
    return `${tablePrefix}${key}`;
  }

  #exists(location: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`,
        )
        .get(location) !== undefined
    );
  }

  get published(): boolean {
    return this.#exists(this.name);
  }

  stage(): void {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
    this.#database.exec(`CREATE TEMP TABLE ${this.#staged} ${chunks}`);
  }

  // An empty file still stores one empty chunk, so its id stays reserved. Ids
  // continue after both the published and the staged chunks.
  async save(content: FileContent): Promise<number> {
    const highest = (table: string) =>
      Number(
        this.#database
          .prepare(`SELECT coalesce(max("file"), 0) AS "file" FROM ${table}`)
          .get()?.file,
      );
    const file =
      Math.max(
        this.published ? highest(quote(this.name)) : 0,
        highest(`temp.${this.#staged}`),
      ) + 1;
    const insert = this.#database.prepare(
      `INSERT INTO temp.${this.#staged} ("file", "n", "bytes") VALUES (?, ?, ?)`,
    );
    let n = 0;
    for await (const chunk of content.chunks(SQLiteFileStore.chunkSize))
      insert.run(file, n++, chunk);
    if (n === 0) insert.run(file, 0, new Uint8Array());
    return file;
  }

  // Moves the staged chunks into the store, inside a commit, and attaches the
  // triggers to the target once it exists. A reload swaps in a table without
  // them, which its next commit attaches again.
  publish(): void {
    const table = quote(this.name);
    const column = this.#column.quotedName;
    this.#database.exec(`CREATE TABLE IF NOT EXISTS ${table} ${chunks}`);
    if (this.#exists(this.#table.location)) {
      this.#database.exec(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_delete`)} AFTER DELETE ON ${this.#table.quotedName} BEGIN DELETE FROM ${table} WHERE "file" = old.${column}; END`,
      );
      this.#database.exec(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_update`)} AFTER UPDATE OF ${column} ON ${this.#table.quotedName} WHEN old.${column} IS NOT new.${column} BEGIN DELETE FROM ${table} WHERE "file" = old.${column}; END`,
      );
    }
    this.#database.exec(
      `INSERT INTO ${table} SELECT * FROM temp.${this.#staged}`,
    );
    this.discard();
  }

  discard(): void {
    this.#database.exec(`DELETE FROM temp.${this.#staged}`);
  }

  unstage(): void {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
  }
}
