import { isDeepStrictEqual } from 'node:util';
import type { SourceMessage, StateMessage } from './source.ts';
import type { Stream } from './stream.ts';

export class CommittedWriteError extends Error {
  override name = 'CommittedWriteError';
  constructor(
    readonly count: number,
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

export type WriteResult = {
  // Input records accepted by a committed copy, including deduplication no-ops.
  readonly count: number;
  readonly checkpoints: readonly StateMessage[];
};

// A destination's loading strategy. Resource ownership starts when write is called.
export abstract class Writer {
  constructor(readonly stream: Stream) {}

  async write(messages: AsyncIterable<SourceMessage>): Promise<WriteResult> {
    const checkpoints: StateMessage[] = [];
    const count = await this.writeRecords(
      this.validateRecords(messages, checkpoints),
    );
    // Every current writer commits the whole copy before resolving. No early acknowledgement.
    return { count, checkpoints };
  }

  protected abstract writeRecords(
    records: AsyncIterable<unknown>,
  ): Promise<number>;

  private async *validateRecords(
    messages: AsyncIterable<SourceMessage>,
    checkpoints: StateMessage[],
  ): AsyncGenerator<unknown> {
    for await (const message of messages) {
      if (
        message === null ||
        typeof message !== 'object' ||
        typeof message.stream !== 'string'
      )
        throw new TypeError(
          'Source must emit records with stream and data or STATE messages',
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
        !('type' in message) &&
        'data' in message &&
        Object.hasOwn(message, 'data')
      ) {
        if (Object.hasOwn(message, 'file'))
          throw new TypeError('Writers cannot receive source staging paths');
        yield message.data;
      } else {
        throw new TypeError(
          'Source must emit records with stream and data or STATE messages',
        );
      }
    }
  }
}
