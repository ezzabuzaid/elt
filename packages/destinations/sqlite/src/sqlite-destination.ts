import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { UnavailableError, open } from '@zukhruf/sqlite-open';

import type { CopyConfiguration, Load, PipelineClock } from '@eltjs/elt';
import { Destination } from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { SQLiteAppendWriter } from './sqlite-append-writer.ts';
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

  constructor({ path }: { path: string }) {
    super();
    if (!path) throw new TypeError('SQLite requires a database path');
    this.path = path === ':memory:' ? path : resolve(path);
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
    const load = SQLiteLoad.open(this.path, connection, clock);
    return {
      prepare: async (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(load, binding),
      [Symbol.asyncDispose]: async () => load[Symbol.dispose](),
    };
  }

  // The positions of the file after a position, ascending, or all of them;
  // each one, `${epoch}:${number}`, names a commit where no pass is half
  // read. A position of another epoch, or past the newest commit, is
  // expired.
  positions(after?: string): readonly string[] | { readonly expired: string } {
    if (this.path === ':memory:')
      throw new TypeError('Positions require a SQLite destination file');
    using database = reader(this.path);
    return positionsAfter(database, after);
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
        return new SQLiteDeduplicatingWriter(configuration, this.path, table);
      case 'append':
        return new SQLiteAppendWriter(configuration, this.path, table);
      case 'overwrite':
        return new SQLiteOverwriteWriter(configuration, this.path, table);
      default:
        throw new TypeError(
          `Destination does not support ${configuration.destinationSyncMode}`,
        );
    }
  }
}

// A reader of the file, or null while no file is at the path.
function reader(path: string): DatabaseSync | null {
  try {
    return open(path, { readOnly: true, timeout: busyTimeout });
  } catch (error) {
    if (error instanceof UnavailableError) return null;
    throw error;
  }
}
