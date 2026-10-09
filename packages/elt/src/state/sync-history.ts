import type { Connection } from '../core/connection.ts';
import {
  type Copy,
  type CopyOutcome,
  type CopyProgress,
  describeFailures,
} from '../core/copy.ts';
import type { ExtractionCoverage, FailureType } from '../core/source.ts';
import type { Target as DestinationTarget } from '../core/target.ts';

export type SyncStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled';

export type DeclaredCopy<Target extends DestinationTarget> = {
  readonly copy: Copy<Target>;
  readonly coverage: ExtractionCoverage;
};

// One pass as recorded: declared before its read, closed with what it loaded.
export type RecordedPass<Target extends DestinationTarget> = {
  // A live view of each copy, counted as Airbyte's SyncStatsTracker counts a
  // stream; nothing here persists it. Advisory: what it throws is ignored and
  // never changes what loads.
  progress?(progress: CopyProgress<Target>): void;
  finish(outcomes: readonly CopyOutcome<Target>[]): Promise<void>;
  // The pass produced no outcomes, so what it committed is unknown.
  fail(error: unknown, failureType: FailureType): Promise<void>;
};

// As Airbyte's platform keeps each connection's jobs and attempts apart from
// any connector, the orchestrator records every pass here. A pass is one
// connection's read over the copies it selected.
export abstract class SyncHistory<Target extends DestinationTarget> {
  // Refuses, without I/O, a connection this history cannot record.
  validate(_connection: Connection<Target>): void {}

  // Durable when it resolves, so a pass that never finishes stays visible as
  // unfinished rather than missing.
  abstract begin(
    connection: Connection<Target>,
    copies: readonly DeclaredCopy<Target>[],
  ): Promise<RecordedPass<Target>>;
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
