import { hash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  type Clearing,
  type CopyConfiguration,
  type FieldValues,
  type KeyValue,
  type Partition,
  type ReloadMode,
  type Reloads,
  SomePartitions,
  type Stage,
  TargetOwnedError,
  Writer,
  describeTarget,
  errorMessage,
  readPartitions,
  reloadMode,
  wholeStream,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { TargetComments } from './postgres-comments.ts';
import { rebindDependents } from './postgres-dependents.ts';
import { storedColumns, storedFit } from './postgres-fit.ts';
import { TargetHistory, rowHash, version } from './postgres-history.ts';
import type { PostgresLoad, Transaction } from './postgres-load.ts';
import {
  commitOnce,
  expireBefore,
  installNumbering,
} from './postgres-numbering.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { inWarehouse, marts, warehouse } from './postgres-schemas.ts';
import {
  PostgresSession,
  type Queries,
  lockSchema,
  makeSchema,
} from './postgres-session.ts';
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
  readonly table: PostgresTable;
  // Where the target keeps the rows that its commits replace or remove, and
  // how long it keeps a position readable.
  readonly #history: TargetHistory;
  readonly #retention: Temporal.Duration;
  readonly #comments: TargetComments;
  readonly #view: TargetReaderView;

  constructor(
    configuration: CopyConfiguration,
    url: string,
    table: PostgresTable,
    retention: Temporal.Duration,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.url = url;
    this.table = table;
    this.#retention = retention;
    this.#history = new TargetHistory(this.#hash);
    const description = describeTarget(configuration, table.columns);
    const { missing } = description;
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${marts}.${table.name} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
    this.#comments = new TargetComments(description.table, {
      ...description.columns,
      committed_in: `Number of the commit that last wrote this row: the row of ${warehouse}._elt_commits with this number tells when, and in which load.`,
    });
    this.#view = new TargetReaderView(
      table.name,
      this.qualifiedName,
      this.#history.qualifiedName,
      [...table.columns.map(({ name }) => name), 'loaded_at'],
      new TargetComments(description.table, description.columns),
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
    return inWarehouse(this.table.raw);
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
    await this.#history.remove(
      sql,
      written.committedIn,
      this.qualifiedName,
      ` WHERE "_elt_old".ctid IN (${this.#unmatched(target, staged)})`,
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
      [warehouse, this.table.raw],
    );
    return rows.map((row) => String(row.indexname));
  }

  // The owner lives beside the table it guards. A dropped table releases it,
  // since nothing it held remains.
  async #refuse(sql: Transaction, writer: string): Promise<void> {
    const [row] = await sql.unsafe(
      `SELECT "writer" FROM ${writersTable} WHERE "target" = $1 AND to_regclass(format('%I.%I', $2::text, "target")) IS NOT NULL`,
      [this.table.raw, warehouse],
    );
    if (row !== undefined && row.writer !== writer)
      throw new TargetOwnedError(this.table.name, String(row.writer), writer);
  }

  // Records the owner with the target's first commit; prepare refused any
  // other.
  async #own(sql: Transaction, writer: string): Promise<void> {
    await sql.unsafe(
      `DELETE FROM ${writersTable} WHERE to_regclass(format('%I.%I', $1::text, "target")) IS NULL`,
      [warehouse],
    );
    await sql.unsafe(
      `INSERT INTO ${writersTable} ("target", "writer") VALUES ($1, $2) ON CONFLICT ("target") DO NOTHING`,
      [this.table.raw, writer],
    );
  }

  // The target as its first commit, numbered committedIn, makes it: its
  // owner, the table, its history and its comments, and the reader view.
  async #create(
    sql: Transaction,
    writer: string,
    replacing: boolean,
    committedIn: number,
  ): Promise<void> {
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
    await this.#comments.write(sql, 'TABLE', warehouse, this.table.raw);
    await this.#view.describe(sql);
  }

  // The field's values in each of the tables and in the history: while a
  // reload is open, the rows of the target and of its hidden target both
  // still refer to files, and a row of the history keeps its file for a
  // reading as of a position before the commit that replaced it.
  private values(
    sql: Transaction,
    tables: () => readonly string[],
  ): FieldValues {
    const { table } = this;
    return async function* (field) {
      const column = table.columns.find((column) => column.field === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      for (const name of tables()) {
        const present = await sql.unsafe(
          'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
          [warehouse, name, column.name],
        );
        if (present.length === 0) continue;
        for await (const rows of sql
          .unsafe(
            `SELECT ${column.quotedName} AS value FROM ${inWarehouse(name)}`,
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
    await makeWriterTables(connection.sql);
    await connection.sql.begin(async (transaction) => {
      const [row] = await transaction.unsafe(
        `SELECT "writer" FROM ${writersTable} WHERE "target" = $1`,
        [this.table.raw],
      );
      if (row !== undefined && row.writer !== writer)
        throw new TargetOwnedError(this.table.name, String(row.writer), writer);
      // Emptied, not dropped: the views built on the table keep working.
      // The rows it removes are forgotten: each position before the
      // clear expires, so the history keeps none of them.
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
        await transaction.unsafe(`DELETE FROM ${this.qualifiedName}`);
        await expireBefore(transaction, committedIn, 'clear');
        await this.#history.expire(transaction);
      }
      // Clearing a copy also abandons the reload it left open.
      await transaction.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
      await this.#reloaded(transaction);
      await transaction.unsafe(
        `DELETE FROM ${writersTable} WHERE "target" = $1`,
        [this.table.raw],
      );
    });
    await committed?.(
      this.values(connection.sql, () => [this.table.raw, this.#history.name]),
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
    return inWarehouse(this.#hiddenName);
  }

  // Swaps a completed reload's hidden target in last, when the target no
  // longer has the stream's shape, so readers of the stored table wait only
  // for the swap, not the reload. A reader that holds it past the timeout
  // fails the copy until the next run. The views that read the target, its
  // history or its reader view read the swapped-in table, and it keeps the
  // target's privileges.
  // Its rows are new to readers at this commit, and the history keeps every
  // row of the target it replaces.
  async #swap(sql: Transaction, committedIn: number): Promise<void> {
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
    await sql.unsafe(`UPDATE ${this.#hidden} SET "committed_in" = $1`, [
      committedIn,
    ]);
    await rebindDependents(sql, this.#readable, async () => {
      await this.#view.drop(sql);
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
        `ALTER TABLE ${this.#hidden} RENAME TO ${this.table.quotedRaw}`,
      );
      await this.adopt(sql);
      await this.#describe(sql, async () => committedIn);
    });
  }

  // What readers and the views built on them read of the target.
  get #readable(): string[] {
    return [
      this.qualifiedName,
      this.#history.qualifiedName,
      this.#view.qualifiedName,
    ];
  }

  // Gives a completed reload's rows to a target that still has the stream's
  // shape, in place and by difference: the history keeps each row of the
  // target that no row of the hidden target matches, and the row goes; a row
  // with a match stays, with its commit and its loaded_at, and the target
  // keeps its indexes, its triggers and what depends on it. Each row of the
  // hidden target that no row matches enters with this commit, and the
  // loaded_at of the load that wrote it.
  async #reloadInPlace(
    sql: Transaction,
    committedIn: number,
    target: Side = { table: this.qualifiedName, id: 'ctid' },
  ): Promise<void> {
    const reloaded = { table: this.#hidden, id: 'ctid' };
    await this.#history.remove(
      sql,
      committedIn,
      this.qualifiedName,
      ` WHERE "_elt_old".ctid IN (${this.#unmatched(target, reloaded)})`,
    );
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} (${this.written.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, "loaded_at", $1::integer, ${version} FROM ${this.#hidden} WHERE ctid IN (${this.#unmatched(reloaded, target)}) ORDER BY ctid`,
      [committedIn],
    );
    await sql.unsafe(`DROP TABLE ${this.#hidden}`);
  }

  // Gives a completed reload of some partitions their rows of the hidden
  // target, in place and by difference: the rows of the target in those
  // partitions are replaced as #reloadInPlace replaces a whole target, and
  // the rows of every other partition stay as they are.
  async #reloadPartitionsInPlace(
    sql: Transaction,
    partitions: readonly Partition[],
    committedIn: number,
  ): Promise<void> {
    const scoped = quote(`_elt_reloaded_${this.#hash}`);
    const [within, values] = this.#within(partitions);
    await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${scoped}`);
    await sql.unsafe(
      `CREATE TEMP TABLE ${scoped} AS SELECT ctid AS "row" FROM ${this.qualifiedName} WHERE ${within}`,
      values,
    );
    await this.#reloadInPlace(sql, committedIn, {
      table: this.qualifiedName,
      id: 'ctid',
      rows: `ctid IN (SELECT "row" FROM pg_temp.${scoped})`,
    });
    await sql.unsafe(`DROP TABLE pg_temp.${scoped}`);
  }

  // Refuses a cast of column from its stored type from that would change a
  // stored value, such as double precision 1.5 to bigint 2, before the ALTER,
  // as a STRICT SQLite table refuses it: each value that is not null must
  // cast back to itself. A cast from text is the parse the load applies to
  // each value of the new type, so it is trusted, and a value it cannot parse
  // fails the ALTER.
  async #refuseInexactCast(
    sql: Transaction,
    column: PostgresColumn,
    from: string,
  ): Promise<void> {
    if (from === 'text' || from === 'text[]') return;
    const { quotedName: name, storageType: to } = column;
    let changes: unknown[];
    try {
      changes = await sql.unsafe(
        `SELECT 1 FROM ${this.qualifiedName} WHERE ${name} IS NOT NULL AND ${name}::${to}::${from} IS DISTINCT FROM ${name} LIMIT 1`,
      );
    } catch (cause) {
      throw new TypeError(
        `column ${name} does not cast to ${to}: ${errorMessage(cause)}`,
        { cause },
      );
    }
    if (changes.length > 0)
      throw new TypeError(
        `column ${name} holds a value that a cast to ${to} would change`,
      );
  }

  // Brings a stored table the stream no longer fits to its shape in place,
  // keeping every row, as Airbyte's Postgres destination does: a column the
  // stream added is added nullable, one it dropped is dropped, a changed type
  // is cast, and NOT NULL and the primary key follow the target's explicit
  // key columns. A value that will not cast exactly, or rows that repeat a
  // new key, fail the load, naming the column, and the transaction leaves the
  // table as it was. Readers wait for the change as they wait for a swap, and
  // the views that read the target, its history or its reader view read it
  // again after the change.
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
    await rebindDependents(sql, this.#readable, async () => {
      await this.#view.drop(sql);
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
          if (existing.type !== type) {
            await this.#refuseInexactCast(sql, column, existing.type);
            await sql.unsafe(
              `ALTER TABLE ${this.qualifiedName} ALTER COLUMN ${column.quotedName} TYPE ${type} USING ${column.quotedName}::${type}`,
            );
          }
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
    });
  }

  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition: Partition | null): [string, string[]] {
    if (partition === null) return ['', []];
    const [condition, values] = this.#within([partition]);
    return [` WHERE ${condition}`, values];
  }

  // The rows of any of the partitions, as a condition over the target's or
  // the stage's columns, with one JSON parameter for each partition: NULL for
  // a row that does not name its partition, such as a staged DELETE whose
  // key leaves the partition out.
  #within(partitions: readonly Partition[]): [string, string[]] {
    const each = partitions.map((partition, index) =>
      this.#partition(partition, `$${index + 1}::text::json`),
    );
    return [
      each.length === 0
        ? 'FALSE'
        : each.map(([condition]) => `(${condition})`).join(' OR '),
      each.map(([, value]) => value),
    ];
  }

  #partition(partition: Partition, parameter: string): [string, string] {
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
      columns
        .map(
          (column, index) =>
            `${column.quotedName} = ${column.valueFrom(parameter, index)}`,
        )
        .join(' AND '),
      JSON.stringify(columns.map((column) => column.encode(partition))),
    ];
  }

  // The partitions that an open reload of the target reloads, in the
  // writer's own table beside it, written in the commit that opens or
  // continues the reload, so a run that resumes the reload continues it. A
  // reload of the whole stream has no row.
  async #reloading(sql: Queries): Promise<Reloads> {
    const [row] = await sql.unsafe<{ partitions: string }[]>(
      `SELECT "partitions" FROM ${reloadsTable} WHERE "target" = $1`,
      [this.table.raw],
    );
    return row === undefined
      ? wholeStream
      : new SomePartitions(
          readPartitions(this.stream, JSON.parse(row.partitions)),
        );
  }

  async #reload(sql: Transaction, reloads: Reloads): Promise<void> {
    if (!(reloads instanceof SomePartitions)) {
      await this.#reloaded(sql);
      return;
    }
    await sql.unsafe(
      `INSERT INTO ${reloadsTable} ("target", "partitions") VALUES ($1, $2) ON CONFLICT ("target") DO UPDATE SET "partitions" = excluded."partitions"`,
      [this.table.raw, JSON.stringify(reloads.partitions)],
    );
  }

  async #reloaded(sql: Queries): Promise<void> {
    await sql.unsafe(`DELETE FROM ${reloadsTable} WHERE "target" = $1`, [
      this.table.raw,
    ]);
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
    // The rows of a commit that belong to the partitions a reload reloads.
    const reloadStage = quote(`_elt_reload_stage_${this.#hash}`);
    const staging = (table: string) =>
      `CREATE TEMP TABLE ${table} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')}, ${version} TEXT)`;
    // What an open reload reloads; the whole stream until a RESET of a
    // partition opens one.
    let reloads: Reloads = wholeStream;
    await makeWriterTables(sql);
    let mode: ReloadMode = await load.transaction(async (sql) => {
      await this.#refuse(sql, writer);
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
      await sql.unsafe(staging(stage));
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${reloadStage}`);
      await sql.unsafe(staging(reloadStage));
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
      if (decided === 'continue') reloads = await this.#reloading(sql);
      else {
        await sql.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
        await this.#reloaded(sql);
      }
      await this.#view.refuse(sql, target === 'stale');
      if (decided === 'evolve') {
        await this.#evolve(sql, stage, load);
        decided = 'load';
      }
      if (decided === 'load' && !this.replaces) await this.inspect(sql);
      return decided;
    });
    const fresh = mode === 'create' || mode === 'reload';
    // The reload as the last commit left it, which a discard goes back to.
    let committed: { readonly mode: ReloadMode; readonly reloads: Reloads } = {
      mode,
      reloads,
    };
    const open = () => mode === 'reload' || mode === 'continue';
    const into = () => (open() ? this.#hidden : this.qualifiedName);
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
    };
    // The first commit claims the target: it owns the hidden target of a
    // reload, or creates or adopts the table, and before its transaction it
    // makes marts for the reader view of a new target; the load made
    // _warehouse with its numbering. Later commits find it claimed. claim
    // gives whether the commit replaces the rows of the target with the
    // stage's.
    const unclaimed: Claim = {
      before: async () => {
        if (mode === 'create') await makeSchema(load.sql, marts);
      },
      claim: async (sql, committedIn) => {
        if (open()) {
          await this.#own(sql, writer);
          return false;
        }
        await this.#create(sql, writer, this.replaces, committedIn);
        return this.replaces;
      },
    };
    const claimed: Claim = {
      before: async () => {},
      claim: async () => false,
    };
    let claiming = unclaimed;
    return {
      fresh,
      get reloading() {
        return open();
      },
      values: this.values(sql, () => [
        ...(open() ? [this.table.raw, this.#hiddenName] : [this.table.raw]),
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
            reloads = wholeStream;
            return;
          }
          const [rows, values] = this.#scope(partition);
          await sql.unsafe(`DELETE FROM ${stage}${rows}`, values);
          resets.push(partition);
          // The partition starts over in a hidden target, and readers see its
          // rows as they were until the stream ends. An overwrite replaces
          // the whole target anyway.
          if (this.replaces) return;
          if (mode === 'load') {
            mode = 'reload';
            reloads = new SomePartitions([partition]);
          } else if (open() && reloads instanceof SomePartitions)
            reloads = reloads.with(partition);
          return;
        }
        const data = operation.type === 'RECORD' ? operation.data : undefined;
        const row =
          operation.type === 'RECORD'
            ? this.encode(data)
            : this.deletionRow(operation.key);
        const hashed =
          operation.type === 'RECORD' ? rowHash(columns, row) : null;
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
        await claiming.before();
        await load.commit(async (sql, committedIn) => {
          if (mode === 'reload') {
            await sql.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
            await sql.unsafe(`CREATE TABLE ${this.#tableSQL(this.#hidden)}`);
            await this.build(sql, this.#hidden);
          }
          if (open()) await this.#reload(sql, reloads);
          const replacing = await claiming.claim(sql, committedIn);
          // The rows of a hidden target were never shown, so only the target
          // keeps the rows a commit replaces.
          const history = open() ? null : this.#history;
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            if (history === null)
              await sql.unsafe(`DELETE FROM ${into()}${rows}`, values);
            else await history.remove(sql, committedIn, into(), rows, values);
          }
          const written = { loadedAt: load.loadedAt, committedIn };
          if (replacing) await this.#replace(sql, stage, written);
          else if (open() && reloads instanceof SomePartitions) {
            // The rows of the reloaded partitions go to the hidden target,
            // the others to the target. A DELETE whose key does not name
            // its partition goes to both, so the reload cannot bring back a
            // row that the source deleted.
            const [within, values] = this.#within(reloads.partitions);
            await sql.unsafe(
              `INSERT INTO ${reloadStage} SELECT * FROM ${stage} WHERE (${within}) IS TRUE OR (${op} = 'D' AND (${within}) IS NULL)`,
              values,
            );
            await sql.unsafe(
              `DELETE FROM ${stage} WHERE (${within}) IS TRUE`,
              values,
            );
            await this.merge(
              sql,
              stage,
              written,
              this.qualifiedName,
              this.#history,
            );
            await this.merge(sql, reloadStage, written, this.#hidden, null);
            await sql.unsafe(`TRUNCATE ${reloadStage}`);
          } else await this.merge(sql, stage, written, into(), history);
          await sql.unsafe(`TRUNCATE ${stage}`);
          await this.#history.expire(sql);
        });
        claiming = claimed;
        // Its first commit made the hidden target, so the reload continues.
        if (mode === 'reload') mode = 'continue';
        committed = { mode, reloads };
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
          // A reload of partitions keeps the target's shape: prepare evolves
          // a stored target before it loads.
          if (reloads instanceof SomePartitions && target === 'fits')
            await this.#reloadPartitionsInPlace(
              sql,
              reloads.partitions,
              committedIn,
            );
          else if (reloads instanceof SomePartitions)
            throw new TypeError(
              `${this.qualifiedName} changed its shape while some of its partitions reloaded; clear the copy to load it again`,
            );
          else if (target === 'fits')
            await this.#reloadInPlace(sql, committedIn);
          else await this.#swap(sql, committedIn);
          await this.#reloaded(sql);
          await this.#history.expire(sql);
        });
        mode = 'load';
        reloads = wholeStream;
        committed = { mode, reloads };
      },
      // A RESET that no commit took is undone with the operations after it:
      // the source's checkpoint does not know it.
      discard: async () => {
        await drop();
        ({ mode, reloads } = committed);
      },
      [Symbol.asyncDispose]: async () => {
        await drop();
        await sql.unsafe(`DROP TABLE pg_temp.${stage}`);
        await sql.unsafe(`DROP TABLE pg_temp.${reloadStage}`);
      },
    };
  }
}

// The tables in _warehouse where each writer keeps the owner of its target
// and the partitions of its open reload.
const writersTable = inWarehouse('_elt_writers');
const reloadsTable = inWarehouse('_elt_reloads');

// Makes the tables of the writers in a transaction of their own, before the
// commits of a load: Postgres refuses a second session's CREATE TABLE of one
// name with 23505, so the lock of _warehouse makes two sessions take turns,
// and no commit holds that lock while it waits for its own target. sql is a
// session outside any transaction.
async function makeWriterTables(sql: Transaction): Promise<void> {
  const [made] = await sql.unsafe(
    'SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS "made"',
    [writersTable, reloadsTable],
  );
  if (made?.made === true) return;
  await sql.begin(async (transaction) => {
    await lockSchema(transaction, warehouse);
    await transaction.unsafe(
      `CREATE TABLE IF NOT EXISTS ${writersTable} ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL)`,
    );
    await transaction.unsafe(
      `CREATE TABLE IF NOT EXISTS ${reloadsTable} ("target" TEXT PRIMARY KEY, "partitions" TEXT NOT NULL)`,
    );
  });
}

// Whether a stage's commit claims its target: the first does, the later ones
// find it claimed.
type Claim = {
  // Runs before the commit's transaction.
  readonly before: () => Promise<void>;
  // Runs in it, and gives whether the commit replaces the target's rows.
  readonly claim: (sql: Transaction, committedIn: number) => Promise<boolean>;
};

// What each row a commit writes keeps: when its load began, and the number of
// the commit.
export type Written = {
  readonly loadedAt: string;
  readonly committedIn: number;
};
