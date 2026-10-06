import type { Partition } from './partition.ts';
import type { KeyValue } from './source.ts';
import type { Stream } from './stream.ts';

// Accepted input: records (including deduplication no-ops) and deletions
// (including keys that were already absent).
export type WriteCount = {
  readonly count: number;
  readonly deleted: number;
};

// A target has one writer, as in Airbyte: an overwrite replaces the whole
// target and a snapshot deletes keys it once saw, so a second writer's rows
// would be lost. Clearing the target releases it.
export class TargetOwnedError extends TypeError {
  override name = 'TargetOwnedError';
  constructor(target: string, owner: string, writer: string) {
    super(
      `Target ${target} is written by ${owner}; ${writer} cannot write it. A target has one writer; clear the owning copy, or drop the target, to reassign it.`,
    );
  }
}

// What did not load: one partition, or the whole copy when partition is null.
export type LoadFailure = {
  readonly partition: Partition | null;
  readonly error: unknown;
};

// What a stage applies, in source order. A RESET of the whole stream opens a
// reload (see Stage.reloading). A RESET of one partition drops what the stage
// holds of it, and the next commit first empties that partition of the target.
export type WriteOperation =
  | { readonly type: 'RECORD'; readonly data: unknown }
  | {
      readonly type: 'DELETE';
      readonly key: Readonly<Record<string, KeyValue>>;
    }
  | { readonly type: 'RESET'; readonly partition: Partition | null };

// Scalar values in a target field, without exposing storage mechanisms.
export type FieldValues = (field: string) => AsyncIterable<unknown>;

// One stream's open load of its target. What is applied between two commits
// becomes durable and visible together, or not at all.
export type Stage = AsyncDisposable & {
  // The target holds none of the copy's earlier rows: this load creates it,
  // or reloads it from scratch, so the copy reloads from no checkpoint.
  readonly fresh: boolean;
  // A reload is open: commits go to a hidden target that readers cannot see
  // until complete() swaps it in, so a reload that fails resumes from its
  // checkpoints. It opens at prepare, for a restart, a resumed reload or a
  // stored target that no longer fits, or when a RESET of the whole stream
  // arrives.
  readonly reloading: boolean;
  // The stream ended without a failure: an open reload replaces the target.
  complete(): Promise<void>;
  // Current target values, excluding pending stage operations. Read while
  // holding the target's write lock, including after commit reacquires it.
  values: FieldValues;
  apply(operation: WriteOperation): Promise<void>;
  // Makes everything applied so far durable and visible.
  commit(): Promise<void>;
  // Drops everything applied since the last commit.
  discard(): Promise<void>;
};

// A destination's loading strategy for one stream; its Load prepares the
// stream's Stage.
export abstract class Writer {
  readonly stream: Stream;

  constructor(stream: Stream) {
    this.stream = stream;
  }

  // Empties the target and releases its owner, refusing another writer's target.
  // Acknowledges the committed result while holding the target's write lock.
  abstract clear(
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void>;
}
