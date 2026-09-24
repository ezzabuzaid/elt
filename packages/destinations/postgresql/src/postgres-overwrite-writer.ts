import { PostgresAppendWriter } from './postgres-append-writer.ts';
import type { Transaction } from './postgres-writer.ts';

export class PostgresOverwriteWriter extends PostgresAppendWriter {
  // DELETE, not TRUNCATE: the transaction stays open while the source is
  // read, and TRUNCATE's exclusive lock would block readers for all of it.
  protected override async initialize(transaction: Transaction): Promise<void> {
    await super.initialize(transaction);
    await transaction.unsafe(`DELETE FROM ${this.qualifiedName}`);
  }
}
