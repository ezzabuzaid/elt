import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import {
  type PassStatus,
  type StreamPassStatus,
  combinedPass,
  recordedPassStatus,
  recordedStreamStatus,
} from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { syncHistory } from './sqlite-sync-history-schema.ts';

// The latest pass of a SQLite destination file and each stream's latest
// outcome, with the errors of its failures in that attempt, one on each line,
// as its sync history records them; null and empty until the history
// recorded a pass, and while the history in the file is one another version
// installed, and while no file is at the path. A file that several
// connections load reads as one pass, made of the latest pass of each
// connection.
export function readPassStatus(path: string): {
  readonly pass: PassStatus | null;
  readonly streams: readonly StreamPassStatus[];
} {
  using data = reader(path);
  if (data === null || syncHistory.drift(data) !== 'fits')
    return { pass: null, streams: [] };
  const [first, ...others] = data
    .prepare(
      'SELECT status, started_at, completed_at, error, failure_type, last_successful_sync_at, current_as_of FROM sync_status',
    )
    .all()
    .map((row) =>
      recordedPassStatus({
        status: row.status,
        startedAt: String(row.started_at),
        completedAt: text(row.completed_at),
        error: row.error,
        failureType: row.failure_type,
        lastSucceededAt: text(row.last_successful_sync_at),
        currentAsOf: text(row.current_as_of),
      }),
    );
  return {
    pass: first === undefined ? null : combinedPass([first, ...others]),
    streams: data
      .prepare(
        `SELECT s.stream, s.status, s.last_successful_sync_at, s.current_as_of,
          (SELECT group_concat(json_extract(f.value, '$.error'), char(10) ORDER BY f.key)
            FROM extraction_coverage c, json_each(c.failures) f
            WHERE c.attempt_id = s.latest_attempt_id AND c.stream = s.stream) AS error
        FROM stream_status s ORDER BY s.stream`,
      )
      .all()
      .map((row) =>
        recordedStreamStatus({
          stream: row.stream,
          status: row.status,
          error: row.error,
          lastSucceededAt: text(row.last_successful_sync_at),
          currentAsOf: text(row.current_as_of),
        }),
      ),
  };
}

// A reader of the file, or null while no file is at the path.
function reader(path: string): DatabaseSync | null {
  try {
    return open(path, { readOnly: true, timeout: busyTimeout });
  } catch (error) {
    if (error instanceof UnavailableError) return null;
    throw error;
  }
}

function text(value: SQLOutputValue | undefined): string | null {
  if (value === undefined)
    throw new TypeError('A sync history view lacks a column it declares');
  return value === null ? null : String(value);
}
