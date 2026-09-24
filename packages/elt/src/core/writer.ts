import { isDeepStrictEqual } from 'node:util';
import type { KeyValue, SourceMessage, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

// Accepted input: records (including deduplication no-ops) and deletions
// (including keys that were already absent).
export type WriteCount = {
  readonly count: number;
  readonly deleted: number;
};

export class CommittedWriteError extends Error {
  override name = 'CommittedWriteError';
  readonly count: number;
  readonly deleted: number;
  constructor(committed: WriteCount, message: string, cause: unknown) {
    super(message, { cause });
    this.count = committed.count;
    this.deleted = committed.deleted;
  }
}

export type WriteResult = WriteCount & {
  readonly checkpoints: readonly StateMessage[];
};

// What a writer applies, in source order.
export type WriteOperation =
  | { readonly type: 'RECORD'; readonly data: unknown }
  | {
      readonly type: 'DELETE';
      readonly key: Readonly<Record<string, KeyValue>>;
    };

// A destination's loading strategy. Resource ownership starts when write is called.
export abstract class Writer {
  constructor(readonly stream: Stream) {}

  async write(messages: AsyncIterable<SourceMessage>): Promise<WriteResult> {
    const checkpoints: StateMessage[] = [];
    const written = await this.writeRecords(
      this.validateMessages(messages, checkpoints),
    );
    // Every current writer commits the whole copy before resolving. No early acknowledgement.
    return { ...written, checkpoints };
  }

  protected abstract writeRecords(
    operations: AsyncIterable<WriteOperation>,
  ): Promise<WriteCount>;

  private async *validateMessages(
    messages: AsyncIterable<SourceMessage>,
    checkpoints: StateMessage[],
  ): AsyncGenerator<WriteOperation> {
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
      if (
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
        checkpoints.push({ type: 'STATE', stream: message.stream, state });
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
