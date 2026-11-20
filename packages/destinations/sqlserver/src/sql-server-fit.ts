import type { StoredFit } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import type { SqlServerTable } from './sql-server-table.ts';

// A column's type as SqlServerColumn spells it, from sys.columns.
export const columnType = `LOWER(TYPE_NAME(c.[user_type_id])) + CASE
  WHEN TYPE_NAME(c.[user_type_id]) IN (N'nvarchar', N'nchar') THEN IIF(c.[max_length] = -1, N'(max)', CONCAT(N'(', c.[max_length] / 2, N')'))
  WHEN TYPE_NAME(c.[user_type_id]) IN (N'varchar', N'char', N'varbinary', N'binary') THEN IIF(c.[max_length] = -1, N'(max)', CONCAT(N'(', c.[max_length], N')'))
  WHEN TYPE_NAME(c.[user_type_id]) IN (N'decimal', N'numeric') THEN CONCAT(N'(', c.[precision], N',', c.[scale], N')')
  WHEN TYPE_NAME(c.[user_type_id]) IN (N'datetime2', N'datetimeoffset', N'time') THEN CONCAT(N'(', c.[scale], N')')
  ELSE N'' END`;

type StoredColumn = {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
};

// The columns a table stores, in order, with each one's type and whether it
// is NOT NULL; none when it does not exist. stage names a #temp table of the
// session, which tempdb keeps.
export async function storedColumns(
  connection: SqlServerConnection,
  relation: { readonly table: string } | { readonly stage: string },
): Promise<readonly StoredColumn[]> {
  const [catalog, object] =
    'table' in relation
      ? ['sys', relation.table]
      : ['tempdb.sys', `tempdb..${relation.stage}`];
  const rows = await connection.query(
    `SELECT c.[name], ${columnType} AS [type], CAST(c.[is_nullable] AS int) AS [nullable]
     FROM ${catalog}.columns AS c WHERE c.[object_id] = OBJECT_ID(@object) ORDER BY c.[column_id]`,
    { object },
  );
  return rows.map(({ name, type, nullable }) => ({
    name: String(name),
    type: String(type),
    required: nullable === 0,
  }));
}

// Whether a stored table has the columns, types and NOT NULL the stream
// needs, and the index of its key hash, which names the key that the stored
// hashes are of. The stage is built from the same column declarations, so
// SQL Server spells both alike.
export async function storedFit(
  connection: SqlServerConnection,
  target: SqlServerTable,
  {
    table,
    stage,
    keyIndex,
  }: { table: string; stage: string; keyIndex: string | null },
): Promise<StoredFit> {
  const stored = await storedColumns(connection, { table });
  if (stored.length === 0) return 'missing';
  const types = new Map(
    (await storedColumns(connection, { stage })).map(({ name, type }) => [
      name,
      type,
    ]),
  );
  const needed = [
    ...target.columns.map(
      (column) =>
        `${column.name} ${types.get(column.name)} ${column.isPrimaryKey}`,
    ),
    '_elt_row bigint true',
    'loaded_at datetimeoffset(3) true',
    'committed_in bigint true',
    '_elt_row_hash binary(32) false',
    ...(keyIndex === null ? [] : ['_elt_key_hash binary(32) true']),
  ];
  const has = stored.map(
    ({ name, type, required }) => `${name} ${type} ${required}`,
  );
  if (needed.sort().join('\0') !== has.sort().join('\0')) return 'stale';
  if (keyIndex === null) return 'fits';
  const [index] = await connection.query(
    'SELECT 1 AS [made] FROM sys.indexes WHERE [object_id] = OBJECT_ID(@table) AND [name] = @index',
    { table, index: keyIndex },
  );
  return index === undefined ? 'stale' : 'fits';
}
