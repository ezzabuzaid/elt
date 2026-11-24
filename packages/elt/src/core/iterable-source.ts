import { ClosedWorld } from '@zukhruf/snapshot-differential';

import { Catalog } from './catalog.ts';
import { type ChangeSignal, Gauge } from './change-signal.ts';
import type { PipelineClock } from './clock.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import { Deduplication } from './deduplication.ts';
import type {
  Properties,
  SchemaRecord,
  StreamSchema,
} from './record-validation.ts';
import { diffVersionedSnapshot } from './snapshot.ts';
import {
  type ExtractionCoverage,
  Source,
  type SourceMessage,
} from './source.ts';
import { Stream } from './stream.ts';

// A property that a stream's schema declares.
type Field<Schema extends StreamSchema> = keyof NonNullable<
  Schema['properties']
> &
  string;

// A row as the stream's schema declares it.
export type IterableRow<Schema extends StreamSchema> = SchemaRecord<
  NonNullable<Schema['properties']> extends Properties
    ? NonNullable<Schema['properties']>
    : Properties
>;

// What a pass gives the host when it asks for the rows: the run's signal, so
// rows that wait on the host stop with the run.
export type IterableReadContext = { readonly signal: AbortSignal };

// The host's own change signal for a stream, such as a gauge that reads a
// store's data_version. The pipeline disposes each gauge when its watch
// stops, so the stream gives a new gauge for each watch.
export type IterableChangeSignal = {
  readonly gauge: (clock: PipelineClock) => Gauge;
  // Milliseconds from one check to the next.
  readonly interval: number;
  // Milliseconds that one read of the gauge can take.
  readonly timeout: number;
};

// What a stream of every kind declares.
type IterableStreamBase<Schema extends StreamSchema> = {
  // What a pass over the stream gives, in the host's words: the coverage of
  // each pass.
  readonly description: string;
  readonly jsonSchema: Schema;
  // The host's own identity of a row, one field or more.
  readonly primaryKey: readonly [Field<Schema>, ...Field<Schema>[]];
  // When the host's rows were last current, if not whenever they are read.
  readonly currentAsOf?: () => Promise<Date | null>;
  // A change signal of the host, beside the revision that changed() raises.
  readonly changeSignal?: IterableChangeSignal;
};

// A stream whose host gives every row it holds at each pass.
export type SnapshotStreamDeclaration<Schema extends StreamSchema> =
  IterableStreamBase<Schema> & {
    // Called once for each pass; the pass pulls the rows as the destination
    // asks for them.
    readonly snapshot: (
      context: IterableReadContext,
    ) => Iterable<IterableRow<Schema>> | AsyncIterable<IterableRow<Schema>>;
    // closed-world: a row that the host stops giving is deleted. Omitted: it
    // stays loaded.
    readonly deletions?: 'closed-world';
    // A column whose value changes each time the host changes the row, such
    // as a version counter. An incremental copy compares it in place of the
    // hash of the row, so a row whose version did not change is not read
    // again, also when its content changed.
    readonly rowVersion?: Field<Schema>;
  };

// The declaration of one stream of an IterableSource.
export type IterableStreamDeclaration<Schema extends StreamSchema> =
  SnapshotStreamDeclaration<Schema>;

// The milliseconds of the change signal that a stream with no change signal of
// its own has.
const defaultPace = { interval: 1000, timeout: 1000 } as const;

// A stream as the source reads it.
type Member = {
  readonly declaration: IterableStreamDeclaration<StreamSchema>;
  readonly deduplication: Deduplication;
  readonly versions: Deduplication | undefined;
  revision: number;
};

// A source of rows that the host already holds: each stream reads what the
// host gives at each pass, with no Source subclass. dlt's pipeline.run(data)
// and LangChain's index(docs) take rows in the same way.
export class IterableSource<
  const Schemas extends Readonly<Record<string, StreamSchema>>,
> extends Source {
  readonly identity: string;
  readonly streams: { readonly [Name in keyof Schemas]: Stream };
  protected readonly catalog: Catalog;
  protected override readonly configErrors: readonly (abstract new (
    ...args: never[]
  ) => Error)[];
  readonly #members = new Map<Stream, Member>();

  constructor({
    identity,
    streams,
    configErrors = [],
  }: {
    // Part of the binding of each copy of the source (ADR 0008).
    readonly identity: string;
    readonly streams: {
      readonly [Name in keyof Schemas]: IterableStreamDeclaration<
        Schemas[Name]
      >;
    };
    // The error classes of the host that mean the user must act.
    readonly configErrors?: readonly (abstract new (
      ...args: never[]
    ) => Error)[];
  }) {
    super();
    this.identity = identity;
    this.configErrors = Object.freeze([...configErrors]);
    const built: Record<string, Stream> = {};
    for (const [name, declaration] of Object.entries<
      IterableStreamDeclaration<StreamSchema>
    >(streams)) {
      const stream = streamOf(name, declaration);
      built[name] = stream;
      this.#members.set(stream, {
        declaration,
        deduplication: new Deduplication(stream, stream.primaryKey),
        versions: versionsOf(stream, declaration),
        revision: 0,
      });
    }
    if (!holdsEach(streams, built))
      throw new TypeError(
        'An IterableSource builds a stream for each declaration',
      );
    this.streams = Object.freeze(built);
    this.catalog = new Catalog(this.#members.keys());
  }

  // Tells a watch that the host's rows of this stream changed: its next
  // check finds the stream changed and starts a pass.
  changed(stream: Stream): void {
    this.#member(stream).revision += 1;
  }

  override coverage(stream: Stream): ExtractionCoverage {
    return {
      description: this.#member(stream).declaration.description,
      selection: {},
    };
  }

  override async currentAsOf(stream: Stream): Promise<Date | null> {
    const { currentAsOf } = this.#member(stream).declaration;
    return currentAsOf === undefined ? null : currentAsOf();
  }

  override *changeSignals(
    streams: readonly Stream[],
    clock: PipelineClock,
  ): Iterable<ChangeSignal> {
    for (const stream of streams) {
      const member = this.#member(stream);
      const own = member.declaration.changeSignal;
      const { interval, timeout } = own ?? defaultPace;
      yield {
        gauge: new Revision(() => member.revision),
        streams: [stream],
        interval,
        timeout,
      };
      if (own !== undefined)
        yield { gauge: own.gauge(clock), streams: [stream], interval, timeout };
    }
  }

  protected override async open(): Promise<AsyncDisposableStack> {
    return new AsyncDisposableStack();
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: unknown,
    _context: AsyncDisposable,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    const member = this.#member(configuration.stream);
    const { declaration, versions } = member;
    const rows = declaration.snapshot({
      signal: signal ?? new AbortController().signal,
    });
    yield* diffVersionedSnapshot(
      configuration,
      configuration.syncMode === 'incremental'
        ? rows
        : unrepeated(member.deduplication, rows),
      state,
      {
        ...(declaration.deletions === 'closed-world'
          ? { policy: new ClosedWorld() }
          : {}),
        signal,
        fingerprint:
          versions === undefined
            ? undefined
            : (row) => JSON.stringify(versions.cursor(row)),
      },
    );
  }

  #member(stream: Stream): Member {
    const member = this.#members.get(stream);
    if (member === undefined)
      throw new TypeError(
        `Stream ${stream.name} is not a stream of IterableSource ${this.identity}`,
      );
    return member;
  }
}

// The Stream that a declaration builds. The host writes no flags: a snapshot
// stream defines its own cursor, and it emits deletions only in a closed
// world.
function streamOf(
  name: string,
  declaration: IterableStreamDeclaration<StreamSchema>,
): Stream {
  const { jsonSchema, primaryKey, deletions } = declaration;
  if (!Array.isArray(primaryKey) || primaryKey.length === 0)
    throw new TypeError(
      `Stream ${name} of an IterableSource needs a primaryKey`,
    );
  if (deletions !== undefined && deletions !== 'closed-world')
    throw new TypeError(
      `Stream ${name} declares deletions ${String(deletions)}; only closed-world is known`,
    );
  return new Stream({
    name,
    jsonSchema,
    primaryKey,
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    ...(deletions === 'closed-world' ? { emitsDeletes: true } : {}),
  });
}

// Whether built holds a stream for each declared name.
function holdsEach<Declarations extends object>(
  declarations: Declarations,
  built: Readonly<Record<string, Stream>>,
): built is { readonly [Name in keyof Declarations]: Stream } {
  return Object.keys(declarations).every((name) => Object.hasOwn(built, name));
}

// What reads the version of each row, or undefined for a stream compared by
// the hash of each row.
function versionsOf(
  stream: Stream,
  { rowVersion }: IterableStreamDeclaration<StreamSchema>,
): Deduplication | undefined {
  if (rowVersion === undefined) return undefined;
  if (!Object.hasOwn(stream.jsonSchema.properties ?? {}, rowVersion))
    throw new TypeError(
      `Stream ${stream.name} names rowVersion ${rowVersion}, which its jsonSchema does not declare`,
    );
  // The version is read as a cursor is: one non-null text or number.
  return new Deduplication(stream, stream.primaryKey, rowVersion);
}

// The rows of a full refresh, which fail at a key that comes twice: a host
// with two rows for one key has a wrong key (ADR 0022). An incremental copy's
// diff checks this itself.
async function* unrepeated<Row>(
  deduplication: Deduplication,
  rows: Iterable<Row> | AsyncIterable<Row>,
): AsyncGenerator<Row> {
  const seen = new Set<string>();
  for await (const row of rows) {
    const key = deduplication.key(row);
    if (seen.has(key))
      throw new TypeError(
        `Snapshot ${deduplication.stream.name} returned ${keyText(deduplication, row)} twice in one scan`,
      );
    seen.add(key);
    yield row;
  }
}

// A key as its fields and values, as the snapshot diff names it.
function keyText(deduplication: Deduplication, row: unknown): string {
  return deduplication.primaryKey
    .map((field) => `${field} ${String(deduplication.value(row, field))}`)
    .join(', ');
}

// The revision of a stream that changed() raises.
class Revision extends Gauge<number> {
  readonly #revision: () => number;

  constructor(revision: () => number) {
    super();
    this.#revision = revision;
  }

  protected async read(): Promise<number> {
    return this.#revision();
  }
}
