import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import {
  type FailureType,
  type PassState,
  type PassStatus,
  type StreamPassStatus,
  combinedPass,
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
    .map((row) => recorded(row, passState(row.status)));
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
      .map((row) => streamRecorded(row, passState(row.status))),
  };
}

// A stream_status row as the stream's latest outcome: only a copy that
// failed has an error.
function streamRecorded(
  row: Record<string, SQLOutputValue>,
  state: PassState,
): StreamPassStatus {
  const outcome = {
    stream: String(row.stream),
    lastSucceededAt: text(row.last_successful_sync_at),
    currentAsOf: text(row.current_as_of),
  };
  switch (state) {
    case 'partial':
    case 'failed':
      return { ...outcome, state, error: String(row.error) };
    default:
      return { ...outcome, state, error: null };
  }
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

// A sync_status row as the pass it records: the history completes every pass
// that ended, and gives an error to each that did not load completely.
function recorded(
  row: Record<string, SQLOutputValue>,
  state: PassState,
): PassStatus {
  const started = {
    startedAt: String(row.started_at),
    lastSucceededAt: text(row.last_successful_sync_at),
    currentAsOf: text(row.current_as_of),
  };
  switch (state) {
    case 'running':
      return {
        ...started,
        state,
        completedAt: null,
        error: null,
        failureType: null,
      };
    case 'succeeded':
      return {
        ...started,
        state,
        completedAt: String(row.completed_at),
        error: null,
        failureType: null,
      };
    case 'cancelled':
      return {
        ...started,
        state,
        completedAt: String(row.completed_at),
        error: String(row.error),
        failureType: null,
      };
    default:
      return {
        ...started,
        state,
        completedAt: String(row.completed_at),
        error: String(row.error),
        failureType: failureType(row.failure_type),
      };
  }
}

function failureType(value: SQLOutputValue | undefined): FailureType {
  switch (value) {
    case 'config':
    case 'system':
      return value;
    default:
      throw new TypeError(`Unknown failure type ${String(value)}`);
  }
}

function passState(status: SQLOutputValue | undefined): PassState {
  switch (status) {
    case 'running':
    case 'succeeded':
    case 'partial':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      throw new TypeError(`Unknown pass status ${String(status)}`);
  }
}

function text(value: SQLOutputValue | undefined): string | null {
  if (value === undefined)
    throw new TypeError('A sync history view lacks a column it declares');
  return value === null ? null : String(value);
}
