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

// One stream's load. Operations, and the chunks of their files, wait in
// connection-private TEMP tables, so another stream's commit never publishes
// them and a crash leaves nothing behind. As in Postgres, no transaction stays
// open between commits: prepare only refuses and stages, and each commit is
// one transaction that merges the stage with the result of applying its
// operations one at a time, the first also creating the target.
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

  // What the target needs at its first commit, before its first merge.
  // replacing: that commit replaces the target, so its rows are moot.
  protected abstract initialize(
    database: DatabaseSync,
    replacing: boolean,
  ): void;

  // Refuses, before anything is read, stored rows the load cannot keep.
  protected inspect(_database: DatabaseSync): void {}

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

  // The owner lives beside the table it guards. A dropped table releases it,
  // since nothing it held remains.
  private writers(database: DatabaseSync): void {
    database.exec(
      'CREATE TABLE IF NOT EXISTS "_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT',
    );
  }

  // Refuses, before anything is read, a target another writer owns.
  #refuse(database: DatabaseSync, writer: string): void {
    if (!this.exists(database, '_elt_writers')) return;
    const owner = database
      .prepare(
        `SELECT "writer" FROM "_elt_writers" WHERE "target" = ? AND "target" IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`,
      )
      .get(this.table.location)?.writer;
    if (owner !== undefined && owner !== writer)
      throw new TargetOwnedError(this.table.name, String(owner), writer);
  }

  // Records the owner with the target's first commit; prepare refused any
  // other, and the writer lock keeps one in until the load ends.
  private own(database: DatabaseSync, writer: string): void {
    this.writers(database);
    database.exec(
      `DELETE FROM "_elt_writers" WHERE "target" NOT IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`,
    );
    database
      .prepare(
        'INSERT INTO "_elt_writers" ("target", "writer") VALUES (?, ?) ON CONFLICT ("target") DO NOTHING',
      )
      .run(this.table.location, writer);
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

  #viewDefinition(view: string): string {
    return `CREATE VIEW ${quote(view)} AS SELECT ${this.fields.join(', ')} FROM ${this.table.quotedName}`;
  }

  // Refuses, before anything is read, a view of other columns or another
  // table, rather than adopting it. A stale table's view still selects the
  // stored columns, which evolving the table replaces.
  #refuseReaderView(
    database: DatabaseSync,
    view: string,
    stale: boolean,
  ): void {
    const existing = database
      .prepare(
        'SELECT "type", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)',
      )
      .get(view);
    if (existing === undefined) return;
    const sql = String(existing.sql);
    const ours = stale
      ? sql.startsWith(`CREATE VIEW ${quote(view)} AS SELECT `) &&
        sql.endsWith(` FROM ${this.table.quotedName}`)
      : sql === this.#viewDefinition(view);
    if (existing.type !== 'view' || !ours)
      throw new TypeError(
        `${quote(view)} is not a view of exactly ${this.table.quotedName}; drop it or delete the database`,
      );
  }

  // Created only when absent and never replaced by a commit: replacing a view
  // readers can see would lock them out. prepare refused any view not this
  // load's own.
  private installReaderView(database: DatabaseSync, view: string): void {
    if (
      database
        .prepare('SELECT 1 FROM sqlite_schema WHERE lower("name") = lower(?)')
        .get(view) === undefined
    )
      database.exec(this.#viewDefinition(view));
  }

  // The target as its first commit makes it: its owner, the table and the
  // index its mode owns, its reader view and its descriptions.
  #create(database: DatabaseSync, writer: string, replacing: boolean): void {
    this.own(database, writer);
    // Only this library-owned mode index is replaced; explicit SQL constraints remain authoritative.
    database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
    database.exec(this.table.createTableSQL);
    this.initialize(database, replacing);
    if (this.table.readerView !== undefined)
      this.installReaderView(database, this.table.readerView);
    this.describe(database);
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

  // Drops the chunks of every stored column that is no longer one of the
  // target's file columns, before the table is replaced: no row of the table
  // that takes its place refers to them.
  #dropRetiredChunks(database: DatabaseSync): void {
    const files = new Set(
      this.table.columns
        .filter(({ storesFile }) => storesFile)
        .map(({ name }) => identifiers.key(name)),
    );
    for (const { name } of database
      .prepare('SELECT "name" FROM pragma_table_info(?)')
      .all(this.table.name))
      if (!files.has(identifiers.key(String(name))))
        database.exec(
          `DROP TABLE IF EXISTS ${quote(SQLiteFileStore.tableName(this.table, { name: String(name) }))}`,
        );
  }

  // Brings a stored table the stream no longer fits to its shape, keeping
  // every row: SQLite cannot change a column's type or constraints in place,
  // so the rows move into a table of the new definition, column by name, a
  // column the stream added reading NULL and one it dropped left behind. A
  // value the new definition refuses fails the load, naming the column, and
  // the transaction leaves the table as it was.
  #evolve(database: DatabaseSync, into: string): void {
    const stored = new Map(
      database
        .prepare('SELECT "name" FROM pragma_table_info(?)')
        .all(this.table.name)
        .map(({ name }) => [
          identifiers.key(String(name)),
          quote(String(name)),
        ]),
    );
    const sources = [...this.table.columns.map(({ name }) => name), 'loaded_at']
      .map((name) => stored.get(identifiers.key(name)) ?? 'NULL')
      .join(', ');
    if (this.table.readerView !== undefined)
      database.exec(`DROP VIEW IF EXISTS ${quote(this.table.readerView)}`);
    database.exec(`CREATE TABLE ${this.table.definition(into)}`);
    try {
      database.exec(
        `INSERT INTO ${into} (${this.fields.join(', ')}) SELECT ${sources} FROM ${this.table.quotedName}`,
      );
    } catch (cause) {
      throw new TypeError(
        `The rows stored in ${this.table.quotedName} do not fit the new shape of stream ${this.stream.name}: ${cause instanceof Error ? cause.message : String(cause)}. Clear the copy to load it again, or change the stream so they fit.`,
        { cause },
      );
    }
    this.#dropRetiredChunks(database);
    database.exec(`DROP TABLE ${this.table.quotedName}`);
    database.exec(`ALTER TABLE ${into} RENAME TO ${this.table.quotedName}`);
    this.initialize(database, false);
    if (this.table.readerView !== undefined)
      this.installReaderView(database, this.table.readerView);
    this.describe(database);
  }

  // Refuses, in one short transaction, a target another writer owns, a
  // reader view not its own and stored rows it cannot keep, evolves a stored
  // table the stream no longer fits unless the load overwrites it, and stages
  // in TEMP. Nothing else reaches the database until a commit. A load into the
  // target creates it, or adopts the stored one, at its first commit; a reload
  // leaves it to readers as it is, merges into a hidden target from its first
  // commit, and swaps that in at complete().
  prepare(
    database: DatabaseSync,
    { writer, reloading }: { writer: string; reloading: boolean },
    loadedAt: string,
  ): Stage {
    const name = quote(`_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    const hidden = quote(this.#hiddenName);
    const stores = this.table.columns
      .filter((column) => column.storesFile)
      .map((column) => ({
        column,
        store: new SQLiteFileStore(database, this.table, column),
      }));
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
        if (store.published)
          database.exec(
            `DELETE FROM ${quote(store.name)} WHERE "file" NOT IN (${referenced(column)})`,
          );
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      this.#refuse(database, writer);
      const target = this.#fit(database, this.table.name);
      mode = reloadMode({
        reloading,
        destinationSyncMode: this.configuration.destinationSyncMode,
        target,
        hidden: this.#fit(database, this.#hiddenName),
      });
      // A hidden target no reload continues is a leftover readers never saw.
      if (mode !== 'continue') database.exec(`DROP TABLE IF EXISTS ${hidden}`);
      if (!open() && this.table.readerView !== undefined)
        this.#refuseReaderView(
          database,
          this.table.readerView,
          target === 'stale',
        );
      if (mode === 'evolve') {
        this.#evolve(database, hidden);
        mode = 'load';
      }
      if (mode === 'load' && !this.replaces) this.inspect(database);
      database.exec(`DROP TABLE IF EXISTS ${stage}`);
      database.exec(
        `CREATE TEMP TABLE ${name} (${seq} INTEGER PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
      );
      for (const { store } of stores) store.stage();
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
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
      for (const { column, store } of stores) {
        if (store.published)
          database.exec(
            `DELETE FROM ${quote(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (${referenced(column)})`,
          );
        store.discard();
      }
      database.exec(`DELETE FROM ${stage}`);
      resets = [];
    };
    // Each commit is one transaction; a failed one leaves the database as the
    // last commit left it.
    const commit = (work: () => void) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        work();
        database.exec('COMMIT');
      } catch (error) {
        // SQLITE_FULL/IOERR can roll back the transaction already. Keep that
        // original error instead of masking it with a rollback error.
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    };
    let committed = false;
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
          if (open()) {
            if (!opened) {
              database.exec(`DROP TABLE IF EXISTS ${hidden}`);
              database.exec(`CREATE TABLE ${this.table.definition(hidden)}`);
              this.build(database, hidden);
            }
            if (!committed) this.own(database, writer);
          } else if (!committed) {
            this.#create(database, writer, this.replaces);
            if (this.replaces) this.replace(database);
          }
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            database.prepare(`DELETE FROM ${into()}${rows}`).run(...values);
          }
          for (const { store } of stores) store.publish();
          this.merge(database, stage, loadedAt, into());
          // Files of the rows a reset emptied, and of staged rows it dropped.
          if (resets.length > 0) prune();
          drop();
        });
        opened = open();
        committed = true;
      },
      complete: async () => {
        if (!open()) return;
        commit(() => {
          if (this.table.readerView !== undefined)
            database.exec(
              `DROP VIEW IF EXISTS ${quote(this.table.readerView)}`,
            );
          this.#dropRetiredChunks(database);
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
        for (const { store } of stores) store.unstage();
      },
    };
  }
}
