import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { KeyValue, Stream } from 'elt';
import {
  FileContent,
  type Load,
  TargetMissingError,
  TargetOwnedError,
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
  private writers(database: DatabaseSync): void {
    database.exec(
      'CREATE TABLE IF NOT EXISTS "_mac_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT',
    );
  }

  private own(database: DatabaseSync, writer: string): void {
    this.writers(database);
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

  override async clear(writer: string): Promise<void> {
    using database = new DatabaseSync(this.path);
    database.exec('BEGIN IMMEDIATE');
    try {
      this.writers(database);
      const owner = database
        .prepare('SELECT "writer" FROM "_mac_elt_writers" WHERE "target" = ?')
        .get(this.table.location)?.writer;
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(this.table.name, String(owner), writer);
      // Emptied, not dropped: views built on the table keep working, and the
      // file triggers remove each row's stored chunks.
      if (
        database
          .prepare(
            `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`,
          )
          .get(this.table.location)
      )
        database.exec(`DELETE FROM ${this.table.quotedName}`);
      database
        .prepare('DELETE FROM "_mac_elt_writers" WHERE "target" = ?')
        .run(this.table.location);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  protected override async open(
    writer: string,
    resuming: boolean,
  ): Promise<Load> {
    const database = new DatabaseSync(this.path);
    // Each unit runs in a savepoint, so discarding a failed read never undoes
    // the owner record and schema the first transaction prepared.
    const begin = () => {
      if (database.isTransaction) return;
      // ponytail: holds the write lock during extraction; stage first if long reads block other writers.
      database.exec('BEGIN IMMEDIATE');
      database.exec('SAVEPOINT unit');
    };
    try {
      database.exec('BEGIN IMMEDIATE');
      if (
        resuming &&
        !database
          .prepare(
            `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`,
          )
          .get(this.table.location)
      )
        throw new TargetMissingError(this.table.name, writer);
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
      database.exec('SAVEPOINT unit');
      return {
        apply: async (operation) => {
          begin();
          if (operation.type === 'DELETE') {
            if (remove === undefined)
              throw new TypeError(
                'Only deduplicating loads can apply deletions',
              );
            remove(operation.key);
            return;
          }
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
        },
        commit: async () => {
          if (!database.isTransaction) return;
          database.exec('RELEASE unit');
          database.exec('COMMIT');
        },
        discard: async () => {
          if (database.isTransaction) database.exec('ROLLBACK TO unit');
        },
        [Symbol.asyncDispose]: async () => {
          try {
            if (database.isTransaction) database.exec('ROLLBACK');
          } finally {
            database.close();
          }
        },
      };
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      database.close();
      throw error;
    }
  }
}
