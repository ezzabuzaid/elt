import {
  type CopyConfiguration,
  type Deduplication,
  type KeyValue,
  deduplicationColumns,
} from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import type { EncodedValue, SqlServerColumn } from './sql-server-column.ts';
import { SqlServerColumns } from './sql-server-columns.ts';
import type { SqlServerTable } from './sql-server-table.ts';
import {
  SqlServerWriter,
  type Written,
  keyHash,
  op,
  seq,
  version,
  writtenParameters,
} from './sql-server-writer.ts';

// Keeps one row for each key of a stream: a record replaces the row of its
// key, and a deletion removes it, as if the operations of a commit applied one
// at a time. Rows match by the key hash, so two keys that differ only in case
// stay two rows (ADR 0004).
export class SqlServerDeduplicatingWriter extends SqlServerWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly SqlServerColumn[];
  readonly cursor?: SqlServerColumn;
  readonly #guard?: SqlServerColumn;

  constructor(
    configuration: CopyConfiguration,
    database: SqlServerDatabase,
    table: SqlServerTable,
    retention: Temporal.Duration,
  ) {
    super(configuration, database, table, retention);
    ({
      deduplication: this.deduplication,
      keys: this.keys,
      cursor: this.cursor,
      guard: this.#guard,
    } = deduplicationColumns(
      configuration,
      table.columns,
      SqlServerColumns.fromSchema(configuration.stream.jsonSchema),
      (column) => column.storageType,
    ));
  }

  protected override async inspect(
    connection: SqlServerConnection,
  ): Promise<void> {
    const tracked =
      this.cursor === undefined ? this.keys : [...this.keys, this.cursor];
    const nulls = await connection.query(
      `SELECT TOP (1) 1 AS [null] FROM ${this.qualifiedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(' OR ')}`,
    );
    if (nulls.length > 0)
      throw new TypeError(
        'Existing deduplication keys and cursors must be non-null',
      );
  }

  // The guard's value of the row alias, in the order the guard compares: a
  // text cursor by its UTF-8 bytes, as COLLATE "C" in Postgres (ADR 0005).
  #ordered(guard: SqlServerColumn, alias: string): string {
    const value = `${alias}.${guard.quotedName}`;
    return guard.storageType === 'nvarchar(max)'
      ? `CONVERT(varchar(max), ${value} COLLATE Latin1_General_100_BIN2_UTF8)`
      : value;
  }

  // The stage as one operation for each key: the operations after the key's
  // last deletion, or that deletion when no record follows it. replace keeps
  // the newest extraction, so a restated fact overwrites the loaded one;
  // cursor_newer keeps the greatest cursor, the first on ties. _elt_last is
  // the place of the deletion that a kept record follows.
  #reduced(stage: string): string {
    const guard = this.#guard;
    const order =
      guard === undefined
        ? `[_elt_staged].${seq} DESC`
        : `${this.#ordered(guard, '[_elt_staged]')} DESC, [_elt_staged].${seq}`;
    return `SELECT [_elt_ranked].* FROM (
      SELECT [_elt_staged].*, [_elt_deleted].[_elt_last], ROW_NUMBER() OVER (PARTITION BY [_elt_staged].${keyHash} ORDER BY IIF([_elt_staged].${op} = 'R', 0, 1), ${order}) AS [_elt_rank]
      FROM ${stage} AS [_elt_staged]
      LEFT JOIN (SELECT ${keyHash}, MAX(${seq}) AS [_elt_last] FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keyHash}) AS [_elt_deleted] ON [_elt_deleted].${keyHash} = [_elt_staged].${keyHash}
      WHERE [_elt_deleted].[_elt_last] IS NULL OR [_elt_staged].${seq} >= [_elt_deleted].[_elt_last]
    ) AS [_elt_ranked] WHERE [_elt_ranked].[_elt_rank] = 1`;
  }

  // One MERGE on the key hash, whose output the history keeps (ADR 0005): a
  // deletion removes its row; a record replaces the row when a deletion came
  // before it, or when its values differ and the guard, if any, lets it in,
  // which rejects out-of-order replay; and a record of a new key enters. A
  // record with the stored row's values leaves the row, its commit and its
  // loaded_at as they are.
  protected override async merge(
    connection: SqlServerConnection,
    stage: string,
    written: Written,
  ): Promise<boolean> {
    const guard = this.#guard;
    const guarded =
      guard === undefined
        ? ''
        : ` AND ${this.#ordered(guard, '[_elt_new]')} > ${this.#ordered(guard, '[_elt_target]')}`;
    const staged = this.staged('[_elt_new]');
    const parameters = writtenParameters(written);
    const kept = await this.history.keep(
      connection,
      written.committedIn,
      this.qualifiedName,
      `MERGE ${this.qualifiedName} AS [_elt_target]
       USING (${this.#reduced(stage)}) AS [_elt_new] ON [_elt_target].${keyHash} = [_elt_new].${keyHash}
       WHEN MATCHED AND [_elt_new].${op} = 'D' THEN DELETE
       WHEN MATCHED AND ([_elt_new].[_elt_last] IS NOT NULL OR ([_elt_new].${version} IS DISTINCT FROM [_elt_target].${version}${guarded})) THEN
         UPDATE SET ${this.written.flatMap((column, index) => (column === keyHash ? [] : [`${column} = ${staged[index]}`])).join(', ')}
       WHEN NOT MATCHED BY TARGET AND [_elt_new].${op} = 'R' THEN
         INSERT (${this.written.join(', ')}) VALUES (${staged.join(', ')})
       OUTPUT deleted.*`,
      parameters,
    );
    if (kept > 0) return true;
    // A commit that kept no row changed one only if it inserted a key.
    const [inserted] = await connection.query(
      `SELECT IIF(EXISTS (SELECT 1 FROM ${stage} AS [_elt_staged] JOIN ${this.qualifiedName} AS [_elt_target] ON [_elt_target].${keyHash} = [_elt_staged].${keyHash} WHERE [_elt_target].[committed_in] = CAST(@committed AS bigint)), 1, 0) AS [inserted]`,
      parameters,
    );
    return inserted?.inserted === 1;
  }

  protected override encode(record: unknown): EncodedValue[] {
    this.deduplication.key(record);
    if (this.cursor !== undefined) this.deduplication.cursor(record);
    return super.encode(record);
  }

  protected override deletionRow(
    key: Readonly<Record<string, KeyValue>>,
  ): EncodedValue[] {
    this.deduplication.key(key);
    return this.table.columns.map((column) =>
      this.keys.includes(column) ? column.encode(key) : null,
    );
  }
}
