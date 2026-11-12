import type { DatabaseSync } from 'node:sqlite';

import type { CopyConfiguration } from '@eltjs/elt';

import type { SQLiteDestination } from './sqlite-destination.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter, type Stamp } from './sqlite-writer.ts';

export class SQLiteOverwriteWriter extends SQLiteWriter {
  constructor(
    configuration: CopyConfiguration,
    destination: SQLiteDestination,
    table: SQLiteTable,
  ) {
    super(configuration, destination, table);
    Object.freeze(this);
  }

  protected override get replaces(): boolean {
    return true;
  }

  protected override merge(
    database: DatabaseSync,
    stage: string,
    stamp: Stamp,
    into: string,
  ): void {
    this.append(database, stage, stamp, into);
  }
}
