import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { FileContent } from '@workspace/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { identifiers } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// A file column's bytes, in ordered chunks: SQLite caps one BLOB at 1e9 bytes
// and a whole-file BLOB would hold the file in memory. The row keeps the
// file's id; triggers drop a row's chunks in the same transaction as the row.
export class SQLiteFileStore {
  static readonly chunkSize = 4 * 1024 * 1024;
  readonly name: string;
  readonly #next: StatementSync;
  readonly #insert: StatementSync;

  constructor(
    database: DatabaseSync,
    table: SQLiteTable,
    column: SQLiteColumn,
  ) {
    this.name = SQLiteFileStore.tableName(table, column);
    const chunks = quote(this.name);
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${chunks} ("file" INTEGER NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("file", "n")) STRICT`,
    );
    // A reload can stage files before its target exists; the next load builds
    // the store again, which attaches the triggers to the table swapped in.
    if (
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`,
        )
        .get(table.location)
    ) {
      database.exec(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_delete`)} AFTER DELETE ON ${table.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`,
      );
      database.exec(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_update`)} AFTER UPDATE OF ${column.quotedName} ON ${table.quotedName} WHEN old.${column.quotedName} IS NOT new.${column.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`,
      );
    }
    this.#next = database.prepare(
      `SELECT coalesce(max("file"), 0) + 1 AS "file" FROM ${chunks}`,
    );
    this.#insert = database.prepare(
      `INSERT INTO ${chunks} ("file", "n", "bytes") VALUES (?, ?, ?)`,
    );
  }

  // A hash of the table and column, as SQLite compares them: joined as text,
  // table a_b with column c and table a with column b_c would share chunks
  // and prune each other's.
  static tableName(table: SQLiteTable, column: SQLiteColumn): string {
    const key = createHash('sha256')
      .update(JSON.stringify([table.location, identifiers.key(column.name)]))
      .digest('hex')
      .slice(0, 40);
    return `_elt_files_${key}`;
  }

  // An empty file still stores one empty chunk, so its id stays reserved.
  async save(content: FileContent): Promise<number> {
    const file = Number(this.#next.get()?.file);
    let n = 0;
    for await (const chunk of content.chunks(SQLiteFileStore.chunkSize))
      this.#insert.run(file, n++, chunk);
    if (n === 0) this.#insert.run(file, 0, new Uint8Array());
    return file;
  }
}
