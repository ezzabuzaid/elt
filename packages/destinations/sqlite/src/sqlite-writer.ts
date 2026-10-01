import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { CopyConfiguration, KeyValue, TargetDescription } from 'elt';
import {
  describeTarget,
  type FieldValues,
  FileContent,
  type Stage,
  TargetMissingError,
  TargetOwnedError,
  undescribed,
  Writer,
} from 'elt';
import type { SQLiteColumn } from './sqlite-column.ts';
import { describe } from './sqlite-descriptions.ts';
import { SQLiteFileStore } from './sqlite-file-store.ts';
import type { SQLiteTable } from './sqlite-table.ts';

// Keep competing loads out across commits, including while other streams have
// pending files. A separate native lock leaves the destination readable and
// releases automatically on process exit; the sidecar stores no records.
export function lockWriter(path: string): Disposable {
  const lock = new DatabaseSync(
    path === ':memory:' ? path : `${path}.writer-lock`,
  );
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return { [Symbol.dispose]: () => lock.close() };
  } catch (error) {
    lock.close();
    throw error;
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const seq = '"_mac_elt_seq"';
export const op = '"_mac_elt_op"';

// One stream's load inside a run's shared transaction. Operations wait in a
// connection-private TEMP stage, so another stream's commit never publishes
// them and a crash leaves nothing behind; commit merges them into the target
// with the result of applying them one at a time.
export abstract class SQLiteWriter extends Writer {
  readonly #description: TargetDescription;

  constructor(
    readonly configuration: CopyConfiguration,
    readonly path: string,
    readonly table: SQLiteTable,
  ) {
    super(configuration.stream);
    this.#description = describeTarget(
      configuration,
      table.columns,
      (column) =>
        `Integer reference to the source file's original bytes. Join ${quote(SQLiteFileStore.tableName(table, column))} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
    );
    if (table.readerView === undefined) return;
    const missing = undescribed(this.#description);
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${table.readerView} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
  }

  // Checks and indexes the target needs before its first merge.
  protected abstract initialize(database: DatabaseSync): void;

  // Moves the staged operations into the target.
  protected abstract merge(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
  ): void;

  // Inserts each staged record, in order.
  protected append(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
  ): void {
    database
      .prepare(
        `INSERT INTO ${this.table.quotedName} (${this.fields.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, ? FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
      )
      .run(loadedAt);
  }

  // An overwrite replaces the target at its first commit.
  protected get replaces(): boolean {
    return false;
  }

  // Empties the target a replacing commit is about to fill.
  protected replace(database: DatabaseSync): void {
    database.exec(`DELETE FROM ${this.table.quotedName}`);
  }

  private get hash(): string {
    return createHash('sha256').update(this.table.location).digest('hex');
  }

  protected get dedupIndex(): string {
    return quote(`_mac_elt_dedup_${this.hash}`);
  }

  protected get fields(): string[] {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
  }

  protected encode(record: unknown): SQLInputValue[] {
    return this.table.columns.map((column) => column.encode(record));
  }

  // Only a load that identifies rows by key can remove one.
  protected deletionKeys(
    _key: Readonly<Record<string, KeyValue>>,
  ): readonly [readonly SQLiteColumn[], SQLInputValue[]] {
    throw new TypeError('Only deduplicating loads can apply deletions');
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

  private exists(database: DatabaseSync, location: string): boolean {
    return (
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`,
        )
        .get(location) !== undefined
    );
  }

  private values(database: DatabaseSync): FieldValues {
    const { table } = this;
    return async function* (field) {
      const column = table.columns.find((column) => column.name === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      // clear also accepts a target or a declared column that was never loaded.
      if (
        !database
          .prepare(
            'SELECT 1 FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE',
          )
          .get(table.name, field)
      )
        return;
      for (const row of database
        .prepare(
          `SELECT ${column.quotedName} AS value FROM ${table.quotedName}`,
        )
        .iterate())
        yield row.value;
    };
  }

  override async clear(
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    using _lock = lockWriter(this.path);
    using database = new DatabaseSync(this.path);
    database.exec('BEGIN IMMEDIATE');
    try {
      this.writers(database);
      const owner = database
        .prepare('SELECT "writer" FROM "_mac_elt_writers" WHERE "target" = ?')
        .get(this.table.location)?.writer;
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(this.table.name, String(owner), writer);
      // Emptied, not dropped: views built on the table keep working. With no
      // rows left, no stored chunk is referenced, including those a failed
      // stream left behind that the file triggers never see.
      if (this.exists(database, this.table.location)) {
        database.exec(`DELETE FROM ${this.table.quotedName}`);
        // A file column declared after the table's last load has no chunks.
        for (const column of this.table.columns) {
          const chunks = SQLiteFileStore.tableName(this.table, column);
          if (column.storesFile && this.exists(database, chunks))
            database.exec(`DELETE FROM ${quote(chunks)}`);
        }
      }
      database
        .prepare('DELETE FROM "_mac_elt_writers" WHERE "target" = ?')
        .run(this.table.location);
      database.exec('COMMIT');
      database.exec('BEGIN IMMEDIATE');
      await committed?.(this.values(database));
      database.exec('ROLLBACK');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  // What the table, its reader view and their columns say to readers,
  // rewritten with every load so they follow the stream's schema.
  private describe(database: DatabaseSync): void {
    const dataTypes = new Map([
      ...this.table.columns.map(
        ({ name, dataType }) => [name, dataType] as const,
      ),
      ['loaded_at', 'timestamp'] as const,
    ]);
    const columns = Object.fromEntries(
      Object.entries(this.#description.columns).map(([name, description]) => [
        name,
        { description, dataType: dataTypes.get(name) },
      ]),
    );
    describe(database, this.table.name, this.#description.table, columns);
    if (this.table.readerView !== undefined)
      describe(
        database,
        this.table.readerView,
        this.#description.table,
        columns,
      );
  }

  // Created only when absent and never replaced inside the load: replacing a
  // view readers can see would lock them out until this load commits. A view
  // of other columns or another table is refused rather than adopted.
  private installReaderView(database: DatabaseSync, view: string): void {
    const definition = `CREATE VIEW ${quote(view)} AS SELECT ${this.fields.join(', ')} FROM ${this.table.quotedName}`;
    const existing = database
      .prepare(
        'SELECT "type", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)',
      )
      .get(view);
    if (existing === undefined) {
      database.exec(definition);
      return;
    }
    if (existing.type !== 'view' || existing.sql !== definition)
      throw new TypeError(
        `${quote(view)} is not a view of exactly ${this.table.quotedName}; drop it or delete the database`,
      );
  }

  // Refuses a target another writer owns, or a resumed one that was dropped,
  // and prepares it inside a savepoint, so a refused target leaves the shared
  // transaction as it was.
  prepare(
    database: DatabaseSync,
    { writer, resuming }: { writer: string; resuming: boolean },
    loadedAt: string,
  ): Stage {
    const name = quote(`_mac_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    const files = this.table.columns.filter((column) => column.storesFile);
    database.exec('SAVEPOINT prepare');
    let stores: { column: SQLiteColumn; store: SQLiteFileStore }[];
    try {
      if (resuming && !this.exists(database, this.table.location))
        throw new TargetMissingError(this.table.name, writer);
      this.own(database, writer);
      // Only this library-owned mode index is replaced; explicit SQL constraints remain authoritative.
      database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
      database.exec(this.table.createTableSQL);
      stores = files.map((column) => ({
        column,
        store: new SQLiteFileStore(database, this.table, column),
      }));
      // Chunks of a stream that failed after another stream committed them.
      for (const { column, store } of stores)
        database.exec(
          `DELETE FROM ${quote(store.name)} WHERE "file" NOT IN (SELECT ${column.quotedName} FROM ${this.table.quotedName} WHERE ${column.quotedName} IS NOT NULL)`,
        );
      this.initialize(database);
      if (this.table.readerView !== undefined)
        this.installReaderView(database, this.table.readerView);
      this.describe(database);
      database.exec(`DROP TABLE IF EXISTS ${stage}`);
      database.exec(
        `CREATE TEMP TABLE ${name} (${seq} INTEGER PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
      );
      database.exec('RELEASE prepare');
    } catch (error) {
      database.exec('ROLLBACK TO prepare');
      database.exec('RELEASE prepare');
      throw error;
    }
    const columns = this.table.columns.map((column) => column.quotedName);
    const record = database.prepare(
      `INSERT INTO ${stage} (${op}, ${columns.join(', ')}) VALUES ('R', ${columns.map(() => '?').join(', ')})`,
    );
    const staged = (column: SQLiteColumn) =>
      `SELECT ${column.quotedName} FROM ${stage} WHERE ${column.quotedName} IS NOT NULL`;
    // Files staged but never merged, and files a merge did not keep.
    const drop = () => {
      for (const { column, store } of stores)
        database.exec(
          `DELETE FROM ${quote(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (SELECT ${column.quotedName} FROM ${this.table.quotedName} WHERE ${column.quotedName} IS NOT NULL)`,
        );
      database.exec(`DELETE FROM ${stage}`);
    };
    let replaced = false;
    return {
      values: this.values(database),
      apply: async (operation) => {
        if (operation.type === 'DELETE') {
          const [keys, values] = this.deletionKeys(operation.key);
          database
            .prepare(
              `INSERT INTO ${stage} (${op}, ${keys.map((column) => column.quotedName).join(', ')}) VALUES ('D', ${keys.map(() => '?').join(', ')})`,
            )
            .run(...values);
          return;
        }
        // Each file is read here, before the source advances past it.
        let data = operation.data;
        for (const { column, store } of stores) {
          const content: unknown = Reflect.get(Object(data), column.name);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [column.name]: await store.save(content),
            };
        }
        record.run(...this.encode(data));
      },
      commit: async () => {
        database.exec('SAVEPOINT merge');
        try {
          if (this.replaces && !replaced) this.replace(database);
          this.merge(database, stage, loadedAt);
          drop();
          database.exec('RELEASE merge');
        } catch (error) {
          // SQLITE_FULL/IOERR can roll back the transaction and its savepoints.
          // Keep that original error instead of masking it with a rollback error.
          if (database.isTransaction) {
            database.exec('ROLLBACK TO merge');
            database.exec('RELEASE merge');
          }
          throw error;
        }
        replaced = true;
        // Commits and takes the lock back in one synchronous step.
        database.exec('COMMIT');
        database.exec('BEGIN IMMEDIATE');
      },
      discard: async () => drop(),
      [Symbol.asyncDispose]: async () => {
        drop();
        database.exec(`DROP TABLE ${stage}`);
      },
    };
  }
}
