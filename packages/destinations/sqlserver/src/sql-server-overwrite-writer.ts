import { SqlServerAppendWriter } from './sql-server-append-writer.ts';

// Replaces the rows of the target with the records of a run, by difference
// and with DELETE, not TRUNCATE: TRUNCATE takes a schema modification lock,
// which readers wait for.
export class SqlServerOverwriteWriter extends SqlServerAppendWriter {
  protected override get replaces(): boolean {
    return true;
  }
}
