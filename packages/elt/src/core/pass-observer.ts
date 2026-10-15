import type { Connection } from './connection.ts';
import type { CopyOutcome, CopyProgress } from './copy.ts';
import type { FailureType } from './source.ts';
import type { Target as DestinationTarget } from './target.ts';

// Sees each pass while it runs, as a terminal shows a sync. Advisory: the
// pipeline never waits for it, and what it throws is ignored and never changes
// what loads or what the sync history records.
export type PassObserver<Target extends DestinationTarget> = {
  begin(connection: Connection<Target>): ObservedPass<Target>;
};

// One pass as observed, each step once its sync history recorded it.
export type ObservedPass<Target extends DestinationTarget> = {
  // A live view of each copy, counted as Airbyte's SyncStatsTracker counts a
  // stream; nothing persists it.
  progress(progress: CopyProgress<Target>): void;
  finish(outcomes: readonly CopyOutcome<Target>[]): void;
  // The pass produced no outcomes, such as an invalid connection or a watcher
  // that stopped.
  fail(error: unknown, failureType: FailureType): void;
};
