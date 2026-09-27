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

// Resuming into a target that no longer exists would load only what changed
// since the checkpoint and silently lose the history before it.
export class TargetMissingError extends TypeError {
  override name = 'TargetMissingError';
  constructor(target: string, writer: string) {
    super(
      `Target ${target} was dropped, but ${writer} still has a checkpoint; clear the copy to reload it from scratch.`,
    );
  }
}

// What did not load: one partition, or the whole copy when partition is null.
export type LoadFailure = {
  readonly partition: Partition | null;
  readonly error: unknown;
};

// What a stage applies, in source order.
export type WriteOperation =
  | { readonly type: 'RECORD'; readonly data: unknown }
  | {
      readonly type: 'DELETE';
      readonly key: Readonly<Record<string, KeyValue>>;
    };

// One stream's open load of its target. What is applied between two commits
// becomes durable and visible together, or not at all.
export type Stage = AsyncDisposable & {
  apply(operation: WriteOperation): Promise<void>;
  // Makes everything applied so far durable and visible.
  commit(): Promise<void>;
  // Drops everything applied since the last commit.
  discard(): Promise<void>;
};

// A destination's loading strategy for one stream; its Load prepares the
// stream's Stage.
export abstract class Writer {
  constructor(readonly stream: Stream) {}

  // Empties the target and releases its owner, refusing another writer's target.
  abstract clear(writer: string): Promise<void>;
}
