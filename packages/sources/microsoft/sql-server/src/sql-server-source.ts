import { setInterval } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
  type Partition,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
} from '@workspace/elt';
import type {
  SqlServerDatabase,
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';
import {
  SqlServerPermissionError,
  SqlServerUnavailableError,
} from '@workspace/sdk-microsoft-sql-server';

import { ChangeTrackingStream } from './change-tracking-stream.ts';
import { FullRefreshStream } from './full-refresh-stream.ts';
import { RowversionStream } from './rowversion-stream.ts';
import type { SqlServerStream } from './sql-server-stream.ts';

// How often a watch asks the database whether anything changed.
const pollIntervalMs = 30_000;
// A table with no change signal refreshes once an hour instead.
const fullRefreshIntervalMs = 60 * 60_000;

// Change Tracking when the login can read it, else the rowversion, else the
// whole table. The first two need a key to apply changes by.
function streamFor(table: SqlServerTable): SqlServerStream {
  if (table.primaryKey.length > 0 && table.changeTracking === 'readable')
    return new ChangeTrackingStream(table);
  if (table.primaryKey.length > 0 && table.rowversion !== undefined)
    return new RowversionStream(table);
  return new FullRefreshStream(table);
}

// Every table one SQL Server database holds that the login can read, one
// stream each, named <schema>.<table>. The streams are the database's own
// tables, so a source is discovered, and a host discovers it again on every
// run: a table whose columns changed arrives as a changed stream, which
// starts its copy over.
export class SqlServerSource extends Source<SqlServerSession> {
  readonly identity: string;
  protected readonly catalog: Catalog;
  readonly #database: SqlServerDatabase;
  readonly #streams: ReadonlyMap<string, SqlServerStream>;

  static async discover(
    database: SqlServerDatabase,
    options: { readonly schemas?: readonly string[] } = {},
  ): Promise<SqlServerSource> {
    await using session = await database.open();
    // A table whose every column is denied has nothing to read.
    const tables = (await session.tables()).filter(
      ({ schema, columns }) =>
        columns.length > 0 &&
        (options.schemas === undefined || options.schemas.includes(schema)),
    );
    // A schema that keeps nothing is misspelled, cased unlike the database, or
    // not granted; loading less in silence would hide it.
    for (const schema of options.schemas ?? [])
      if (!tables.some((table) => table.schema === schema))
        throw new TypeError(
          `The schemas to keep name ${schema}, which holds no table this login can read in ${database.location}`,
        );
    return new SqlServerSource(database, tables.map(streamFor));
  }

  private constructor(
    database: SqlServerDatabase,
    streams: readonly SqlServerStream[],
  ) {
    super();
    this.identity = `sql-server:${database.location}`;
    this.#database = database;
    this.#streams = new Map(
      streams.map((stream) => [stream.stream.name, stream]),
    );
    this.catalog = new Catalog(streams.map(({ stream }) => stream));
    Object.freeze(this);
  }

  // The streams the database's tables became, by name.
  get streams(): readonly Stream[] {
    return this.catalog.streams;
  }

  protected override open(): Promise<SqlServerSession> {
    return this.#database.open();
  }

  override failureType(error: unknown): FailureType {
    return error instanceof SqlServerPermissionError ||
      error instanceof SqlServerUnavailableError
      ? 'config'
      : 'system';
  }

  coverage(stream: Stream): ExtractionCoverage {
    return this.#reader(stream).coverage();
  }

  // Polls the database's change counters: a moved Change Tracking version
  // wakes the streams read through it, a moved rowversion the streams read
  // by theirs; streams with neither refresh on an interval.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    await using session = await this.#database.open();
    let seen = await session.version();
    let refreshed = Date.now();
    yield streams;
    const of = <T extends SqlServerStream>(
      kind: abstract new (...args: never[]) => T,
    ) => streams.filter((stream) => this.#reader(stream) instanceof kind);
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = await session.version();
        const changed = [
          ...(current.changeTracking === seen.changeTracking
            ? []
            : of(ChangeTrackingStream)),
          ...(current.rowversion === seen.rowversion
            ? []
            : of(RowversionStream)),
          ...(Date.now() - refreshed < fullRefreshIntervalMs
            ? []
            : of(FullRefreshStream)),
        ];
        seen = current;
        if (
          changed.some(
            (stream) => this.#reader(stream) instanceof FullRefreshStream,
          )
        )
          refreshed = Date.now();
        if (changed.length > 0) yield changed;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: Partition | null,
    session: SqlServerSession,
  ): AsyncIterable<SourceMessage> {
    return this.#reader(configuration.stream).extract(
      configuration,
      state,
      session,
    );
  }

  #reader(stream: Stream): SqlServerStream {
    const reader = this.#streams.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`SQL Server has no stream ${stream.name}`);
    return reader;
  }
}
