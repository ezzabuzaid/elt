import type { Catalog } from './catalog.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { DocumentParser } from './document-parser.ts';
import { FileContent } from './file-content.ts';
import {
  assertInPartition,
  assertPartitions,
  type Partition,
  type PartitionState,
  partitionIdentity,
  readPartition,
  readPartitionStates,
} from './partition.ts';
import type { Stream } from './stream.ts';

export type SourceWatchOptions = {
  readonly streams: readonly Stream[];
  readonly signal: AbortSignal;
};

export type RecordMessage = {
  readonly stream: string;
  readonly data: unknown;
  // Source-owned staging path, valid until the consumer advances the iterator.
  // null means this record has no exportable file (for example a URL attachment).
  readonly file?: string | null;
};

export type StateMessage = {
  readonly type: 'STATE';
  readonly stream: string;
  readonly state: unknown;
};

export type KeyValue = string | number | boolean;

// Removes the destination row with this primary key. Only streams that declare
// emitsDeletes may send it, and only deduplicating loads can apply it.
export type DeleteMessage = {
  readonly type: 'DELETE';
  readonly stream: string;
  readonly key: Readonly<Record<string, KeyValue>>;
};

export type SourceMessage = RecordMessage | StateMessage | DeleteMessage;

// A read that failed, for one partition or, when partition is null, the whole
// stream: Airbyte's error trace. Only Source.read creates it, from what
// extract threw; a connector signals failure by throwing.
export class ReadFailure {
  constructor(
    readonly stream: string,
    readonly partition: Partition | null,
    readonly error: unknown,
  ) {
    Object.freeze(this);
  }
}

export type ReadMessage = SourceMessage | ReadFailure;

// Every copy in one pipeline run reads through one session, so related
// streams see the same moment of the source.
export abstract class Source<
  Session extends AsyncDisposable = AsyncDisposable,
> {
  abstract readonly identity: string;
  // Metadata only. Selections must use these exact Stream objects: a stream's
  // schema shapes the destination, so a matching name is not enough.
  protected abstract readonly catalog: Catalog;

  async discover(): Promise<Catalog> {
    return this.catalog;
  }

  // Check source-owned metadata without extraction or rediscovery.
  validate(configuration: CopyConfiguration): void {
    const stream = this.member(configuration.stream);
    configuration.validate(stream);
    this.validateExtraction(configuration);
    if (stream.partitionKey !== undefined)
      assertPartitions(stream, this.partitions(stream));
  }

  async *watch(options: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for (const stream of options.streams) this.member(stream);
    yield* this.observe(options);
  }

  // One consistent view of the upstream for reading these streams: a read
  // transaction, or every stream read up front. A source whose streams need
  // not agree returns an empty AsyncDisposableStack.
  abstract session(streams: readonly Stream[]): Promise<Session>;

  // Source-specific selection rules, checked without I/O.
  protected validateExtraction(_configuration: CopyConfiguration): void {}

  // The partitions a partitioned stream is read as, derived from configuration
  // without I/O. The list is not part of the identity: adding or removing a
  // partition keeps every other partition's checkpoint.
  protected partitions(stream: Stream): readonly Partition[] {
    throw new TypeError(
      `Source must declare partitions for stream ${stream.name}`,
    );
  }

  // Subscribe before yielding all selected streams once, then yield invalidations.
  // Keep receiving changes until signal aborts, including while extraction runs.
  protected abstract observe(
    options: SourceWatchOptions,
  ): AsyncIterable<readonly Stream[]>;

  private member(stream: Stream): Stream {
    if (this.catalog.get(stream.name) !== stream)
      throw new TypeError(
        `Stream ${stream.name} is not from this source's discovered catalog`,
      );
    return stream;
  }

  // Must be lazy: the destination prepares its target before pulling records.
  // Each checkpoint is a commit point. A full refresh carries none, so it
  // loads all or nothing; an incremental read that fails keeps what earlier
  // checkpoints committed.
  async *read(
    configuration: CopyConfiguration,
    state: unknown,
    session: Session,
  ): AsyncGenerator<ReadMessage> {
    this.validate(configuration);
    if (configuration.stream.partitionKey !== undefined) {
      yield* this.partitioned(configuration, state, session);
      return;
    }
    const incremental = configuration.syncMode === 'incremental';
    try {
      for await (const message of this.resolved(
        configuration,
        this.extract(configuration, state, null, session),
      ))
        if (incremental || !('type' in message) || message.type !== 'STATE')
          yield message;
    } catch (error) {
      yield new ReadFailure(configuration.stream.name, null, error);
    }
  }

  // Replaces each record's staging path with the file reads it asked for.
  private async *resolved(
    configuration: CopyConfiguration,
    messages: AsyncIterable<SourceMessage>,
  ): AsyncGenerator<SourceMessage> {
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0) {
        yield message;
        continue;
      }
      if (message.stream !== configuration.stream.name)
        throw new TypeError(
          `Source emitted an unselected stream: ${message.stream}`,
        );
      if (message.file !== null && typeof message.file !== 'string')
        throw new TypeError(
          'File extraction must supply a staging path or explicit null',
        );
      const data = message.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data))
        throw new TypeError('File metadata must be an object');
      const output = { ...data };
      const values = new Map<
        DocumentParser | undefined,
        Promise<string | null> | FileContent
      >();
      for (const read of configuration.fileReads) {
        if (
          Object.keys(data).some(
            (name) => name.toLowerCase() === read.name.toLowerCase(),
          )
        )
          throw new TypeError('File field collides with source metadata');
        let value: string | FileContent | null = null;
        if (message.file !== null) {
          let pending = values.get(read.parser);
          if (pending === undefined) {
            pending =
              read.parser === undefined
                ? new FileContent(message.file)
                : read.parser.parse(message.file);
            values.set(read.parser, pending);
          }
          value = await pending;
          if (
            read.parser !== undefined &&
            value !== null &&
            typeof value !== 'string'
          )
            throw new TypeError('Document parser must return text or null');
        }
        Object.defineProperty(output, read.name, { value, enumerable: true });
      }
      yield { stream: message.stream, data: output };
    }
  }

  // Reads each partition with its own saved state: null for a partition not
  // seen before, so it starts from the source's normal beginning. Every
  // checkpoint carries all listed partitions' latest states, so a partition
  // not yet read, or one that failed, keeps what it had. Partitions no longer
  // listed drop out of the next checkpoint; their rows stay loaded.
  private async *partitioned(
    configuration: CopyConfiguration,
    state: unknown,
    session: Session,
  ): AsyncGenerator<ReadMessage> {
    const { stream } = configuration;
    const incremental = configuration.syncMode === 'incremental';
    const saved = incremental
      ? readPartitionStates(stream, state)
      : new Map<string, PartitionState>();
    const identity = partitionIdentity(stream);
    const listed = this.partitions(stream).map((entry) =>
      readPartition(identity, entry),
    );
    const latest = new Map(saved);
    for (const { key, partition } of listed) {
      try {
        for await (const message of this.resolved(
          configuration,
          this.extract(
            configuration,
            saved.get(key)?.state ?? null,
            partition,
            session,
          ),
        )) {
          if ('type' in message && message.type === 'STATE') {
            if (!incremental) continue;
            latest.set(key, { partition, state: message.state });
            yield {
              type: 'STATE',
              stream: stream.name,
              state: {
                partitions: listed.flatMap(
                  (entry) => latest.get(entry.key) ?? [],
                ),
              },
            };
            continue;
          }
          assertInPartition(
            stream,
            partition,
            'type' in message ? message.key : message.data,
          );
          yield message;
        }
      } catch (error) {
        yield new ReadFailure(stream.name, partition, error);
        // A full refresh commits nothing after a failure; stop reading.
        if (!incremental) return;
      }
    }
  }

  protected abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    session: Session,
  ): AsyncIterable<SourceMessage>;
}
