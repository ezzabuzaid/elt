import {
  assertShareable,
  CommittedWriteError,
  type KeyValue,
  readClaims,
  type Stream,
  type WriteCount,
  type WriteOperation,
  Writer,
  type WriterClaim,
} from 'elt';
import type postgres from 'postgres';
import { Connection, schemaLock } from './connection.ts';
import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import type { PostgresTable } from './postgres-table.ts';

export type Transaction = postgres.TransactionSql;

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
  // limit, and one loaded_at for the whole copy. Parameters are declared text
  // so the driver sends them as given instead of re-serializing by type.
  protected get insertSQL(): string {
    const { columns } = this.table;
    return `INSERT INTO ${this.qualifiedName} AS "_mac_elt_target" (${[...columns.map((column) => column.quotedName), '"loaded_at"'].join(', ')}) SELECT ${[...columns.map((column, index) => `(row->>${index})::${column.storageType}`), 'transaction_timestamp()'].join(', ')} FROM json_array_elements($1::text::json) AS row`;
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

  // Claims live beside the tables they guard and commit with the load. A
  // dropped table releases its claims, since nothing it held remains.
  private async claim(
    transaction: Transaction,
    claim: WriterClaim,
  ): Promise<void> {
    const writers = `${quote(this.schema)}."_mac_elt_writers"`;
    await transaction.unsafe(
      `CREATE TABLE IF NOT EXISTS ${writers} ("target" TEXT NOT NULL, "writer" TEXT NOT NULL, "destination_sync_mode" TEXT NOT NULL, "primary_key" JSONB, "partitions" JSONB, PRIMARY KEY ("target", "writer"))`,
    );
    await transaction.unsafe(
      `DELETE FROM ${writers} WHERE to_regclass(format('%I.%I', $1::text, "target")) IS NULL`,
      [this.schema],
    );
    const rows = await transaction.unsafe(
      `SELECT "writer", "destination_sync_mode" AS "destinationSyncMode", "primary_key" AS "primaryKey", "partitions" FROM ${writers} WHERE "target" = $1`,
      [this.table.name],
    );
    assertShareable(
      this.table.name,
      readClaims(rows.map((row) => ({ ...row }))),
      claim,
    );
    await transaction.unsafe(
      `INSERT INTO ${writers} ("target", "writer", "destination_sync_mode", "primary_key", "partitions") VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb) ON CONFLICT ("target", "writer") DO UPDATE SET "destination_sync_mode" = excluded."destination_sync_mode", "primary_key" = excluded."primary_key", "partitions" = excluded."partitions"`,
      [
        this.table.name,
        claim.writer,
        claim.destinationSyncMode,
        claim.primaryKey === null ? null : JSON.stringify(claim.primaryKey),
        claim.partitions === null ? null : JSON.stringify(claim.partitions),
      ],
    );
  }

  protected override async writeRecords(
    operations: AsyncIterable<WriteOperation>,
    claim: WriterClaim,
  ): Promise<WriteCount> {
    let committed: WriteCount | undefined;
    try {
      await using connection = new Connection(this.url, 'elt');
      // ponytail: holds the write transaction during extraction; stage first if long reads hold back vacuum.
      committed = await connection.sql.begin(async (transaction) => {
        // One writer per schema at a time, as SQLite's BEGIN IMMEDIATE is one
        // per file: claims span the schema's tables. Readers never wait on it.
        await transaction.unsafe(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [schemaLock(this.schema)],
        );
        await transaction.unsafe(
          `CREATE SCHEMA IF NOT EXISTS ${quote(this.schema)}`,
        );
        await this.claim(transaction, claim);
        await this.initialize(transaction);
        const remove = this.deletion(transaction);
        const insert = this.insertSQL;
        let pending: Pending[] = [];
        const flush = async () => {
          if (pending.length === 0) return;
          const rows = this.collapse(pending).map(({ row }) => row);
          pending = [];
          await transaction.unsafe(insert, [JSON.stringify(rows)]);
        };
        let count = 0;
        let deleted = 0;
        for await (const operation of operations) {
          if (operation.type === 'RECORD') {
            pending.push({
              record: operation.data,
              row: this.encode(operation.data),
            });
            count++;
            if (pending.length >= batchSize) await flush();
          } else {
            if (remove === undefined)
              throw new TypeError(
                'Only deduplicating loads can apply deletions',
              );
            // Deletions apply in source order relative to the records before them.
            await flush();
            await remove(operation.key);
            deleted++;
          }
        }
        await flush();
        return { count, deleted };
      });
      return committed;
    } catch (cause) {
      if (committed !== undefined)
        throw new CommittedWriteError(
          committed,
          'Destination committed, but cleanup failed; retry may replay records',
          cause,
        );
      throw cause;
    }
  }
}
