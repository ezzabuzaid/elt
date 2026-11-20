import { hash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import type {
  Clearing,
  CopyConfiguration,
  FieldValues,
  KeyValue,
  Partition,
  ReloadMode,
  Reloads,
  Stage,
  TargetDescription,
} from '@eltjs/elt';
import {
  FileContent,
  SomePartitions,
  TargetOwnedError,
  Writer,
  describeTarget,
  errorMessage,
  readPartitions,
  reloadMode,
  wholeStream,
} from '@eltjs/elt';

import { openDestination } from './open-destination.ts';
import type { SQLiteColumn } from './sqlite-column.ts';
import { describe } from './sqlite-descriptions.ts';
import type { SQLiteDestination } from './sqlite-destination.ts';
import { SQLiteFileStore } from './sqlite-file-store.ts';
import { SQLiteHistory, rowHash } from './sqlite-history.ts';
import { identifiers, quote } from './sqlite-identifiers.ts';
import { SQLiteLoad, expire } from './sqlite-loads.ts';
import { SQLiteReaderView } from './sqlite-reader-view.ts';
import type { SQLiteTable } from './sqlite-table.ts';

const writersTable = new Declaration(
  [
    'CREATE TABLE "_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT',
  ],
  { rows: 'replace' },
);

export const seq = '"_elt_seq"';
export const op = '"_elt_op"';
export const version = '"_elt_row_hash"';
// The id SQLite gives each row of a table; no column takes the name.
const rowid = '_rowid_';

// What a commit writes in the destination's own columns of each row that it
// inserts or updates: when its load began, and its number.
export type Stamp = { readonly loadedAt: string; readonly committedIn: number };

// One side of a difference: a table, what tells its rows apart, and which
// of its rows count, all of them when rows is undefined.
type Side = {
  readonly table: string;
  readonly id: string;
  readonly rows?: string;
};

// One stream's load. Operations, and the chunks of their files, wait in
// connection-private TEMP tables, so another stream's commit never publishes
// them and a crash leaves nothing behind. As in Postgres, no transaction stays
// open between commits: prepare only refuses and stages, and each commit is
// one transaction that merges the stage with the result of applying its
// operations one at a time, the first also creating the target.
export abstract class SQLiteWriter extends Writer {
  readonly configuration: CopyConfiguration;
  readonly destination: SQLiteDestination;
  readonly table: SQLiteTable;
  // Where the target keeps the rows that its commits replace or remove.
  readonly history: SQLiteHistory;
  readonly #view: SQLiteReaderView;
  readonly #description: TargetDescription;

  constructor(
    configuration: CopyConfiguration,
    destination: SQLiteDestination,
    table: SQLiteTable,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.destination = destination;
    this.table = table;
    this.history = new SQLiteHistory(table);
    this.#view = new SQLiteReaderView(table, this.shown);
    this.#description = describeTarget(
      configuration,
      table.columns,
      (column) =>
        `Integer reference to the source file's original bytes. Join ${quote(SQLiteFileStore.tableName(table, column))} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
    );
    const { missing } = this.#description;
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${table.name} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
  }

  // What the target needs before rows of its mode enter it: at its first
  // commit, once it evolves, and once a difference removed the rows that
  // leave. replacing: the first commit replaces the rows by difference, so
  // the index of the mode waits until the rows that leave are gone. A mode
  // without a key releases the index a deduplicating mode made.
  protected initialize(database: DatabaseSync, _replacing: boolean): void {
    this.dropDedupIndexes(database, null);
  }

  // Drops the deduplication indexes this library made on the target, except
  // kept.
  protected dropDedupIndexes(
    database: DatabaseSync,
    kept: string | null,
  ): void {
    for (const { name } of database
      .prepare(
        String.raw`SELECT "name" FROM sqlite_schema WHERE "type" = 'index' AND "tbl_name" = ? AND "name" LIKE '\_elt\_dedup\_%' ESCAPE '\'`,
      )
      .all(this.table.raw))
      if (name !== kept) database.exec(`DROP INDEX ${quote(String(name))}`);
  }

  // Refuses, before anything is read, stored rows the load cannot keep.
  protected inspect(_database: DatabaseSync): void {}

  // Moves the staged operations into the target, or the hidden target of a
  // reload. history keeps the rows of the target that the merge replaces or
  // removes; it is null for a hidden target, whose rows no reader saw.
  protected abstract merge(
    database: DatabaseSync,
    stage: string,
    stamp: Stamp,
    into: string,
    history: SQLiteHistory | null,
  ): void;

  // What a reload's hidden target needs once it is created, before the first
  // merge fills it, and once it takes the target's name.
  protected build(_database: DatabaseSync, _into: string): void {}
  protected adopt(_database: DatabaseSync): void {}

  // Inserts each staged record, in order.
  protected append(
    database: DatabaseSync,
    stage: string,
    { loadedAt, committedIn }: Stamp,
    into: string,
  ): void {
    database
      .prepare(
        `INSERT INTO ${into} (${this.written.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, ?, ?, ${version} FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
      )
      .run(loadedAt, committedIn);
  }

  // An overwrite replaces the rows of the target at its first commit.
  protected get replaces(): boolean {
    return false;
  }

  // Which rows of the stage a merge into an empty table keeps, as a
  // condition on them.
  protected kept(_stage: string): string {
    return `${op} = 'R'`;
  }

  // The ids of the rows of left that no row of right matches, as multisets:
  // the k-th copy of some values on one side matches the k-th copy of the
  // same values on the other, so no key is needed.
  #unmatched(left: Side, right: Side): string {
    const numbered = ({ table, id, rows }: Side) =>
      `SELECT ${id} AS "row", ${version} AS "hash", row_number() OVER (PARTITION BY ${version} ORDER BY ${id}) AS "copy" FROM ${table}${rows === undefined ? '' : ` WHERE ${rows}`}`;
    return `SELECT "mine"."row" FROM (${numbered(left)}) AS "mine" LEFT JOIN (${numbered(right)}) AS "theirs" ON "theirs"."hash" = "mine"."hash" AND "theirs"."copy" = "mine"."copy" WHERE "theirs"."row" IS NULL`;
  }

  get #target(): Side {
    return { table: this.table.quotedRaw, id: rowid };
  }

  // The first half of replacing the rows of the target with the rows of
  // next: the history keeps each row of the target that no row of next
  // matches, and the row goes. A row with a match stays as it is, with its
  // commit and its loaded_at. What remains matches rows of next, so it fits
  // the index of the mode, which the rows that enter then fit too.
  #removeUnmatched(
    database: DatabaseSync,
    next: Side,
    committedIn: number,
    target: Side = this.#target,
  ): void {
    const { table, id } = target;
    const leaving = this.#unmatched(target, next);
    this.history.keep(
      database,
      committedIn,
      `FROM ${table} AS "_elt_old" WHERE "_elt_old".${id} IN (${leaving})`,
    );
    database.exec(`DELETE FROM ${table} WHERE ${id} IN (${leaving})`);
    this.initialize(database, false);
  }

  // Replaces the rows of the target with the records that the stage keeps,
  // by difference: each record that no row matches enters with this commit.
  #replace(
    database: DatabaseSync,
    stage: string,
    { loadedAt, committedIn }: Stamp,
  ): void {
    const staged = { table: stage, id: seq, rows: this.kept(stage) };
    this.#removeUnmatched(database, staged, committedIn);
    database
      .prepare(
        `INSERT INTO ${this.table.quotedRaw} (${this.written.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, ?, ?, ${version} FROM ${stage} WHERE ${seq} IN (${this.#unmatched(staged, this.#target)}) ORDER BY ${seq}`,
      )
      .run(loadedAt, committedIn);
  }

  // Copies each row of the target into its history, as replaced in commit
  // replacedIn.
  #keepRows(database: DatabaseSync, replacedIn: number): void {
    this.history.keep(
      database,
      replacedIn,
      `FROM ${this.table.quotedRaw} AS "_elt_old"`,
    );
  }

  private get hash(): string {
    return hash('sha256', this.table.location);
  }

  // What a reader sees of each row, its reader view's columns: the stream's
  // columns and loaded_at, none of the internal ones.
  protected get shown(): string[] {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
  }

  // What a commit writes into each row: what a reader sees, the commit's
  // number, and the hash of its values.
  protected get written(): string[] {
    return [...this.shown, '"committed_in"', version];
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
  // since nothing it held remains, and so does a table of owners another
  // version declared otherwise, which is replaced empty.
  private writers(database: DatabaseSync): void {
    writersTable.apply(database);
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
  // other.
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

  // The field's values that a row of the tables or of the history holds:
  // while a reload is open, the rows of the target and of its hidden target
  // both still refer to files.
  private values(
    database: DatabaseSync,
    tables: () => readonly string[],
  ): FieldValues {
    const { table } = this;
    const referenced = (column: SQLiteColumn) =>
      this.#referenced(database, column, tables());
    return async function* (field) {
      const column = table.columns.find((column) => column.field === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      for (const row of database.prepare(referenced(column)).iterate())
        yield row.value;
    };
  }

  // A clear that empties a table is a change readers see, so it is a load of
  // one numbered commit. It forgets the rows it removes: the history keeps
  // none of them, so neither they nor their stored files stay, and each
  // position before the clear expires, as no reading can read it exactly.
  override async clear(
    { writer, clock, connection }: Clearing,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    using database = openDestination(this.destination.path);
    database.exec('BEGIN IMMEDIATE');
    try {
      this.writers(database);
      const owner = database
        .prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?')
        .get(this.table.location)?.writer;
      if (owner !== undefined && owner !== writer)
        throw new TargetOwnedError(this.table.name, String(owner), writer);
      // Emptied, not dropped: views built on the table keep working. With no
      // rows left, nothing refers to its stored files.
      if (this.exists(database, this.table.location)) {
        const cleared = SQLiteLoad.once(database, connection, {
          clock,
          retention: this.destination.retention,
        });
        database.exec(`DELETE FROM ${this.table.quotedRaw}`);
        expire(database, cleared, 'clear');
        // Clearing a copy also abandons the reload it left open.
        database.exec(`DROP TABLE IF EXISTS ${quote(this.#hiddenName)}`);
        this.#reloaded(database);
        // A file column declared after the table's last load has no chunks.
        for (const column of this.table.columns) {
          const chunks = SQLiteFileStore.tableName(this.table, column);
          if (column.storesFile && this.exists(database, chunks))
            database.exec(
              `DELETE FROM ${quote(chunks)} WHERE "file" NOT IN (${this.#referenced(database, column, [])})`,
            );
        }
      }
      database
        .prepare('DELETE FROM "_elt_writers" WHERE "target" = ?')
        .run(this.table.location);
      database.exec('COMMIT');
      database.exec('BEGIN IMMEDIATE');
      await committed?.(this.values(database, () => [this.table.raw]));
      database.exec('ROLLBACK');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  // What the raw table, its reader view and their columns say to readers,
  // rewritten with every load so they follow the stream's schema. The reader
  // view describes only the columns it shows.
  private describe(database: DatabaseSync): void {
    const dataTypes = new Map([
      ...this.table.columns.map(
        ({ name, dataType }) => [name, dataType] as const,
      ),
      ['loaded_at', 'timestamp'] as const,
      ['committed_in', 'integer'] as const,
    ]);
    const described = (descriptions: Readonly<Record<string, string | null>>) =>
      Object.fromEntries(
        Object.entries(descriptions).map(([name, description]) => [
          name,
          { description, dataType: dataTypes.get(name) },
        ]),
      );
    const shown = {
      ...this.#description.columns,
      loaded_at:
        'Start time of the load that wrote these values of the row. A deduplicating load, an overwrite or a reload that brings the same values leaves the row, and its loaded_at, as they are. Not the source modification time or the most recent successful sync.',
    };
    describe(
      database,
      this.table.raw,
      this.#description.table,
      described({
        ...shown,
        committed_in:
          'Number of the commit that last wrote this row: the row of _elt_commits with this number tells when, and in which load.',
      }),
    );
    this.#view.describe(database, this.#description.table, described(shown));
  }

  // The target as its first commit makes it: its owner, the table, its
  // history, the index its mode owns, its reader view and its descriptions.
  #create(database: DatabaseSync, writer: string, replacing: boolean): void {
    this.own(database, writer);
    database.exec(this.table.createTableSQL);
    this.history.create(database, this.written);
    this.initialize(database, replacing);
    this.#view.install(database);
    this.describe(database);
  }

  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition: Partition | null): [string, SQLInputValue[]] {
    if (partition === null) return ['', []];
    const [condition, values] = this.#partition(partition);
    return [` WHERE ${condition}`, values];
  }

  // The rows of any of the partitions, as a condition over the target's or
  // the stage's columns: NULL for a row that does not name its partition,
  // such as a staged DELETE whose key leaves the partition out.
  #within(partitions: readonly Partition[]): [string, SQLInputValue[]] {
    const each = partitions.map((partition) => this.#partition(partition));
    return [
      each.length === 0
        ? 'FALSE'
        : each.map(([condition]) => `(${condition})`).join(' OR '),
      each.flatMap(([, values]) => values),
    ];
  }

  #partition(partition: Partition): [string, SQLInputValue[]] {
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
      columns.map((column) => `${column.quotedName} = ?`).join(' AND '),
      columns.map((column) => column.encode(partition)),
    ];
  }

  // The partitions that an open reload of the target reloads, in the
  // writer's own table beside it, written in the commit that opens or
  // continues the reload, so a run that resumes the reload continues it. A
  // reload of the whole stream has no row.
  #makeReloads(database: DatabaseSync): void {
    database.exec(
      'CREATE TABLE IF NOT EXISTS "_elt_reloads" ("target" TEXT PRIMARY KEY, "partitions" TEXT NOT NULL) STRICT',
    );
  }

  #reloading(database: DatabaseSync): Reloads {
    if (!this.exists(database, '_elt_reloads')) return wholeStream;
    const partitions = database
      .prepare('SELECT "partitions" FROM "_elt_reloads" WHERE "target" = ?')
      .get(this.table.location)?.partitions;
    return typeof partitions === 'string'
      ? new SomePartitions(readPartitions(this.stream, JSON.parse(partitions)))
      : wholeStream;
  }

  #reload(database: DatabaseSync, reloads: Reloads): void {
    if (!(reloads instanceof SomePartitions)) {
      this.#reloaded(database);
      return;
    }
    this.#makeReloads(database);
    database
      .prepare(
        'INSERT INTO "_elt_reloads" ("target", "partitions") VALUES (?, ?) ON CONFLICT ("target") DO UPDATE SET "partitions" = excluded."partitions"',
      )
      .run(this.table.location, JSON.stringify(reloads.partitions));
  }

  #reloaded(database: DatabaseSync): void {
    if (this.exists(database, '_elt_reloads'))
      database
        .prepare('DELETE FROM "_elt_reloads" WHERE "target" = ?')
        .run(this.table.location);
  }

  // A reload's hidden target, beside the target and invisible to readers.
  get #hiddenName(): string {
    return `_elt_next_${this.hash}`;
  }

  // The table the stream needs under the name, by the text SQLite keeps of
  // its CREATE TABLE, which a CHECK alone can change. Evolving it keeps its
  // rows.
  #declaration(name: string): Declaration {
    return new Declaration(
      [`CREATE TABLE ${this.table.definition(quote(name))}`],
      { rows: 'keep' },
    );
  }

  // Every stored file of the column that a row of the tables or of the
  // history refers to, as a SELECT of "value". A row of the history keeps its
  // file for a reading as of a position before the commit that replaced the
  // row. A table without the column refers to none of its files: the target
  // while a reload adds the column, a history that has kept no row since, or
  // a target that a clear finds never loaded.
  #referenced(
    database: DatabaseSync,
    column: SQLiteColumn,
    tables: readonly string[],
  ): string {
    const selects = [...tables, this.history.name]
      .filter(
        (table) =>
          database
            .prepare(
              'SELECT 1 FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE',
            )
            .get(table, column.name) !== undefined,
      )
      .map(
        (table) =>
          `SELECT ${column.quotedName} AS "value" FROM ${quote(table)} WHERE ${column.quotedName} IS NOT NULL`,
      );
    // With no such table yet, no row refers to a file: a query of no rows.
    return selects.length === 0
      ? 'SELECT NULL AS "value" WHERE 0'
      : selects.join(' UNION ');
  }

  // Drops the chunks of every stored column that is no longer one of the
  // target's file columns, before the table is replaced: no row of the table
  // that takes its place refers to them, and a reading as of a position reads
  // only the target's columns.
  #dropRetiredChunks(database: DatabaseSync): void {
    const files = new Set(
      this.table.columns
        .filter(({ storesFile }) => storesFile)
        .map(({ name }) => identifiers.key(name)),
    );
    for (const { name } of database
      .prepare('SELECT "name" FROM pragma_table_info(?)')
      .all(this.table.raw))
      if (!files.has(identifiers.key(String(name)))) {
        const chunks = SQLiteFileStore.tableName(this.table, {
          name: String(name),
        });
        database.exec(`DROP TABLE IF EXISTS ${quote(chunks)}`);
      }
  }

  // Keeps in the history, in a commit of its own, each row with a value in a
  // stored column that the new shape drops or stores as another type: the
  // row loses or changes the value, so it is a new version. Its row hash
  // counted the old value, so evolve sets the hash to NULL, which matches no
  // record until a commit writes the row again. A column that the shape adds
  // is NULL in each row, which a row hash does not count, so it makes no new
  // version. Gives the number of the commit, if any.
  #keepChanged(database: DatabaseSync, load: SQLiteLoad): number | undefined {
    const declared = new Map([
      ...this.table.columns.map(
        (column) => [identifiers.key(column.name), column.storageType] as const,
      ),
      ['loaded_at', 'TEXT'],
      ['committed_in', 'INTEGER'],
      ['_elt_row_hash', 'TEXT'],
    ]);
    const changed = database
      .prepare('SELECT "name", "type" FROM pragma_table_info(?)')
      .all(this.table.raw)
      .filter(
        ({ name, type }) =>
          declared.get(identifiers.key(String(name))) !== String(type),
      )
      .map(({ name }) => `${quote(String(name))} IS NOT NULL`);
    if (changed.length === 0) return undefined;
    const rows = changed.join(' OR ');
    const committedIn = load.commit();
    this.history.keep(
      database,
      committedIn,
      `FROM ${this.table.quotedRaw} AS "_elt_old" WHERE ${rows}`,
    );
    database
      .prepare(
        `UPDATE ${this.table.quotedRaw} SET "committed_in" = ?, "loaded_at" = ? WHERE ${rows}`,
      )
      .run(committedIn, load.loadedAt);
    return committedIn;
  }

  // Brings a stored table the stream no longer fits to its shape, keeping
  // every row: drift rebuilds it from the new definition and copies the
  // columns both have, by name, a column the stream added taking its default
  // (NULL) and one it dropped left behind. A value the new definition refuses
  // fails the load, naming the column, and the transaction leaves the table as
  // it was. The reader view selects the stored columns, and the mode index
  // can cover a dropped key, so both are made again for the new shape.
  #evolve(database: DatabaseSync, load: SQLiteLoad): void {
    this.#view.drop(database);
    this.dropDedupIndexes(database, null);
    const changedIn = this.#keepChanged(database, load);
    this.#dropRetiredChunks(database);
    try {
      this.#declaration(this.table.raw).apply(database);
    } catch (cause) {
      throw new TypeError(
        `The rows stored in ${this.table.quotedRaw} do not fit the new shape of stream ${this.stream.name}: ${errorMessage(cause)}. Clear the copy to load it again, or change the stream so they fit.`,
        { cause },
      );
    }
    if (changedIn !== undefined)
      database
        .prepare(
          `UPDATE ${this.table.quotedRaw} SET ${version} = NULL WHERE "committed_in" = ?`,
        )
        .run(changedIn);
    this.initialize(database, false);
    this.#view.install(database);
    this.describe(database);
  }

  // Replaces the rows of the target with the rows of the hidden target, by
  // difference, in place: the table keeps its indexes, triggers and reader
  // view. Each row of the hidden target that no row matches enters with this
  // commit, and the loaded_at of the load that wrote it.
  #reloadInPlace(
    database: DatabaseSync,
    hidden: string,
    committedIn: number,
    target: Side = this.#target,
  ): void {
    const reloaded = { table: hidden, id: rowid };
    this.#removeUnmatched(database, reloaded, committedIn, target);
    database
      .prepare(
        `INSERT INTO ${this.table.quotedRaw} (${this.written.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, "loaded_at", ?, ${version} FROM ${hidden} WHERE ${rowid} IN (${this.#unmatched(reloaded, target)}) ORDER BY ${rowid}`,
      )
      .run(committedIn);
    database.exec(`DROP TABLE ${hidden}`);
  }

  // Gives a completed reload of some partitions their rows of the hidden
  // target, in place and by difference: the rows of the target in those
  // partitions are replaced as #reloadInPlace replaces a whole target, and
  // the rows of every other partition stay as they are.
  #reloadPartitionsInPlace(
    database: DatabaseSync,
    hidden: string,
    partitions: readonly Partition[],
    committedIn: number,
  ): void {
    const scoped = quote(`_elt_reloaded_${this.hash}`);
    const [within, values] = this.#within(partitions);
    database.exec(`DROP TABLE IF EXISTS temp.${scoped}`);
    database
      .prepare(
        `CREATE TEMP TABLE ${scoped} AS SELECT ${rowid} AS "row" FROM ${this.table.quotedRaw} WHERE ${within}`,
      )
      .run(...values);
    this.#reloadInPlace(database, hidden, committedIn, {
      ...this.#target,
      rows: `${rowid} IN (SELECT "row" FROM temp.${scoped})`,
    });
    database.exec(`DROP TABLE temp.${scoped}`);
  }

  // Replaces the target with the hidden target, whose rows readers see from
  // this commit on, once the history keeps every row of the target.
  #swap(database: DatabaseSync, hidden: string, committedIn: number): void {
    database
      .prepare(`UPDATE ${hidden} SET "committed_in" = ?`)
      .run(committedIn);
    this.#view.drop(database);
    if (this.exists(database, this.table.location))
      this.#keepRows(database, committedIn);
    database.exec(`DROP TABLE IF EXISTS ${this.table.quotedRaw}`);
    database.exec(`ALTER TABLE ${hidden} RENAME TO ${this.table.quotedRaw}`);
    this.adopt(database);
  }

  // Refuses, in one short transaction, a target another writer owns, a
  // reader view not its own and stored rows it cannot keep, evolves a stored
  // table the stream no longer fits unless the load overwrites it, and stages
  // in TEMP. Nothing else reaches the database until a commit. A load into the
  // target creates it, or adopts the stored one, at its first commit; a reload
  // leaves it to readers as it is, merges into a hidden target from its first
  // commit, and gives its rows to the target at complete().
  prepare(
    load: SQLiteLoad,
    { writer, reloading }: { writer: string; reloading: boolean },
  ): Stage {
    const { database, loadedAt } = load;
    const name = quote(`_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    // The rows of a commit that belong to the partitions a reload reloads.
    const reloadName = quote(`_elt_reload_stage_${this.hash}`);
    const reloadStage = `temp.${reloadName}`;
    const hidden = quote(this.#hiddenName);
    const staging = (table: string) =>
      `CREATE TEMP TABLE ${table} (${seq} INTEGER PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')}, ${version} TEXT)`;
    const stores = this.table.columns
      .filter((column) => column.storesFile)
      .map((column) => ({
        column,
        store: new SQLiteFileStore(database, this.table, column),
      }));
    let mode: ReloadMode;
    // What an open reload reloads; the whole stream until a RESET of a
    // partition opens one.
    let reloads: Reloads = wholeStream;
    const open = (at: ReloadMode) => at === 'reload' || at === 'continue';
    const into = () => (open(mode) ? hidden : this.table.quotedRaw);
    const tables = () =>
      [this.table.raw, ...(open(mode) ? [this.#hiddenName] : [])].filter(
        (table) => this.exists(database, identifiers.key(table)),
      );
    // Drops the chunks of files that no row of the tables or of the history
    // refers to.
    const prune = () => {
      for (const { column, store } of stores)
        if (store.published)
          database.exec(
            `DELETE FROM ${quote(store.name)} WHERE "file" NOT IN (${this.#referenced(database, column, tables())})`,
          );
    };
    mode = transaction(
      database,
      () => {
        this.#refuse(database, writer);
        const target = this.#declaration(this.table.raw).drift(database);
        let next = reloadMode({
          reloading,
          destinationSyncMode: this.configuration.destinationSyncMode,
          target,
          hidden: this.#declaration(this.#hiddenName).drift(database),
        });
        // A hidden target no reload continues is a leftover readers never saw.
        if (next === 'continue') reloads = this.#reloading(database);
        else {
          database.exec(`DROP TABLE IF EXISTS ${hidden}`);
          this.#reloaded(database);
        }
        if (!open(next)) this.#view.refuse(database, target === 'stale');
        if (next === 'evolve') {
          this.#evolve(database, load);
          next = 'load';
        }
        if (next === 'load' && !this.replaces) this.inspect(database);
        database.exec(`DROP TABLE IF EXISTS ${stage}`);
        database.exec(staging(name));
        database.exec(`DROP TABLE IF EXISTS ${reloadStage}`);
        database.exec(staging(reloadName));
        for (const { store } of stores) store.stage();
        return next;
      },
      { mode: 'immediate' },
    );
    const fresh = mode === 'create' || mode === 'reload';
    // The reload as the last commit left it, which a discard goes back to.
    let committed: { readonly mode: ReloadMode; readonly reloads: Reloads } = {
      mode,
      reloads,
    };
    const columns = this.table.columns.map((column) => column.quotedName);
    const record = database.prepare(
      `INSERT INTO ${stage} (${op}, ${columns.join(', ')}, ${version}) VALUES ('R', ${columns.map(() => '?').join(', ')}, ?)`,
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
            `DELETE FROM ${quote(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (${this.#referenced(database, column, tables())})`,
          );
        store.discard();
      }
      database.exec(`DELETE FROM ${stage}`);
      resets = [];
    };
    // The first commit claims the target: it owns the hidden target of a
    // reload, or creates or adopts the table. Later commits find it claimed.
    // Returns whether the commit replaces the rows of the target with the
    // stage's.
    const claimTarget = () => {
      if (open(mode)) {
        this.own(database, writer);
        return false;
      }
      this.#create(database, writer, this.replaces);
      return this.replaces;
    };
    const claimed = () => false;
    let claim = claimTarget;
    return {
      fresh,
      get reloading() {
        return open(mode);
      },
      values: this.values(database, tables),
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          const { partition } = operation;
          if (partition === null) {
            // The whole stream starts over in a new hidden target.
            drop();
            mode = 'reload';
            reloads = wholeStream;
            return;
          }
          const [rows, values] = this.#scope(partition);
          database.prepare(`DELETE FROM ${stage}${rows}`).run(...values);
          resets.push(partition);
          // The partition starts over in a hidden target, and readers see its
          // rows as they were until the stream ends. An overwrite replaces
          // the whole target anyway.
          if (this.replaces) return;
          if (mode === 'load') {
            mode = 'reload';
            reloads = new SomePartitions([partition]);
          } else if (open(mode) && reloads instanceof SomePartitions)
            reloads = reloads.with(partition);
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
        // Each file is read here, before the source advances past it. The
        // row keeps its id, and the row hash its content: each load gives a
        // file a new id, so a row whose file is the same matches.
        let data = operation.data;
        const contents = new Map<SQLiteColumn, Uint8Array>();
        for (const { column, store } of stores) {
          const content: unknown = Reflect.get(Object(data), column.field);
          if (content instanceof FileContent) {
            const { id, sha256 } = await store.save(content);
            data = { ...Object(data), [column.field]: id };
            contents.set(column, sha256);
          }
        }
        const values = this.encode(data);
        const hashed = this.table.columns.map(
          (column, index) => contents.get(column) ?? values[index] ?? null,
        );
        record.run(...values, rowHash(this.table.columns, hashed));
      },
      // Each commit is one transaction; a failed one leaves the database as
      // the last commit left it.
      commit: async () => {
        transaction(
          database,
          () => {
            const committedIn = load.commit();
            if (mode === 'reload') {
              database.exec(`DROP TABLE IF EXISTS ${hidden}`);
              database.exec(`CREATE TABLE ${this.table.definition(hidden)}`);
              this.build(database, hidden);
            }
            if (open(mode)) this.#reload(database, reloads);
            const replacing = claim();
            // The rows of a hidden target were never shown, so only the
            // target keeps the rows a commit replaces.
            const history = open(mode) ? null : this.history;
            for (const partition of resets) {
              const [rows, values] = this.#scope(partition);
              history?.keep(
                database,
                committedIn,
                `FROM ${into()} AS "_elt_old"${rows}`,
                values,
              );
              database.prepare(`DELETE FROM ${into()}${rows}`).run(...values);
            }
            for (const { store } of stores) store.publish();
            const stamp = { loadedAt, committedIn };
            if (replacing) this.#replace(database, stage, stamp);
            else if (open(mode) && reloads instanceof SomePartitions) {
              // The rows of the reloaded partitions go to the hidden target,
              // the others to the target. A DELETE whose key does not name
              // its partition goes to both, so the reload cannot bring back
              // a row that the source deleted.
              const [within, values] = this.#within(reloads.partitions);
              database
                .prepare(
                  `INSERT INTO ${reloadStage} SELECT * FROM ${stage} WHERE (${within}) IS TRUE OR (${op} = 'D' AND (${within}) IS NULL)`,
                )
                .run(...values, ...values);
              database
                .prepare(`DELETE FROM ${stage} WHERE (${within}) IS TRUE`)
                .run(...values);
              this.merge(
                database,
                stage,
                stamp,
                this.table.quotedRaw,
                this.history,
              );
              this.merge(database, reloadStage, stamp, hidden, null);
              database.exec(`DELETE FROM ${reloadStage}`);
            } else this.merge(database, stage, stamp, into(), history);
            // Files of the rows a reset emptied, and of staged rows it dropped.
            if (resets.length > 0) prune();
            drop();
          },
          { mode: 'immediate' },
        );
        claim = claimed;
        // Its first commit made the hidden target, so the reload continues.
        if (mode === 'reload') mode = 'continue';
        committed = { mode, reloads };
      },
      complete: async () => {
        if (!open(mode)) return;
        transaction(
          database,
          () => {
            // Readers see the rows from this commit on, and the rows of the
            // target it replaces up to it.
            const committedIn = load.commit();
            this.#dropRetiredChunks(database);
            this.history.create(database, this.written);
            // A target of another shape cannot take the rows of the hidden
            // target in place. A reload of partitions keeps the target's
            // shape: prepare evolves a stored target before it loads.
            const fits =
              this.#declaration(this.table.raw).drift(database) === 'fits';
            if (reloads instanceof SomePartitions && fits)
              this.#reloadPartitionsInPlace(
                database,
                hidden,
                reloads.partitions,
                committedIn,
              );
            else if (reloads instanceof SomePartitions)
              throw new TypeError(
                `${this.table.quotedRaw} changed its shape while some of its partitions reloaded; clear the copy to load it again`,
              );
            else if (fits) this.#reloadInPlace(database, hidden, committedIn);
            else this.#swap(database, hidden, committedIn);
            this.#reloaded(database);
            this.#view.install(database);
            this.describe(database);
            mode = 'load';
            reloads = wholeStream;
            committed = { mode, reloads };
            prune();
          },
          { mode: 'immediate' },
        );
      },
      // A RESET that no commit took is undone with the operations after it:
      // the source's checkpoint does not know it.
      discard: async () => {
        drop();
        ({ mode, reloads } = committed);
      },
      [Symbol.asyncDispose]: async () => {
        drop();
        database.exec(`DROP TABLE ${stage}`);
        database.exec(`DROP TABLE ${reloadStage}`);
        for (const { store } of stores) store.unstage();
      },
    };
  }
}
