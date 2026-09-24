import { createHash } from 'node:crypto';
import type { CopyConfiguration, Deduplication, KeyValue } from 'elt';
import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import type { PostgresTable } from './postgres-table.ts';
import {
  type Pending,
  PostgresWriter,
  type Transaction,
} from './postgres-writer.ts';

export class PostgresDeduplicatingWriter extends PostgresWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly PostgresColumn[];
  readonly cursor?: PostgresColumn;

  constructor(
    readonly configuration: CopyConfiguration,
    url: string,
    schema: string,
    table: PostgresTable,
  ) {
    super(configuration.stream, url, schema, table);
    this.deduplication = configuration.deduplication();
    const inferred = PostgresColumns.fromSchema(
      configuration.stream.jsonSchema,
    );
    const column = (field: string): PostgresColumn => {
      const selected = table.columns.find((column) => column.name === field);
      if (selected === undefined)
        throw new TypeError(
          `Deduplication requires destination column ${field}`,
        );
      if (
        selected.kind !== inferred.find((column) => column.name === field)?.kind
      )
        throw new TypeError(
          `Deduplication column ${field} must preserve the source scalar type`,
        );
      return selected;
    };
    this.keys = Object.freeze(this.deduplication.primaryKey.map(column));
    const { cursorField } = this.deduplication;
    this.cursor = cursorField === undefined ? undefined : column(cursorField);
    Object.freeze(this);
  }

  // Named after the table and its key, so a changed key builds a new index
  // and an unchanged one is never rebuilt under readers.
  get dedupIndex(): string {
    return `_mac_elt_dedup_${createHash('sha256')
      .update(
        JSON.stringify([
          this.schema,
          this.table.name,
          this.keys.map((key) => key.name),
        ]),
      )
      .digest('hex')
      .slice(0, 40)}`;
  }

  protected override async initialize(transaction: Transaction): Promise<void> {
    await transaction.unsafe(this.createTableSQL);
    if (this.configuration.destinationSyncMode === 'overwrite_dedup')
      await transaction.unsafe(`DELETE FROM ${this.qualifiedName}`);
    const existing = await transaction.unsafe(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [this.schema, this.table.name],
    );
    const tracked =
      this.cursor === undefined ? this.keys : [...this.keys, this.cursor];
    for (const column of tracked)
      if (
        !existing.some(
          (field) =>
            field.column_name === column.name &&
            field.data_type === column.dataType,
        )
      )
        throw new TypeError(
          `Existing deduplication column ${column.name} has an incompatible storage type`,
        );
    const nulls = await transaction.unsafe(
      `SELECT 1 FROM ${this.qualifiedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(' OR ')} LIMIT 1`,
    );
    if (nulls.length > 0)
      throw new TypeError(
        'Existing deduplication keys and cursors must be non-null',
      );
    for (const index of await this.dedupIndexes(transaction))
      if (index !== this.dedupIndex)
        await transaction.unsafe(
          `DROP INDEX ${quote(this.schema)}.${quote(index)}`,
        );
    await transaction.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(this.dedupIndex)} ON ${this.qualifiedName} (${this.keys.map((column) => column.quotedName).join(', ')})`,
    );
  }

  protected override get insertSQL(): string {
    const fields = [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
    // replace lets the newest extraction win, so a restated fact overwrites the
    // loaded one; cursor_newer keeps the guard that rejects out-of-order replay.
    // Text cursors compare by bytes, as SQLite's BINARY and Markdown do.
    const { cursor } = this;
    const collate = cursor?.kind === 'text' ? ' COLLATE "C"' : '';
    const guard =
      this.configuration.dedupPolicy === 'replace' || cursor === undefined
        ? ''
        : ` WHERE excluded.${cursor.quotedName}${collate} > "_mac_elt_target".${cursor.quotedName}${collate}`;
    return `${super.insertSQL} ON CONFLICT (${this.keys.map((column) => column.quotedName).join(', ')}) DO UPDATE SET ${fields.map((field) => `${field} = excluded.${field}`).join(', ')}${guard}`;
  }

  protected override encode(record: unknown): EncodedValue[] {
    this.deduplication.key(record);
    if (this.cursor !== undefined) this.deduplication.cursor(record);
    return super.encode(record);
  }

  // The row each key would hold after applying the batch one row at a time,
  // decided as Markdown decides it; the statement's guard then compares the
  // winner with the stored row.
  protected override collapse(pending: readonly Pending[]): readonly Pending[] {
    const replace = this.configuration.dedupPolicy === 'replace';
    const winners = new Map<string, Pending>();
    for (const entry of pending) {
      const key = this.deduplication.key(entry.record);
      const saved = winners.get(key);
      if (
        saved === undefined ||
        replace ||
        this.deduplication.newer(entry.record, saved.record)
      )
        winners.set(key, entry);
    }
    return [...winners.values()];
  }

  protected override deletion(
    transaction: Transaction,
  ): (key: Readonly<Record<string, KeyValue>>) => Promise<unknown> {
    const statement = `DELETE FROM ${this.qualifiedName} WHERE ${this.keys.map((column, index) => `${column.quotedName} = $${index + 1}::text::${column.storageType}`).join(' AND ')}`;
    return (key) => {
      this.deduplication.key(key);
      return transaction.unsafe(
        statement,
        this.keys.map((column) => String(column.encode(key))),
      );
    };
  }
}
