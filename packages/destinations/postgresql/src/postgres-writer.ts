import { hash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  type Clearing,
  type CopyConfiguration,
  type FieldValues,
  FileContent,
  type KeyValue,
  type Partition,
  type ReloadMode,
  type Stage,
  TargetOwnedError,
  Writer,
  describeTarget,
  errorMessage,
  reloadMode,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { TargetComments } from './postgres-comments.ts';
import { PostgresFileStore } from './postgres-file-store.ts';
import { storedColumns, storedFit } from './postgres-fit.ts';
import { TargetHistory, rowHash, version } from './postgres-history.ts';
import type { PostgresLoad, Transaction } from './postgres-load.ts';
import { commitOnce, installNumbering } from './postgres-numbering.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { PostgresSession } from './postgres-session.ts';
import type { PostgresTable } from './postgres-table.ts';

const batchSize = 1000;
// A batch also flushes once its JSON reaches this size, so rows of large text
// or binary values are sent a few at a time rather than a thousand at once.
const batchBytes = 16 * 2 ** 20;
// Postgres takes at most 1 GB in one message (PQ_LARGE_MESSAGE_LIMIT), less
// a margin for the batch's brackets and the message framing.
const rowBytes = 2 ** 30 - 2 ** 20;
export const seq = '"_elt_seq"';
export const op = '"_elt_op"';

// How long swapping in a rebuilt target waits for its readers before the
// copy gives up until the next run.
const swapTimeout = '3s';

// One side of a difference: a table, what tells its rows apart, and which
// of its rows count, all of them when rows is undefined.
type Side = {
  readonly table: string;
  readonly id: string;
  readonly rows?: string;
};

export abstract class PostgresWriter extends Writer {
  readonly configuration: CopyConfiguration;
  protected readonly url: string;
  readonly schema: string;
  readonly table: PostgresTable;
  // Where the target keeps the rows that its commits replace or remove, and
  // how long it keeps a position readable.
  readonly #history: TargetHistory;
  readonly #retention: Temporal.Duration;
  readonly #comments: TargetComments;
  readonly #view: TargetReaderView | undefined;

  constructor(
    configuration: CopyConfiguration,
    url: string,
    schema: string,
    table: PostgresTable,
    retention: Temporal.Duration,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.url = url;
    this.schema = schema;
    this.table = table;
    this.#retention = retention;
    this.#history = new TargetHistory(schema, this.#hash);
    const description = describeTarget(
      configuration,
      table.columns,
      (column) =>
        `UUID reference to the source file's original bytes. Join ${new PostgresFileStore(schema, table, column).qualifiedName} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
    );
    this.#comments = new TargetComments(description.table, {
      ...description.columns,
      committed_in:
        'Number of the commit that last wrote this row: the row of _warehouse._elt_commits with this number tells when, and in which load.',
    });
    this.#view =
      table.readerView &&
      new TargetReaderView(
        table.readerView,
        this.qualifiedName,
        this.#history.qualifiedName,
        [...table.columns.map(({ name }) => name), 'loaded_at', 'committed_in'],
      );
    if (table.readerView === undefined) return;
    const { missing } = description;
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${table.readerView.schema}.${table.readerView.name} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
  }

  // Creates the target, or adopts the stored one, at the first commit.
  // replacing: that commit replaces the target, so its rows are moot.
  protected abstract initialize(
    transaction: Transaction,
    replacing: boolean,
  ): Promise<void>;

  // Refuses, before anything is read, stored rows the load cannot keep.
  protected async inspect(_sql: Transaction): Promise<void> {}

  get qualifiedName(): string {
    return `${quote(this.schema)}.${this.table.quotedName}`;
  }

  protected get createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.#tableSQL(this.qualifiedName)}`;
  }

  // A table named name with the target's columns.
  #tableSQL(name: string): string {
    if (this.table.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `${name} (${this.table.columns.map((column) => column.definition).join(', ')}, "loaded_at" TIMESTAMPTZ NOT NULL, "committed_in" INTEGER NOT NULL, ${version} TEXT)`;
  }

  // What a reload's hidden target needs once it is created, before the first
  // merge fills it, and once it takes the target's name.
  protected async build(_sql: Transaction, _into: string): Promise<void> {}
  protected async adopt(_sql: Transaction): Promise<void> {}

  // What a commit writes into each row: its values, when its load began,
  // its number, and the hash of its values.
  protected get written(): string[] {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
      '"committed_in"',
      version,
    ];
  }

  // The staged values of each row, and what the commit writes beside them.
  protected get staged(): string {
    return `${this.table.columns.map((column) => column.quotedName).join(', ')}, $1::text::timestamptz, $2::integer, ${version}`;
  }

  protected encode(record: unknown): EncodedValue[] {
    return this.table.columns.map((column) => column.encode(record));
  }

  // Only a load that identifies rows by key can remove one: the key's values,
  // at their columns, and null elsewhere.
  protected deletionRow(
    _key: Readonly<Record<string, KeyValue>>,
  ): EncodedValue[] {
    throw new TypeError('Only deduplicating loads can apply deletions');
  }

  // An overwrite replaces the target at its first commit.
  protected get replaces(): boolean {
    return false;
  }

  // Which rows of the stage a commit that replaces the target keeps, as a
  // condition on them.
  protected kept(_stage: string): string {
    return `${op} = 'R'`;
  }

  // Moves the staged operations into the target, or the hidden target of a
  // reload; every row of a run shares its loaded_at, and each row names the
  // commit that wrote it. history keeps the rows of the target that the
  // merge replaces or removes; it is null for a hidden target, whose rows no
  // reader saw.
  protected async merge(
    sql: Transaction,
    stage: string,
    written: Written,
    into: string,
    _history: TargetHistory | null,
  ): Promise<void> {
    await sql.unsafe(
      `INSERT INTO ${into} (${this.written.join(', ')}) SELECT ${this.staged} FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
      [written.loadedAt, written.committedIn],
    );
  }

  // The ids of the rows of left that no row of right matches, as multisets:
  // the k-th copy of some values on one side matches the k-th copy of the
  // same values on the other, so no key is needed.
  #unmatched(left: Side, right: Side): string {
    const numbered = ({ table, id, rows }: Side) =>
      `SELECT ${id} AS "row", ${version} AS "hash", row_number() OVER (PARTITION BY ${version} ORDER BY ${id}) AS "copy" FROM ${table}${rows === undefined ? '' : ` WHERE ${rows}`}`;
    return `SELECT "mine"."row" FROM (${numbered(left)}) AS "mine" LEFT JOIN (${numbered(right)}) AS "theirs" ON "theirs"."hash" = "mine"."hash" AND "theirs"."copy" = "mine"."copy" WHERE "theirs"."row" IS NULL`;
  }

  // Replaces the rows of the target with the records that the stage keeps,
  // by difference: the history keeps each row of the target that no record
  // matches, and the row goes; a row with a match stays as it is, with its
  // commit and its loaded_at; and each record that no row matches enters
  // with this commit. What stays matches records, so it fits the index of
  // the mode, which the records that enter then fit too.
  async #replace(
    sql: Transaction,
    stage: string,
    written: Written,
  ): Promise<void> {
    const target = { table: this.qualifiedName, id: 'ctid' };
    const staged = { table: stage, id: seq, rows: this.kept(stage) };
    const leaving = this.#unmatched(target, staged);
    await this.#history.keep(
      sql,
      written.committedIn,
      this.qualifiedName,
      `FROM ${this.qualifiedName} AS "_elt_old" WHERE "_elt_old".ctid IN (${leaving})`,
    );
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} WHERE ctid IN (${leaving})`,
    );
    await this.initialize(sql, false);
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} (${this.written.join(', ')}) SELECT ${this.staged} FROM ${stage} WHERE ${seq} IN (${this.#unmatched(staged, target)}) ORDER BY ${seq}`,
      [written.loadedAt, written.committedIn],
    );
  }

  // The existing library-owned dedup indexes on this table.
  protected async dedupIndexes(transaction: Transaction): Promise<string[]> {
    const rows = await transaction.unsafe(
      String.raw`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname LIKE '\_elt\_dedup\_%'`,
      [this.schema, this.table.name],
    );
    return rows.map((row) => String(row.indexname));
  }

  get #writers(): string {
    return `${quote(this.schema)}."_elt_writers"`;
  }

  // The owner lives beside the table it guards. A dropped table releases it,
  // since nothing it held remains.
  async #refuse(sql: Transaction, writer: string): Promise<void> {
    const [writers] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [this.#writers],
    );
    if (writers?.exists !== true) return;
    const [row] = await sql.unsafe(
      `SELECT "writer" FROM ${this.#writers} WHERE "target" = $1 AND to_regclass(format('%I.%I', $2::text, "target")) IS NOT NULL`,
      [this.table.name, this.schema],
    );
    if (row !== undefined && row.writer !== writer)
      throw new TargetOwnedError(this.table.name, String(row.writer), writer);
  }

  // Records the owner with the target's first commit; prepare refused any
  // other, and the schema lock keeps one in until the load ends.
  async #own(sql: Transaction, writer: string): Promise<void> {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.#writers} ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL)`,
    );
    await sql.unsafe(
      `DELETE FROM ${this.#writers} WHERE to_regclass(format('%I.%I', $1::text, "target")) IS NULL`,
      [this.schema],
    );
    await sql.unsafe(
      `INSERT INTO ${this.#writers} ("target", "writer") VALUES ($1, $2) ON CONFLICT ("target") DO NOTHING`,
      [this.table.name, writer],
    );
  }

  // The target as its first commit, numbered committedIn, makes it: the
  // schema, its owner, the table, its history and its comments, and the
  // reader view.
  async #create(
    sql: Transaction,
    writer: string,
    replacing: boolean,
    committedIn: number,
  ): Promise<void> {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`);
    await this.#own(sql, writer);
    await this.initialize(sql, replacing);
    await this.#describe(sql, async () => committedIn);
  }

  // The history in the target's shape, the comments of the table, and its
  // reader view, which reads each column of the target from its history too.
  // change gives the number of the commit that changes the target's shape.
  async #describe(
    sql: Transaction,
    change: () => Promise<number>,
  ): Promise<void> {
    await this.#history.create(sql, this.qualifiedName, change);
    await this.#comments.write(sql, 'TABLE', this.schema, this.table.name);
    if (this.#view === undefined) return;
    await this.#view.describe(sql, this.#comments);
  }

  // The field's values in each of the tables and in the history: while a
  // reload is open, the rows of the target and of its hidden target both
  // still refer to files, and a row of the history keeps its file for a
  // reading as of a position before the commit that replaced it.
  private values(
    sql: Transaction,
    tables: () => readonly string[],
  ): FieldValues {
    const { table, schema } = this;
    return async function* (field) {
      const column = table.columns.find((column) => column.field === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      for (const name of tables()) {
        const present = await sql.unsafe(
          'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
          [schema, name, column.name],
        );
        if (present.length === 0) continue;
        for await (const rows of sql
          .unsafe(
            `SELECT ${column.quotedName} AS value FROM ${quote(schema)}.${quote(name)}`,
          )
          .cursor(batchSize))
          for (const row of rows) yield row.value;
      }
    };
  }

  // A clear of a stored table is a load of one commit of its connection.
  override async clear(
    { writer, clock, connection: connector }: Clearing,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    await using connection = new PostgresSession(this.url, 'elt');
    await installNumbering(connection.sql);
    await connection.sql.begin(async (transaction) => {
      const [schema] = await transaction.unsafe(
        'SELECT to_regnamespace($1) IS NOT NULL AS "exists"',
        [quote(this.schema)],
      );
      if (schema?.exists !== true) return;
      const writers = this.#writers;
      await transaction.unsafe(
        `CREATE TABLE IF NOT EXISTS ${writers} ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL)`,
      );
      const [row] = await transaction.unsafe(
        `SELECT "writer" FROM ${writers} WHERE "target" = $1`,
        [this.table.name],
      );
      if (row !== undefined && row.writer !== writer)
        throw new TargetOwnedError(this.table.name, String(row.writer), writer);
      // Emptied, not dropped: views built on the table, such as marts, keep working.
      const [table] = await transaction.unsafe(
        'SELECT to_regclass($1) IS NOT NULL AS "exists"',
        [this.qualifiedName],
      );
      if (table?.exists === true) {
        const committedIn = await commitOnce(
          transaction,
          connector,
          new Date(clock.Date.now()),
          this.#retention,
        );
        await this.#history.create(
          transaction,
          this.qualifiedName,
          async () => committedIn,
        );
        await this.#history.keep(
          transaction,
          committedIn,
          this.qualifiedName,
          `FROM ${this.qualifiedName} AS "_elt_old"`,
        );
        await transaction.unsafe(`DELETE FROM ${this.qualifiedName}`);
        await this.#history.expire(transaction);
      }
      // Clearing a copy also abandons the reload it left open.
      await transaction.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
      for (const column of this.table.columns.filter(
        (column) => column.storesFile,
      )) {
        const store = new PostgresFileStore(this.schema, this.table, column);
        const [chunks] = await transaction.unsafe(
          'SELECT to_regclass($1) IS NOT NULL AS "exists"',
          [store.qualifiedName],
        );
        // With no rows left, only the history refers to stored files.
        if (chunks?.exists === true)
          await store.prune(transaction, [this.#history.qualifiedName]);
      }
      await transaction.unsafe(`DELETE FROM ${writers} WHERE "target" = $1`, [
        this.table.name,
      ]);
    });
    await committed?.(
      this.values(connection.sql, () => [this.table.name, this.#history.name]),
    );
  }

  get #hash(): string {
    return hash('sha256', this.qualifiedName).slice(0, 40);
  }

  // One staged row as JSON. A row too large to send even alone, past V8's
  // longest string or Postgres's largest message, fails its stream, naming the
  // column that holds the most and the record's key.
  #serialize(row: EncodedValue[], record: unknown): string {
    let text: string | undefined;
    try {
      text = JSON.stringify(row);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    if (text !== undefined && Buffer.byteLength(text) <= rowBytes) return text;
    const { columns } = this.table;
    const sizes = columns.map((column) => {
      const value = Reflect.get(Object(record), column.field);
      return typeof value === 'string' ? Buffer.byteLength(value) : 0;
    });
    const largestSize = Math.max(...sizes);
    const largest = columns[sizes.indexOf(largestSize)];
    const key = Object.fromEntries(
      this.stream.primaryKey.map((field) => [
        field,
        Reflect.get(Object(record), field),
      ]),
    );
    throw new RangeError(
      `A record of ${this.qualifiedName} with key ${JSON.stringify(key)} is too large to stage: its largest value, in column ${largest?.name}, is ${largestSize} bytes, and Postgres takes at most 1 GB in one message`,
    );
  }

  // A reload's hidden target, beside the target and invisible to readers.
  get #hiddenName(): string {
    return `_elt_next_${this.#hash}`;
  }

  get #hidden(): string {
    return `${quote(this.schema)}.${quote(this.#hiddenName)}`;
  }

  // Drops the chunks of every stored column that is no longer one of the
  // target's file columns, before the table is replaced: no row of the table
  // that takes its place refers to them.
  async #dropRetiredChunks(sql: Transaction): Promise<void> {
    const files = new Set(
      this.table.columns
        .filter(({ storesFile }) => storesFile)
        .map(({ name }) => name),
    );
    for (const { name } of await storedColumns(sql, this.qualifiedName))
      if (!files.has(name))
        await sql.unsafe(
          `DROP TABLE IF EXISTS ${PostgresFileStore.qualifiedName(this.schema, this.table, name)}`,
        );
  }

  // Swaps a completed reload's hidden target in last, when the target no
  // longer has the stream's shape, so readers of the stored table wait only
  // for the swap, not the reload. A reader that holds it past the timeout
  // fails the copy until the next run. Whatever else depends on the target,
  // such as marts, refuses the swap.
  // Its rows are new to readers at this commit, and the history keeps every
  // row of the target it replaces.
  async #swap(sql: Transaction, committedIn: number): Promise<void> {
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
    await sql.unsafe(`UPDATE ${this.#hidden} SET "committed_in" = $1`, [
      committedIn,
    ]);
    await this.#view?.drop(sql);
    await this.#dropRetiredChunks(sql);
    const [target] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [this.qualifiedName],
    );
    if (target?.exists === true)
      await this.#history.keep(
        sql,
        committedIn,
        this.qualifiedName,
        `FROM ${this.qualifiedName} AS "_elt_old"`,
      );
    await sql.unsafe(`DROP TABLE IF EXISTS ${this.qualifiedName}`);
    await sql.unsafe(
      `ALTER TABLE ${this.#hidden} RENAME TO ${this.table.quotedName}`,
    );
    await this.adopt(sql);
    await this.#describe(sql, async () => committedIn);
  }

  // Gives a completed reload's rows to a target that still has the stream's
  // shape, in place and by difference: the history keeps each row of the
  // target that no row of the hidden target matches, and the row goes; a row
  // with a match stays, with its commit and its loaded_at, and the target
  // keeps its indexes, its triggers and what depends on it. Each row of the
  // hidden target that no row matches enters with this commit, and the
  // loaded_at of the load that wrote it.
  async #reloadInPlace(sql: Transaction, committedIn: number): Promise<void> {
    const target = { table: this.qualifiedName, id: 'ctid' };
    const reloaded = { table: this.#hidden, id: 'ctid' };
    const leaving = this.#unmatched(target, reloaded);
    await this.#history.keep(
      sql,
      committedIn,
      this.qualifiedName,
      `FROM ${this.qualifiedName} AS "_elt_old" WHERE "_elt_old".ctid IN (${leaving})`,
    );
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} WHERE ctid IN (${leaving})`,
    );
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} (${this.written.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, "loaded_at", $1::integer, ${version} FROM ${this.#hidden} WHERE ctid IN (${this.#unmatched(reloaded, target)}) ORDER BY ctid`,
      [committedIn],
    );
    await sql.unsafe(`DROP TABLE ${this.#hidden}`);
  }

  // Brings a stored table the stream no longer fits to its shape in place,
  // keeping every row, as Airbyte's Postgres destination does: a column the
  // stream added is added nullable, one it dropped is dropped, a changed type
  // is cast, and NOT NULL and the primary key follow the target's explicit
  // key columns. A value that will not cast, or rows that repeat a new key,
  // fail the load, naming the column, and the transaction leaves the table
  // as it was. Readers wait for the change as they wait for a swap, and
  // whatever else depends on the reader view refuses it.
  // A row with a value in a column that the change drops or casts loses or
  // changes the value, so it is a new version, in a commit of the load of its
  // own: the history keeps the row as it was. Its row hash counted the old
  // value, so it becomes NULL, which matches no record until a commit writes
  // the row again. A column that the change adds is NULL in each row, which a
  // row hash does not count, so it makes no new version.
  // A change of type that the history cannot follow by a widening makes the
  // change a commit too, which expires each position before it.
  async #evolve(
    sql: Transaction,
    stage: string,
    load: PostgresLoad,
  ): Promise<void> {
    let changedIn: number | undefined;
    const change = async () => (changedIn ??= await load.number(sql));
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
    // Postgres keeps the primary key as a constraint apart from NOT NULL, and
    // refuses to drop NOT NULL from a column it covers.
    const storedKey = await sql.unsafe<{ conname: string; attname: string }[]>(
      "SELECT c.conname, a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) WHERE c.conrelid = to_regclass($1) AND c.contype = 'p'",
      [this.qualifiedName],
    );
    const key = this.table.columns.filter((column) => column.isPrimaryKey);
    const rekeyed = !isDeepStrictEqual(
      storedKey.map(({ attname }) => attname).toSorted(),
      key.map(({ name }) => name).toSorted(),
    );
    const stored = new Map(
      (await storedColumns(sql, this.qualifiedName)).map((column) => [
        column.name,
        column,
      ]),
    );
    const types = new Map(
      (await storedColumns(sql, `pg_temp.${stage}`)).map(({ name, type }) => [
        name,
        type,
      ]),
    );
    const kept = new Set(['loaded_at', 'committed_in', '_elt_row_hash']);
    const declared = new Set(this.table.columns.map(({ name }) => name));
    const changed = [...stored.values()]
      .filter(
        ({ name, type }) =>
          !kept.has(name) && (!declared.has(name) || types.get(name) !== type),
      )
      .map(({ name }) => `${quote(name)} IS NOT NULL`)
      .join(' OR ');
    await this.#view?.drop(sql);
    if (changed !== '') {
      const committedIn = await change();
      await this.#history.keep(
        sql,
        committedIn,
        this.qualifiedName,
        `FROM ${this.qualifiedName} AS "_elt_old" WHERE ${changed}`,
      );
      await sql.unsafe(
        `UPDATE ${this.qualifiedName} SET "committed_in" = $1, "loaded_at" = $2::text::timestamptz, ${version} = NULL WHERE ${changed}`,
        [committedIn, load.loadedAt],
      );
    }
    try {
      await this.#dropRetiredChunks(sql);
      const [constraint] = storedKey;
      if (rekeyed && constraint !== undefined)
        await sql.unsafe(
          `ALTER TABLE ${this.qualifiedName} DROP CONSTRAINT ${quote(constraint.conname)}`,
        );
      for (const column of this.table.columns) {
        kept.add(column.name);
        const type = types.get(column.name);
        const existing = stored.get(column.name);
        if (existing === undefined) {
          await sql.unsafe(
            `ALTER TABLE ${this.qualifiedName} ADD COLUMN ${column.quotedName} ${type}`,
          );
          continue;
        }
        if (existing.type !== type)
          await sql.unsafe(
            `ALTER TABLE ${this.qualifiedName} ALTER COLUMN ${column.quotedName} TYPE ${type} USING ${column.quotedName}::${type}`,
          );
        if (existing.required !== column.isPrimaryKey)
          await sql.unsafe(
            `ALTER TABLE ${this.qualifiedName} ALTER COLUMN ${column.quotedName} ${column.isPrimaryKey ? 'SET' : 'DROP'} NOT NULL`,
          );
      }
      for (const name of stored.keys())
        if (!kept.has(name))
          await sql.unsafe(
            `ALTER TABLE ${this.qualifiedName} DROP COLUMN ${quote(name)}`,
          );
      if (rekeyed && key.length > 0)
        await sql.unsafe(
          `ALTER TABLE ${this.qualifiedName} ADD PRIMARY KEY (${key.map(({ quotedName }) => quotedName).join(', ')})`,
        );
    } catch (cause) {
      throw new TypeError(
        `The rows stored in ${this.qualifiedName} do not fit the new shape of stream ${this.stream.name}: ${errorMessage(cause)}. Clear the copy to load it again, or change the stream so they fit.`,
        { cause },
      );
    }
    await this.#describe(sql, change);
  }

  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition: Partition | null): [string, string[]] {
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
      ` WHERE ${columns.map((column, index) => `${column.quotedName} = ${column.valueFrom('$1::text::json', index)}`).join(' AND ')}`,
      [JSON.stringify(columns.map((column) => column.encode(partition)))],
    ];
  }

  // One stream's load. Operations wait in a session-private TEMP stage, so no
  // other session sees them and a crash leaves nothing behind. prepare only
  // refuses, evolves a stored table the stream no longer fits unless the load
  // overwrites it, and stages, so a run that fails before a commit leaves no
  // rows behind.
  // Each commit is one transaction that merges the stage, with the result of
  // applying its operations one at a time, into the target, or into a
  // reload's hidden target until complete() gives its rows to the target.
  // The first commit also creates the target, or the hidden target of a new
  // reload.
  async prepare(
    load: PostgresLoad,
    { writer, reloading }: { writer: string; reloading: boolean },
  ): Promise<Stage> {
    const { sql } = load;
    const stage = quote(`_elt_stage_${this.#hash}`);
    const stores = this.table.columns
      .filter((column) => column.storesFile)
      .map((column) => new PostgresFileStore(this.schema, this.table, column));
    let mode: ReloadMode = await load.transaction(async (sql) => {
      await this.#refuse(sql, writer);
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
      await sql.unsafe(
        `CREATE TEMP TABLE ${stage} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')}, ${version} TEXT)`,
      );
      for (const store of stores) await store.stage(sql);
      const target = await storedFit(
        sql,
        this.table,
        this.qualifiedName,
        stage,
      );
      const hidden = await storedFit(sql, this.table, this.#hidden, stage);
      let decided = reloadMode({
        reloading,
        destinationSyncMode: this.configuration.destinationSyncMode,
        target,
        hidden,
      });
      // A hidden target no reload continues is a leftover readers never saw.
      if (decided !== 'continue')
        await sql.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
      await this.#view?.refuse(sql, target === 'stale');
      if (decided === 'evolve') {
        await this.#evolve(sql, stage, load);
        decided = 'load';
      }
      if (decided === 'load' && !this.replaces) await this.inspect(sql);
      return decided;
    });
    const fresh = mode === 'create' || mode === 'reload';
    const open = () => mode === 'reload' || mode === 'continue';
    const into = () => (open() ? this.#hidden : this.qualifiedName);
    const tables = () => [
      ...(open() ? [this.qualifiedName, this.#hidden] : [this.qualifiedName]),
      this.#history.qualifiedName,
    ];
    const { columns } = this.table;
    // One JSON parameter per batch, cast back per column: no bind-parameter
    // limit. Declared text so the driver sends it as given.
    const insert = `INSERT INTO ${stage} (${seq}, ${op}, ${columns.map((column) => column.quotedName).join(', ')}, ${version}) SELECT (row->>0)::bigint, row->>1, ${columns.map((column, index) => column.valueFrom('row', index + 2)).join(', ')}, row->>${columns.length + 2} FROM json_array_elements($1::text::json) AS row`;
    // Each staged row as its JSON, and how many bytes they add up to.
    let pending: string[] = [];
    let pendingBytes = 0;
    let next = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      const rows = pending;
      pending = [];
      pendingBytes = 0;
      await sql.unsafe(insert, [`[${rows.join(',')}]`]);
    };
    // Partitions the stage dropped, which the next commit empties in the
    // table it merges into.
    let resets: Partition[] = [];
    const drop = async () => {
      pending = [];
      pendingBytes = 0;
      resets = [];
      await sql.unsafe(`TRUNCATE ${stage}`);
      for (const store of stores) await store.discard(sql);
    };
    // The first commit claims the target: it owns the hidden target of a
    // reload, or creates or adopts the table. Later commits find it claimed.
    // Gives whether the commit replaces the rows of the target with the
    // stage's.
    const claimTarget = async (sql: Transaction, committedIn: number) => {
      if (open()) {
        await this.#own(sql, writer);
        return false;
      }
      await this.#create(sql, writer, this.replaces, committedIn);
      return this.replaces;
    };
    const claimed = async () => false;
    let claim: (sql: Transaction, committedIn: number) => Promise<boolean> =
      claimTarget;
    return {
      fresh,
      get reloading() {
        return open();
      },
      values: this.values(sql, () => [
        ...(open() ? [this.table.name, this.#hiddenName] : [this.table.name]),
        this.#history.name,
      ]),
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          await flush();
          const { partition } = operation;
          if (partition === null) {
            // The whole stream starts over in a new hidden target.
            await drop();
            mode = 'reload';
            return;
          }
          const [rows, values] = this.#scope(partition);
          await sql.unsafe(`DELETE FROM ${stage}${rows}`, values);
          resets.push(partition);
          return;
        }
        // Each file is read here, before the source advances past it. The
        // row keeps its id, and the row hash its content: each load gives a
        // file a new id, so a row whose file is the same matches.
        let data = operation.type === 'RECORD' ? operation.data : undefined;
        const contents = new Map<PostgresColumn, Uint8Array>();
        for (const store of stores) {
          const content: unknown = Reflect.get(
            Object(data),
            store.column.field,
          );
          if (content instanceof FileContent) {
            const { file, sha256 } = await store.save(sql, content);
            data = { ...Object(data), [store.column.field]: file };
            contents.set(store.column, sha256);
          }
        }
        const row =
          operation.type === 'RECORD'
            ? this.encode(data)
            : this.deletionRow(operation.key);
        const hashed =
          operation.type === 'RECORD'
            ? rowHash(
                columns,
                columns.map(
                  (column, index) => contents.get(column) ?? row[index] ?? null,
                ),
              )
            : null;
        const text = this.#serialize(
          [next++, operation.type === 'RECORD' ? 'R' : 'D', ...row, hashed],
          data,
        );
        const bytes = Buffer.byteLength(text);
        if (pendingBytes + bytes > batchBytes) await flush();
        pending.push(text);
        pendingBytes += bytes;
        if (pending.length >= batchSize || pendingBytes >= batchBytes)
          await flush();
      },
      commit: async () => {
        await flush();
        await load.commit(async (sql, committedIn) => {
          if (mode === 'reload') {
            await sql.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
            await sql.unsafe(`CREATE TABLE ${this.#tableSQL(this.#hidden)}`);
            await this.build(sql, this.#hidden);
          }
          const replacing = await claim(sql, committedIn);
          // The rows of a hidden target were never shown, so only the target
          // keeps the rows a commit replaces.
          const history = open() ? null : this.#history;
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            await history?.keep(
              sql,
              committedIn,
              into(),
              `FROM ${into()} AS "_elt_old"${rows}`,
              values,
            );
            await sql.unsafe(`DELETE FROM ${into()}${rows}`, values);
          }
          for (const store of stores) await store.publish(sql);
          const written = { loadedAt: load.loadedAt, committedIn };
          if (replacing) await this.#replace(sql, stage, written);
          else await this.merge(sql, stage, written, into(), history);
          await sql.unsafe(`TRUNCATE ${stage}`);
          await this.#history.expire(sql);
          for (const store of stores) await store.prune(sql, tables());
        });
        claim = claimed;
        // Its first commit made the hidden target, so the reload continues.
        if (mode === 'reload') mode = 'continue';
        resets = [];
      },
      complete: async () => {
        if (!open()) return;
        await load.commit(async (sql, committedIn) => {
          const target = await storedFit(
            sql,
            this.table,
            this.qualifiedName,
            stage,
          );
          if (target === 'fits') await this.#reloadInPlace(sql, committedIn);
          else await this.#swap(sql, committedIn);
          await this.#history.expire(sql);
          for (const store of stores)
            await store.prune(sql, [
              this.qualifiedName,
              this.#history.qualifiedName,
            ]);
        });
        mode = 'load';
      },
      discard: drop,
      [Symbol.asyncDispose]: async () => {
        await drop();
        await sql.unsafe(`DROP TABLE pg_temp.${stage}`);
        for (const store of stores) await store.unstage(sql);
      },
    };
  }
}

// What each row a commit writes keeps: when its load began, and the number of
// the commit.
export type Written = {
  readonly loadedAt: string;
  readonly committedIn: number;
};
