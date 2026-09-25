import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { FileContent } from 'elt';
import type { SQLiteColumn } from './sqlite-column.ts';
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
  readonly #discard: StatementSync;

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
    database.exec(
      `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_delete`)} AFTER DELETE ON ${table.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`,
    );
    database.exec(
      `CREATE TRIGGER IF NOT EXISTS ${quote(`${this.name}_update`)} AFTER UPDATE OF ${column.quotedName} ON ${table.quotedName} WHEN old.${column.quotedName} IS NOT new.${column.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`,
    );
    this.#next = database.prepare(
      `SELECT coalesce(max("file"), 0) + 1 AS "file" FROM ${chunks}`,
    );
    this.#insert = database.prepare(
      `INSERT INTO ${chunks} ("file", "n", "bytes") VALUES (?, ?, ?)`,
    );
    this.#discard = database.prepare(`DELETE FROM ${chunks} WHERE "file" = ?`);
  }

  static tableName(table: SQLiteTable, column: SQLiteColumn): string {
    return `_mac_elt_files_${table.location}_${column.name.toLowerCase()}`;
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

  discard(file: number): void {
    this.#discard.run(file);
  }
}
