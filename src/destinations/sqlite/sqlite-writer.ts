import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Stream } from '../../core/stream.ts';
import { CommittedWriteError, Writer } from '../../core/writer.ts';
import type { SQLiteTable } from './sqlite-table.ts';

export abstract class SQLiteWriter extends Writer {
  constructor(
    stream: Stream,
    readonly path: string,
    readonly table: SQLiteTable,
  ) {
    super(stream);
  }

  protected abstract initialize(database: DatabaseSync): void;

  protected get dedupIndex(): string {
    return `"_mac_elt_dedup_${createHash('sha256')
      .update(
        this.table.name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase()),
      )
      .digest('hex')}"`;
  }

  protected get insertSQL(): string {
    const fields = [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
    return `INSERT INTO ${this.table.quotedName} AS "_mac_elt_target" (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`;
  }

  protected encode(record: unknown): SQLInputValue[] {
    return this.table.columns.map((column) => column.encode(record));
  }

  protected override async writeRecords(
    records: AsyncIterable<unknown>,
  ): Promise<number> {
    let committed: number | undefined;
    try {
      using database = new DatabaseSync(this.path);
      // ponytail: holds the write transaction during extraction; stage first if long reads block other writers.
      database.exec('BEGIN IMMEDIATE');
      try {
        // Only this library-owned mode index is replaced; explicit SQL constraints remain authoritative.
        database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
        this.initialize(database);
        const insert = database.prepare(this.insertSQL);
        const loadedAt = new Date().toISOString();
        let count = 0;
        for await (const record of records) {
          insert.run(...this.encode(record), loadedAt);
          count++;
        }
        database.exec('COMMIT');
        committed = count;
        return count;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    } catch (cause) {
      if (committed !== undefined)
        throw new CommittedWriteError(
          committed,
          'Destination committed, but cleanup failed; retry may replay records',
          cause,
        );
      throw cause;
    }
  }
}
