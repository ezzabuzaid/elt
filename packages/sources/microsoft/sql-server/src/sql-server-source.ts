import { pollChanges } from '@zukhruf/async';

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
import type { ChangeSignal } from './signals/change-signal.ts';
import { WholeTableSignals } from './signals/whole-table-signals.ts';
import { SnapshotStream } from './snapshot-stream.ts';
import type { SqlServerStream } from './sql-server-stream.ts';

// How often a watch asks the database whether anything changed.
const pollIntervalMs = 30_000;

// Change Tracking when the login can read it, else the rowversion, else a
// snapshot of the whole table, all by key; a table with no key in full.
function streamFor(
  table: SqlServerTable,
  watch: WholeTableSignals,
): SqlServerStream {
  if (table.primaryKey.length === 0) return new FullRefreshStream(table, watch);
  if (table.changeTracking === 'readable')
    return new ChangeTrackingStream(table);
  if (table.rowversion !== undefined) return new RowversionStream(table);
  return new SnapshotStream(table, watch);
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
    const watch = await WholeTableSignals.discover(session);
    return new SqlServerSource(
      database,
      tables.map((table) => streamFor(table, watch)),
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

  // Checks the signals of the streams every 30 s: each signal reads once for
  // every table, and a stream wakes when the value of any signal it names
  // moved since the last check.
  protected override async *observe({
    streams,
    signal,
    clock,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    await using session = await this.#database.open();
    const started = clock.Date.now();
    // The reads of one check, by signal. pollChanges reads in the order of
    // the map, so the first stream's read starts a new check, and each
    // stream after it takes the reads of the signals it shares.
    let check = new Map<ChangeSignal, ReturnType<ChangeSignal['read']>>();
    const read = (changeSignal: ChangeSignal) => {
      const known = check.get(changeSignal);
      if (known !== undefined) return known;
      const values = changeSignal.read({
        session,
        started,
        now: clock.Date.now(),
      });
      check.set(changeSignal, values);
      return values;
    };
    const probes = new Map(
      streams.map((stream, index) => {
        const reader = this.#reader(stream);
        return [
          stream,
          async () => {
            if (index === 0) check = new Map();
            const values = await Promise.all(reader.signals.map(read));
            return JSON.stringify(values.map((value) => value(reader.table)));
          },
        ];
      }),
    );
    for await (const changed of pollChanges(probes, {
      interval: pollIntervalMs,
      signal,
      clock,
    }))
      if (changed.size > 0) yield [...changed];
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
