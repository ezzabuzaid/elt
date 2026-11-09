import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import type { FailureType, SyncStatus } from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { syncHistory } from './sqlite-sync-history-schema.ts';

// running: begun and not yet ended, or left so by a process that was killed.
export type PassState = SyncStatus | 'running';

// currentAsOf is when everything the connector loaded last matched its
// upstream, as sync_status.current_as_of says.
type Started = {
  readonly startedAt: string;
  readonly lastSucceededAt: string | null;
  readonly currentAsOf: string | null;
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
  readonly currentAsOf: string | null;
};

// The latest pass of a SQLite destination file and each stream's latest
// outcome, as its sync history records them; null and empty until the history
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
    pass: first === undefined ? null : combined([first, ...others]),
    streams: data
      .prepare(
        'SELECT stream, status, last_successful_sync_at, current_as_of FROM stream_status ORDER BY stream',
      )
      .all()
      .map((row) => ({
        stream: String(row.stream),
        state: passState(row.status),
        lastSucceededAt: text(row.last_successful_sync_at),
        currentAsOf: text(row.current_as_of),
      })),
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

type Ended = Exclude<PassStatus, { readonly state: 'running' }>;

// The latest passes of the connections of one file as one pass, which is only
// as good as its worst connection: it runs while any of them runs, began when
// the first began, ended when the last ended, and is current only as of the
// least current. A failure of one connection makes the pass partial, not
// succeeded, and its error keeps the error of each connection that did not
// succeed, as Go's errors.Join does, one on each line.
function combined(passes: readonly [PassStatus, ...PassStatus[]]): PassStatus {
  const started = {
    startedAt: earliest(passes.map(({ startedAt }) => startedAt)),
    lastSucceededAt: earliestOfAll(
      passes.map(({ lastSucceededAt }) => lastSucceededAt),
    ),
    currentAsOf: earliestOfAll(passes.map(({ currentAsOf }) => currentAsOf)),
  };
  const ended = passes.filter(
    (pass): pass is Ended => pass.state !== 'running',
  );
  if (ended.length < passes.length)
    return {
      ...started,
      state: 'running',
      completedAt: null,
      error: null,
      failureType: null,
    };
  const completedAt = latest(ended.map(({ completedAt }) => completedAt));
  const error = ended
    .flatMap((pass) => (pass.error === null ? [] : [pass.error]))
    .join('\n');
  if (ended.some(({ state }) => state === 'cancelled'))
    return {
      ...started,
      state: 'cancelled',
      completedAt,
      error,
      failureType: null,
    };
  if (ended.every(({ state }) => state === 'succeeded'))
    return {
      ...started,
      state: 'succeeded',
      completedAt,
      error: null,
      failureType: null,
    };
  return {
    ...started,
    state: ended.every(({ state }) => state === 'failed')
      ? 'failed'
      : 'partial',
    completedAt,
    error,
    failureType: ended.some(({ failureType }) => failureType === 'config')
      ? 'config'
      : 'system',
  };
}

function earliest(instants: readonly string[]): string {
  return instants.reduce((first, next) =>
    Date.parse(next) < Date.parse(first) ? next : first,
  );
}

function latest(instants: readonly string[]): string {
  return instants.reduce((last, next) =>
    Date.parse(next) > Date.parse(last) ? next : last,
  );
}

// The earliest instant, or null when any of them is null.
function earliestOfAll(instants: readonly (string | null)[]): string | null {
  const known = instants.filter((instant) => instant !== null);
  return known.length < instants.length ? null : earliest(known);
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
