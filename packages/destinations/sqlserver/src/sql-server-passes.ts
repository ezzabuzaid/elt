import {
  type PassStatus,
  type StreamPassStatus,
  combinedPass,
  recordedPassStatus,
  recordedStreamStatus,
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import { type SqlServerLogin, connect } from './sql-server-connection.ts';
import { inMarts } from './sql-server-schemas.ts';

// The latest pass of each connection and each stream's latest outcome, as
// one result set: one statement reads one snapshot of the history when the
// database keeps row versions, and needs no SNAPSHOT transaction, which a
// database that keeps none refuses, though its history records why its
// loads failed.
const status = `SELECT * FROM (SELECT N'pass' AS [kind], CAST(NULL AS nvarchar(max)) AS [stream], [status], [started_at], [completed_at], [error], [failure_type], [last_successful_sync_at], [current_as_of]
  FROM ${inMarts('sync_status')}
  UNION ALL
  SELECT N'stream', s.[stream], s.[status], NULL, NULL,
    (SELECT STRING_AGG(e.[error], NCHAR(10)) WITHIN GROUP (ORDER BY CAST(f.[key] AS int))
      FROM ${inMarts('extraction_coverage')} AS c
      CROSS APPLY OPENJSON(c.[failures]) AS f
      CROSS APPLY OPENJSON(f.[value]) WITH ([error] nvarchar(max) '$.error') AS e
      WHERE c.[attempt_id] = s.[latest_attempt_id] AND c.[stream] = s.[stream]),
    NULL, s.[last_successful_sync_at], s.[current_as_of]
  FROM ${inMarts('stream_status')} AS s) AS [status]
  ORDER BY [kind], [stream] COLLATE Latin1_General_100_BIN2`;

// The latest pass of the connections that the sync history of a database
// records, and each stream's latest outcome, with the errors of its failures
// in that attempt, one on each line; null and empty until the history
// recorded a pass, also while no history is installed (error 208, an
// invalid object name). The latest passes of several connections read as
// one pass, as in elt-postgresql.
export async function readPassStatus(login: SqlServerLogin): Promise<{
  readonly pass: PassStatus | null;
  readonly streams: readonly StreamPassStatus[];
}> {
  await using connection = await connect(
    new SqlServerDatabase(login),
    globalThis,
  );
  let rows;
  try {
    rows = await connection.query(status);
  } catch (error) {
    if (Object(error).number === 208) return { pass: null, streams: [] };
    throw error;
  }
  const [first, ...others] = rows
    .filter(({ kind }) => kind === 'pass')
    .map((row) =>
      recordedPassStatus({
        status: row.status,
        startedAt: instant(row.started_at),
        completedAt: optionalInstant(row.completed_at),
        error: row.error,
        failureType: row.failure_type,
        lastSucceededAt: optionalInstant(row.last_successful_sync_at),
        currentAsOf: optionalInstant(row.current_as_of),
      }),
    );
  return {
    pass: first === undefined ? null : combinedPass([first, ...others]),
    streams: rows
      .filter(({ kind }) => kind === 'stream')
      .map((row) =>
        recordedStreamStatus({
          stream: row.stream,
          status: row.status,
          error: row.error,
          lastSucceededAt: optionalInstant(row.last_successful_sync_at),
          currentAsOf: optionalInstant(row.current_as_of),
        }),
      ),
  };
}

// A datetimeoffset as the ISO text that elt-sqlite stores and gives.
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`A sync history view gave ${String(value)} for a time`);
}

function optionalInstant(value: unknown): string | null {
  return value === null ? null : instant(value);
}
