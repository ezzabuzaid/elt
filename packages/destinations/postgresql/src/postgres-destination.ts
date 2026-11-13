import {
  type CopyConfiguration,
  Destination,
  type Load,
  type PipelineClock,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import { PostgresAppendWriter } from './postgres-append-writer.ts';
import { type PostgresReading, readAsOf } from './postgres-as-of.ts';
import type { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { PostgresDeduplicatingWriter } from './postgres-deduplicating-writer.ts';
import { PostgresLoad } from './postgres-load.ts';
import { positionsAfter } from './postgres-numbering.ts';
import { PostgresOverwriteWriter } from './postgres-overwrite-writer.ts';
import {
  PostgresSession,
  connectionUrl,
  schemaName,
} from './postgres-session.ts';
import { PostgresTable } from './postgres-table.ts';
import type { PostgresWriter } from './postgres-writer.ts';

// Loads into one schema of one database. The URL carries credentials, so it
// stays private and out of location(), which is persisted with checkpoints.
export class PostgresDestination extends Destination<PostgresTable> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
    'append_dedup',
    'overwrite_dedup',
  ] as const);
  readonly schema: string;
  // How long the history keeps a position readable: 30 days unless set, as
  // Delta Lake keeps its log. The destinations of one database share one
  // numbering, so the shortest retention among them decides.
  readonly retention: Temporal.Duration;
  readonly #url: string;

  constructor({
    url,
    schema,
    retention = Temporal.Duration.from({ days: 30 }),
  }: {
    url: string;
    schema: string;
    retention?: Temporal.Duration;
  }) {
    super();
    if (retention.sign < 0)
      throw new RangeError(`Retention ${retention} must not be negative`);
    this.#url = connectionUrl(url);
    this.schema = schemaName(schema);
    this.retention = retention;
    Object.freeze(this);
  }

  override location(target: PostgresTable): string {
    return `${quote(this.schema)}.${target.quotedName}`;
  }

  // One connection for the whole run; each commit is its own transaction,
  // numbered in the numbering that the destinations of the database share.
  override async load(owner: {
    clock: PipelineClock;
    connection: string;
  }): Promise<Load<PostgresTable>> {
    const load = await PostgresLoad.open(this.#url, {
      ...owner,
      retention: this.retention,
    });
    return {
      prepare: (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(load, binding),
      [Symbol.asyncDispose]: () => load[Symbol.asyncDispose](),
    };
  }

  // The positions of the database after a position, ascending, or all of
  // them; each one, `${epoch}:${number}`, names a commit where no pass of any
  // schema of the database is half read. A position of another epoch, or past
  // the newest commit, is expired.
  async positions(
    after?: string,
  ): Promise<readonly string[] | { readonly expired: string }> {
    await using session = new PostgresSession(this.#url, 'elt-positions');
    return await positionsAfter(session.sql, after);
  }

  // The database as of a position, or as of its newest one, read through the
  // reader views: { expired } for a position of another epoch or past the
  // newest commit, and a TypeError for one inside a pass or not a position.
  reading(
    position?: string,
  ): Promise<PostgresReading | { readonly expired: string }> {
    return readAsOf(this.#url, position);
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
          this.schema,
          table,
          this.retention,
        );
      case 'append':
        return new PostgresAppendWriter(
          configuration,
          this.#url,
          this.schema,
          table,
          this.retention,
        );
      case 'overwrite':
        return new PostgresOverwriteWriter(
          configuration,
          this.#url,
          this.schema,
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
