import {
  type KeyValue,
  type Load,
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

// A record, validated and encoded on arrival, awaiting its batch.
export type Pending = {
  readonly record: unknown;
  readonly row: EncodedValue[];
};

const batchSize = 1000;

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

  // One JSON parameter per batch, cast back per column: no bind-parameter
  // limit. Parameters are declared text so the driver sends them as given
  // instead of re-serializing by type. $2 is the copy's one loaded_at, kept
  // across its commits so a load's rows share it.
  protected get insertSQL(): string {
    const { columns } = this.table;
    return `INSERT INTO ${this.qualifiedName} AS "_mac_elt_target" (${[...columns.map((column) => column.quotedName), '"loaded_at"'].join(', ')}) SELECT ${[...columns.map((column, index) => `(row->>${index})::${column.storageType}`), '$2::text::timestamptz'].join(', ')} FROM json_array_elements($1::text::json) AS row`;
  }

  protected encode(record: unknown): EncodedValue[] {
    return this.table.columns.map((column) => column.encode(record));
  }

  // A batch is applied as one statement; a deduplicating load keeps one row
  // per key, since one statement cannot upsert a key twice.
  protected collapse(pending: readonly Pending[]): readonly Pending[] {
    return pending;
  }

  // Only a load that identifies rows by key can remove one.
  protected deletion(
    _transaction: Transaction,
  ):
    | ((key: Readonly<Record<string, KeyValue>>) => Promise<unknown>)
    | undefined {
    return undefined;
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

  protected override async open(
    writer: string,
    resuming: boolean,
  ): Promise<Load> {
    const connection = new Connection(this.url, 'elt');
    const { sql } = connection;
    let open = false;
    // One writer per schema at a time, as SQLite's BEGIN IMMEDIATE is one
    // per file: owners span the schema's tables. Readers never wait on it.
    // ponytail: holds the write transaction during extraction; stage first if long reads hold back vacuum.
    const begin = async () => {
      await sql.unsafe('BEGIN');
      open = true;
      await sql.unsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [schemaLock(this.schema)],
      );
    };
    const close = async () => {
      try {
        if (open) await sql.unsafe('ROLLBACK');
      } finally {
        await connection[Symbol.asyncDispose]();
      }
    };
    try {
      await begin();
      if (resuming) {
        const [table] = await sql.unsafe(
          'SELECT to_regclass($1) IS NOT NULL AS "exists"',
          [this.qualifiedName],
        );
        if (table?.exists !== true)
          throw new TargetMissingError(this.table.name, writer);
      }
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`);
      await this.own(sql, writer);
      await this.initialize(sql);
      const [clock] = await sql.unsafe(
        'SELECT transaction_timestamp()::text AS "loadedAt"',
      );
      const loadedAt = String(clock?.loadedAt);
      // Each unit runs in a savepoint, so discarding a failed read never
      // undoes the owner record and schema this transaction prepared.
      await sql.unsafe('SAVEPOINT unit');
      const remove = this.deletion(sql);
      const insert = this.insertSQL;
      let pending: Pending[] = [];
      const flush = async () => {
        if (pending.length === 0) return;
        const rows = this.collapse(pending).map(({ row }) => row);
        pending = [];
        await sql.unsafe(insert, [JSON.stringify(rows), loadedAt]);
      };
      return {
        apply: async (operation) => {
          if (!open) {
            await begin();
            await sql.unsafe('SAVEPOINT unit');
          }
          if (operation.type === 'RECORD') {
            pending.push({
              record: operation.data,
              row: this.encode(operation.data),
            });
            if (pending.length >= batchSize) await flush();
            return;
          }
          if (remove === undefined)
            throw new TypeError('Only deduplicating loads can apply deletions');
          // Deletions apply in source order relative to the records before them.
          await flush();
          await remove(operation.key);
        },
        commit: async () => {
          if (!open) return;
          await flush();
          await sql.unsafe('COMMIT');
          open = false;
        },
        discard: async () => {
          pending = [];
          if (open) await sql.unsafe('ROLLBACK TO SAVEPOINT unit');
        },
        [Symbol.asyncDispose]: close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
