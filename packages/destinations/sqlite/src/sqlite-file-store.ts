import { createHash, hash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

import type { FileContent } from '@eltjs/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { identifiers } from './sqlite-identifiers.ts';
import type { SQLiteTable } from './sqlite-table.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tablePrefix = '_elt_files_';
const chunks =
  '("file" INTEGER NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("file", "n")) STRICT';
// The highest id that each store gave a file it published. Ids only go up: a
// row of the history keeps the id of its file for a reading as of a position,
// so no other file may take that id, even after the chunks of the file, or the
// whole store, are gone.
const ids = new Declaration(
  [
    'CREATE TABLE "_elt_file_ids" ("store" TEXT PRIMARY KEY, "last" INTEGER NOT NULL) STRICT',
  ],
  { rows: 'replace' },
);

// A file column's bytes, in ordered chunks: SQLite caps one BLOB at 1e9 bytes
// and a whole-file BLOB would hold the file in memory. The row keeps the
// file's id. A load stages chunks in a connection-private TEMP table and
// publishes them inside a commit, so a load holds no transaction while it
// reads files.
export class SQLiteFileStore {
  static readonly chunkSize = 4 * 1024 * 1024;
  readonly name: string;
  readonly #database: DatabaseSync;
  readonly #staged: string;

  constructor(
    database: DatabaseSync,
    table: SQLiteTable,
    column: SQLiteColumn,
  ) {
    this.#database = database;
    this.name = SQLiteFileStore.tableName(table, column);
    this.#staged = quote(
      `${tablePrefix}stage_${this.name.slice(tablePrefix.length)}`,
    );
  }

  // A hash of the table and column, as SQLite compares them: joined as text,
  // table a_b with column c and table a with column b_c would share chunks
  // and prune each other's.
  static tableName(
    table: Pick<SQLiteTable, 'location'>,
    column: Pick<SQLiteColumn, 'name'>,
  ): string {
    const key = hash(
      'sha256',
      JSON.stringify([table.location, identifiers.key(column.name)]),
    ).slice(0, 40);
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

  #lastGivenId(): number {
    if (!this.#exists('_elt_file_ids')) return 0;
    const row = this.#database
      .prepare('SELECT "last" FROM "_elt_file_ids" WHERE "store" = ?')
      .get(this.name);
    return Number(row?.last ?? 0);
  }

  get published(): boolean {
    return this.#exists(this.name);
  }

  stage(): void {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
    this.#database.exec(`CREATE TEMP TABLE ${this.#staged} ${chunks}`);
  }

  // Stages the file's chunks under an id above each id the store gave and each
  // staged id. An empty file still stores one empty chunk, so its id stays
  // reserved. Gives the id and the SHA-256 of the bytes, which names the
  // content.
  async save(
    content: FileContent,
  ): Promise<{ readonly id: number; readonly sha256: Uint8Array }> {
    const given = this.#lastGivenId();
    const staged = Number(
      this.#database
        .prepare(
          `SELECT coalesce(max("file"), 0) AS "file" FROM temp.${this.#staged}`,
        )
        .get()?.file,
    );
    const id = Math.max(given, staged) + 1;
    const insert = this.#database.prepare(
      `INSERT INTO temp.${this.#staged} ("file", "n", "bytes") VALUES (?, ?, ?)`,
    );
    const sha256 = createHash('sha256');
    let n = 0;
    for await (const chunk of content.chunks(SQLiteFileStore.chunkSize)) {
      sha256.update(chunk);
      insert.run(id, n++, chunk);
    }
    if (n === 0) insert.run(id, 0, new Uint8Array());
    return { id, sha256: sha256.digest() };
  }

  // Moves the staged chunks into the store, and records the highest id they
  // take, inside a commit.
  publish(): void {
    const table = quote(this.name);
    this.#database.exec(`CREATE TABLE IF NOT EXISTS ${table} ${chunks}`);
    this.#database.exec(
      `INSERT INTO ${table} SELECT * FROM temp.${this.#staged}`,
    );
    ids.apply(this.#database);
    this.#database
      .prepare(
        `INSERT INTO "_elt_file_ids" ("store", "last") SELECT ?, "file" FROM (SELECT max("file") AS "file" FROM temp.${this.#staged}) WHERE "file" IS NOT NULL ON CONFLICT ("store") DO UPDATE SET "last" = excluded."last"`,
      )
      .run(this.name);
    this.discard();
  }

  discard(): void {
    this.#database.exec(`DELETE FROM temp.${this.#staged}`);
  }

  unstage(): void {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
  }
}
