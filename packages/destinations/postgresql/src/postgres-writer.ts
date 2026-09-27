import { createHash } from 'node:crypto';
import {
  type KeyValue,
  type Stage,
  type Stream,
  TargetMissingError,
  TargetOwnedError,
  Writer,
} from 'elt';
import type postgres from 'postgres';
import { Connection, schemaLock } from './connection.ts';
import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import type { PostgresTable } from './postgres-table.ts';

// The load's one connection; statements run inside its open transaction.
export type Transaction = postgres.Sql;

const batchSize = 1000;
export const seq = '"_mac_elt_seq"';
export const op = '"_mac_elt_op"';

// A run's one connection and write transaction for a schema, shared by every
// stream's stage. The schema lock serializes everything elt writes there, as
// SQLite's BEGIN IMMEDIATE does per file; readers never wait on it.
// ponytail: holds the write transaction during extraction; stage elsewhere if long reads hold back vacuum.
export class PostgresLoad implements AsyncDisposable {
  readonly #connection: Connection;
  readonly loadedAt: string;
  #open = false;

  private constructor(
    connection: Connection,
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
    const connection = new Connection(url, 'elt');
    try {
      const [clock] = await connection.sql.unsafe(
        'SELECT clock_timestamp()::text AS "loadedAt"',
      );
      const load = new PostgresLoad(
        connection,
        schema,
        String(clock?.loadedAt),
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
    await this.sql.unsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [schemaLock(this.schema)],
    );
  }

  // Makes everything merged so far durable, then takes the lock back.
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
  constructor(
    stream: Stream,
    protected readonly url: string,
    readonly schema: string,
    readonly table: PostgresTable,
  ) {
    super(stream);
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

  override async clear(writer: string): Promise<void> {
    await using connection = new Connection(this.url, 'elt');
    await connection.sql.begin(async (transaction) => {
      await transaction.unsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [schemaLock(this.schema)],
      );
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
      await transaction.unsafe(`DELETE FROM ${writers} WHERE "target" = $1`, [
        this.table.name,
      ]);
    });
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
      await sql.unsafe(`DROP TABLE IF EXISTS pg_temp.${stage}`);
      await sql.unsafe(
        `CREATE TEMP TABLE ${stage} (${seq} BIGINT PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(', ')})`,
      );
    });
    const { columns } = this.table;
    // One JSON parameter per batch, cast back per column: no bind-parameter
    // limit. Declared text so the driver sends it as given.
    const insert = `INSERT INTO ${stage} (${seq}, ${op}, ${columns.map((column) => column.quotedName).join(', ')}) SELECT (row->>0)::bigint, row->>1, ${columns.map((column, index) => `(row->>${index + 2})::${column.storageType}`).join(', ')} FROM json_array_elements($1::text::json) AS row`;
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
      await load.savepoint('drop', () => sql.unsafe(`TRUNCATE ${stage}`));
    };
    let replaced = false;
    return {
      apply: async (operation) => {
        const row =
          operation.type === 'RECORD'
            ? this.encode(operation.data)
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
