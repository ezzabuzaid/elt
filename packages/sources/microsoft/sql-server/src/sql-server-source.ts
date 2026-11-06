import { ChangeWatcher, type Gauge, Group } from '@zukhruf/async';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
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
  SqlServerLoginError,
  SqlServerPermissionError,
} from '@workspace/sdk-microsoft-sql-server';

import { ChangeTrackingStream } from './change-tracking-stream.ts';
import { FullRefreshStream } from './full-refresh-stream.ts';
import { RowversionStream } from './rowversion-stream.ts';
import { SnapshotStream } from './snapshot-stream.ts';
import type { SqlServerStream } from './sql-server-stream.ts';
import { WatchGauges } from './watch-gauges.ts';
import { WholeTableGauges } from './whole-table-gauges.ts';

// How often a watch asks the database whether anything changed.
const pollIntervalMs = 30_000;

// How long the queries of one check can take. Each query took 160 to 300 ms
// on Azure SQL Database, and a check runs at most four at once, one on each
// connection of the session. A check that takes a third of the interval is
// stuck: its gauges fail, and the watch fails with them, as a system failure
// that the pipeline watches again after.
const checkTimeoutMs = 10_000;

// The gauges of one stream: a check wakes the stream when one changed.
class StreamGroup extends Group {
  readonly stream: Stream;

  constructor(stream: Stream, members: readonly Gauge[]) {
    super(members);
    this.stream = stream;
  }
}

// Change Tracking when the login can read it, else the rowversion, else a
// snapshot of the whole table, all by key; a table with no key in full.
function streamFor(
  table: SqlServerTable,
  whole: WholeTableGauges,
): SqlServerStream {
  if (table.primaryKey.length === 0) return new FullRefreshStream(table, whole);
  if (table.changeTracking === 'readable')
    return new ChangeTrackingStream(table);
  if (table.rowversion !== undefined) return new RowversionStream(table);
  return new SnapshotStream(table, whole);
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
    const whole = await WholeTableGauges.discover(session);
    return new SqlServerSource(
      database,
      tables.map((table) => streamFor(table, whole)),
    );
  }

  private constructor(
    database: SqlServerDatabase,
    streams: readonly SqlServerStream[],
  ) {
    super();
    this.identity = `sql-server:${database.name}`;
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

  // A server that cannot be reached now is a system failure: a later
  // attempt, or a watch that watches again, can succeed.
  protected override readonly configErrors = [
    SqlServerLoginError,
    SqlServerPermissionError,
  ];

  coverage(stream: Stream): ExtractionCoverage {
    return this.#reader(stream).coverage();
  }

  async currentAsOf() {
    return null;
  }

  // Checks the gauges of the streams every 30 s, and yields the streams
  // whose gauges changed. The first check wakes every stream; a check that
  // wakes none yields nothing; a gauge that fails fails the watch.
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    await using session = await this.#database.open();
    const gauges = new WatchGauges(session);
    const watcher = new ChangeWatcher(
      streams.map(
        (stream) =>
          new StreamGroup(stream, this.#reader(stream).gauges(gauges)),
      ),
      { interval: pollIntervalMs, timeout: checkTimeoutMs, clock },
    );
    for await (const outcomes of watcher.watch(signal)) {
      const woken: Stream[] = [];
      for (const [group, outcome] of outcomes) {
        if (outcome.state === 'failed') throw outcome.error;
        if (outcome.state === 'changed') woken.push(group.stream);
      }
      if (woken.length > 0) yield woken;
    }
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: Partition | null,
    session: SqlServerSession,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return this.#reader(configuration.stream).extract(
      configuration,
      state,
      session,
      signal,
    );
  }

  #reader(stream: Stream): SqlServerStream {
    const reader = this.#streams.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`SQL Server has no stream ${stream.name}`);
    return reader;
  }
}
