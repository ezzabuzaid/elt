import { ClosedWorld } from '@zukhruf/snapshot-differential';

import { Catalog } from './catalog.ts';
import { type ChangeSignal, Gauge } from './change-signal.ts';
import type { PipelineClock } from './clock.ts';
import type { CopyConfiguration } from './copy-configuration.ts';
import { Deduplication } from './deduplication.ts';
import type { DeclaredFormat } from './formats/declared-format.ts';
import type {
  Properties,
  SchemaRecord,
  StreamSchema,
} from './record-validation.ts';
import { diffVersionedSnapshot } from './snapshot.ts';
import {
  type ExtractionCoverage,
  type KeyValue,
  Source,
  type SourceMessage,
} from './source.ts';
import { Stream } from './stream.ts';

// A property that a stream's schema declares.
type Field<Schema extends StreamSchema> = keyof NonNullable<
  Schema['properties']
> &
  string;

// The properties that a stream's schema declares.
type Declared<Schema extends StreamSchema> =
  NonNullable<Schema['properties']> extends Properties
    ? NonNullable<Schema['properties']>
    : Properties;

// A property that the schema lists in required.
type RequiredField<Schema extends StreamSchema> =
  Schema['required'] extends readonly (infer Name)[] ? Name : never;

// A row as the stream's schema declares it, as JSON Schema reads required: a
// property listed in required is required, and any other may be left out.
export type IterableRow<Schema extends StreamSchema> =
  SchemaRecord<Declared<Schema>> extends infer Row
    ? string extends keyof Row
      ? Row
      : {
          [
            Name in keyof Row as Name extends RequiredField<Schema>
              ? Name
              : never
          ]: Row[Name];
        } & {
          [
            Name in keyof Row as Name extends RequiredField<Schema>
              ? never
              : Name
          ]?: Row[Name];
        }
    : never;

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
    readonly changes?: never;
    readonly cursorField?: never;
    readonly ordered?: never;
  };

// A version of a row, as the stream's cursor field holds it.
export type IterableVersion = string | number;

// What a pass of a changes stream gives the host: the greatest version that
// the copy saved, or null when it saved none, so the host gives the changes
// after it.
export type IterableChangesContext<
  Version extends IterableVersion = IterableVersion,
> = IterableReadContext & { readonly since: Version | null };

// A row that the host deleted at a version, by the fields of its primary key.
export type IterableTombstone<
  Version extends IterableVersion = IterableVersion,
> = {
  readonly deleted: Readonly<Record<string, KeyValue>>;
  readonly version: Version;
};

// A changes stream whose versions are in the column name.
type ChangesOn<
  Schema extends StreamSchema,
  Name extends string,
  Version extends IterableVersion,
> = IterableStreamBase<Schema> & {
  // Called once for each pass; the pass pulls the changes as the
  // destination asks for them. A method, so a declaration with the type of
  // its own cursor field is a declaration of any schema.
  changes(
    context: IterableChangesContext<Version>,
  ):
    | Iterable<IterableRow<Schema> | IterableTombstone<Version>>
    | AsyncIterable<IterableRow<Schema> | IterableTombstone<Version>>;
  // The column that holds the version of each row. A copy of the stream
  // deduplicates with cursor_newer on it, so an older version of a row, or
  // an older tombstone, changes nothing.
  readonly cursorField: Name;
  // The host gives the changes in version order. A pass then saves its
  // progress each time the version rises, and fails at a version below
  // the one before it.
  readonly ordered?: true;
  readonly snapshot?: never;
  readonly deletions?: never;
  readonly rowVersion?: never;
};

// A property whose values can be versions: text or numbers, never null.
type VersionField<Schema extends StreamSchema> = {
  [Name in Field<Schema>]: SchemaRecord<
    Declared<Schema>
  >[Name] extends IterableVersion
    ? Name
    : never;
}[Field<Schema>];

// A stream whose host gives the rows that changed after a version, and a
// tombstone for each row it deleted. since and each version have the type
// of the cursor field.
export type ChangesStreamDeclaration<Schema extends StreamSchema> =
  string extends Field<Schema>
    ? ChangesOn<Schema, string, IterableVersion>
    : {
        [Name in VersionField<Schema>]: ChangesOn<
          Schema,
          Name,
          Extract<SchemaRecord<Declared<Schema>>[Name], IterableVersion>
        >;
      }[VersionField<Schema>];

// The declaration of one stream of an IterableSource.
export type IterableStreamDeclaration<Schema extends StreamSchema> =
  SnapshotStreamDeclaration<Schema> | ChangesStreamDeclaration<Schema>;

// The milliseconds of the change signal that a stream with no change signal of
// its own has.
const defaultPace = { interval: 1000, timeout: 1000 } as const;

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
      const member =
        declaration.changes === undefined
          ? new SnapshotMember(name, declaration)
          : new ChangesMember(name, declaration);
      built[name] = member.stream;
      this.#members.set(member.stream, member);
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

  protected override validateExtraction(
    configuration: CopyConfiguration,
  ): void {
    this.#member(configuration.stream).validate(configuration);
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: unknown,
    _context: AsyncDisposable,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return this.#member(configuration.stream).extract(
      configuration,
      state,
      signal,
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

// A stream as the source reads it.
abstract class Member {
  abstract readonly stream: Stream;
  abstract readonly declaration: IterableStreamBase<StreamSchema>;
  // The revision that changed() raises.
  revision = 0;

  // Refuses a copy that the stream cannot load correctly.
  validate(_configuration: CopyConfiguration): void {}

  abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage>;
}

// A snapshot stream: the host writes no flags, the stream defines its own
// cursor, and it emits deletions only in a closed world.
class SnapshotMember extends Member {
  readonly stream: Stream;
  readonly declaration: SnapshotStreamDeclaration<StreamSchema>;
  readonly #deduplication: Deduplication;
  // What reads the version of each row, or undefined for a stream compared by
  // the hash of each row.
  readonly #versions: Deduplication | undefined;

  constructor(
    name: string,
    declaration: SnapshotStreamDeclaration<StreamSchema>,
  ) {
    super();
    const { jsonSchema, primaryKey, deletions, rowVersion } = declaration;
    requirePrimaryKey(name, primaryKey);
    if (deletions !== undefined && deletions !== 'closed-world')
      throw new TypeError(
        `Stream ${name} declares deletions ${String(deletions)}; only closed-world is known`,
      );
    this.stream = new Stream({
      name,
      jsonSchema,
      primaryKey,
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      ...(deletions === 'closed-world' ? { emitsDeletes: true } : {}),
    });
    this.declaration = declaration;
    this.#deduplication = new Deduplication(this.stream, primaryKey);
    if (rowVersion !== undefined) {
      if (!Object.hasOwn(jsonSchema.properties ?? {}, rowVersion))
        throw new TypeError(
          `Stream ${name} names rowVersion ${rowVersion}, which its jsonSchema does not declare`,
        );
      // The version is read as a cursor is: one non-null text or number.
      this.#versions = new Deduplication(this.stream, primaryKey, rowVersion);
    }
  }

  override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    const versions = this.#versions;
    const rows = this.declaration.snapshot({
      signal: signal ?? new AbortController().signal,
    });
    yield* diffVersionedSnapshot(
      configuration,
      configuration.syncMode === 'incremental'
        ? rows
        : unrepeated(this.#deduplication, rows),
      state,
      {
        ...(this.declaration.deletions === 'closed-world'
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
}

// A changes stream: an incremental stream with a cursor field, which emits
// each tombstone as a deletion at its version. Its state is the greatest
// version whose changes all loaded.
class ChangesMember extends Member {
  readonly stream: Stream;
  readonly declaration: ChangesStreamDeclaration<StreamSchema>;
  // What reads the version of each row, and the format that orders it.
  readonly #versions: Deduplication;
  readonly #format: DeclaredFormat | null;

  constructor(
    name: string,
    declaration: ChangesStreamDeclaration<StreamSchema>,
  ) {
    super();
    const { jsonSchema, primaryKey, cursorField } = declaration;
    requirePrimaryKey(name, primaryKey);
    // A tombstone is the change that holds deleted.
    if (Object.hasOwn(jsonSchema.properties ?? {}, 'deleted'))
      throw new TypeError(
        `Stream ${name} declares a property deleted, which a changes stream reads as a tombstone`,
      );
    this.stream = new Stream({
      name,
      jsonSchema,
      primaryKey,
      supportedSyncModes: ['full_refresh', 'incremental'],
      defaultCursorField: [cursorField],
      emitsDeletes: true,
    });
    this.declaration = declaration;
    this.#versions = new Deduplication(this.stream, primaryKey, cursorField);
    this.#format = this.#versions.format(cursorField);
  }

  // The version decides which change of a row wins, so a copy compares it.
  // A copy that selects no cursorField compares it by default.
  override validate({ dedupPolicy, cursorField }: CopyConfiguration): void {
    const field = this.declaration.cursorField;
    if (dedupPolicy !== 'cursor_newer' || cursorField !== field)
      throw new TypeError(
        `Stream ${this.stream.name} gives changes by ${field}; a copy of it deduplicates with dedupPolicy cursor_newer on cursorField ${field}`,
      );
  }

  override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    const { name } = this.stream;
    const { cursorField, ordered } = this.declaration;
    const since = sinceOf(name, state);
    // The greatest version given, and the greatest version saved.
    let greatest = since;
    let saved = since;
    for await (const change of this.declaration.changes({
      since,
      signal: signal ?? new AbortController().signal,
    })) {
      signal?.throwIfAborted();
      const tombstone = isTombstone(change);
      const version = this.#versions.cursor(
        tombstone ? { [cursorField]: change.version } : change,
      );
      const order =
        greatest === null
          ? 1
          : compareVersions(this.#format, version, greatest);
      if (ordered && order < 0)
        throw new TypeError(
          `Stream ${name} gives ordered changes, but version ${String(version)} came after version ${String(greatest)}`,
        );
      if (order > 0) {
        // Every change at the versions before this one came, so a pass that
        // stops here resumes after them. Changes that share a version save
        // together.
        if (ordered && greatest !== saved) {
          yield { type: 'STATE', stream: name, state: { since: greatest } };
          saved = greatest;
        }
        greatest = version;
      }
      yield tombstone
        ? { type: 'DELETE', stream: name, key: change.deleted, cursor: version }
        : { stream: name, data: change };
    }
    if (greatest !== saved)
      yield { type: 'STATE', stream: name, state: { since: greatest } };
  }
}

function requirePrimaryKey(name: string, primaryKey: readonly string[]): void {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0)
    throw new TypeError(
      `Stream ${name} of an IterableSource needs a primaryKey`,
    );
}

// Whether built holds a stream for each declared name.
function holdsEach<Declarations extends object>(
  declarations: Declarations,
  built: Readonly<Record<string, Stream>>,
): built is { readonly [Name in keyof Declarations]: Stream } {
  return Object.keys(declarations).every((name) => Object.hasOwn(built, name));
}

// The version that a changes stream saved, or null before its first save.
function sinceOf(name: string, state: unknown): IterableVersion | null {
  if (state === null) return null;
  const since: unknown =
    typeof state === 'object' && Object.hasOwn(state, 'since')
      ? Reflect.get(state, 'since')
      : undefined;
  if (typeof since !== 'string' && typeof since !== 'number')
    throw new TypeError(`Stream ${name} has no saved version in its state`);
  return since;
}

function isTombstone(
  change: IterableRow<StreamSchema> | IterableTombstone,
): change is IterableTombstone {
  return Object.hasOwn(change, 'deleted');
}

// How two versions of the cursor field order, as the destinations compare
// them (FieldFormat.ordering): numbers by value, int64 text as integers, and
// other text by byte order, which UTF-8 keeps as code point order.
function compareVersions(
  format: DeclaredFormat | null,
  a: IterableVersion,
  b: IterableVersion,
): number {
  if (typeof a === 'number' || typeof b === 'number')
    return Math.sign(Number(a) - Number(b));
  if (format?.name === 'int64') {
    const x = BigInt(a);
    const y = BigInt(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
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
