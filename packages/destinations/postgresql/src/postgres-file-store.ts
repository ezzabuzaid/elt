import { createHash, randomUUID } from 'node:crypto';
import type { FileContent } from 'elt';
import type postgres from 'postgres';
import { quote } from './identifier.ts';
import type { PostgresColumn } from './postgres-column.ts';
import type { PostgresTable } from './postgres-table.ts';

// Like SQLite, keep original files in bounded chunks rather than one whole-file
// value. A file column contains the UUID of its ordered BYTEA chunks.
export class PostgresFileStore {
  static readonly chunkSize = 4 * 1024 * 1024;
  readonly qualifiedName: string;

  constructor(
    readonly schema: string,
    readonly table: PostgresTable,
    readonly column: PostgresColumn,
  ) {
    const key = createHash('sha256')
      .update(JSON.stringify([table.name, column.name]))
      .digest('hex')
      .slice(0, 40);
    this.qualifiedName = `${quote(schema)}.${quote(`_mac_elt_files_${key}`)}`;
  }

  async initialize(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.qualifiedName} ("file" UUID NOT NULL, "n" BIGINT NOT NULL, "bytes" BYTEA NOT NULL, PRIMARY KEY ("file", "n"))`,
    );
    await this.prune(sql);
  }

  async save(sql: postgres.Sql, content: FileContent): Promise<string> {
    const file = randomUUID();
    let n = 0;
    const insert = (bytes: Uint8Array) =>
      sql.unsafe(
        `INSERT INTO ${this.qualifiedName} ("file", "n", "bytes") VALUES ($1, $2, $3)`,
        [file, n++, Buffer.from(bytes)],
      );
    for await (const chunk of content.chunks(PostgresFileStore.chunkSize))
      await insert(chunk);
    if (n === 0) await insert(new Uint8Array());
    return file;
  }

  // Called after a stage is merged or discarded, and when reopening after a
  // crash. This store belongs to just one target column and one writer.
  // ponytail: scans this column's chunks; use targeted cleanup if checkpoint cost grows.
  async prune(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} AS chunks WHERE NOT EXISTS (SELECT 1 FROM ${quote(this.schema)}.${this.table.quotedName} AS target WHERE target.${this.column.quotedName} = chunks."file")`,
    );
  }
}
