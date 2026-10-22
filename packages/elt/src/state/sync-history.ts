import { inspect } from 'node:util';

import type { Connection } from '../core/connection.ts';
import { type Copy, type CopyOutcome, describeFailures } from '../core/copy.ts';
import type { ExtractionCoverage, FailureType } from '../core/source.ts';
import type { Target as DestinationTarget } from '../core/target.ts';
import type { LoadFailure } from '../core/writer.ts';

export type SyncStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled';

export type DeclaredCopy<Target extends DestinationTarget> = {
  readonly copy: Copy<Target>;
  readonly coverage: ExtractionCoverage;
};

// A stream a check found unchanged: current as of the check, or as of
// earlier when its source says its upstream was current only then.
export type StreamCheck = { readonly stream: string; readonly at: Date };

// One pass as recorded: declared before its read, closed with what it loaded.
// upstream holds, by stream, when its source said its upstream was last
// current; a stream it does not hold was read from a live upstream.
export type RecordedPass<Target extends DestinationTarget> = {
  finish(
    outcomes: readonly CopyOutcome<Target>[],
    upstream: ReadonlyMap<string, Date>,
  ): Promise<void>;
  // The pass produced no outcomes, so what it committed is unknown.
  fail(error: unknown, failureType: FailureType): Promise<void>;
};

// How often a history records the checks that found a connection's streams
// unchanged. A source checks about every second; a reader needs
// current_as_of only to about a minute, and every record is a write.
const checkRecordMs = 60_000;

// As Airbyte's platform keeps each connection's jobs and attempts apart from
// any connector, the orchestrator records every pass here. A pass is one
// connection's read over the copies it selected.
export abstract class SyncHistory<Target extends DestinationTarget> {
  // When each connection's checks were last recorded.
  readonly #checkedAt = new Map<string, number>();

  // Refuses, without I/O, a connection this history cannot record.
  validate(_connection: Connection<Target>): void {}

  // Durable when it resolves, so a pass that never finishes stays visible as
  // unfinished rather than missing.
  abstract begin(
    connection: Connection<Target>,
    copies: readonly DeclaredCopy<Target>[],
  ): Promise<RecordedPass<Target>>;

  // At that moment a watch's source checked its streams and found them
  // unchanged since their last copy loaded, so readers see them current as of
  // then though no pass read them, as a Debezium heartbeat moves a connector's
  // position with no change to carry. A connection's first check is recorded
  // at once, and the next at most once a minute; current gives the streams
  // to record only then, since asking a source can cost a process call.
  async checked(
    connection: Connection<Target>,
    at: Date,
    current: (at: Date) => Promise<readonly StreamCheck[]>,
  ): Promise<void> {
    const last = this.#checkedAt.get(connection.name);
    if (last !== undefined && at.getTime() - last < checkRecordMs) return;
    this.#checkedAt.set(connection.name, at.getTime());
    await this.recordChecks(connection, await current(at));
  }

  // Durable when it resolves.
  protected abstract recordChecks(
    connection: Connection<Target>,
    checks: readonly StreamCheck[],
  ): Promise<void>;
}

// A failure as a history records it in a copy's failures. stacktrace is the
// error as Node renders it, with its stack and every cause it chains, such as
// the code of a refused connection behind "fetch failed", as Airbyte keeps a
// FailureReason's stacktrace beside its message.
export function recordedFailure({
  partition,
  error,
  failureType,
}: LoadFailure) {
  return {
    partition,
    error: error instanceof Error ? error.message : String(error),
    failure_type: failureType,
    stacktrace: inspect(error),
  };
}

export function copyStatus({
  count,
  deleted,
  failures,
  cancelled,
}: CopyOutcome<DestinationTarget>): SyncStatus {
  if (cancelled) return 'cancelled';
  if (failures.length === 0) return 'succeeded';
  return count + deleted > 0 ? 'partial' : 'failed';
}

export function passStatus(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): SyncStatus {
  if (outcomes.some(({ cancelled }) => cancelled)) return 'cancelled';
  if (outcomes.every(({ failures }) => failures.length === 0))
    return 'succeeded';
  return outcomes.some((outcome) => copyStatus(outcome) !== 'failed')
    ? 'partial'
    : 'failed';
}

// Whose a pass's failures are to fix: config when any one is the user's, null
// when nothing failed or the run was stopped on request.
export function passFailureType(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): FailureType | null {
  const status = passStatus(outcomes);
  if (status === 'succeeded' || status === 'cancelled') return null;
  return outcomes.some(({ failures }) =>
    failures.some(({ failureType }) => failureType === 'config'),
  )
    ? 'config'
    : 'system';
}

// What did not load in a pass, or null when every copy loaded completely.
export function passError(
  outcomes: readonly CopyOutcome<DestinationTarget>[],
): string | null {
  const incomplete = outcomes.filter(({ failures }) => failures.length > 0);
  if (incomplete.length === 0) return null;
  return `The following copies did not load completely: ${incomplete.map(describeFailures).join('; ')}`;
}
