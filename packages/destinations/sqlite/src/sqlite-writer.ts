import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { KeyValue, Stream } from 'elt';
import {
  CommittedWriteError,
  FileContent,
  TargetOwnedError,
  type WriteCount,
  type WriteOperation,
  Writer,
} from 'elt';
import { SQLiteFileStore } from './sqlite-file-store.ts';
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
      .update(this.table.location)
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

  // Only a load that identifies rows by key can remove one.
  protected deletion(
    _database: DatabaseSync,
  ): ((key: Readonly<Record<string, KeyValue>>) => void) | undefined {
    return undefined;
  }

  // The owner lives beside the table it guards and commits with the load. A
  // dropped table releases it, since nothing it held remains.
  private own(database: DatabaseSync, writer: string): void {
    database.exec(
      'CREATE TABLE IF NOT EXISTS "_mac_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT',
    );
    database.exec(
      `DELETE FROM "_mac_elt_writers" WHERE "target" NOT IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`,
    );
    const owner = database
      .prepare('SELECT "writer" FROM "_mac_elt_writers" WHERE "target" = ?')
      .get(this.table.location)?.writer;
    if (owner === undefined)
      database
        .prepare(
          'INSERT INTO "_mac_elt_writers" ("target", "writer") VALUES (?, ?)',
        )
        .run(this.table.location, writer);
    else if (owner !== writer)
      throw new TargetOwnedError(this.table.name, String(owner), writer);
  }

  protected override async writeRecords(
    operations: AsyncIterable<WriteOperation>,
    writer: string,
  ): Promise<WriteCount> {
    let committed: WriteCount | undefined;
    try {
      using database = new DatabaseSync(this.path);
      // ponytail: holds the write transaction during extraction; stage first if long reads block other writers.
      database.exec('BEGIN IMMEDIATE');
      try {
        this.own(database, writer);
        // Only this library-owned mode index is replaced; explicit SQL constraints remain authoritative.
        database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
        database.exec(this.table.createTableSQL);
        // Triggers must exist before initialize, whose DELETE clears old chunks.
        const stores = this.table.columns
          .filter((column) => column.storesFile)
          .map((column) => ({
            column,
            store: new SQLiteFileStore(database, this.table, column),
          }));
        this.initialize(database);
        const insert = database.prepare(this.insertSQL);
        const remove = this.deletion(database);
        const loadedAt = new Date().toISOString();
        let count = 0;
        let deleted = 0;
        for await (const operation of operations) {
          if (operation.type === 'RECORD') {
            const saved: { store: SQLiteFileStore; file: number }[] = [];
            let data = operation.data;
            for (const { column, store } of stores) {
              const content: unknown = Reflect.get(Object(data), column.name);
              if (!(content instanceof FileContent)) continue;
              const file = await store.save(content);
              saved.push({ store, file });
              data = { ...Object(data), [column.name]: file };
            }
            const { changes } = insert.run(...this.encode(data), loadedAt);
            // A deduplication guard kept the loaded row; its files are unused.
            if (changes === 0)
              for (const { store, file } of saved) store.discard(file);
            count++;
          } else {
            if (remove === undefined)
              throw new TypeError(
                'Only deduplicating loads can apply deletions',
              );
            remove(operation.key);
            deleted++;
          }
        }
        database.exec('COMMIT');
        committed = { count, deleted };
        return committed;
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
