import { PostgresAppendWriter } from './postgres-append-writer.ts';

// Replaces the target at its commit with DELETE, not TRUNCATE: TRUNCATE's
// exclusive lock would block readers for the rest of the run.
export class PostgresOverwriteWriter extends PostgresAppendWriter {
  protected override get replaces(): boolean {
    return true;
  }
}
