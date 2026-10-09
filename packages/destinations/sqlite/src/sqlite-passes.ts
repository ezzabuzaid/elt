import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { type Key, Modes, Mutex, SqliteStore } from '@zukhruf/mutex';

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

// interrupted: recorded as running while no process runs a pass of the file,
// as when the process running it was killed.
export type PassState = SyncStatus | 'running' | 'interrupted';

type Started = {
  readonly startedAt: string;
  readonly lastSucceededAt: string | null;
};

// Only a pass that ended has completedAt, only one that did not load
// completely has an error, and only one whose copies failed says whose the
// failure is to fix.
export type PassStatus =
  | (Started & {
      readonly state: 'running' | 'interrupted';
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

// The passes of one SQLite destination file: one runs at a time, and its sync
// history tells readers how the latest one went.
export class SQLitePasses {
  readonly #path: string;
  readonly #pass: Key<'maybe'>;

  constructor(path: string) {
    this.#path = path;
    // A folder of the lock's own, beside the file.
    this.#pass = new Mutex(new SqliteStore(`${path}.locks`)).key('pass', {
      mode: Modes.skipIfBusy(),
    });
  }

  // Runs work as the file's one pass, or not at all while another holds it.
  run<T>(work: () => Promise<T>) {
    return this.#pass.run(work);
  }

  // Whether a process runs a pass of the file now.
  running(): Promise<boolean> {
    return this.#pass.isHeld();
  }

  // The latest pass and each stream's latest outcome; null and empty until
  // the file's sync history recorded a pass.
  async status(): Promise<{
    readonly pass: PassStatus | null;
    readonly streams: readonly StreamPassStatus[];
  }> {
    if (!existsSync(this.#path)) return { pass: null, streams: [] };
    const running = await this.running();
    using data = readSQLite(this.#path);
    const installed = data
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = 'sync_status'",
      )
      .get();
    if (installed === undefined) return { pass: null, streams: [] };
    const state = (status: SQLOutputValue | undefined): PassState => {
      const recorded = passState(status);
      return recorded === 'running' && !running ? 'interrupted' : recorded;
    };
    const latest = data
      .prepare(
        'SELECT status, started_at, completed_at, error, failure_type, last_successful_sync_at FROM sync_status',
      )
      .get();
    return {
      pass:
        latest === undefined ? null : recorded(latest, state(latest.status)),
      streams: data
        .prepare(
          'SELECT stream, status, last_successful_sync_at FROM stream_status ORDER BY stream',
        )
        .all()
        .map((row) => ({
          stream: String(row.stream),
          state: state(row.status),
          lastSucceededAt: text(row.last_successful_sync_at),
        })),
    };
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
  };
  switch (state) {
    case 'running':
    case 'interrupted':
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

function passState(
  status: SQLOutputValue | undefined,
): Exclude<PassState, 'interrupted'> {
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
