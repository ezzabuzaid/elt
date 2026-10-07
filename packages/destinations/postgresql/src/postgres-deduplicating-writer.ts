import { createHash } from 'node:crypto';

import type {
  CopyConfiguration,
  Deduplication,
  KeyValue,
} from '@workspace/elt';

import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import type { PostgresTable } from './postgres-table.ts';
import {
  PostgresWriter,
  type Transaction,
  op,
  seq,
} from './postgres-writer.ts';

export class PostgresDeduplicatingWriter extends PostgresWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly PostgresColumn[];
  readonly cursor?: PostgresColumn;

  constructor(
    configuration: CopyConfiguration,
    url: string,
    schema: string,
    table: PostgresTable,
  ) {
    super(configuration, url, schema, table);
    this.deduplication = configuration.deduplication();
    const inferred = PostgresColumns.fromSchema(
      configuration.stream.jsonSchema,
    );
    const column = (field: string): PostgresColumn => {
      const selected = table.columns.find((column) => column.field === field);
      if (selected === undefined)
        throw new TypeError(
          `Deduplication requires destination column ${field}`,
        );
      if (
        selected.storageType !==
        inferred.find((column) => column.field === field)?.storageType
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
    return `_elt_dedup_${createHash('sha256')
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

  protected override get replaces(): boolean {
    return this.configuration.destinationSyncMode === 'overwrite_dedup';
  }

  protected override async initialize(
    transaction: Transaction,
    replacing: boolean,
  ): Promise<void> {
    await transaction.unsafe(this.createTableSQL);
    // A replacing load keeps none of these rows: its index is built once the
    // commit has emptied the table.
    if (replacing) await this.dropOtherIndexes(transaction);
    else await this.index(transaction);
  }

  protected override async inspect(sql: Transaction): Promise<void> {
    const tracked =
      this.cursor === undefined ? this.keys : [...this.keys, this.cursor];
    const nulls = await sql.unsafe(
      `SELECT 1 FROM ${this.qualifiedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(' OR ')} LIMIT 1`,
    );
    if (nulls.length > 0)
      throw new TypeError(
        'Existing deduplication keys and cursors must be non-null',
      );
  }

  protected override async replace(transaction: Transaction): Promise<void> {
    await super.replace(transaction);
    await this.index(transaction);
  }

  private async dropOtherIndexes(transaction: Transaction): Promise<void> {
    for (const index of await this.dedupIndexes(transaction))
      if (index !== this.dedupIndex)
        await transaction.unsafe(
          `DROP INDEX ${quote(this.schema)}.${quote(index)}`,
        );
  }

  private async index(transaction: Transaction): Promise<void> {
    await this.dropOtherIndexes(transaction);
    await transaction.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(this.dedupIndex)} ON ${this.qualifiedName} (${this.keys.map((column) => column.quotedName).join(', ')})`,
    );
  }

  // A rebuilt target's key index, created while it is empty and renamed with
  // the target, since index names are unique in a schema.
  get #provisionalIndex(): string {
    return `${this.dedupIndex.slice(0, 50)}_next`;
  }

  protected override async build(
    sql: Transaction,
    into: string,
  ): Promise<void> {
    await sql.unsafe(
      `CREATE UNIQUE INDEX ${quote(this.#provisionalIndex)} ON ${into} (${this.keys.map((column) => column.quotedName).join(', ')})`,
    );
  }

  protected override async adopt(sql: Transaction): Promise<void> {
    await sql.unsafe(
      `ALTER INDEX ${quote(this.schema)}.${quote(this.#provisionalIndex)} RENAME TO ${quote(this.dedupIndex)}`,
    );
  }

  // The result of applying the staged operations one at a time: a staged
  // DELETE removes its key, and only records after a key's last DELETE count.
  // replace keeps the newest extraction, so a restated fact overwrites the
  // loaded one; cursor_newer keeps the greatest cursor (the first on ties) and
  // the guard that rejects out-of-order replay. Text cursors compare by bytes,
  // as SQLite's BINARY and Markdown do.
  protected override async merge(
    sql: Transaction,
    stage: string,
    loadedAt: string,
    into = this.qualifiedName,
  ): Promise<void> {
    const keys = this.keys.map((column) => column.quotedName);
    const same = (left: string, right: string) =>
      keys.map((key) => `${left}.${key} = ${right}.${key}`).join(' AND ');
    await sql.unsafe(
      `DELETE FROM ${into} AS "_elt_target" USING (SELECT DISTINCT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D') AS "deleted" WHERE ${same('"_elt_target"', '"deleted"')}`,
    );
    const { cursor } = this;
    const guarded =
      this.configuration.dedupPolicy !== 'replace' && cursor !== undefined;
    const collate = cursor?.dataType === 'text' ? ' COLLATE "C"' : '';
    const order = guarded
      ? `"staged".${cursor.quotedName}${collate} DESC, "staged".${seq}`
      : `"staged".${seq} DESC`;
    const columns = this.table.columns.map((column) => column.quotedName);
    await sql.unsafe(
      `WITH "deleted" AS (SELECT ${keys.join(', ')}, max(${seq}) AS "_elt_last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(', ')}), "ranked" AS (SELECT "staged".*, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(', ')} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN "deleted" ON ${same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."_elt_last" IS NULL OR "staged".${seq} > "deleted"."_elt_last")) ` +
        `INSERT INTO ${into} AS "_elt_target" (${this.fields.join(', ')}) SELECT ${columns.join(', ')}, $1::text::timestamptz FROM "ranked" WHERE "_elt_rank" = 1 ORDER BY ${seq} ` +
        `ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${this.fields.map((field) => `${field} = excluded.${field}`).join(', ')}${guarded ? ` WHERE excluded.${cursor.quotedName}${collate} > "_elt_target".${cursor.quotedName}${collate}` : ''}`,
      [loadedAt],
    );
  }

  protected override encode(record: unknown): EncodedValue[] {
    this.deduplication.key(record);
    if (this.cursor !== undefined) this.deduplication.cursor(record);
    return super.encode(record);
  }

  protected override deletionRow(
    key: Readonly<Record<string, KeyValue>>,
  ): EncodedValue[] {
    this.deduplication.key(key);
    return this.table.columns.map((column) =>
      this.keys.includes(column) ? column.encode(key) : null,
    );
  }
}
