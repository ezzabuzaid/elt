import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  CopyConfiguration,
  FieldValues,
  KeyValue,
  Partition,
  ReloadMode,
  Stage,
  StoredFit,
  TargetDescription,
} from '@workspace/elt';
import {
  FileContent,
  TargetOwnedError,
  Writer,
  describeTarget,
  reloadMode,
} from '@workspace/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { describe } from './sqlite-descriptions.ts';
import { SQLiteFileStore } from './sqlite-file-store.ts';
import { identifiers } from './sqlite-identifiers.ts';
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
export const seq = '"_elt_seq"';
export const op = '"_elt_op"';

// One stream's load inside a run's shared transaction. Operations wait in a
// connection-private TEMP stage, so another stream's commit never publishes
// them and a crash leaves nothing behind; commit merges them into the target
// with the result of applying them one at a time.
export abstract class SQLiteWriter extends Writer {
  readonly configuration: CopyConfiguration;
  readonly path: string;
  readonly table: SQLiteTable;
  readonly #description: TargetDescription;

  constructor(
    configuration: CopyConfiguration,
    path: string,
    table: SQLiteTable,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.path = path;
    this.table = table;
    this.#description = describeTarget(
      configuration,
      table.columns,
      (column) =>
        `Integer reference to the source file's original bytes. Join ${quote(SQLiteFileStore.tableName(table, column))} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
    );
    if (table.readerView === undefined) return;
    const { missing } = this.#description;
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${table.readerView} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
  }

  // Checks and indexes the target needs before its first merge.
  // replacing: the first commit replaces the target, so its rows are moot.
  protected abstract initialize(
    database: DatabaseSync,
    replacing: boolean,
  ): void;

  // Moves the staged operations into the target, or the hidden target of a
  // reload.
  protected abstract merge(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
    into: string,
  ): void;

  // What a reload's hidden target needs once it is created, before the first
  // merge fills it, and once it takes the target's name.
  protected build(_database: DatabaseSync, _into: string): void {}
  protected adopt(_database: DatabaseSync): void {}

  // Inserts each staged record, in order.
  protected append(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
    into: string,
  ): void {
    database
      .prepare(
        `INSERT INTO ${into} (${this.fields.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, ? FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
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
    return quote(`_elt_dedup_${this.hash}`);
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
      'CREATE TABLE IF NOT EXISTS "_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT',
    );
  }

  private own(database: DatabaseSync, writer: string): void {
    this.writers(database);
    database.exec(
      `DELETE FROM "_elt_writers" WHERE "target" NOT IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`,
    );
    const owner = database
      .prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?')
      .get(this.table.location)?.writer;
    if (owner === undefined)
      database
        .prepare(
          'INSERT INTO "_elt_writers" ("target", "writer") VALUES (?, ?)',
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

  // The field's values in each of the tables, which while a reload is open
  // are the target and its hidden target: both rows still refer to files.
  private values(
    database: DatabaseSync,
    tables: () => readonly string[],
  ): FieldValues {
    const { table } = this;
    return async function* (field) {
      const column = table.columns.find((column) => column.field === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      for (const name of tables()) {
        // clear also accepts a target or a declared column that was never loaded.
        if (
          !database
            .prepare(
              'SELECT 1 FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE',
            )
            .get(name, column.name)
        )
          continue;
        for (const row of database
          .prepare(`SELECT ${column.quotedName} AS value FROM ${quote(name)}`)
          .iterate())
          yield row.value;
      }
    };
  }

  override async clear(
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    using _lock = lockWriter(this.path);
    // Waits for readers to finish, as a load's commit does.
    using database = new DatabaseSync(this.path, { timeout: 30_000 });
    database.exec('BEGIN IMMEDIATE');
    try {
      this.writers(database);
      const owner = database
        .prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?')
        .get(this.table.location)?.writer;
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(this.table.name, String(owner), writer);
      // Emptied, not dropped: views built on the table keep working. With no
      // rows left, no stored chunk is referenced, including those a failed
      // stream left behind that the file triggers never see.
      if (this.exists(database, this.table.location)) {
        database.exec(`DELETE FROM ${this.table.quotedName}`);
        // Clearing a copy also abandons the reload it left open.
        database.exec(`DROP TABLE IF EXISTS ${quote(this.#hiddenName)}`);
        // A file column declared after the table's last load has no chunks.
        for (const column of this.table.columns) {
          const chunks = SQLiteFileStore.tableName(this.table, column);
          if (column.storesFile && this.exists(database, chunks))
            database.exec(`DELETE FROM ${quote(chunks)}`);
        }
      }
      database
        .prepare('DELETE FROM "_elt_writers" WHERE "target" = ?')
        .run(this.table.location);
      database.exec('COMMIT');
      database.exec('BEGIN IMMEDIATE');
      await committed?.(this.values(database, () => [this.table.name]));
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

  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition: Partition | null): [string, SQLInputValue[]] {
    if (partition === null) return ['', []];
    const columns = Object.keys(partition).map((field) => {
      const column = this.table.columns.find(
        (column) => column.field === field,
      );
      if (column === undefined)
        throw new TypeError(
          `Resetting a partition requires destination column ${field}`,
        );
      return column;
    });
    return [
      ` WHERE ${columns.map((column) => `${column.quotedName} = ?`).join(' AND ')}`,
      columns.map((column) => column.encode(partition)),
    ];
  }

  // A reload's hidden target, beside the target and invisible to readers.
  get #hiddenName(): string {
    return `_elt_next_${this.hash}`;
  }

  // Whether a stored table is the one the stream needs, by the text SQLite
  // keeps of its CREATE TABLE, which a CHECK alone can change.
  #fit(database: DatabaseSync, name: string): StoredFit {
    const stored = database
      .prepare(
        `SELECT "sql" FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = lower(?)`,
      )
      .get(name)?.sql;
    if (stored === undefined) return 'missing';
    return stored === `CREATE TABLE ${this.table.definition(quote(name))}`
      ? 'fits'
      : 'stale';
  }

  // Refuses a target another writer owns and prepares it inside a savepoint,
  // so a refused target leaves the shared transaction as it was. A load into
  // the target creates or adopts it here; a reload leaves it to readers as it
  // is, merges into a hidden target from its first commit, and swaps that in
  // at complete().
  prepare(
    database: DatabaseSync,
    {
      writer,
      restart,
      reloading,
    }: { writer: string; restart: boolean; reloading: boolean },
    loadedAt: string,
  ): Stage {
    const name = quote(`_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    const hidden = quote(this.#hiddenName);
    const files = this.table.columns.filter((column) => column.storesFile);
    database.exec('SAVEPOINT prepare');
    let stores: { column: SQLiteColumn; store: SQLiteFileStore }[] = [];
    let mode: ReloadMode;
    const open = () => mode === 'reload' || mode === 'continue';
    const into = () => (open() ? hidden : this.table.quotedName);
    const tables = () =>
      [this.table.name, ...(open() ? [this.#hiddenName] : [])].filter((table) =>
        this.exists(database, identifiers.key(table)),
      );
    // Every stored file a row of the tables refers to.
    const referenced = (column: SQLiteColumn) =>
      tables()
        .map(
          (table) =>
            `SELECT ${column.quotedName} FROM ${quote(table)} WHERE ${column.quotedName} IS NOT NULL`,
        )
        .join(' UNION ') || 'SELECT NULL WHERE 0';
    // Drops the chunks of files no row of the tables refers to.
    const prune = () => {
      for (const { column, store } of stores)
        database.exec(
          `DELETE FROM ${quote(store.name)} WHERE "file" NOT IN (${referenced(column)})`,
        );
    };
    try {
      this.own(database, writer);
      mode = reloadMode({
        reloading,
        restart,
        target: this.#fit(database, this.table.name),
        hidden: this.#fit(database, this.#hiddenName),
      });
      // A hidden target no reload continues is a leftover readers never saw.
      if (mode !== 'continue') database.exec(`DROP TABLE IF EXISTS ${hidden}`);
      if (!open()) {
        // Only this library-owned mode index is replaced; explicit SQL constraints remain authoritative.
        database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
        database.exec(this.table.createTableSQL);
        this.initialize(database, this.replaces);
        if (this.table.readerView !== undefined)
          this.installReaderView(database, this.table.readerView);
        this.describe(database);
      }
      stores = files.map((column) => ({
        column,
        store: new SQLiteFileStore(database, this.table, column),
      }));
      // Chunks of a stream that failed after another stream committed them.
      prune();
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
    const fresh = mode === 'create' || mode === 'reload';
    // The hidden target of a reload exists once its first commit made it.
    let opened = mode === 'continue';
    const columns = this.table.columns.map((column) => column.quotedName);
    const record = database.prepare(
      `INSERT INTO ${stage} (${op}, ${columns.join(', ')}) VALUES ('R', ${columns.map(() => '?').join(', ')})`,
    );
    const staged = (column: SQLiteColumn) =>
      `SELECT ${column.quotedName} FROM ${stage} WHERE ${column.quotedName} IS NOT NULL`;
    // Partitions the stage dropped, which the next commit empties in the
    // table it merges into.
    let resets: Partition[] = [];
    // Files staged but never merged, and files a merge did not keep.
    const drop = () => {
      for (const { column, store } of stores)
        database.exec(
          `DELETE FROM ${quote(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (${referenced(column)})`,
        );
      database.exec(`DELETE FROM ${stage}`);
      resets = [];
    };
    // Runs work in a savepoint, then commits and takes the lock back in one
    // synchronous step.
    const commit = (work: () => void) => {
      database.exec('SAVEPOINT merge');
      try {
        work();
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
      database.exec('COMMIT');
      database.exec('BEGIN IMMEDIATE');
    };
    let replaced = false;
    return {
      fresh,
      get reloading() {
        return open();
      },
      values: this.values(database, tables),
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          const { partition } = operation;
          if (partition === null) {
            // The whole stream starts over in a new hidden target.
            drop();
            mode = 'reload';
            opened = false;
            return;
          }
          const [rows, values] = this.#scope(partition);
          database.prepare(`DELETE FROM ${stage}${rows}`).run(...values);
          resets.push(partition);
          return;
        }
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
          const content: unknown = Reflect.get(Object(data), column.field);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [column.field]: await store.save(content),
            };
        }
        record.run(...this.encode(data));
      },
      commit: async () => {
        commit(() => {
          if (open() && !opened) {
            database.exec(`DROP TABLE IF EXISTS ${hidden}`);
            database.exec(`CREATE TABLE ${this.table.definition(hidden)}`);
            this.build(database, hidden);
          }
          if (!open() && this.replaces && !replaced) this.replace(database);
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            database.prepare(`DELETE FROM ${into()}${rows}`).run(...values);
          }
          this.merge(database, stage, loadedAt, into());
          // Files of the rows a reset emptied, and of staged rows it dropped.
          if (resets.length > 0) prune();
          drop();
        });
        opened = open();
        replaced = true;
      },
      complete: async () => {
        if (!open()) return;
        commit(() => {
          if (this.table.readerView !== undefined)
            database.exec(
              `DROP VIEW IF EXISTS ${quote(this.table.readerView)}`,
            );
          database.exec(`DROP TABLE IF EXISTS ${this.table.quotedName}`);
          database.exec(
            `ALTER TABLE ${hidden} RENAME TO ${this.table.quotedName}`,
          );
          this.adopt(database);
          if (this.table.readerView !== undefined)
            this.installReaderView(database, this.table.readerView);
          this.describe(database);
          mode = 'load';
          prune();
        });
        opened = false;
      },
      discard: async () => drop(),
      [Symbol.asyncDispose]: async () => {
        drop();
        database.exec(`DROP TABLE ${stage}`);
      },
    };
  }
}
