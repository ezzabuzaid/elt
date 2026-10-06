import { createHash, randomUUID } from 'node:crypto';

import type postgres from 'postgres';

import type { FileContent } from '@workspace/elt';

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
    const key = createHash('sha256')
      .update(JSON.stringify([table.name, column.name]))
      .digest('hex')
      .slice(0, 40);
    this.qualifiedName = `${quote(schema)}.${quote(`_elt_files_${key}`)}`;
    this.#staged = quote(`_elt_files_stage_${key}`);
  }

  async stage(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${this.#staged}`);
    await sql.unsafe(`CREATE TEMP TABLE ${this.#staged} ${chunks}`);
  }

  async save(sql: postgres.Sql, content: FileContent): Promise<string> {
    const file = randomUUID();
    let n = 0;
    const insert = (bytes: Uint8Array) =>
      sql.unsafe(
        `INSERT INTO pg_temp.${this.#staged} ("file", "n", "bytes") VALUES ($1, $2, $3)`,
        [file, n++, Buffer.from(bytes)],
      );
    for await (const chunk of content.chunks(PostgresFileStore.chunkSize))
      await insert(chunk);
    if (n === 0) await insert(new Uint8Array());
    return file;
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

  // Called inside each commit, after the merge: chunks no row refers to,
  // such as a deduplication loser's, go. This store belongs to just one
  // target column and one writer.
  // ponytail: scans this column's chunks; use targeted cleanup if checkpoint cost grows.
  async prune(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} AS chunks WHERE NOT EXISTS (SELECT 1 FROM ${quote(this.schema)}.${this.table.quotedName} AS target WHERE target.${this.column.quotedName} = chunks."file")`,
    );
  }
}
