import { SqlServerDeduplicatingWriter } from './sql-server-deduplicating-writer.ts';

// Replaces the rows of the target with one record for each key of a run, by
// difference.
export class SqlServerOverwriteDeduplicatingWriter extends SqlServerDeduplicatingWriter {
  protected override get replaces(): boolean {
    return true;
  }
}
