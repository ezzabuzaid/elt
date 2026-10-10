import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import type { FailureType, SyncStatus } from '@workspace/elt';

// How long a reader waits out a pass committing to the file.
const busyTimeout = 30_000;

// Opens a destination file for reading only, waiting while a pass commits. A
// pass killed mid-commit leaves a hot journal that only a writable connection
// rolls back, and until then every read-only open fails, so one writable read
// recovers it first.
export function readSQLite(path: string): DatabaseSync {
  if (existsSync(path)) {
    using recovery = new DatabaseSync(path, { timeout: busyTimeout });
    recovery.prepare('SELECT count(*) FROM sqlite_schema').get();
  }
  return new DatabaseSync(path, { readOnly: true, timeout: busyTimeout });
}

// running: begun and not yet ended, or left so by a process that was killed.
export type PassState = SyncStatus | 'running';

type Started = {
  readonly startedAt: string;
  readonly lastSucceededAt: string | null;
};

// Only a pass that ended has completedAt, only one that did not load
// completely has an error, and only one whose copies failed says whose the
// failure is to fix.
export type PassStatus =
  | (Started & {
      readonly state: 'running';
      readonly completedAt: null;
      readonly error: null;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'succeeded';
      readonly completedAt: string;
      readonly error: null;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'cancelled';
      readonly completedAt: string;
      readonly error: string;
      readonly failureType: null;
    })
  | (Started & {
      readonly state: 'partial' | 'failed';
      readonly completedAt: string;
      readonly error: string;
      readonly failureType: FailureType;
    });

export type StreamPassStatus = {
  readonly stream: string;
  readonly state: PassState;
  readonly lastSucceededAt: string | null;
};

// The latest pass of a SQLite destination file and each stream's latest
// outcome, as its sync history records them; null and empty until the history
// recorded a pass.
export function readPassStatus(path: string): {
  readonly pass: PassStatus | null;
  readonly streams: readonly StreamPassStatus[];
} {
  if (!existsSync(path)) return { pass: null, streams: [] };
  using data = readSQLite(path);
  const installed = data
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = 'sync_status'",
    )
    .get();
  if (installed === undefined) return { pass: null, streams: [] };
  const latest = data
    .prepare(
      'SELECT status, started_at, completed_at, error, failure_type, last_successful_sync_at FROM sync_status',
    )
    .get();
  return {
    pass:
      latest === undefined ? null : recorded(latest, passState(latest.status)),
    streams: data
      .prepare(
        'SELECT stream, status, last_successful_sync_at FROM stream_status ORDER BY stream',
      )
      .all()
      .map((row) => ({
        stream: String(row.stream),
        state: passState(row.status),
        lastSucceededAt: text(row.last_successful_sync_at),
      })),
  };
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
