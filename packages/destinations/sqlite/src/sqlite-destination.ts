import { resolve } from 'node:path';

import type { CopyConfiguration, Load, PipelineClock } from '@eltjs/elt';
import { Destination } from '@eltjs/elt';

import { SQLiteAppendWriter } from './sqlite-append-writer.ts';
import { type SQLiteReading, readAsOf, reader } from './sqlite-as-of.ts';
import type { SQLiteColumn } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import { SQLiteDeduplicatingWriter } from './sqlite-deduplicating-writer.ts';
import { SQLiteLoad, positionsAfter } from './sqlite-loads.ts';
import { SQLiteOverwriteWriter } from './sqlite-overwrite-writer.ts';
import { SQLiteTable } from './sqlite-table.ts';
import type { SQLiteWriter } from './sqlite-writer.ts';

export class SQLiteDestination extends Destination<SQLiteTable> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
    'append_dedup',
    'overwrite_dedup',
  ] as const);
  readonly path: string;
  // How long the history keeps a position readable after its commit; Delta
  // Lake keeps its log for the same 30 days by default.
  readonly retention: Temporal.Duration;

  constructor({
    path,
    retention = Temporal.Duration.from({ days: 30 }),
  }: {
    path: string;
    retention?: Temporal.Duration;
  }) {
    super();
    if (!path) throw new TypeError('SQLite requires a database path');
    if (retention.sign < 0)
      throw new RangeError(`Retention ${retention} must not be negative`);
    this.path = path === ':memory:' ? path : resolve(path);
    this.retention = retention;
    Object.freeze(this);
  }

  override location(target: SQLiteTable): string {
    return target.location;
  }

  // Each stream's commit is its own short transaction, so no transaction
  // stays open while the sources read.
  override async load({
    clock,
    connection,
  }: {
    clock: PipelineClock;
    connection: string;
  }): Promise<Load<SQLiteTable>> {
    const load = SQLiteLoad.open(
      this.path,
      { connector: connection },
      { clock, retention: this.retention },
    );
    return {
      prepare: async (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(load, binding),
      [Symbol.asyncDispose]: async () => load[Symbol.dispose](),
    };
  }

  // The positions of the file after a position, ascending, or all of them;
  // each one, `${epoch}:${number}`, names a commit where no pass is half
  // read. A position of another epoch, or past the newest commit, is
  // expired, and so is one older than the retention.
  positions(after?: string): readonly string[] | { readonly expired: string } {
    if (this.path === ':memory:')
      throw new TypeError('Positions require a SQLite destination file');
    using database = reader(this.path);
    return positionsAfter(database, after);
  }

  // The file as of a position, or as of its newest position: each target,
  // its reader view and each view over them show the rows that the commit of
  // the position left, and the sync history refuses to be read. At the
  // newest commit the reading reads the tables as they are. It opens the
  // file read-only, in one read transaction. A position of another epoch,
  // past the newest commit, or older than the retention, is expired.
  reading(position?: string): SQLiteReading | { readonly expired: string } {
    if (this.path === ':memory:')
      throw new TypeError('Readings require a SQLite destination file');
    return readAsOf(this.path, position);
  }

  table(
    name: string,
    configure?: (columns: SQLiteColumns) => readonly SQLiteColumn[],
  ): SQLiteTable {
    return new SQLiteTable(name, configure?.(new SQLiteColumns()));
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: SQLiteTable,
  ): SQLiteWriter {
    this.validateConfiguration(configuration, target);
    if (!(target instanceof SQLiteTable))
      throw new TypeError('SQLite requires SQLite table targets');
    if (configuration.syncMode === 'incremental' && this.path === ':memory:')
      throw new TypeError(
        'Incremental SQLite requires a persistent destination file',
      );
    const table = target.resolve(configuration.stream);
    switch (configuration.destinationSyncMode) {
      case 'append_dedup':
      case 'overwrite_dedup':
        return new SQLiteDeduplicatingWriter(configuration, this, table);
      case 'append':
        return new SQLiteAppendWriter(configuration, this, table);
      case 'overwrite':
        return new SQLiteOverwriteWriter(configuration, this, table);
      default:
        throw new TypeError(
          `Destination does not support ${configuration.destinationSyncMode}`,
        );
    }
  }
}
