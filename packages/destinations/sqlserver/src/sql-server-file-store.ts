import { hash, randomUUID } from 'node:crypto';

import { type FileContent, storedChunkSize, writeChunks } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import type { SqlServerColumn } from './sql-server-column.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { storedColumns } from './sql-server-fit.ts';
import { inMarts, inWarehouse, marts } from './sql-server-schemas.ts';
import type { SqlServerTable } from './sql-server-table.ts';

const chunks =
  '([file] uniqueidentifier NOT NULL, [n] bigint NOT NULL, [bytes] varbinary(max) NOT NULL, PRIMARY KEY ([file], [n]))';

// The original bytes of the files of one column, in chunks, as in
// elt-postgresql: the column holds the UNIQUEIDENTIFIER of its file, the
// chunks are a table in _warehouse, and readers read them through a view of
// the same name in marts. The chunks of a load wait in a #temp table of its
// connection until the commit of their rows moves them.
export class SqlServerFileStore {
  readonly column: SqlServerColumn;
  readonly qualifiedName: string;
  // The view in marts that readers join on file.
  readonly view: string;
  readonly #name: string;
  readonly #descriptions: TargetDescriptions;
  readonly #staged: string;

  constructor(table: SqlServerTable, column: SqlServerColumn) {
    this.column = column;
    this.#name = SqlServerFileStore.#nameOf(table, column.name);
    this.qualifiedName = inWarehouse(this.#name);
    this.view = inMarts(this.#name);
    this.#descriptions = new TargetDescriptions(
      `The original bytes of the files that column ${column.name} of ${marts}.${table.name} names, in chunks: join on file = that column and concatenate bytes in order of n.`,
      {
        file: `The UNIQUEIDENTIFIER that column ${column.name} of ${marts}.${table.name} holds.`,
        n: 'The place of the chunk in its file, from 0.',
        bytes: `The bytes of the chunk, at most ${storedChunkSize} bytes.`,
      },
    );
    this.#staged = `#elt_files_stage_${SqlServerFileStore.#key(table, column.name)}`;
  }

  // Drops the chunks of the column named column, which may no longer be one
  // of the table's file columns, and their view.
  static async drop(
    connection: SqlServerConnection,
    table: SqlServerTable,
    column: string,
  ): Promise<void> {
    const name = SqlServerFileStore.#nameOf(table, column);
    await connection.query(
      `DROP VIEW IF EXISTS ${inMarts(name)}; DROP TABLE IF EXISTS ${inWarehouse(name)};`,
    );
  }

  static #nameOf(table: SqlServerTable, column: string): string {
    return `_elt_files_${SqlServerFileStore.#key(table, column)}`;
  }

  static #key(table: SqlServerTable, column: string): string {
    return hash('sha256', JSON.stringify([table.raw, column])).slice(0, 40);
  }

  // A #temp table that a batch with parameters makes is dropped at the end
  // of that batch, so the stage is made by a batch with none.
  async stage(connection: SqlServerConnection): Promise<void> {
    await connection.query(
      `DROP TABLE IF EXISTS ${this.#staged}; CREATE TABLE ${this.#staged} ${chunks};`,
    );
  }

  // Stages the file's bytes under a new id, and gives the id and the SHA-256
  // of the bytes, which the row hash counts in place of the id. Each chunk
  // travels as base64 in one JSON parameter, which OPENJSON reads as varchar:
  // BASE64_DECODE takes no nvarchar (ADR 0011).
  async save(
    connection: SqlServerConnection,
    content: FileContent,
  ): Promise<{ readonly file: string; readonly sha256: Uint8Array }> {
    const file = randomUUID();
    const sha256 = await writeChunks(content, async (n, bytes) => {
      await connection.query(
        `INSERT INTO ${this.#staged} ([file], [n], [bytes]) SELECT CAST(@file AS uniqueidentifier), j.[n], BASE64_DECODE(j.[b]) FROM OPENJSON(@chunk) WITH ([n] bigint '$.n', [b] varchar(max) '$.b') AS j`,
        { file, chunk: JSON.stringify({ n, b: bytes.toBase64() }) },
      );
    });
    return { file, sha256 };
  }

  // Moves the staged chunks into the store, inside a commit, and makes the
  // store and its view when absent. CREATE VIEW must be the only statement
  // of its batch.
  async publish(connection: SqlServerConnection): Promise<void> {
    const [made] = await connection.query(
      `IF OBJECT_ID(@store, N'U') IS NULL CREATE TABLE ${this.qualifiedName} ${chunks};
       SELECT IIF(OBJECT_ID(@view, N'V') IS NULL, 0, 1) AS [made];`,
      { store: this.qualifiedName, view: this.view },
    );
    if (made?.made !== 1) {
      await connection.query(
        `CREATE VIEW ${this.view} AS SELECT [file], [n], [bytes] FROM ${this.qualifiedName}`,
      );
      await this.#descriptions.write(connection, 'VIEW', marts, this.#name);
    }
    await connection.query(
      `INSERT INTO ${this.qualifiedName} ([file], [n], [bytes]) SELECT [file], [n], [bytes] FROM ${this.#staged}; TRUNCATE TABLE ${this.#staged};`,
    );
  }

  async discard(connection: SqlServerConnection): Promise<void> {
    await connection.query(`TRUNCATE TABLE ${this.#staged}`);
  }

  async unstage(connection: SqlServerConnection): Promise<void> {
    await connection.query(`DROP TABLE IF EXISTS ${this.#staged}`);
  }

  // Called inside each commit, after the merge: chunks that no row of the
  // tables names, such as the chunks of a record that deduplication refused,
  // go. The tables are the target, its history, whose rows keep their files
  // for a reading as of a position before the commit that replaced them,
  // and, while a reload is open, its hidden target. Only a table that keeps
  // the column as a UNIQUEIDENTIFIER names a file.
  async prune(
    connection: SqlServerConnection,
    tables: readonly string[],
  ): Promise<void> {
    const kept: string[] = [];
    for (const table of tables)
      if (
        (await storedColumns(connection, { table })).some(
          ({ name, type }) =>
            name === this.column.name && type === 'uniqueidentifier',
        )
      )
        kept.push(
          `NOT EXISTS (SELECT 1 FROM ${table} AS [kept] WHERE [kept].${this.column.quotedName} = ${this.qualifiedName}.[file])`,
        );
    await connection.query(
      `IF OBJECT_ID(@store, N'U') IS NOT NULL DELETE FROM ${this.qualifiedName}${kept.length === 0 ? '' : ` WHERE ${kept.join(' AND ')}`}`,
      { store: this.qualifiedName },
    );
  }
}
