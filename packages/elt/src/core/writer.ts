import { isDeepStrictEqual } from 'node:util';
import type { Partition } from './partition.ts';
import { type KeyValue, ReadFailure, type ReadMessage } from './source.ts';
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

// count and deleted are what the destination committed.
export type WriteResult = WriteCount & {
  readonly failures: readonly LoadFailure[];
};

// What a writer applies, in source order.
export type WriteOperation =
  | { readonly type: 'RECORD'; readonly data: unknown }
  | {
      readonly type: 'DELETE';
      readonly key: Readonly<Record<string, KeyValue>>;
    };

export type WriteOptions = {
  // Names the copy across runs; the target refuses any other writer.
  readonly writer: string;
  // The copy continues from a saved checkpoint, so its target must exist.
  readonly resuming: boolean;
  // Called with each checkpoint once everything before it is committed.
  readonly acknowledge: (state: unknown) => Promise<void>;
};

// One open load of a target. What is applied between two commits becomes
// durable and visible together, or not at all.
export type Load = AsyncDisposable & {
  apply(operation: WriteOperation): Promise<void>;
  // Makes everything applied so far durable and visible.
  commit(): Promise<void>;
  // Drops everything applied since the last commit.
  discard(): Promise<void>;
};

// A destination's loading strategy. As in Airbyte, a checkpoint is a commit
// point: the writer acknowledges it only after the rows before it are durable,
// and a failed read drops only what it applied since then. A destination
// supplies the Load; this class owns the protocol.
export abstract class Writer {
  constructor(readonly stream: Stream) {}

  async write(
    messages: AsyncIterable<ReadMessage>,
    { writer, resuming, acknowledge }: WriteOptions,
  ): Promise<WriteResult> {
    const committed = { count: 0, deleted: 0 };
    const pending = { count: 0, deleted: 0 };
    const failures: LoadFailure[] = [];
    // Nothing is committed after a failed read until the next checkpoint: a
    // full refresh has none, so any failure keeps the previous target.
    let failed = false;
    let clean = false;
    const commit = async (load: Load) => {
      await load.commit();
      clean = true;
      committed.count += pending.count;
      committed.deleted += pending.deleted;
      pending.count = 0;
      pending.deleted = 0;
      failed = false;
    };
    try {
      await using load = await this.open(writer, resuming);
      for await (const message of this.validateMessages(messages)) {
        if (message instanceof ReadFailure) {
          await load.discard();
          pending.count = 0;
          pending.deleted = 0;
          failed = true;
          failures.push({ partition: message.partition, error: message.error });
        } else if (message.type === 'STATE') {
          await commit(load);
          await acknowledge(message.state);
        } else {
          await load.apply(message);
          clean = false;
          if (message.type === 'RECORD') pending.count++;
          else pending.deleted++;
        }
      }
      // The first commit also makes the prepared target itself durable, so an
      // empty overwrite still clears it.
      if (!failed && !clean) await commit(load);
    } catch (error) {
      failures.push({ partition: null, error });
    }
    return { ...committed, failures };
  }

  // Refuse a target another writer owns, or a resumed one that was dropped,
  // and prepare it before extracting anything; the owner record commits with
  // the first commit.
  protected abstract open(writer: string, resuming: boolean): Promise<Load>;

  // Empties the target and releases its owner, refusing another writer's target.
  abstract clear(writer: string): Promise<void>;

  private async *validateMessages(
    messages: AsyncIterable<ReadMessage>,
  ): AsyncGenerator<
    | WriteOperation
    | { readonly type: 'STATE'; readonly state: unknown }
    | ReadFailure
  > {
    for await (const message of messages) {
      if (
        message === null ||
        typeof message !== 'object' ||
        typeof message.stream !== 'string'
      )
        throw new TypeError(
          'Source must emit records with stream and data, DELETE or STATE messages',
        );
      if (message.stream !== this.stream.name)
        throw new TypeError(
          `Source emitted an unselected stream: ${message.stream}`,
        );
      if (message instanceof ReadFailure) {
        yield message;
      } else if (
        'type' in message &&
        message.type === 'STATE' &&
        Object.hasOwn(message, 'state') &&
        !Object.hasOwn(message, 'data')
      ) {
        const state: unknown = JSON.parse(JSON.stringify(message.state));
        if (!isDeepStrictEqual(state, message.state))
          throw new TypeError(
            'Checkpoint state must be losslessly JSON serializable',
          );
        yield { type: 'STATE', state };
      } else if (
        'type' in message &&
        message.type === 'DELETE' &&
        Object.hasOwn(message, 'key') &&
        !Object.hasOwn(message, 'data')
      ) {
        yield { type: 'DELETE', key: this.deletionKey(message.key) };
      } else if (
        !('type' in message) &&
        'data' in message &&
        Object.hasOwn(message, 'data')
      ) {
        if (Object.hasOwn(message, 'file'))
          throw new TypeError('Writers cannot receive source staging paths');
        yield { type: 'RECORD', data: message.data };
      } else {
        throw new TypeError(
          'Source must emit records with stream and data, DELETE or STATE messages',
        );
      }
    }
  }

  private deletionKey(key: unknown): Readonly<Record<string, KeyValue>> {
    const { name, primaryKey, emitsDeletes } = this.stream;
    if (!emitsDeletes)
      throw new TypeError(`Stream ${name} does not emit deletions`);
    if (
      key === null ||
      typeof key !== 'object' ||
      Array.isArray(key) ||
      Object.getPrototypeOf(key) !== Object.prototype ||
      Object.keys(key).length !== primaryKey.length ||
      !primaryKey.every((field) => Object.hasOwn(key, field))
    )
      throw new TypeError(
        `DELETE for ${name} must carry exactly its primary key ${JSON.stringify(primaryKey)}`,
      );
    const snapshot: Record<string, KeyValue> = {};
    for (const field of primaryKey) {
      const value: unknown = Reflect.get(key, field);
      if (
        !(typeof value === 'string' && value.isWellFormed()) &&
        !(typeof value === 'number' && Number.isFinite(value)) &&
        typeof value !== 'boolean'
      )
        throw new TypeError(`DELETE for ${name} has an invalid ${field}`);
      snapshot[field] = value;
    }
    return Object.freeze(snapshot);
  }
}
