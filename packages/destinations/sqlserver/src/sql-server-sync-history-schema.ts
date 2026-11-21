import { readerCatalog, syncHistoryRelations } from '@eltjs/elt';

import { derivedStatusTable } from './sql-server-derived-status.ts';
import { columnType } from './sql-server-fit.ts';
import { now, position } from './sql-server-reader-view.ts';
import { inWarehouse, marts, warehouse } from './sql-server-schemas.ts';
import type { SqlServerView } from './sql-server-views.ts';

// The tables of the history in _warehouse.
export const attempts = inWarehouse('sync_attempts');
export const coverage = inWarehouse('extraction_coverage');
export const checks = inWarehouse('stream_checks');
const derivedStatus = inWarehouse('derived_status');

// A name of a connection or a stream compares by its code points, as in
// Postgres. A key of text of any length is unique by its SHA-256 (ADR 0004).
const name = 'nvarchar(max) COLLATE Latin1_General_100_BIN2';
const keyOf = (column: string) =>
  `CAST(HASHBYTES('SHA2_256', [${column}]) AS binary(32)) PERSISTED NOT NULL`;
const statuses = `(N'running', N'succeeded', N'partial', N'failed', N'cancelled')`;

export const syncHistoryTables = `
  IF SCHEMA_ID(N'${warehouse}') IS NULL EXEC (N'CREATE SCHEMA [${warehouse}]');
  IF OBJECT_ID(N'${attempts}', N'U') IS NULL
    CREATE TABLE ${attempts} (
      [id] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY,
      [connector] ${name} NOT NULL CHECK (TRIM([connector]) <> N''), [source] nvarchar(max) NOT NULL,
      [started_at] datetimeoffset(3) NOT NULL, [completed_at] datetimeoffset(3) NULL,
      [status] nvarchar(20) NOT NULL DEFAULT N'running' CHECK ([status] IN ${statuses}),
      [error] nvarchar(max) NULL,
      [failure_type] nvarchar(20) NULL CHECK ([failure_type] IN (N'config', N'system')),
      CHECK (([status] = N'running' AND [completed_at] IS NULL) OR ([status] <> N'running' AND [completed_at] IS NOT NULL)),
      CHECK (([status] IN (N'partial', N'failed') AND [failure_type] IS NOT NULL) OR ([status] NOT IN (N'partial', N'failed') AND [failure_type] IS NULL)));
  IF OBJECT_ID(N'${coverage}', N'U') IS NULL
    CREATE TABLE ${coverage} (
      [attempt_id] bigint NOT NULL REFERENCES ${attempts} ([id]),
      [stream] ${name} NOT NULL, [stream_key] AS ${keyOf('stream')}, [target_table] nvarchar(128) NOT NULL,
      [sync_mode] nvarchar(20) NOT NULL, [destination_sync_mode] nvarchar(20) NOT NULL,
      [description] nvarchar(max) NOT NULL CHECK (TRIM([description]) <> N''), [selection] json NOT NULL,
      [status] nvarchar(20) NOT NULL DEFAULT N'running' CHECK ([status] IN ${statuses}),
      [written_count] bigint NULL CHECK ([written_count] >= 0), [deleted_count] bigint NULL CHECK ([deleted_count] >= 0),
      [failures] json NOT NULL DEFAULT N'[]', [upstream_current_as_of] datetimeoffset(3) NULL,
      PRIMARY KEY ([attempt_id], [stream_key]));
  IF OBJECT_ID(N'${checks}', N'U') IS NULL
    CREATE TABLE ${checks} (
      [connector] ${name} NOT NULL, [connector_key] AS ${keyOf('connector')},
      [stream] ${name} NOT NULL, [stream_key] AS ${keyOf('stream')},
      [checked_at] datetimeoffset(3) NOT NULL,
      PRIMARY KEY ([connector_key], [stream_key]));
  ${derivedStatusTable}`;

// When connector's stream last matched its upstream: the start of its last
// successful pass, or a later check that found it unchanged, each no later
// than when the source said the upstream itself was last current. NULL if it
// never succeeded. LEAST and GREATEST skip NULLs.
const currentAsOf = (connector: string, stream: string) => `(
  SELECT CASE WHEN success.[id] IS NULL THEN NULL ELSE GREATEST(LEAST(success.[started_at], success.[upstream_current_as_of]), k.[checked_at]) END
  FROM (SELECT 1 AS [one]) AS one
  OUTER APPLY (
    SELECT TOP (1) s.[id], s.[started_at], sc.[upstream_current_as_of] FROM ${coverage} AS sc
    JOIN ${attempts} AS s ON s.[id] = sc.[attempt_id]
    WHERE s.[connector] = ${connector} AND sc.[stream] = ${stream} AND sc.[status] = N'succeeded'
    ORDER BY s.[completed_at] DESC, s.[id] DESC
  ) AS success
  LEFT JOIN ${checks} AS k ON k.[connector] = ${connector} AND k.[stream] = ${stream})`;

const lastSuccess = (connector: string) => `OUTER APPLY (
  SELECT TOP (1) [id], [completed_at] FROM ${attempts}
  WHERE [connector] = ${connector} AND [status] = N'succeeded'
  ORDER BY [completed_at] DESC, [id] DESC) AS success`;

const queries: Readonly<Record<keyof typeof syncHistoryRelations, string>> = {
  sync_attempts: `SELECT [id] AS [attempt_id], [connector], [source], [started_at], [completed_at], [status], [error], [failure_type] FROM ${attempts}`,
  extraction_coverage: `SELECT c.[attempt_id], a.[connector], a.[source], a.[started_at], a.[completed_at],
    c.[stream], c.[target_table],
    CAST(IIF(OBJECT_ID(QUOTENAME(N'${marts}') + N'.' + QUOTENAME(c.[target_table]), N'V') IS NULL, 0, 1) AS bit) AS [target_exists],
    c.[sync_mode], c.[destination_sync_mode], c.[description], c.[selection],
    c.[status], c.[written_count], c.[deleted_count], c.[failures]
    FROM ${coverage} AS c JOIN ${attempts} AS a ON a.[id] = c.[attempt_id]`,
  sync_status: `SELECT a.[connector],
    a.[id] AS [latest_attempt_id], a.[started_at], a.[completed_at], a.[status], a.[error], a.[failure_type],
    success.[id] AS [last_successful_attempt_id], success.[completed_at] AS [last_successful_sync_at],
    (SELECT CASE WHEN COUNT(*) = COUNT(streams.[current_as_of]) THEN MIN(streams.[current_as_of]) END
      FROM (SELECT ${currentAsOf('a.[connector]', 'd.[stream]')} AS [current_as_of]
        FROM (SELECT DISTINCT dc.[stream] FROM ${coverage} AS dc
          JOIN ${attempts} AS da ON da.[id] = dc.[attempt_id]
          WHERE da.[connector] = a.[connector]) AS d) AS streams) AS [current_as_of]
    FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY [connector] ORDER BY [id] DESC) AS [latest] FROM ${attempts}) AS a
    ${lastSuccess('a.[connector]')}
    WHERE a.[latest] = 1`,
  stream_status: `SELECT a.[connector], c.[stream], c.[target_table],
    a.[id] AS [latest_attempt_id], a.[started_at], a.[completed_at], c.[status],
    success.[id] AS [last_successful_attempt_id], success.[completed_at] AS [last_successful_sync_at],
    ${currentAsOf('a.[connector]', 'c.[stream]')} AS [current_as_of]
    FROM (SELECT cc.*, ROW_NUMBER() OVER (PARTITION BY ca.[connector], cc.[stream] ORDER BY ca.[id] DESC) AS [latest]
      FROM ${coverage} AS cc JOIN ${attempts} AS ca ON ca.[id] = cc.[attempt_id]) AS c
    JOIN ${attempts} AS a ON a.[id] = c.[attempt_id]
    OUTER APPLY (
      SELECT TOP (1) s.[id], s.[completed_at] FROM ${coverage} AS sc
      JOIN ${attempts} AS s ON s.[id] = sc.[attempt_id]
      WHERE s.[connector] = a.[connector] AND sc.[stream] = c.[stream] AND sc.[status] = N'succeeded'
      ORDER BY s.[completed_at] DESC, s.[id] DESC) AS success
    WHERE c.[latest] = 1`,
  derived_status: `SELECT [dataset], [kind], [state], [as_of], [refreshed_at], [refreshing_since], [error], [inputs], [computed], [empty], [failed], [pending] FROM ${derivedStatus}`,
};

// How readers see the sync history: what each pass declared and loaded.
// The sync history keeps no row versions, so a session that reads as of a
// position before now fails each of its views. A view cannot raise an
// error, so the condition converts the reason to int, which fails with
// error 245 and the reason in its message, also over no rows.
export const syncHistoryViews: readonly SqlServerView[] = Object.values(
  syncHistoryRelations,
).map((relation) => ({
  ...relation,
  query: `SELECT * FROM (${queries[relation.name]}) AS [history] WHERE 1 = IIF(${position} = ${now}, 1, CAST(N'The sync history cannot be read as of a position: it keeps no row versions' AS int))`,
}));

// Lists what readers of marts query, its views and its inline table-valued
// functions, such as the search of a vector index (ADR 0014), from the
// descriptions every load and publication writes there.
export const catalog: SqlServerView = {
  ...readerCatalog,
  description: `${readerCatalog.description} A function, such as the search of a vector index, is listed with each of its parameters and each column that it gives.`,
  columns: {
    ...readerCatalog.columns,
    kind: 'view, function, parameter or column.',
    name: 'Relation name, relation.column, or function.@parameter.',
  },
  query: `SELECT IIF(o.[type] = N'V', N'view', N'function') AS [kind], o.[name] AS [name], CAST(NULL AS nvarchar(max)) AS [data_type], CAST(ep.[value] AS nvarchar(max)) AS [description]
    FROM sys.objects AS o
    LEFT JOIN sys.extended_properties AS ep ON ep.[class] = 1 AND ep.[major_id] = o.[object_id] AND ep.[minor_id] = 0 AND ep.[name] = N'MS_Description'
    WHERE o.[schema_id] = SCHEMA_ID(N'${marts}') AND o.[type] IN (N'V', N'IF')
    UNION ALL
    SELECT N'column', o.[name] + N'.' + c.[name], ${columnType}, CAST(ep.[value] AS nvarchar(max))
    FROM sys.objects AS o
    JOIN sys.columns AS c ON c.[object_id] = o.[object_id]
    LEFT JOIN sys.extended_properties AS ep ON ep.[class] = 1 AND ep.[major_id] = o.[object_id] AND ep.[minor_id] = c.[column_id] AND ep.[name] = N'MS_Description'
    WHERE o.[schema_id] = SCHEMA_ID(N'${marts}') AND o.[type] IN (N'V', N'IF')
    UNION ALL
    SELECT N'parameter', o.[name] + N'.' + c.[name], ${columnType}, CAST(NULL AS nvarchar(max))
    FROM sys.objects AS o
    JOIN sys.parameters AS c ON c.[object_id] = o.[object_id]
    WHERE o.[schema_id] = SCHEMA_ID(N'${marts}') AND o.[type] = N'IF'`,
};
