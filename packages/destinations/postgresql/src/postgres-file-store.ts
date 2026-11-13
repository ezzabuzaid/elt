import { createHash, hash, randomUUID } from 'node:crypto';

import type postgres from 'postgres';

import type { FileContent } from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { PostgresColumn } from './postgres-column.ts';
import type { PostgresTable } from './postgres-table.ts';

const chunks =
  '("file" UUID NOT NULL, "n" BIGINT NOT NULL, "bytes" BYTEA NOT NULL, PRIMARY KEY ("file", "n"))';

// Like SQLite, keep original files in bounded chunks rather than one whole-file
// value. A file column contains the UUID of its ordered BYTEA chunks.
export class PostgresFileStore {
  static readonly chunkSize = 4 * 1024 * 1024;
  readonly schema: string;
  readonly table: PostgresTable;
  readonly column: PostgresColumn;
  readonly qualifiedName: string;
  // The TEMP table of chunks saved since the last commit, private to the
  // load's session like the stage of their records.
  readonly #staged: string;

  constructor(schema: string, table: PostgresTable, column: PostgresColumn) {
    this.schema = schema;
    this.table = table;
    this.column = column;
    this.qualifiedName = PostgresFileStore.qualifiedName(
      schema,
      table,
      column.name,
    );
    this.#staged = quote(
      `_elt_files_stage_${PostgresFileStore.#key(table, column.name)}`,
    );
  }

  // The chunk table of the column named column, which may no longer be one
  // of the table's file columns.
  static qualifiedName(
    schema: string,
    table: PostgresTable,
    column: string,
  ): string {
    return `${quote(schema)}.${quote(`_elt_files_${PostgresFileStore.#key(table, column)}`)}`;
  }

  static #key(table: PostgresTable, column: string): string {
    return hash('sha256', JSON.stringify([table.name, column])).slice(0, 40);
  }

  async stage(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${this.#staged}`);
    await sql.unsafe(`CREATE TEMP TABLE ${this.#staged} ${chunks}`);
  }

  // Stages the file's bytes under a new id, and gives the id and the SHA-256
  // of the bytes, which the row hash counts in place of the id.
  async save(
    sql: postgres.Sql,
    content: FileContent,
  ): Promise<{ readonly file: string; readonly sha256: Uint8Array }> {
    const file = randomUUID();
    const sha256 = createHash('sha256');
    let n = 0;
    const insert = (bytes: Uint8Array) =>
      sql.unsafe(
        `INSERT INTO pg_temp.${this.#staged} ("file", "n", "bytes") VALUES ($1, $2, $3)`,
        [file, n++, Buffer.from(bytes)],
      );
    for await (const chunk of content.chunks(PostgresFileStore.chunkSize)) {
      sha256.update(chunk);
      await insert(chunk);
    }
    if (n === 0) await insert(new Uint8Array());
    return { file, sha256: sha256.digest() };
  }

  // Moves the staged chunks into the store, inside a commit.
  async publish(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.qualifiedName} ${chunks}`,
    );
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} SELECT * FROM pg_temp.${this.#staged}`,
    );
    await sql.unsafe(`TRUNCATE pg_temp.${this.#staged}`);
  }

  async discard(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`TRUNCATE pg_temp.${this.#staged}`);
  }

  async unstage(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`DROP TABLE pg_temp.${this.#staged}`);
  }

  // Called inside each commit, after the merge: chunks no row of the tables
  // refers to, such as a deduplication loser's, go. The tables are the target,
  // its history, whose rows keep their files for a reading as of a position
  // before the commit that replaced them, and, while a reload is open, its
  // hidden target. A table can type the column otherwise, such as a target
  // whose reload makes it a file column, so ids compare as text. This store
  // belongs to just one target column and one writer.
  // ponytail: scans this column's chunks; use targeted cleanup if checkpoint cost grows.
  async prune(
    sql: Pick<postgres.Sql, 'unsafe'>,
    tables: readonly string[],
  ): Promise<void> {
    const referring: string[] = [];
    for (const table of tables) {
      const [column] = await sql.unsafe(
        'SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped',
        [table, this.column.name],
      );
      if (column !== undefined) referring.push(table);
    }
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} AS chunks WHERE ${
        referring
          .map(
            (table) =>
              `NOT EXISTS (SELECT 1 FROM ${table} AS kept WHERE kept.${this.column.quotedName}::text = chunks."file"::text)`,
          )
          .join(' AND ') || 'true'
      }`,
    );
  }
}
