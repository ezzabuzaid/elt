import { createHash } from 'node:crypto';

import {
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
  reloadMode,
} from '@workspace/elt';

import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import { TargetComments } from './postgres-comments.ts';
import { PostgresFileStore } from './postgres-file-store.ts';
import { storedColumns, storedFit } from './postgres-fit.ts';
import type { PostgresLoad, Transaction } from './postgres-load.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { PostgresSession, schemaLock } from './postgres-session.ts';
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

export abstract class PostgresWriter extends Writer {
  readonly configuration: CopyConfiguration;
  protected readonly url: string;
  readonly schema: string;
  readonly table: PostgresTable;
  readonly #comments: TargetComments;
  readonly #view: TargetReaderView | undefined;

  constructor(
    configuration: CopyConfiguration,
    url: string,
    schema: string,
    table: PostgresTable,
  ) {
    super(configuration.stream);
    this.configuration = configuration;
    this.url = url;
    this.schema = schema;
    this.table = table;
    const description = describeTarget(
      configuration,
      table.columns,
      (column) =>
        `UUID reference to the source file's original bytes. Join ${new PostgresFileStore(schema, table, column).qualifiedName} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
    );
    this.#comments = new TargetComments(description.table, description.columns);
    this.#view =
      table.readerView &&
      new TargetReaderView(
        table.readerView,
        this.qualifiedName,
        [...table.columns.map(({ name }) => name), 'loaded_at'],
        this.fields,
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
    return `${name} (${this.table.columns.map((column) => column.definition).join(', ')}, "loaded_at" TIMESTAMPTZ NOT NULL)`;
  }

  // What a reload's hidden target needs once it is created, before the first
  // merge fills it, and once it takes the target's name.
  protected async build(_sql: Transaction, _into: string): Promise<void> {}
  protected async adopt(_sql: Transaction): Promise<void> {}

  protected get fields(): string[] {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
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

  // Empties the target a replacing commit is about to fill.
  protected async replace(sql: Transaction): Promise<void> {
    await sql.unsafe(`DELETE FROM ${this.qualifiedName}`);
  }

  // Moves the staged operations into the target, or the table a rebuild
  // fills; every row of a run shares its loaded_at.
  protected async merge(
    sql: Transaction,
    stage: string,
    loadedAt: string,
    into = this.qualifiedName,
  ): Promise<void> {
    await sql.unsafe(
      `INSERT INTO ${into} (${this.fields.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, $1::text::timestamptz FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
      [loadedAt],
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

  // The target as its first commit makes it: the schema, its owner, the
  // table and its comments, and the reader view.
  async #create(
    sql: Transaction,
    writer: string,
    replacing: boolean,
  ): Promise<void> {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`);
    await this.#own(sql, writer);
    await this.initialize(sql, replacing);
    await this.#comments.write(sql, 'TABLE', this.schema, this.table.name);
    await this.#view?.describe(sql, this.#comments);
  }

  // The field's values in each of the tables, which while a reload is open
  // are the target and its hidden target: both rows still refer to files.
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

  override async clear(
    writer: string,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    await using connection = new PostgresSession(this.url, 'elt');
    // Hold this schema across the database commit and its acknowledgement.
    // The session closes on every exit, releasing its advisory lock.
    await connection.sql.unsafe(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [schemaLock(this.schema)],
    );
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
      if (table?.exists === true)
        await transaction.unsafe(`DELETE FROM ${this.qualifiedName}`);
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
        if (chunks?.exists === true)
          await transaction.unsafe(`DELETE FROM ${store.qualifiedName}`);
      }
      await transaction.unsafe(`DELETE FROM ${writers} WHERE "target" = $1`, [
        this.table.name,
      ]);
    });
    await committed?.(this.values(connection.sql, () => [this.table.name]));
  }

  get #hash(): string {
    return createHash('sha256')
      .update(this.qualifiedName)
      .digest('hex')
      .slice(0, 40);
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

  // Swaps a completed reload's hidden target in last, so readers of the
  // stored table wait only for the swap, not the reload. A reader that holds
  // it past the timeout fails the copy until the next run. Whatever else
  // depends on the target, such as marts, refuses the swap.
  async #swap(sql: Transaction): Promise<void> {
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
    await this.#view?.drop(sql);
    await sql.unsafe(`DROP TABLE IF EXISTS ${this.qualifiedName}`);
    await sql.unsafe(
      `ALTER TABLE ${this.#hidden} RENAME TO ${this.table.quotedName}`,
    );
    await this.adopt(sql);
    await this.#comments.write(sql, 'TABLE', this.schema, this.table.name);
    await this.#view?.describe(sql, this.#comments);
  }

  // Brings a stored table the stream no longer fits to its shape in place,
  // keeping every row, as Airbyte's Postgres destination does: a column the
  // stream added is added nullable, one it dropped is dropped, a changed type
  // is cast, and NOT NULL follows the primary key. A value that will not cast
  // fails the load, naming the column, and the transaction leaves the table
  // as it was. Readers wait for the change as they wait for a swap, and
  // whatever else depends on the reader view refuses it.
  async #evolve(sql: Transaction, stage: string): Promise<void> {
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
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
    const kept = new Set(['loaded_at']);
    await this.#view?.drop(sql);
    try {
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
    } catch (cause) {
      throw new TypeError(
        `The rows stored in ${this.qualifiedName} do not fit the new shape of stream ${this.stream.name}: ${cause instanceof Error ? cause.message : String(cause)}. Clear the copy to load it again, or change the stream so they fit.`,
        { cause },
      );
    }
    await this.#comments.write(sql, 'TABLE', this.schema, this.table.name);
    await this.#view?.describe(sql, this.#comments);
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
  // reload's hidden target until complete() swaps it in. The first commit
  // also creates the target, or the hidden target of a new reload.
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
        `CREATE TEMP TABLE ${stage} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
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
        await this.#evolve(sql, stage);
        decided = 'load';
      }
      if (decided === 'load' && !this.replaces) await this.inspect(sql);
      return decided;
    });
    const fresh = mode === 'create' || mode === 'reload';
    // The hidden target of a reload exists once its first commit made it.
    let opened = mode === 'continue';
    const open = () => mode === 'reload' || mode === 'continue';
    const into = () => (open() ? this.#hidden : this.qualifiedName);
    const tables = () =>
      open() ? [this.qualifiedName, this.#hidden] : [this.qualifiedName];
    const { columns } = this.table;
    // One JSON parameter per batch, cast back per column: no bind-parameter
    // limit. Declared text so the driver sends it as given.
    const insert = `INSERT INTO ${stage} (${seq}, ${op}, ${columns.map((column) => column.quotedName).join(', ')}) SELECT (row->>0)::bigint, row->>1, ${columns.map((column, index) => column.valueFrom('row', index + 2)).join(', ')} FROM json_array_elements($1::text::json) AS row`;
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
    let committed = false;
    return {
      fresh,
      get reloading() {
        return open();
      },
      values: this.values(sql, () =>
        open() ? [this.table.name, this.#hiddenName] : [this.table.name],
      ),
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          await flush();
          const { partition } = operation;
          if (partition === null) {
            // The whole stream starts over in a new hidden target.
            await drop();
            mode = 'reload';
            opened = false;
            return;
          }
          const [rows, values] = this.#scope(partition);
          await sql.unsafe(`DELETE FROM ${stage}${rows}`, values);
          resets.push(partition);
          return;
        }
        let data = operation.type === 'RECORD' ? operation.data : undefined;
        for (const store of stores) {
          const content: unknown = Reflect.get(
            Object(data),
            store.column.field,
          );
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [store.column.field]: await store.save(sql, content),
            };
        }
        const row =
          operation.type === 'RECORD'
            ? this.encode(data)
            : this.deletionRow(operation.key);
        const text = this.#serialize(
          [next++, operation.type === 'RECORD' ? 'R' : 'D', ...row],
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
        await load.transaction(async (sql) => {
          if (open()) {
            if (!opened) {
              await sql.unsafe(`DROP TABLE IF EXISTS ${this.#hidden}`);
              await sql.unsafe(`CREATE TABLE ${this.#tableSQL(this.#hidden)}`);
              await this.build(sql, this.#hidden);
            }
            if (!committed) await this.#own(sql, writer);
          } else if (!committed) {
            await this.#create(sql, writer, this.replaces);
            if (this.replaces) await this.replace(sql);
          }
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            await sql.unsafe(`DELETE FROM ${into()}${rows}`, values);
          }
          for (const store of stores) await store.publish(sql);
          await this.merge(sql, stage, load.loadedAt, into());
          await sql.unsafe(`TRUNCATE ${stage}`);
          for (const store of stores) await store.prune(sql, tables());
        });
        opened = open();
        committed = true;
        resets = [];
      },
      complete: async () => {
        if (!open()) return;
        await load.transaction(async (sql) => {
          await this.#swap(sql);
          for (const store of stores)
            await store.prune(sql, [this.qualifiedName]);
        });
        mode = 'load';
        opened = false;
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
