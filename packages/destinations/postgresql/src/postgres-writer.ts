import { createHash } from 'node:crypto';
import {
  type CopyConfiguration,
  type FieldValues,
  FileContent,
  type KeyValue,
  type Stage,
  TargetMissingError,
  TargetOwnedError,
  Writer,
} from 'elt';
import type postgres from 'postgres';
import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import { PostgresFileStore } from './postgres-file-store.ts';
import { PostgresSession, schemaLock } from './postgres-session.ts';
import type { PostgresReaderView, PostgresTable } from './postgres-table.ts';

// The load's one connection; statements run inside its open transaction.
export type Transaction = postgres.Sql;

const batchSize = 1000;
export const seq = '"_mac_elt_seq"';
export const op = '"_mac_elt_op"';

// JSON Schema annotations are optional; when absent, remove any old SQL comment.
function description(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    !value.isWellFormed()
  )
    throw new TypeError(
      'JSON Schema description must be well-formed text without NUL',
    );
  return value;
}

// A run's one connection and write transaction for a schema, shared by every
// stream's stage. The schema lock serializes everything elt writes there, as
// SQLite's BEGIN IMMEDIATE does per file; readers never wait on it.
// ponytail: holds the write transaction during extraction; stage elsewhere if long reads hold back vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: PostgresSession;
  readonly loadedAt: string;
  #open = false;

  private constructor(
    connection: PostgresSession,
    readonly schema: string,
    loadedAt: string,
  ) {
    this.#connection = connection;
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
      const load = new PostgresLoad(
        connection,
        schema,
        String(clock?.loadedAt),
      );
      // Keep pending files of every stream protected across commit boundaries.
      // Closing this connection releases the session lock, including on errors.
      await load.sql.unsafe(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [schemaLock(schema)],
      );
      await load.#begin();
      await load.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
      return load;
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }

  async #begin(): Promise<void> {
    await this.sql.unsafe('BEGIN');
    this.#open = true;
  }

  // Makes everything merged so far durable while retaining the writer lock.
  async commit(): Promise<void> {
    await this.sql.unsafe('COMMIT');
    this.#open = false;
    await this.#begin();
  }

  // Any failed statement aborts a Postgres transaction; the savepoint keeps
  // that failure from erasing the other streams' stages.
  async savepoint<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.sql.unsafe(`SAVEPOINT ${name}`);
    try {
      const result = await work();
      await this.sql.unsafe(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.sql.unsafe(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      if (this.#open) await this.sql.unsafe('ROLLBACK');
    } finally {
      await this.#connection[Symbol.asyncDispose]();
    }
  }
}

export abstract class PostgresWriter extends Writer {
  readonly #tableComment: string;
  readonly #columnComments: Record<string, string | null>;

  constructor(
    readonly configuration: CopyConfiguration,
    protected readonly url: string,
    readonly schema: string,
    readonly table: PostgresTable,
  ) {
    super(configuration.stream);
    const meaning = description(this.stream.jsonSchema.description);
    const loading = {
      append: 'Every accepted observation is appended; source keys may repeat.',
      overwrite:
        'Each full refresh replaces the table with its accepted records.',
      append_dedup: 'Accepted observations reconcile rows by the copy key.',
      overwrite_dedup:
        'Each full refresh replaces the table with deduplicated records.',
    }[configuration.destinationSyncMode];
    const lines = [`Source stream: ${this.stream.name}.`];
    if (meaning !== null) lines.push(`Source record meaning: ${meaning}`);
    lines.push(
      `Extraction: ${configuration.syncMode}. Loading: ${configuration.destinationSyncMode}. ${loading}`,
    );
    if (configuration.dedupPolicy !== undefined) {
      const { primaryKey, cursorField } = configuration.deduplication();
      lines.push(`Copy key: ${primaryKey.join(', ')}.`);
      lines.push(
        configuration.dedupPolicy === 'replace'
          ? 'For a repeated key, the newest extracted record wins.'
          : `For a repeated key, the greatest ${cursorField} wins; equal cursors retain the first accepted record. Text cursors compare by byte order.`,
      );
    }
    this.#tableComment = lines.join('\n');
    const properties = this.stream.jsonSchema.properties as
      | Readonly<Record<string, Readonly<Record<string, unknown>>>>
      | undefined;
    this.#columnComments = Object.fromEntries(
      table.columns.map((column) => {
        if (column.storesFile) {
          const store = new PostgresFileStore(schema, table, column);
          return [
            column.name,
            `UUID reference to the source file's original bytes. Join ${store.qualifiedName} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`,
          ];
        }
        if (column.fileRead?.parser !== undefined)
          return [
            column.name,
            `Text extracted from the source file by parser ${column.fileRead.parser.identity}. NULL when the source file is unavailable or the parser returns no text.`,
          ];
        if (column.fileRead?.file.storage !== undefined)
          return [
            column.name,
            `${column.fileRead.file.storage.reference} NULL when the source file is unavailable.`,
          ];
        return [
          column.name,
          description(properties?.[column.name]?.description),
        ];
      }),
    );
    this.#columnComments.loaded_at =
      'Start time of the load that last wrote this row, not the source modification time or the most recent successful sync.';
    if (table.readerView === undefined) return;
    const undescribed = Object.entries(this.#columnComments).flatMap(
      ([column, comment]) => (comment === null ? [column] : []),
    );
    if (meaning === null) undescribed.unshift('the stream');
    if (undescribed.length > 0)
      throw new TypeError(
        `Reader view ${table.readerView.schema}.${table.readerView.name} needs JSON Schema descriptions for ${undescribed.join(', ')} of stream ${this.stream.name}`,
      );
  }

  protected abstract initialize(transaction: Transaction): Promise<void>;

  get qualifiedName(): string {
    return `${quote(this.schema)}.${this.table.quotedName}`;
  }

  protected get createTableSQL(): string {
    if (this.table.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `CREATE TABLE IF NOT EXISTS ${this.qualifiedName} (${this.table.columns.map((column) => column.definition).join(', ')}, "loaded_at" TIMESTAMPTZ NOT NULL)`;
  }

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

  // Moves the staged operations into the target; every row of a run shares
  // its loaded_at.
  protected async merge(
    sql: Transaction,
    stage: string,
    loadedAt: string,
  ): Promise<void> {
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} (${this.fields.join(', ')}) SELECT ${this.table.columns.map((column) => column.quotedName).join(', ')}, $1::text::timestamptz FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`,
      [loadedAt],
    );
  }

  // The existing library-owned dedup indexes on this table.
  protected async dedupIndexes(transaction: Transaction): Promise<string[]> {
    const rows = await transaction.unsafe(
      String.raw`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname LIKE '\_mac\_elt\_dedup\_%'`,
      [this.schema, this.table.name],
    );
    return rows.map((row) => String(row.indexname));
  }

  // The owner lives beside the table it guards and commits with the load. A
  // dropped table releases it, since nothing it held remains.
  private async own(transaction: Transaction, writer: string): Promise<void> {
    const writers = `${quote(this.schema)}."_mac_elt_writers"`;
    await transaction.unsafe(
      `CREATE TABLE IF NOT EXISTS ${writers} ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL)`,
    );
    await transaction.unsafe(
      `DELETE FROM ${writers} WHERE to_regclass(format('%I.%I', $1::text, "target")) IS NULL`,
      [this.schema],
    );
    const [row] = await transaction.unsafe(
      `SELECT "writer" FROM ${writers} WHERE "target" = $1`,
      [this.table.name],
    );
    if (row === undefined)
      await transaction.unsafe(
        `INSERT INTO ${writers} ("target", "writer") VALUES ($1, $2)`,
        [this.table.name, writer],
      );
    else if (row.writer !== writer)
      throw new TargetOwnedError(this.table.name, String(row.writer), writer);
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
      const writers = `${quote(this.schema)}."_mac_elt_writers"`;
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

  // Created only when absent and never replaced inside the load: replacing a
  // view readers can see would lock them out until this load commits. A view
  // of other columns or another table is refused rather than adopted.
  async #installReaderView(
    sql: Transaction,
    reader: PostgresReaderView,
  ): Promise<void> {
    const view = `${quote(reader.schema)}.${quote(reader.name)}`;
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
    if (existing === undefined) {
      await sql.unsafe(
        `CREATE VIEW ${view} AS SELECT ${this.fields.join(', ')} FROM ${this.qualifiedName}`,
      );
      return;
    }
    const expected = [
      ...this.table.columns.map(({ name }) => name),
      'loaded_at',
    ];
    if (
      existing.relkind !== 'v' ||
      !existing.reads ||
      existing.columns.join('\0') !== expected.join('\0')
    )
      throw new TypeError(
        `${view} is not a view of exactly ${this.qualifiedName}; drop it or reset the warehouse`,
      );
  }

  // One stream's load inside the run's shared transaction. Operations wait in
  // a session-private TEMP stage, so another stream's commit never publishes
  // them and a crash leaves nothing behind; commit merges them into the target
  // with the result of applying them one at a time.
  async prepare(
    load: PostgresLoad,
    { writer, resuming }: { writer: string; resuming: boolean },
  ): Promise<Stage> {
    const { sql } = load;
    const stage = quote(
      `_mac_elt_stage_${createHash('sha256').update(this.qualifiedName).digest('hex').slice(0, 40)}`,
    );
    const stores = this.table.columns
      .filter((column) => column.storesFile)
      .map((column) => new PostgresFileStore(this.schema, this.table, column));
    await load.savepoint('prepare', async () => {
      if (resuming) {
        const [table] = await sql.unsafe(
          'SELECT to_regclass($1) IS NOT NULL AS "exists"',
          [this.qualifiedName],
        );
        if (table?.exists !== true)
          throw new TargetMissingError(this.table.name, writer);
      }
      await this.own(sql, writer);
      await this.initialize(sql);
      for (const store of stores) await store.initialize(sql);
      await this.#comment(sql, 'TABLE', this.schema, this.table.name);
      if (this.table.readerView !== undefined) {
        await this.#installReaderView(sql, this.table.readerView);
        const { schema, name } = this.table.readerView;
        await this.#comment(sql, 'VIEW', schema, name);
      }
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
      await sql.unsafe(
        `CREATE TEMP TABLE ${stage} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
      );
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
      await load.savepoint('flush', () =>
        sql.unsafe(insert, [JSON.stringify(rows)]),
      );
    };
    const drop = async () => {
      pending = [];
      await load.savepoint('drop', async () => {
        await sql.unsafe(`TRUNCATE ${stage}`);
        for (const store of stores) await store.prune(sql);
      });
    };
    let replaced = false;
    return {
      values: this.values(sql),
      apply: async (operation) => {
        let data = operation.type === 'RECORD' ? operation.data : undefined;
        for (const store of stores) {
          const content: unknown = Reflect.get(Object(data), store.column.name);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [store.column.name]: await load.savepoint('file', () =>
                store.save(sql, content),
              ),
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
        await load.savepoint('merge', async () => {
          if (this.replaces && !replaced) await this.replace(sql);
          await this.merge(sql, stage, load.loadedAt);
          await sql.unsafe(`TRUNCATE ${stage}`);
          for (const store of stores) await store.prune(sql);
        });
        replaced = true;
        await load.commit();
      },
      discard: drop,
      [Symbol.asyncDispose]: async () => {
        await drop();
        await load.savepoint('drop', () =>
          sql.unsafe(`DROP TABLE pg_temp.${stage}`),
        );
      },
    };
  }
}
