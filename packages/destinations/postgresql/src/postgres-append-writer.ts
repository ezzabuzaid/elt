import { quote } from './identifier.ts';
import { PostgresWriter, type Transaction } from './postgres-writer.ts';

export class PostgresAppendWriter extends PostgresWriter {
  protected override async initialize(transaction: Transaction): Promise<void> {
    await transaction.unsafe(this.createTableSQL);
    // A mode change releases the deduplication index. Dropping only one that
    // exists avoids an exclusive lock that would block readers every run.
    for (const index of await this.dedupIndexes(transaction))
      await transaction.unsafe(
        `DROP INDEX ${quote(this.schema)}.${quote(index)}`,
      );
  }
}
