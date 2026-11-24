import { hash } from 'node:crypto';

import {
  type CopyConfiguration,
  type Deduplication,
  type DeleteOperation,
  deduplicationColumns,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { EncodedValue, PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { type TargetHistory, version } from './postgres-history.ts';
import type { Transaction } from './postgres-load.ts';
import { inWarehouse } from './postgres-schemas.ts';
import type { PostgresTable } from './postgres-table.ts';
import { PostgresWriter, type Written, op, seq } from './postgres-writer.ts';

export class PostgresDeduplicatingWriter extends PostgresWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly PostgresColumn[];
  readonly cursor?: PostgresColumn;
  readonly #guard?: PostgresColumn;

  constructor(
    configuration: CopyConfiguration,
    url: string,
    table: PostgresTable,
    retention: Temporal.Duration,
  ) {
    super(configuration, url, table, retention);
    ({
      deduplication: this.deduplication,
      keys: this.keys,
      cursor: this.cursor,
      guard: this.#guard,
    } = deduplicationColumns(
      configuration,
      table.columns,
      PostgresColumns.fromSchema(configuration.stream.jsonSchema),
      (column) => column.storageType,
    ));
    Object.freeze(this);
  }

  // Named after the table and its key, so a changed key builds a new index
  // and an unchanged one is never rebuilt under readers.
  get dedupIndex(): string {
    return `_elt_dedup_${hash(
      'sha256',
      JSON.stringify([this.table.raw, this.keys.map((key) => key.name)]),
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
        await transaction.unsafe(`DROP INDEX ${inWarehouse(index)}`);
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
      `ALTER INDEX ${inWarehouse(this.#provisionalIndex)} RENAME TO ${quote(this.dedupIndex)}`,
    );
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

  // The staged records that the merge upserts, as a SELECT of their seq, at
  // most one per key. replace applies the staged operations in source order:
  // only records after a key's last DELETE count, and the newest extraction
  // wins, so a restated fact overwrites the loaded one. cursor_newer ranks
  // the records and deletions of a key together, and keeps the record that
  // wins.
  #accepted(stage: string): string {
    const guard = this.#guard;
    if (guard !== undefined) return this.#winners(stage, guard, 'R');
    const keys = this.keys.map((column) => column.quotedName);
    return `SELECT "ranked".${seq} FROM (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(', ')} ORDER BY "staged".${seq} DESC) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN (SELECT ${keys.join(', ')}, max(${seq}) AS "_elt_last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(', ')}) AS "deleted" ON ${this.#same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."_elt_last" IS NULL OR "staged".${seq} > "deleted"."_elt_last")) AS "ranked" WHERE "ranked"."_elt_rank" = 1`;
  }

  // The seq of each staged row that wins its key under cursor_newer, if it
  // is of kind operation: of a key's records and deletions, the greatest
  // cursor wins, and the first staged on ties, as the guard of the stored
  // row lets only a greater cursor in.
  #winners(stage: string, guard: PostgresColumn, operation: 'R' | 'D'): string {
    const keys = this.keys.map((column) => column.quotedName);
    return `SELECT "ranked".${seq} FROM (SELECT ${seq}, ${op}, row_number() OVER (PARTITION BY ${keys.join(', ')} ORDER BY ${guard.quotedName}${this.#collate} DESC, ${seq}) AS "_elt_rank" FROM ${stage}) AS "ranked" WHERE "ranked"."_elt_rank" = 1 AND "ranked".${op} = '${operation}'`;
  }

  // The staged deletions that can remove a stored row, as a SELECT of their
  // keys and, under cursor_newer, their cursors: replace takes each key that
  // a DELETE names, cursor_newer only the deletion that won its key.
  #deletions(stage: string): string {
    const keys = this.keys.map((column) => column.quotedName);
    const guard = this.#guard;
    if (guard === undefined)
      return `SELECT DISTINCT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D'`;
    return `SELECT ${keys.join(', ')}, ${guard.quotedName} FROM ${stage} WHERE ${seq} IN (${this.#winners(stage, guard, 'D')})`;
  }

  // Whether the deletion removes the stored row row: it names the row's key,
  // and under cursor_newer its cursor sorts after the row's, as a record
  // replaces a row only then. On a tie the row stays.
  #removes(deletion: string, row: string): string {
    const guard = this.#guard;
    return `${this.#same(deletion, row)}${guard === undefined ? '' : ` AND ${deletion}.${guard.quotedName}${this.#collate} > ${row}.${guard.quotedName}${this.#collate}`}`;
  }

  protected override kept(stage: string): string {
    return `${seq} IN (${this.#accepted(stage)})`;
  }

  // Whether a staged record replaces the stored row: its values differ, and
  // the cursor guard, if any, lets it in, which rejects out-of-order replay.
  #replaces(record: string, row: string): string {
    const guard = this.#guard;
    return `${record}.${version} IS DISTINCT FROM ${row}.${version}${guard === undefined ? '' : ` AND ${record}.${guard.quotedName}${this.#collate} > ${row}.${guard.quotedName}${this.#collate}`}`;
  }

  // The staged deletions remove the rows that #removes names, and the
  // records that #accepted keeps are upserted, with the guard, if any,
  // rejecting out-of-order replay. The history keeps each row that a DELETE
  // removes or an accepted record replaces; a record with the stored row's
  // values leaves the row, its commit and its loaded_at as they are.
  protected override async merge(
    sql: Transaction,
    stage: string,
    written: Written,
    into: string,
    history: TargetHistory | null,
  ): Promise<void> {
    const keys = this.keys.map((column) => column.quotedName);
    const deletions = this.#deletions(stage);
    await history?.keep(
      sql,
      written.committedIn,
      into,
      `FROM ${into} AS "_elt_old" WHERE EXISTS (SELECT 1 FROM (${deletions}) AS "deleted" WHERE ${this.#removes('"deleted"', '"_elt_old"')})`,
    );
    await sql.unsafe(
      `DELETE FROM ${into} AS "_elt_target" USING (${deletions}) AS "deleted" WHERE ${this.#removes('"deleted"', '"_elt_target"')}`,
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

  // A deletion stages its key, and under cursor_newer its cursor, which
  // ranks it with the records of its key and guards the stored row. Other
  // columns stay null.
  protected override deletionRow({
    key,
    cursor,
  }: DeleteOperation): EncodedValue[] {
    this.deduplication.key(key);
    const guard = this.#guard;
    const versioned = guard === undefined ? {} : { [guard.field]: cursor };
    if (guard !== undefined) this.deduplication.cursor(versioned);
    return this.table.columns.map((column) => {
      if (this.keys.includes(column)) return column.encode(key);
      if (column === guard) return column.encode(versioned);
      return null;
    });
  }
}
