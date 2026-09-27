import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CopyConfiguration, Load } from 'elt';
import { Destination } from 'elt';
import { SQLiteAppendWriter } from './sqlite-append-writer.ts';
import type { SQLiteColumn } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import { SQLiteDeduplicatingWriter } from './sqlite-deduplicating-writer.ts';
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

  override identity(target: SQLiteTable): string {
    return JSON.stringify({ type: 'sqlite', path: this.path, target });
  }

  override location(target: SQLiteTable): string {
    return target.location;
  }

  // One connection and one write transaction for the whole run; each commit
  // takes the lock straight back.
  override async load(): Promise<Load<SQLiteTable>> {
    const database = new DatabaseSync(this.path);
    try {
      database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      database.close();
      throw error;
    }
    const loadedAt = new Date().toISOString();
    return {
      prepare: async (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(
          database,
          binding,
          loadedAt,
        ),
      [Symbol.asyncDispose]: async () => {
        try {
          if (database.isTransaction) database.exec('ROLLBACK');
        } finally {
          database.close();
        }
      },
    };
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
        return new SQLiteAppendWriter(configuration.stream, this.path, table);
      case 'overwrite':
        return new SQLiteOverwriteWriter(
          configuration.stream,
          this.path,
          table,
        );
      default:
        throw new TypeError(
          `Destination does not support ${configuration.destinationSyncMode}`,
        );
    }
  }
}
