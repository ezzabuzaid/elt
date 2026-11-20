import type postgres from 'postgres';

import {
  type FailureType,
  type PassState,
  type PassStatus,
  type StreamPassStatus,
  combinedPass,
} from '@eltjs/elt';

import { inMarts } from './postgres-schemas.ts';
import { PostgresSession } from './postgres-session.ts';

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
            FROM ${sql.unsafe(inMarts('sync_status'))}`
        ).map((row) => recorded(row, passState(row.status)));
        const streams = await streamOutcomes(sql);
        return {
          pass: first === undefined ? null : combinedPass([first, ...others]),
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
        FROM ${sql.unsafe(inMarts('extraction_coverage'))} c,
          jsonb_array_elements(c.failures) WITH ORDINALITY f
        WHERE c.attempt_id = s.latest_attempt_id AND c.stream = s.stream) AS error
    FROM ${sql.unsafe(inMarts('stream_status'))} s ORDER BY s.stream COLLATE "C"`;
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
