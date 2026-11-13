import { hash } from 'node:crypto';

import type { CopyConfiguration, Deduplication, KeyValue } from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { type TargetHistory, version } from './postgres-history.ts';
import type { Transaction } from './postgres-load.ts';
import type { PostgresTable } from './postgres-table.ts';
import { PostgresWriter, type Written, op, seq } from './postgres-writer.ts';

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
    return `_elt_dedup_${hash(
      'sha256',
      JSON.stringify([
        this.schema,
        this.table.name,
        this.keys.map((key) => key.name),
      ]),
    ).slice(0, 40)}`;
  }

  protected override get replaces(): boolean {
    return this.configuration.destinationSyncMode === 'overwrite_dedup';
  }

  protected override async initialize(
    transaction: Transaction,
    replacing: boolean,
  ): Promise<void> {
    await transaction.unsafe(this.createTableSQL);
    // A replacing load keeps only the rows its records match: its index is
    // built once the rows that leave are gone, since they may repeat a key.
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

  get #guarded(): PostgresColumn | undefined {
    return this.configuration.dedupPolicy === 'replace'
      ? undefined
      : this.cursor;
  }

  // A text cursor compares by bytes, as SQLite's BINARY does.
  get #collate(): string {
    return this.cursor?.dataType === 'text' ? ' COLLATE "C"' : '';
  }

  #same(left: string, right: string): string {
    return this.keys
      .map(({ quotedName }) => `${left}.${quotedName} = ${right}.${quotedName}`)
      .join(' AND ');
  }

  // The staged records that the result of applying the operations one at a
  // time keeps, as a SELECT of their seq: a staged DELETE removes its key,
  // and only records after a key's last DELETE count. replace keeps the
  // newest extraction, so a restated fact overwrites the loaded one;
  // cursor_newer keeps the greatest cursor, the first on ties.
  #accepted(stage: string): string {
    const keys = this.keys.map((column) => column.quotedName);
    const guard = this.#guarded;
    const order =
      guard === undefined
        ? `"staged".${seq} DESC`
        : `"staged".${guard.quotedName}${this.#collate} DESC, "staged".${seq}`;
    return `SELECT "ranked".${seq} FROM (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(', ')} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN (SELECT ${keys.join(', ')}, max(${seq}) AS "_elt_last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(', ')}) AS "deleted" ON ${this.#same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."_elt_last" IS NULL OR "staged".${seq} > "deleted"."_elt_last")) AS "ranked" WHERE "ranked"."_elt_rank" = 1`;
  }

  protected override kept(stage: string): string {
    return `${seq} IN (${this.#accepted(stage)})`;
  }

  // Whether a staged record replaces the stored row: its values differ, and
  // the cursor guard, if any, lets it in, which rejects out-of-order replay.
  #replaces(record: string, row: string): string {
    const guard = this.#guarded;
    return `${record}.${version} IS DISTINCT FROM ${row}.${version}${guard === undefined ? '' : ` AND ${record}.${guard.quotedName}${this.#collate} > ${row}.${guard.quotedName}${this.#collate}`}`;
  }

  // Applies the staged operations as if one at a time. The history keeps
  // each row that a DELETE removes or an accepted record replaces; a record
  // with the stored row's values leaves the row, its commit and its
  // loaded_at as they are.
  protected override async merge(
    sql: Transaction,
    stage: string,
    written: Written,
    into: string,
    history: TargetHistory | null,
  ): Promise<void> {
    const keys = this.keys.map((column) => column.quotedName);
    const deleted = `FROM ${into} AS "_elt_old" WHERE (${keys.map((key) => `"_elt_old".${key}`).join(', ')}) IN (SELECT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D')`;
    await history?.keep(sql, written.committedIn, into, deleted);
    await sql.unsafe(
      `DELETE FROM ${into} AS "_elt_target" USING (SELECT DISTINCT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D') AS "deleted" WHERE ${this.#same('"_elt_target"', '"deleted"')}`,
    );
    const accepted = this.#accepted(stage);
    await history?.keep(
      sql,
      written.committedIn,
      into,
      `FROM ${stage} AS "_elt_new" JOIN ${into} AS "_elt_old" ON ${this.#same('"_elt_new"', '"_elt_old"')} WHERE "_elt_new".${seq} IN (${accepted}) AND ${this.#replaces('"_elt_new"', '"_elt_old"')}`,
    );
    await sql.unsafe(
      `INSERT INTO ${into} AS "_elt_target" (${this.written.join(', ')}) SELECT ${this.staged} FROM ${stage} WHERE ${seq} IN (${accepted}) ORDER BY ${seq} ` +
        `ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${this.written.map((field) => `${field} = excluded.${field}`).join(', ')} WHERE ${this.#replaces('excluded', '"_elt_target"')}`,
      [written.loadedAt, written.committedIn],
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
