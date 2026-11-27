import { basename } from 'node:path';

import type { Catalog } from './catalog.ts';
import type { ChangeSignal } from './change-signal.ts';
import type { PipelineClock } from './clock.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import type { DocumentParser } from './document-parser.ts';
import { plainObject } from './entry-name.ts';
import { EscalatedFailure } from './escalated-failure.ts';
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
import type { Upkeep } from './upkeep.ts';

// What a read of a source gets besides its catalog and states.
export type SourceReadOptions = {
  readonly signal?: AbortSignal | undefined;
  // The clock of the pipeline: a source waits and reads the time on it.
  readonly clock: PipelineClock;
  // The saved entries of a stream's space, by the space's name in the
  // checkpoint (ADR 0035).
  readonly entries: (
    stream: string,
    space: string,
  ) => Promise<ReadonlyMap<string, unknown>>;
};

export type RecordMessage = {
  readonly stream: string;
  readonly data: unknown;
  // A path the source keeps readable until the consumer advances the iterator:
  // a file it staged and removes afterwards, or the original in the app's store.
  // null means this record has no exportable file (for example a URL attachment).
  readonly file?: string | null;
};

// A checkpoint of the stream. Beside state, entries carries the changes of
// its keyed entries since the last STATE: for each space, the keys to put
// with their values and the keys to remove. A space names one consumer of the
// stream's state, such as a crawl or a diff, so their keys do not meet. A
// STATE with no entries changes no entry (ADR 0035).
export type StateMessage = {
  readonly type: 'STATE';
  readonly stream: string;
  readonly state: unknown;
  readonly entries?: Readonly<
    Record<
      string,
      {
        readonly put?: Iterable<readonly [key: string, value: unknown]>;
        readonly remove?: Iterable<string>;
      }
    >
  >;
};

// The saved entries of what one extract reads: its stream, or its partition
// of a partitioned stream, so two partitions that name one key keep two
// entries (ADR 0035). space reads a space's entries from the checkpoint each
// time it is asked, as the last save left them; they are empty for one never
// saved.
export type SavedEntries = {
  space(name: string): Promise<ReadonlyMap<string, unknown>>;
};

// A checkpoint as Source.read emits it: clear names the scopes of the
// partitions whose entries the save removes before it applies entries.
export type ScopedState = StateMessage & {
  readonly clear?: readonly string[];
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
// upstream or the destination refused what the user set up or granted, so
// only they can fix it, such as an app's store macOS keeps behind an access
// the user has not given; system for every other failure. Airbyte's
// transient_error has no reader here yet.
export type FailureType = 'config' | 'system';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };

type Deletion = {
  readonly type: 'DELETE';
  readonly stream: string;
  readonly key: Readonly<Record<string, KeyValue>>;
};
// For a copy with dedupPolicy replace: the last message of the key wins.
export type UnversionedDelete = Deletion & { readonly cursor?: never };
// For a copy with dedupPolicy cursor_newer: the deletion's value of the
// copy's cursor field. It competes with the records of its key as a record
// does, and removes the stored row only when its cursor sorts after the row's.
type VersionedDelete = Deletion & { readonly cursor: string | number };
// Removes the destination row with this primary key. Only streams that declare
// emitsDeletes may send it, and only deduplicating loads can apply it.
export type DeleteMessage = UnversionedDelete | VersionedDelete;

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
  RecordMessage | ScopedState | DeleteMessage | ScopedReset | StreamStatus;

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

  // One consistent view of the upstream for reading these streams: a read
  // transaction, or every stream read up front. A source whose streams need
  // not agree returns an empty AsyncDisposableStack. signal is the run's: an
  // open that waits on its upstream stops once the run is cancelled. states
  // is the read's, so a context whose streams depend on each other's saved
  // state, such as a consumer's offset into a sibling's outbox, can read it.
  // A source that reads the time in extract keeps clock in its context.
  protected abstract open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ): Promise<Context>;

  // Source-specific selection rules, checked without I/O.
  protected validateExtraction(_configuration: CopyConfiguration): void {}

  // The partitions a partitioned stream is read as, asked at the start of
  // each read and at the start of a watch, so a source whose host changes
  // them, such as a web stream's inputs, gives the list as it is then; none
  // is a stream that reads nothing. The list is not part of the identity:
  // adding or removing a partition keeps every other partition's checkpoint.
  protected partitions(stream: Stream): readonly Partition[] {
    throw new TypeError(
      `Source must declare partitions for stream ${stream.name}`,
    );
  }

  // Declares what a pass over this stream covers, from this source's configuration.
  abstract coverage(stream: Stream): ExtractionCoverage;

  // When this stream's upstream was last current, if not whenever it is
  // read: an app's store that the app writes only while it runs stays as of
  // when the app last wrote it, as a replica stays as of its last replayed
  // change. null means the upstream is current whenever it is read. The
  // pipeline asks before each pass and each check it records; a stream whose
  // source cannot tell is not read, and fails with that error.
  abstract currentAsOf(stream: Stream): Promise<Date | null>;

  // The error classes that mean the user must act, such as an SDK's access
  // error. Only the source knows which of its upstream's errors those are.
  protected readonly configErrors: readonly (abstract new (
    ...args: never[]
  ) => Error)[] = [];

  // What kind of failure an error from this source is: config for an instance
  // of a class in configErrors, and system for any other error. The
  // destination names the kind of what it raised. A source whose decision
  // needs more than the class, such as an HTTP status, overrides it.
  failureType(error: unknown): FailureType {
    return this.configErrors.some((type) => error instanceof type)
      ? 'config'
      : 'system';
  }

  // What tells a watch that each selected stream changed. A declaration, as
  // coverage is: it does no I/O, and each gauge opens what it reads in its
  // first read. The pipeline owns the gauges that it gets, and disposes them
  // when the watch stops (ADR 0020). clock is the pipeline's: a gauge that
  // waits or reads the time does it on that clock (ADR 0019).
  abstract changeSignals(
    streams: readonly Stream[],
    clock: PipelineClock,
  ): Iterable<ChangeSignal>;

  // What the source keeps doing while a watch runs, such as keeping an app
  // running when only that app syncs its store (ADR 0021). Most sources keep
  // nothing.
  upkeep(_clock: PipelineClock): Iterable<Upkeep> {
    return [];
  }

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
  // checkpoints committed. states holds each incremental stream's saved state,
  // or a promise of it, by stream name; a read asks for a stream's state when
  // it starts that stream, so a state that grows with its upstream, such as a
  // snapshot, is held only while its own stream reads. signal is the run's:
  // each extract receives it, so one waiting on its upstream can stop once
  // the run is cancelled. Streams that read together are one task group, as
  // Python's asyncio.TaskGroup: the first one that throws aborts the signal
  // the others read with, so a stream that waits on another, such as a
  // consumer of a sibling's outbox, ends with the read.
  async *read(
    catalog: readonly CopyConfiguration[],
    states: { get(stream: string): unknown },
    { signal, clock, entries }: SourceReadOptions,
  ): AsyncGenerator<ReadMessage> {
    for (const configuration of catalog) this.validate(configuration);
    if (
      new Set(catalog.map(({ stream }) => stream.name)).size !== catalog.length
    )
      throw new TypeError('A read selects each stream once');
    const group = new AbortController();
    const reading =
      signal === undefined
        ? group.signal
        : AbortSignal.any([signal, group.signal]);
    await using context = await this.open(
      catalog.map(({ stream }) => stream),
      reading,
      states,
      clock,
    );
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1)
      throw new TypeError('Source concurrency must be a positive integer');
    yield* interleave(
      catalog.map((configuration) =>
        grouped(
          this.#stream(configuration, states, entries, context, reading),
          group,
        ),
      ),
      this.concurrency,
    );
  }

  async *#stream(
    configuration: CopyConfiguration,
    states: { get(stream: string): unknown },
    entries: Entries,
    context: Context,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ReadMessage> {
    const { name } = configuration.stream;
    yield new StreamStatus(name, 'STARTED');
    const state = (await states.get(name)) ?? null;
    if (configuration.stream.partitionKey !== undefined)
      yield* this.partitioned(configuration, state, entries, context, signal);
    else {
      const incremental = configuration.syncMode === 'incremental';
      // Whether the next STATE clears every space first: a RESET came
      // before it.
      let reset = false;
      try {
        for await (const message of this.resolved(
          configuration,
          this.extract(
            configuration,
            state,
            null,
            context,
            signal,
            savedEntries(name, '', entries),
          ),
          signal,
        ))
          if (!('type' in message) || message.type === 'DELETE') yield message;
          else if (!incremental) continue;
          else if (message.type === 'RESET') {
            reset = true;
            yield { ...message, partition: null };
          } else {
            yield { ...message, ...scoped(message, '', reset ? [''] : []) };
            reset = false;
          }
      } catch (error) {
        // An escalated failure is no failure of the stream: it ends the read
        // (ADR 0037).
        if (error instanceof EscalatedFailure) throw error;
        yield new StreamStatus(name, 'FAILED', null, error);
      }
    }
    yield new StreamStatus(name, 'ENDED');
  }

  // Keeps each message to the stream whose extract emitted it, and replaces
  // each record's file path with the file reads it asked for.
  private async *resolved(
    configuration: CopyConfiguration,
    messages: AsyncIterable<SourceMessage>,
    signal: AbortSignal | undefined,
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
      if (
        'type' in message &&
        message.type === 'STATE' &&
        Object.hasOwn(message, 'clear')
      )
        throw new TypeError('Only Source.read clears the entries of a STATE');
      if ('type' in message || configuration.fileReads.length === 0) {
        yield message;
        continue;
      }
      if (message.file !== null && typeof message.file !== 'string')
        throw new TypeError(
          'File extraction must supply a file path or explicit null',
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
        if (message.file !== null && read.accepts(basename(message.file))) {
          let pending = values.get(read.parser);
          if (pending === undefined) {
            pending =
              read.parser === undefined
                ? new FileContent(message.file)
                : read.parser.parse(message.file, signal);
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
  // listed drop out of the next checkpoint with their entries; their rows
  // stay loaded. Each partition's entries are under its own scope.
  private async *partitioned(
    configuration: CopyConfiguration,
    state: unknown,
    entries: Entries,
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
    const keys = new Set(listed.map((entry) => entry.key));
    // The scopes of the partitions no longer listed: the first STATE drops
    // them from the checkpoint, and clears them.
    const unlisted = [...saved.keys()]
      .filter((key) => !keys.has(key))
      .map(partitionScope);
    for (const { key, partition } of listed) {
      const scope = partitionScope(key);
      // Whether this partition's next STATE clears its scope first: the
      // partition reset before it. A partition that fails before its STATE
      // keeps its saved state, so it keeps its entries too.
      let reset = false;
      try {
        for await (const message of this.resolved(
          configuration,
          this.extract(
            configuration,
            saved.get(key)?.state ?? null,
            partition,
            context,
            signal,
            savedEntries(stream.name, scope, entries),
          ),
          signal,
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
              ...scoped(message, scope, [
                ...unlisted.splice(0),
                ...(reset ? [scope] : []),
              ]),
            };
            reset = false;
            continue;
          }
          if ('type' in message && message.type === 'RESET') {
            if (incremental) {
              reset = true;
              yield { ...message, partition };
            }
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
        // An escalated failure is no failure of the partition (ADR 0037).
        if (error instanceof EscalatedFailure) throw error;
        yield new StreamStatus(stream.name, 'FAILED', partition, error);
        // A full refresh commits nothing after a failure; stop reading.
        if (!incremental) return;
      }
    }
  }

  // entries holds the saved entries of the stream, or of partition when the
  // stream is partitioned.
  protected abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    context: Context,
    signal: AbortSignal | undefined,
    entries: SavedEntries,
  ): AsyncIterable<SourceMessage>;
}

type Entries = SourceReadOptions['entries'];

// The scope of a partition's entries: its key as a JSON string, which ends
// where the key ends, so no scope begins another. A stream that is not
// partitioned has the empty scope, which begins every space.
function partitionScope(key: string): string {
  return JSON.stringify(key);
}

// The saved entries of one extract, in the checkpoint's spaces: each
// space's name under scope. Until its next STATE, an extract that reset
// still reads the saved entries, as its state stays the saved one.
function savedEntries(
  stream: string,
  scope: string,
  read: Entries,
): SavedEntries {
  return {
    space: async (name) => read(stream, scope + name),
  };
}

// What a STATE saves of the entries: its changes under scope, after the
// scopes in clear are cleared.
function scoped(
  message: StateMessage,
  scope: string,
  clear: readonly string[],
): Pick<ScopedState, 'entries' | 'clear'> {
  const cleared = clear.length === 0 ? {} : { clear };
  const { entries } = message;
  if (entries === undefined) return cleared;
  // Entries that are not an object go on as they are, for the copy's
  // validation to refuse.
  if (scope === '' || !plainObject(entries)) return { ...cleared, entries };
  return {
    ...cleared,
    entries: Object.fromEntries(
      Object.entries(entries).map(([space, changes]) => [
        scope + space,
        changes,
      ]),
    ),
  };
}

// A stream that throws aborts its group before the throw reaches interleave,
// which waits for every other stream to settle.
async function* grouped<T>(
  messages: AsyncGenerator<T>,
  group: AbortController,
): AsyncGenerator<T> {
  try {
    yield* messages;
  } catch (error) {
    group.abort(error);
    throw error;
  }
}
