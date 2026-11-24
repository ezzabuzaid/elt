import {
  type CopyConfiguration,
  type Deduplication,
  type DeleteOperation,
  deduplicationColumns,
} from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import type { EncodedValue, SqlServerColumn } from './sql-server-column.ts';
import { SqlServerColumns } from './sql-server-columns.ts';
import type { TargetHistory } from './sql-server-history.ts';
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
// key, and a deletion removes it. replace applies the operations of a commit
// in source order; cursor_newer applies the operation of each key whose
// cursor is greatest, and only when that cursor sorts after the stored row's
// (ADR 0032 of elt). Rows match by the key hash, so two keys that differ only
// in case stay two rows (ADR 0004).
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

  // The stage as one operation for each key. replace applies the operations
  // in source order: of the operations after the key's last deletion, the
  // newest record, so a restated fact overwrites the loaded one, or that
  // deletion when no record follows it; _elt_last is the place of the
  // deletion that a kept record follows. cursor_newer ranks the records and
  // deletions of a key together: the greatest cursor wins, the first on ties.
  #reduced(stage: string): string {
    const guard = this.#guard;
    if (guard !== undefined)
      return `SELECT [_elt_ranked].* FROM (
        SELECT [_elt_staged].*, ROW_NUMBER() OVER (PARTITION BY [_elt_staged].${keyHash} ORDER BY ${this.#ordered(guard, '[_elt_staged]')} DESC, [_elt_staged].${seq}) AS [_elt_rank]
        FROM ${stage} AS [_elt_staged]
      ) AS [_elt_ranked] WHERE [_elt_ranked].[_elt_rank] = 1`;
    return `SELECT [_elt_ranked].* FROM (
      SELECT [_elt_staged].*, [_elt_deleted].[_elt_last], ROW_NUMBER() OVER (PARTITION BY [_elt_staged].${keyHash} ORDER BY IIF([_elt_staged].${op} = 'R', 0, 1), [_elt_staged].${seq} DESC) AS [_elt_rank]
      FROM ${stage} AS [_elt_staged]
      LEFT JOIN (SELECT ${keyHash}, MAX(${seq}) AS [_elt_last] FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keyHash}) AS [_elt_deleted] ON [_elt_deleted].${keyHash} = [_elt_staged].${keyHash}
      WHERE [_elt_deleted].[_elt_last] IS NULL OR [_elt_staged].${seq} >= [_elt_deleted].[_elt_last]
    ) AS [_elt_ranked] WHERE [_elt_ranked].[_elt_rank] = 1`;
  }

  // The records that the reduced stage keeps, when a commit replaces the
  // target.
  protected override kept(stage: string): string {
    return `${seq} IN (SELECT [_elt_reduced].${seq} FROM (${this.#reduced(stage)}) AS [_elt_reduced] WHERE [_elt_reduced].${op} = 'R')`;
  }

  // One MERGE on the key hash, whose output the history keeps (ADR 0005).
  // Under replace, a deletion removes its row, and a record replaces the row
  // when a deletion came before it or when its values differ. Under
  // cursor_newer, the deletion or record that won its key changes the row
  // only when its cursor sorts after the row's, so a tie keeps the row and
  // out-of-order replay changes nothing (ADR 0032 of elt). Only a record
  // updates: a deletion that its guard refuses has null values and no row
  // hash, and must leave the row as it is. A record of a new key enters, and
  // a record with the stored row's values leaves the row, its commit and its
  // loaded_at as they are. A hidden target has no history: no reader saw its
  // rows.
  protected override async merge(
    connection: SqlServerConnection,
    stage: string,
    written: Written,
    into: string,
    history: TargetHistory | null,
  ): Promise<boolean> {
    const guard = this.#guard;
    const differs = `[_elt_new].${version} IS DISTINCT FROM [_elt_target].${version}`;
    const newer =
      guard === undefined
        ? undefined
        : `${this.#ordered(guard, '[_elt_new]')} > ${this.#ordered(guard, '[_elt_target]')}`;
    const deletes = newer === undefined ? '' : ` AND ${newer}`;
    const updates =
      newer === undefined
        ? `([_elt_new].[_elt_last] IS NOT NULL OR ${differs})`
        : `${differs} AND ${newer}`;
    const staged = this.staged('[_elt_new]');
    const parameters = writtenParameters(written);
    const merge = `MERGE ${into} AS [_elt_target]
       USING (${this.#reduced(stage)}) AS [_elt_new] ON [_elt_target].${keyHash} = [_elt_new].${keyHash}
       WHEN MATCHED AND [_elt_new].${op} = 'D'${deletes} THEN DELETE
       WHEN MATCHED AND [_elt_new].${op} = 'R' AND ${updates} THEN
         UPDATE SET ${this.written.flatMap((column, index) => (column === keyHash ? [] : [`${column} = ${staged[index]}`])).join(', ')}
       WHEN NOT MATCHED BY TARGET AND [_elt_new].${op} = 'R' THEN
         INSERT (${this.written.join(', ')}) VALUES (${staged.join(', ')})`;
    if (history === null) {
      const [merged] = await connection.query(
        `${merge};
         SELECT @@ROWCOUNT AS [rows];`,
        parameters,
      );
      return merged?.rows !== 0;
    }
    const kept = await history.keep(
      connection,
      written.committedIn,
      into,
      `${merge}
       OUTPUT deleted.*`,
      parameters,
    );
    if (kept > 0) return true;
    // A commit that kept no row changed one only if it inserted a key.
    const [inserted] = await connection.query(
      `SELECT IIF(EXISTS (SELECT 1 FROM ${stage} AS [_elt_staged] JOIN ${into} AS [_elt_target] ON [_elt_target].${keyHash} = [_elt_staged].${keyHash} WHERE [_elt_target].[committed_in] = CAST(@committed AS bigint)), 1, 0) AS [inserted]`,
      parameters,
    );
    return inserted?.inserted === 1;
  }

  protected override encode(record: unknown): EncodedValue[] {
    this.deduplication.key(record);
    if (this.cursor !== undefined) this.deduplication.cursor(record);
    return super.encode(record);
  }

  // A deletion stages its key, and under cursor_newer its cursor, which
  // ranks it with the records of its key and guards the stored row. Its
  // other columns are null.
  protected override deletionRow({
    key,
    cursor,
  }: DeleteOperation): EncodedValue[] {
    this.deduplication.key(key);
    const guard = this.#guard;
    if (guard === undefined)
      return this.table.columns.map((column) =>
        this.keys.includes(column) ? column.encode(key) : null,
      );
    const versioned = { ...key, [guard.field]: cursor };
    this.deduplication.cursor(versioned);
    return this.table.columns.map((column) =>
      column === guard || this.keys.includes(column)
        ? column.encode(versioned)
        : null,
    );
  }
}
