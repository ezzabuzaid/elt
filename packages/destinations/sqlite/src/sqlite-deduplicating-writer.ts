import { hash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { CopyConfiguration, Deduplication, KeyValue } from '@eltjs/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import type { SQLiteDestination } from './sqlite-destination.ts';
import type { SQLiteHistory } from './sqlite-history.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter, type Stamp, op, seq, version } from './sqlite-writer.ts';

export class SQLiteDeduplicatingWriter extends SQLiteWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly SQLiteColumn[];
  readonly cursor?: SQLiteColumn;

  constructor(
    configuration: CopyConfiguration,
    destination: SQLiteDestination,
    table: SQLiteTable,
  ) {
    super(configuration, destination, table);
    this.deduplication = configuration.deduplication();
    const inferred = SQLiteColumns.fromSchema(configuration.stream.jsonSchema);
    const column = (field: string): SQLiteColumn => {
      const selected = table.columns.find((column) => column.field === field);
      if (selected === undefined)
        throw new TypeError(
          `Deduplication requires destination column ${field}`,
        );
      if (
        selected.dataType !==
        inferred.find((column) => column.field === field)?.dataType
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

  protected override get replaces(): boolean {
    return this.configuration.destinationSyncMode === 'overwrite_dedup';
  }

  // Named after the table and its key, so a changed key builds a new index
  // and an unchanged one is never rebuilt.
  get #dedupIndex(): string {
    return `_elt_dedup_${hash('sha256', JSON.stringify([this.table.name, this.keys.map((key) => key.name)]))}`;
  }

  // A stored table the load merges into must hold keys and cursors of the
  // stream's types, none null, and no key twice, which its index forbids once
  // it exists.
  protected override inspect(database: DatabaseSync): void {
    const existing = database
      .prepare(`PRAGMA table_info(${this.table.quotedName})`)
      .all();
    const tracked =
      this.cursor === undefined ? this.keys : [...this.keys, this.cursor];
    for (const column of tracked) {
      if (
        !existing.some(
          (field) =>
            field.name === column.name && field.type === column.storageType,
        )
      )
        throw new TypeError(
          `Existing deduplication column ${column.name} has an incompatible storage type`,
        );
    }
    if (
      database
        .prepare(
          `SELECT 1 FROM ${this.table.quotedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(' OR ')} LIMIT 1`,
        )
        .get()
    )
      throw new TypeError(
        'Existing deduplication keys and cursors must be non-null',
      );
    if (
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE "type" = 'index' AND "name" = ?`,
        )
        .get(this.#dedupIndex) === undefined &&
      database
        .prepare(
          `SELECT 1 FROM ${this.table.quotedName} GROUP BY ${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(', ')} HAVING count(*) > 1 LIMIT 1`,
        )
        .get()
    )
      throw new TypeError(
        'Existing rows repeat a deduplication key; replace them with overwrite_dedup before deduplicating incrementally',
      );
  }

  // A replacing commit builds the index once the rows that leave are gone:
  // under a narrower key, they can repeat a key.
  protected override initialize(
    database: DatabaseSync,
    replacing: boolean,
  ): void {
    if (replacing) this.dropDedupIndexes(database, this.#dedupIndex);
    else this.#index(database);
  }

  // The target's key index, built only when it does not exist yet.
  #index(database: DatabaseSync): void {
    this.dropDedupIndexes(database, this.#dedupIndex);
    this.#unique(database, `"${this.#dedupIndex}"`, this.table.quotedName);
  }

  #unique(database: DatabaseSync, name: string, on: string): void {
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${on} (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(', ')})`,
    );
  }

  // A reload's hidden target merges on its key from its first commit; SQLite
  // cannot rename an index, so the target's own is built once it is swapped in.
  get #provisionalIndex(): string {
    return `"${this.#dedupIndex}_next"`;
  }

  protected override build(database: DatabaseSync, into: string): void {
    this.#unique(database, this.#provisionalIndex, into);
  }

  protected override adopt(database: DatabaseSync): void {
    database.exec(`DROP INDEX IF EXISTS ${this.#provisionalIndex}`);
    this.#index(database);
  }

  // The cursor of the guard that rejects out-of-order replay: cursor_newer's,
  // when the copy has a cursor.
  get #guard(): SQLiteColumn | undefined {
    return this.configuration.dedupPolicy === 'replace'
      ? undefined
      : this.cursor;
  }

  #same(left: string, right: string): string {
    return this.keys
      .map(({ quotedName }) => `${left}.${quotedName} = ${right}.${quotedName}`)
      .join(' AND ');
  }

  // The seq of each staged record that applying the staged operations one at
  // a time keeps: only records after a key's last DELETE count. replace keeps
  // the newest extraction, so a restated fact overwrites the loaded one;
  // cursor_newer keeps the greatest cursor (the first on ties).
  #accepted(stage: string): string {
    const keys = this.keys.map((column) => column.quotedName);
    const guard = this.#guard;
    const order =
      guard === undefined
        ? `"staged".${seq} DESC`
        : `"staged".${guard.quotedName} COLLATE BINARY DESC, "staged".${seq}`;
    // Rank identifiers only: sorting whole mail bodies/files multiplies temporary disk usage.
    return `WITH "deleted" AS (SELECT ${keys.join(', ')}, max(${seq}) AS "_elt_last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(', ')}), "ranked" AS (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(', ')} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN "deleted" ON ${this.#same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."_elt_last" IS NULL OR "staged".${seq} > "deleted"."_elt_last")) SELECT ${seq} FROM "ranked" WHERE "_elt_rank" = 1`;
  }

  protected override kept(stage: string): string {
    return `${seq} IN (${this.#accepted(stage)})`;
  }

  // A staged DELETE removes its key, and the records that #accepted keeps are
  // upserted, with the guard, if any, rejecting out-of-order replay. A stored
  // row with the values of the record that replaces it stays as it is, with
  // its commit and its loaded_at; history keeps each stored row that a DELETE
  // removes or a record with other values replaces.
  protected override merge(
    database: DatabaseSync,
    stage: string,
    { loadedAt, committedIn }: Stamp,
    into: string,
    history: SQLiteHistory | null,
  ): void {
    const keys = this.keys.map((column) => column.quotedName);
    const deleted = `(${keys.join(', ')}) IN (SELECT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D')`;
    history?.keep(
      database,
      committedIn,
      `FROM ${into} AS "_elt_old" WHERE ${deleted}`,
    );
    database.exec(`DELETE FROM ${into} WHERE ${deleted}`);
    const accepted = this.#accepted(stage);
    const guard = this.#guard;
    // Whether a staged record replaces the stored row: its values differ,
    // and the guard, if any, lets it in.
    const replaces = (record: string, row: string) =>
      `${record}.${version} IS NOT ${row}.${version}${guard === undefined ? '' : ` AND ${record}.${guard.quotedName} COLLATE BINARY > ${row}.${guard.quotedName}`}`;
    history?.keep(
      database,
      committedIn,
      `FROM ${stage} AS "_elt_new" JOIN ${into} AS "_elt_old" ON ${this.#same('"_elt_new"', '"_elt_old"')} WHERE "_elt_new".${seq} IN (${accepted}) AND ${replaces('"_elt_new"', '"_elt_old"')}`,
    );
    const columns = this.table.columns.map((column) => column.quotedName);
    database
      .prepare(
        `INSERT INTO ${into} AS "_elt_target" (${this.written.join(', ')}) SELECT ${columns.join(', ')}, ?, ?, ${version} FROM ${stage} WHERE ${seq} IN (${accepted}) ORDER BY ${seq} ` +
          `ON CONFLICT (${keys.map((key) => `${key} COLLATE BINARY`).join(', ')}) DO UPDATE SET ${this.written.map((field) => `${field} = excluded.${field}`).join(', ')} WHERE ${replaces('excluded', '"_elt_target"')}`,
      )
      .run(loadedAt, committedIn);
  }

  protected override encode(record: unknown): SQLInputValue[] {
    this.deduplication.key(record);
    if (this.cursor !== undefined) this.deduplication.cursor(record);
    return super.encode(record);
  }

  protected override deletionKeys(
    key: Readonly<Record<string, KeyValue>>,
  ): readonly [readonly SQLiteColumn[], SQLInputValue[]] {
    this.deduplication.key(key);
    return [this.keys, this.keys.map((column) => column.encode(key))];
  }
}
