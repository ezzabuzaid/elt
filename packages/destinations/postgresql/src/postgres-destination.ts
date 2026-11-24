import {
  type CopyConfiguration,
  Destination,
  type FailureType,
  type FileStorage,
  type Load,
  type PipelineClock,
  parsePosition,
  positionsAfter,
} from '@eltjs/elt';

import { PostgresAppendWriter } from './postgres-append-writer.ts';
import { type PostgresReading, readAsOf } from './postgres-as-of.ts';
import type { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { PostgresDeduplicatingWriter } from './postgres-deduplicating-writer.ts';
import { failureType } from './postgres-failure-type.ts';
import { PostgresFiles } from './postgres-files.ts';
import { PostgresLoad } from './postgres-load.ts';
import { postgresDatabase, readNumbering } from './postgres-numbering.ts';
import { PostgresOverwriteWriter } from './postgres-overwrite-writer.ts';
import { PostgresSession, connectionUrl } from './postgres-session.ts';
import { PostgresTable } from './postgres-table.ts';
import type { PostgresWriter } from './postgres-writer.ts';

// Loads into one database: each target is a reader view in marts over a raw
// table in _warehouse (ADR 0010). The URL carries credentials, so it stays
// private and out of location(), which is persisted with checkpoints.
export class PostgresDestination extends Destination<PostgresTable> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
    'append_dedup',
    'overwrite_dedup',
  ] as const);
  // How long the history keeps a position readable: 30 days unless set, as
  // Delta Lake keeps its log. The destinations of one database share one
  // numbering, so the shortest retention among them decides.
  readonly retention: Temporal.Duration;
  // Whether a computed dataset with a vector column runs CREATE EXTENSION IF
  // NOT EXISTS vector when the database has no type vector, as Haystack's
  // and LangChain's create_extension do: true unless set. When false, such a
  // dataset fails with a PostgresSetupError, of failure type config.
  readonly createExtension: boolean;
  readonly #url: string;

  constructor({
    url,
    retention = Temporal.Duration.from({ days: 30 }),
    createExtension = true,
  }: {
    url: string;
    retention?: Temporal.Duration;
    createExtension?: boolean;
  }) {
    super();
    if (retention.sign < 0)
      throw new RangeError(`Retention ${retention} must not be negative`);
    this.#url = connectionUrl(url);
    this.retention = retention;
    this.createExtension = createExtension;
    Object.freeze(this);
  }

  // The connection URL, for the views and computed datasets of the
  // destination. A getter, so neither JSON nor util.inspect shows it.
  get url(): string {
    return this.#url;
  }

  override location(target: PostgresTable): string {
    return target.raw;
  }

  // One connection for the whole run; each commit is its own transaction,
  // numbered in the numbering that the destinations of the database share.
  override async load(owner: {
    clock: PipelineClock;
    connection: string;
  }): Promise<Load<PostgresTable>> {
    const load = await PostgresLoad.open(
      this.#url,
      { connector: owner.connection },
      { clock: owner.clock, retention: this.retention },
    );
    return {
      prepare: (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(load, binding),
      [Symbol.asyncDispose]: () => load[Symbol.asyncDispose](),
    };
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }

  // The positions of the database after a position, ascending, or all of
  // them; each one, `${epoch}:${number}`, names a commit where no pass of the
  // database is half read. A position of another epoch, or past the newest
  // commit, is expired.
  async positions(
    after?: string,
  ): Promise<readonly string[] | { readonly expired: string }> {
    const since =
      after === undefined ? undefined : parsePosition(after, postgresDatabase);
    await using session = new PostgresSession(this.#url, 'elt-positions');
    return positionsAfter(
      await readNumbering(session.sql),
      since,
      postgresDatabase,
    );
  }

  // The database as of a position, or as of its newest one, read through the
  // reader views: { expired } for a position of another epoch or past the
  // newest commit, and a TypeError for one inside a pass or not a position.
  reading(
    position?: string,
  ): Promise<PostgresReading | { readonly expired: string }> {
    return readAsOf(this.#url, position);
  }

  // A file storage in the database of this destination, which a copy gives
  // to .store() and a DocumentText reads.
  files(): FileStorage {
    return new PostgresFiles(this.#url);
  }

  table(
    name: string,
    configure?: (columns: PostgresColumns) => readonly PostgresColumn[],
  ): PostgresTable {
    return new PostgresTable(name, configure?.(new PostgresColumns()));
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: PostgresTable,
  ): PostgresWriter {
    this.validateConfiguration(configuration, target);
    if (!(target instanceof PostgresTable))
      throw new TypeError('Postgres requires Postgres table targets');
    const table = target.resolve(configuration.stream);
    switch (configuration.destinationSyncMode) {
      case 'append_dedup':
      case 'overwrite_dedup':
        return new PostgresDeduplicatingWriter(
          configuration,
          this.#url,
          table,
          this.retention,
        );
      case 'append':
        return new PostgresAppendWriter(
          configuration,
          this.#url,
          table,
          this.retention,
        );
      case 'overwrite':
        return new PostgresOverwriteWriter(
          configuration,
          this.#url,
          table,
          this.retention,
        );
      default:
        throw new TypeError(
          `Destination does not support ${configuration.destinationSyncMode}`,
        );
    }
  }
}
