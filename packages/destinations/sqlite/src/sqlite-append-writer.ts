import type { DatabaseSync } from 'node:sqlite';
import type { Stream } from 'elt';
import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter } from './sqlite-writer.ts';

export class SQLiteAppendWriter extends SQLiteWriter {
  constructor(stream: Stream, path: string, table: SQLiteTable) {
    super(stream, path, table);
    Object.freeze(this);
  }

  protected override initialize(database: DatabaseSync): void {
    database.exec(this.table.createTableSQL);
  }
}
