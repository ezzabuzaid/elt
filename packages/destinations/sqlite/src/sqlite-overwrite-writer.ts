import type { DatabaseSync } from 'node:sqlite';

import type { CopyConfiguration } from '@eltjs/elt';

import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter, type Stamp } from './sqlite-writer.ts';

export class SQLiteOverwriteWriter extends SQLiteWriter {
  constructor(
    configuration: CopyConfiguration,
    path: string,
    table: SQLiteTable,
  ) {
    super(configuration, path, table);
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
