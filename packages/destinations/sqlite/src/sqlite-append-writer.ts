import type { DatabaseSync } from 'node:sqlite';

import type { CopyConfiguration } from '@workspace/elt';

import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter } from './sqlite-writer.ts';

export class SQLiteAppendWriter extends SQLiteWriter {
  constructor(
    configuration: CopyConfiguration,
    path: string,
    table: SQLiteTable,
  ) {
    super(configuration, path, table);
    Object.freeze(this);
  }

  protected override initialize(): void {}

  protected override merge(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
  ): void {
    this.append(database, stage, loadedAt);
  }
}
