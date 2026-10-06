import { createHash } from 'node:crypto';

import type postgres from 'postgres';

import {
  type CopyConfiguration,
  type FieldValues,
  FileContent,
  type KeyValue,
  type Partition,
  type Stage,
  TargetOwnedError,
  Writer,
  describeTarget,
  undescribed,
} from '@workspace/elt';

import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import { PostgresFileStore } from './postgres-file-store.ts';
import { PostgresSession, schemaLock } from './postgres-session.ts';
import type { PostgresTable } from './postgres-table.ts';

// The load's one connection, inside one commit's transaction or on its own.
export type Transaction = postgres.Sql;

const batchSize = 1000;
export const seq = '"_elt_seq"';
export const op = '"_elt_op"';

// How long swapping in a rebuilt target waits for its readers before the
// copy gives up until the next run.
const swapTimeout = '3s';

// A run's one connection to a schema. The schema lock keeps every other load
// out until it closes, as SQLite's BEGIN IMMEDIATE does per file; readers
// never wait on it. No transaction stays open between commits, so reading the
// source holds no locks on the targets and keeps nothing from vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: PostgresSession;
  readonly schema: string;
  readonly loadedAt: string;

  private constructor(
    connection: PostgresSession,
    schema: string,
    loadedAt: string,
  ) {
    this.#connection = connection;
    this.schema = schema;
    this.loadedAt = loadedAt;
  }

  get sql(): Transaction {
    return this.#connection.sql;
  }

  static async open(url: string, schema: string): Promise<PostgresLoad> {
    const connection = new PostgresSession(url, 'elt');
    try {
      const [clock] = await connection.sql.unsafe(
        'SELECT clock_timestamp()::text AS "loadedAt"',
      );
      // Closing this connection releases the session lock, including on errors.
      await connection.sql.unsafe(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [schemaLock(schema)],
      );
      return new PostgresLoad(connection, schema, String(clock?.loadedAt));
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  // What work does becomes durable and visible together, or not at all.
  async transaction<T>(work: (sql: Transaction) => Promise<T>): Promise<T> {
    await this.sql.unsafe('BEGIN');
    try {
      const result = await work(this.sql);
      await this.sql.unsafe('COMMIT');
      return result;
    } catch (error) {
      await this.sql.unsafe('ROLLBACK');
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#connection[Symbol.asyncDispose]();
  }
}

export abstract class PostgresWriter extends Writer {
  readonly configuration: CopyConfiguration;
  protected readonly url: string;
  readonly schema: string;
  readonly table: PostgresTable;
  readonly #tableComment: string;
  readonly #columnComments: Readonly<Record<string, string | null>>;

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
    this.#tableComment = description.table;
    this.#columnComments = description.columns;
    if (table.readerView === undefined) return;
    const missing = undescribed(description);
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

  // What a rebuilt target, still empty under its temporary name into, needs
  // before the merge fills it, and once it takes the target's name.
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
    await this.#comment(sql, 'TABLE', this.schema, this.table.name);
    await this.#describeReaderView(sql);
  }

  private values(sql: Transaction): FieldValues {
    const { table, schema, qualifiedName } = this;
    return async function* (field) {
      const column = table.columns.find((column) => column.name === field);
      if (column === undefined)
        throw new TypeError(`Unknown target field: ${field}`);
      const present = await sql.unsafe(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
        [schema, table.name, field],
      );
      if (present.length === 0) return;
      for await (const rows of sql
        .unsafe(`SELECT ${column.quotedName} AS value FROM ${qualifiedName}`)
        .cursor(batchSize))
        for (const row of rows) yield row.value;
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
    await committed?.(this.values(connection.sql));
  }

  // COMMENT does not accept bind parameters. Let Postgres quote identifiers
  // and literals, including NULL to clear annotations removed from the schema.
  async #comment(
    sql: Transaction,
    kind: 'TABLE' | 'VIEW',
    schema: string,
    name: string,
  ): Promise<void> {
    const comments = await sql.unsafe<{ statement: string }[]>(
      `SELECT format('COMMENT ON ${kind} %I.%I IS %L', $1::text, $2::text, $3::text) AS statement
       UNION ALL
       SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L', $1::text, $2::text, key, value)
       FROM jsonb_each_text($4::jsonb)`,
      [schema, name, this.#tableComment, sql.json(this.#columnComments)],
    );
    await sql.unsafe(comments.map(({ statement }) => statement).join(';'));
  }

  get #readerViewName(): string | undefined {
    const reader = this.table.readerView;
    return reader && `${quote(reader.schema)}.${quote(reader.name)}`;
  }

  // Refuses, before anything is read, a reader view this load did not make:
  // not a view, or a view of other columns or another table. A stale
  // target's view still shows the stored columns, which its rebuild replaces.
  async #refuseReaderView(sql: Transaction, stale: boolean): Promise<void> {
    const view = this.#readerViewName;
    if (view === undefined) return;
    const [existing] = await sql.unsafe<
      { relkind: string; columns: string[]; reads: boolean }[]
    >(
      `SELECT c.relkind,
         ARRAY(SELECT attname::text FROM pg_attribute
           WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum) AS columns,
         EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_depend d
           ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
           WHERE r.ev_class = c.oid AND d.refobjid = to_regclass($2)) AS reads
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [view, this.qualifiedName],
    );
    if (existing === undefined) return;
    const expected = [
      ...this.table.columns.map(({ name }) => name),
      'loaded_at',
    ];
    if (
      existing.relkind !== 'v' ||
      !existing.reads ||
      (!stale && existing.columns.join('\0') !== expected.join('\0'))
    )
      throw new TypeError(
        `${view} is not a view of exactly ${this.qualifiedName}; drop it or reset the warehouse`,
      );
  }

  // Created only when absent and never replaced by a commit: replacing a view
  // readers can see would lock them out. prepare refused any view not this
  // load's own.
  async #describeReaderView(sql: Transaction): Promise<void> {
    const view = this.#readerViewName;
    const reader = this.table.readerView;
    if (view === undefined || reader === undefined) return;
    const [existing] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [view],
    );
    if (existing?.exists !== true)
      await sql.unsafe(
        `CREATE VIEW ${view} AS SELECT ${this.fields.join(', ')} FROM ${this.qualifiedName}`,
      );
    await this.#comment(sql, 'VIEW', reader.schema, reader.name);
  }

  get #hash(): string {
    return createHash('sha256')
      .update(this.qualifiedName)
      .digest('hex')
      .slice(0, 40);
  }

  // Whether the stored target has the columns, types and NOT NULL the stream
  // needs. The stage is built from the same column declarations, so Postgres
  // spells both alike.
  async #fit(
    sql: Transaction,
    stage: string,
  ): Promise<'missing' | 'stale' | 'fits'> {
    const columns = (relation: string) =>
      sql.unsafe<{ name: string; type: string; required: boolean }[]>(
        'SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS required FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped',
        [relation],
      );
    const stored = await columns(this.qualifiedName);
    if (stored.length === 0) return 'missing';
    const types = new Map(
      (await columns(`pg_temp.${stage}`)).map(({ name, type }) => [name, type]),
    );
    const needed = [
      ...this.table.columns.map(
        (column) =>
          `${column.name} ${types.get(column.name)} ${column.required || column.isPrimaryKey}`,
      ),
      'loaded_at timestamp with time zone true',
    ];
    const has = stored.map(
      ({ name, type, required }) => `${name} ${type} ${required}`,
    );
    return needed.sort().join('\0') === has.sort().join('\0')
      ? 'fits'
      : 'stale';
  }

  // Builds the target in its new shape under another name and swaps it in
  // last, so readers of the stored table wait only for the swap, not the
  // load. A reader that holds it past the timeout fails the copy for this
  // run. Whatever else depends on the target, such as marts, refuses the swap.
  async #rebuild(sql: Transaction, stage: string, loadedAt: string) {
    const into = `${quote(this.schema)}.${quote(`_elt_next_${this.#hash}`)}`;
    await sql.unsafe(`DROP TABLE IF EXISTS ${into}`);
    await sql.unsafe(`CREATE TABLE ${this.#tableSQL(into)}`);
    await this.build(sql, into);
    await this.merge(sql, stage, loadedAt, into);
    await sql.unsafe(`SET LOCAL lock_timeout = '${swapTimeout}'`);
    const view = this.#readerViewName;
    if (view !== undefined) await sql.unsafe(`DROP VIEW IF EXISTS ${view}`);
    await sql.unsafe(`DROP TABLE ${this.qualifiedName}`);
    await sql.unsafe(`ALTER TABLE ${into} RENAME TO ${this.table.quotedName}`);
    await this.adopt(sql);
    await this.#comment(sql, 'TABLE', this.schema, this.table.name);
    await this.#describeReaderView(sql);
  }

  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition: Partition | null): [string, string[]] {
    if (partition === null) return ['', []];
    const columns = Object.keys(partition).map((field) => {
      const column = this.table.columns.find(({ name }) => name === field);
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
  // refuses and stages, so a run that fails before a commit leaves nothing.
  // Each commit is one transaction: the first also creates the target, or
  // swaps in its rebuild, and every one merges the stage with the result of
  // applying its operations one at a time.
  async prepare(
    load: PostgresLoad,
    { writer, restart }: { writer: string; restart: boolean },
  ): Promise<Stage> {
    const { sql } = load;
    const stage = quote(`_elt_stage_${this.#hash}`);
    const stores = this.table.columns
      .filter((column) => column.storesFile)
      .map((column) => new PostgresFileStore(this.schema, this.table, column));
    const replacing = this.replaces || restart;
    const fit = await load.transaction(async (sql) => {
      await this.#refuse(sql, writer);
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
      await sql.unsafe(
        `CREATE TEMP TABLE ${stage} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
      );
      for (const store of stores) await store.stage(sql);
      const stored = await this.#fit(sql, stage);
      await this.#refuseReaderView(sql, stored === 'stale');
      if (stored === 'fits' && !replacing) await this.inspect(sql);
      return stored;
    });
    const { columns } = this.table;
    // One JSON parameter per batch, cast back per column: no bind-parameter
    // limit. Declared text so the driver sends it as given.
    const insert = `INSERT INTO ${stage} (${seq}, ${op}, ${columns.map((column) => column.quotedName).join(', ')}) SELECT (row->>0)::bigint, row->>1, ${columns.map((column, index) => column.valueFrom('row', index + 2)).join(', ')} FROM json_array_elements($1::text::json) AS row`;
    let pending: EncodedValue[][] = [];
    let next = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      const rows = pending;
      pending = [];
      await sql.unsafe(insert, [JSON.stringify(rows)]);
    };
    // Scopes the stage dropped, which the next commit empties in the target.
    let resets: (Partition | null)[] = [];
    const drop = async () => {
      pending = [];
      resets = [];
      await sql.unsafe(`TRUNCATE ${stage}`);
      for (const store of stores) await store.discard(sql);
    };
    let committed = false;
    return {
      fresh: fit !== 'fits',
      values: this.values(sql),
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          await flush();
          const [rows, values] = this.#scope(operation.partition);
          await sql.unsafe(`DELETE FROM ${stage}${rows}`, values);
          resets.push(operation.partition);
          return;
        }
        let data = operation.type === 'RECORD' ? operation.data : undefined;
        for (const store of stores) {
          const content: unknown = Reflect.get(Object(data), store.column.name);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [store.column.name]: await store.save(sql, content),
            };
        }
        const row =
          operation.type === 'RECORD'
            ? this.encode(data)
            : this.deletionRow(operation.key);
        pending.push([next++, operation.type === 'RECORD' ? 'R' : 'D', ...row]);
        if (pending.length >= batchSize) await flush();
      },
      commit: async () => {
        await flush();
        await load.transaction(async (sql) => {
          if (fit === 'stale' && !committed) {
            await this.#own(sql, writer);
            for (const store of stores) await store.publish(sql);
            await this.#rebuild(sql, stage, load.loadedAt);
          } else {
            if (!committed) await this.#create(sql, writer, replacing);
            if (replacing && !committed) await this.replace(sql);
            for (const partition of resets) {
              const [rows, values] = this.#scope(partition);
              await sql.unsafe(
                `DELETE FROM ${this.qualifiedName}${rows}`,
                values,
              );
            }
            for (const store of stores) await store.publish(sql);
            await this.merge(sql, stage, load.loadedAt);
          }
          await sql.unsafe(`TRUNCATE ${stage}`);
          for (const store of stores) await store.prune(sql);
        });
        committed = true;
        resets = [];
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
