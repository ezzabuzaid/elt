import type postgres from 'postgres';

import type { FailureType, SyncStatus } from '@eltjs/elt';

import { PostgresSession } from './postgres-session.ts';

// running: begun and not yet ended. A pass whose process stopped shows so
// until the next attempt of its connection begins (ADR 0009).
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

// Only a stream whose copies failed in its latest attempt has an error.
export type StreamPassStatus = {
  readonly stream: string;
  readonly lastSucceededAt: string | null;
  readonly currentAsOf: string | null;
} & (
  | {
      readonly state: 'running' | 'succeeded' | 'cancelled';
      readonly error: null;
    }
  | { readonly state: 'partial' | 'failed'; readonly error: string }
);

type Row = Record<string, unknown>;

// The latest pass of the connections that the sync history of a database
// records, and each stream's latest outcome, with the errors of its failures
// in that attempt, one on each line; null and empty until the history
// recorded a pass, also while no history is installed. The latest passes of
// several connections read as one pass, as the passes of a SQLite file that
// several connections load do. One snapshot reads both.
export async function readPassStatus(url: string): Promise<{
  readonly pass: PassStatus | null;
  readonly streams: readonly StreamPassStatus[];
}> {
  await using session = new PostgresSession(url, 'elt-pass-status');
  try {
    return await session.sql.begin(
      'ISOLATION LEVEL REPEATABLE READ READ ONLY',
      async (sql) => {
        const [first, ...others] = (
          await sql<Row[]>`
            SELECT status, started_at, completed_at, error, failure_type,
              last_successful_sync_at, current_as_of
            FROM marts.sync_status`
        ).map((row) => recorded(row, passState(row.status)));
        const streams = await streamOutcomes(sql);
        return {
          pass: first === undefined ? null : combined([first, ...others]),
          streams,
        };
      },
    );
  } catch (error) {
    if (Object(error).code === '42P01') return { pass: null, streams: [] };
    throw error;
  }
}

async function streamOutcomes(
  sql: postgres.TransactionSql,
): Promise<StreamPassStatus[]> {
  const rows = await sql<Row[]>`
    SELECT s.stream, s.status, s.last_successful_sync_at, s.current_as_of,
      (SELECT string_agg(f.value->>'error', E'\n' ORDER BY f.ordinality)
        FROM marts.extraction_coverage c,
          jsonb_array_elements(c.failures) WITH ORDINALITY f
        WHERE c.attempt_id = s.latest_attempt_id AND c.stream = s.stream) AS error
    FROM marts.stream_status s ORDER BY s.stream COLLATE "C"`;
  return rows.map((row) => streamRecorded(row, passState(row.status)));
}

// A stream_status row as the stream's latest outcome: only a copy that
// failed has an error.
function streamRecorded(row: Row, state: PassState): StreamPassStatus {
  const outcome = {
    stream: String(row.stream),
    lastSucceededAt: optionalInstant(row.last_successful_sync_at),
    currentAsOf: optionalInstant(row.current_as_of),
  };
  switch (state) {
    case 'partial':
    case 'failed':
      return { ...outcome, state, error: String(row.error) };
    default:
      return { ...outcome, state, error: null };
  }
}

// A sync_status row as the pass it records: the history completes every pass
// that ended, and gives an error to each that did not load completely.
function recorded(row: Row, state: PassState): PassStatus {
  const started = {
    startedAt: instant(row.started_at),
    lastSucceededAt: optionalInstant(row.last_successful_sync_at),
    currentAsOf: optionalInstant(row.current_as_of),
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
        completedAt: instant(row.completed_at),
        error: null,
        failureType: null,
      };
    case 'cancelled':
      return {
        ...started,
        state,
        completedAt: instant(row.completed_at),
        error: String(row.error),
        failureType: null,
      };
    default:
      return {
        ...started,
        state,
        completedAt: instant(row.completed_at),
        error: String(row.error),
        failureType: failureType(row.failure_type),
      };
  }
}

type Ended = Exclude<PassStatus, { readonly state: 'running' }>;

// The latest passes of the connections of one database as one pass, which
// is only as good as its worst connection: it runs while any of them runs,
// began when the first began, ended when the last ended, and is current only
// as of the least current. A failure of one connection makes the pass
// partial, not succeeded, and its error keeps the error of each connection
// that did not succeed, as Go's errors.Join does, one on each line.
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

// A timestamptz as the ISO text that elt-sqlite stores and gives.
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`A sync history view gave ${String(value)} for a time`);
}

function optionalInstant(value: unknown): string | null {
  return value === null ? null : instant(value);
}

function failureType(value: unknown): FailureType {
  switch (value) {
    case 'config':
    case 'system':
      return value;
    default:
      throw new TypeError(`Unknown failure type ${String(value)}`);
  }
}

function passState(value: unknown): PassState {
  switch (value) {
    case 'running':
    case 'succeeded':
    case 'partial':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      throw new TypeError(`Unknown pass status ${String(value)}`);
  }
}
