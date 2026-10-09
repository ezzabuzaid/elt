import type { Catalog } from './catalog.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { DocumentParser } from './document-parser.ts';
import { FileContent } from './file-content.ts';
import { interleave } from './interleave.ts';
import {
  type Partition,
  type PartitionState,
  assertInPartition,
  assertPartitions,
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

// What a pass over one stream asks the upstream for, in the source's own
// words: the reader tells "no matching rows" from "not covered" with it.
// selection holds the configuration values the description refers to.
export type ExtractionCoverage = {
  readonly description: string;
  readonly selection: { readonly [field: string]: JsonValue };
};

// Whose a failure is to fix, as Airbyte's failure_type: config when the
// upstream refused what the user set up or granted, so only they can fix it,
// such as an app's store macOS keeps behind an access the user has not given;
// system for every other failure. Airbyte's transient_error has no reader
// here yet.
export type FailureType = 'config' | 'system';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };

// Removes the destination row with this primary key. Only streams that declare
// emitsDeletes may send it, and only deduplicating loads can apply it.
export type DeleteMessage = {
  readonly type: 'DELETE';
  readonly stream: string;
  readonly key: Readonly<Record<string, KeyValue>>;
};

// Starts the stream over, as when the upstream's change history expired:
// what follows loads into a hidden target that replaces every row the stream
// loaded once the stream ends without a failure; for a partitioned stream,
// the next commit replaces the partition being read. Only a stream that
// emits deletions may send it; a full refresh starts over anyway.
export type ResetMessage = {
  readonly type: 'RESET';
  readonly stream: string;
};

// A reset as Source.read emits it, scoped to the partition being read.
export type ScopedReset = ResetMessage & {
  readonly partition: Partition | null;
};

export type SourceMessage =
  RecordMessage | StateMessage | DeleteMessage | ResetMessage;

// Where a stream's read stands, as Airbyte's stream status: STARTED before its
// first message; FAILED when one partition, or the whole stream when
// partition is null, did not read; ENDED after its last message. Only
// Source.read creates it, from what extract threw; a connector signals
// failure by throwing.
export class StreamStatus {
  readonly stream: string;
  readonly status: 'STARTED' | 'FAILED' | 'ENDED';
  readonly partition: Partition | null;
  readonly error: unknown;

  constructor(
    stream: string,
    status: 'STARTED' | 'FAILED' | 'ENDED',
    partition: Partition | null = null,
    error: unknown = undefined,
  ) {
    this.stream = stream;
    this.status = status;
    this.partition = partition;
    this.error = error;
    Object.freeze(this);
  }
}

export type ReadMessage =
  RecordMessage | StateMessage | DeleteMessage | ScopedReset | StreamStatus;

// Airbyte's read(config, catalog, state): one read covers every selected
// stream, inside one context the source opens for it, so related streams see
// the same moment of the upstream.
export abstract class Source<
  Context extends AsyncDisposable = AsyncDisposable,
> {
  abstract readonly identity: string;
  // Metadata only. Selections must use these exact Stream objects: a stream's
  // schema shapes the destination, so a matching name is not enough.
  protected abstract readonly catalog: Catalog;

  // How many streams one read reads at once; their messages interleave. A
  // source raising it reads its context from several extracts together.
  protected readonly concurrency: number = 1;

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
  protected abstract open(streams: readonly Stream[]): Promise<Context>;

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

  // Declares what a pass over this stream covers, from this source's configuration.
  abstract coverage(stream: Stream): ExtractionCoverage;

  // What kind of failure an error from this source is. Only the source knows
  // which of its upstream's errors mean the user must act; any other error,
  // a destination's included, is system.
  failureType(_error: unknown): FailureType {
    return 'system';
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

  // Must be lazy: the destination prepares its targets before pulling records.
  // Each checkpoint is a commit point. A full refresh carries none, so it
  // loads all or nothing; an incremental read that fails keeps what earlier
  // checkpoints committed. states holds each incremental stream's saved state.
  // signal is the run's: each extract receives it, so one waiting on its
  // upstream can stop once the run is cancelled.
  async *read(
    catalog: readonly CopyConfiguration[],
    states: ReadonlyMap<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<ReadMessage> {
    for (const configuration of catalog) this.validate(configuration);
    if (
      new Set(catalog.map(({ stream }) => stream.name)).size !== catalog.length
    )
      throw new TypeError('A read selects each stream once');
    await using context = await this.open(catalog.map(({ stream }) => stream));
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1)
      throw new TypeError('Source concurrency must be a positive integer');
    yield* interleave(
      catalog.map((configuration) =>
        this.#stream(
          configuration,
          states.get(configuration.stream.name) ?? null,
          context,
          signal,
        ),
      ),
      this.concurrency,
    );
  }

  async *#stream(
    configuration: CopyConfiguration,
    state: unknown,
    context: Context,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ReadMessage> {
    const { name } = configuration.stream;
    yield new StreamStatus(name, 'STARTED');
    if (configuration.stream.partitionKey !== undefined)
      yield* this.partitioned(configuration, state, context, signal);
    else {
      const incremental = configuration.syncMode === 'incremental';
      try {
        for await (const message of this.resolved(
          configuration,
          this.extract(configuration, state, null, context, signal),
        ))
          if (!('type' in message) || message.type === 'DELETE') yield message;
          else if (incremental)
            yield message.type === 'RESET'
              ? { ...message, partition: null }
              : message;
      } catch (error) {
        yield new StreamStatus(name, 'FAILED', null, error);
      }
    }
    yield new StreamStatus(name, 'ENDED');
  }

  // Keeps each message to the stream whose extract emitted it, and replaces
  // each record's staging path with the file reads it asked for.
  private async *resolved(
    configuration: CopyConfiguration,
    messages: AsyncIterable<SourceMessage>,
  ): AsyncGenerator<SourceMessage> {
    for await (const message of messages) {
      if (message instanceof StreamStatus)
        throw new TypeError(
          'Only Source.read reports stream status; extract signals failure by throwing',
        );
      if (message.stream !== configuration.stream.name)
        throw new TypeError(
          `Extract for ${configuration.stream.name} emitted ${message.stream}`,
        );
      if (
        'type' in message &&
        message.type === 'RESET' &&
        Object.hasOwn(message, 'partition')
      )
        throw new TypeError('Only Source.read scopes a reset to its partition');
      if ('type' in message || configuration.fileReads.length === 0) {
        yield message;
        continue;
      }
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
    context: Context,
    signal: AbortSignal | undefined,
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
            context,
            signal,
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
          if ('type' in message && message.type === 'RESET') {
            if (incremental) yield { ...message, partition };
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
        yield new StreamStatus(stream.name, 'FAILED', partition, error);
        // A full refresh commits nothing after a failure; stop reading.
        if (!incremental) return;
      }
    }
  }

  protected abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    context: Context,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage>;
}
