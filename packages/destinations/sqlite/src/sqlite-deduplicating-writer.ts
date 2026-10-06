import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type {
  CopyConfiguration,
  Deduplication,
  KeyValue,
} from '@workspace/elt';

import type { SQLiteColumn } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter, op, seq } from './sqlite-writer.ts';

export class SQLiteDeduplicatingWriter extends SQLiteWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly SQLiteColumn[];
  readonly cursor?: SQLiteColumn;

  constructor(
    configuration: CopyConfiguration,
    path: string,
    table: SQLiteTable,
  ) {
    super(configuration, path, table);
    this.deduplication = configuration.deduplication();
    const inferred = SQLiteColumns.fromSchema(configuration.stream.jsonSchema);
    const column = (field: string): SQLiteColumn => {
      const selected = table.columns.find((column) => column.name === field);
      if (selected === undefined)
        throw new TypeError(
          `Deduplication requires destination column ${field}`,
        );
      if (
        selected.dataType !==
        inferred.find((column) => column.name === field)?.dataType
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

  protected override initialize(
    database: DatabaseSync,
    replacing: boolean,
  ): void {
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
    // A replacing load keeps none of these rows: its index is built once the
    // commit has emptied the table.
    if (replacing) return;
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
    this.index(database);
  }

  protected override replace(database: DatabaseSync): void {
    super.replace(database);
    this.index(database);
  }

  private index(database: DatabaseSync): void {
    database.exec(
      `CREATE UNIQUE INDEX ${this.dedupIndex} ON ${this.table.quotedName} (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(', ')})`,
    );
  }

  // The result of applying the staged operations one at a time: a staged
  // DELETE removes its key, and only records after a key's last DELETE count.
  // replace keeps the newest extraction, so a restated fact overwrites the
  // loaded one; cursor_newer keeps the greatest cursor (the first on ties) and
  // the guard that rejects out-of-order replay.
  protected override merge(
    database: DatabaseSync,
    stage: string,
    loadedAt: string,
  ): void {
    const keys = this.keys.map((column) => column.quotedName);
    const same = (left: string, right: string) =>
      keys.map((key) => `${left}.${key} = ${right}.${key}`).join(' AND ');
    database.exec(
      `DELETE FROM ${this.table.quotedName} WHERE (${keys.join(', ')}) IN (SELECT ${keys.join(', ')} FROM ${stage} WHERE ${op} = 'D')`,
    );
    const { cursor } = this;
    const guarded =
      this.configuration.dedupPolicy !== 'replace' && cursor !== undefined;
    const order = guarded
      ? `"staged".${cursor.quotedName} COLLATE BINARY DESC, "staged".${seq}`
      : `"staged".${seq} DESC`;
    // Rank identifiers only: sorting whole mail bodies/files multiplies temporary disk usage.
    const columns = this.table.columns.map((column) => column.quotedName);
    database
      .prepare(
        `WITH "deleted" AS (SELECT ${keys.join(', ')}, max(${seq}) AS "last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(', ')}), "ranked" AS (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(', ')} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN "deleted" ON ${same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."last" IS NULL OR "staged".${seq} > "deleted"."last")) ` +
          `INSERT INTO ${this.table.quotedName} AS "_elt_target" (${this.fields.join(', ')}) SELECT ${columns.join(', ')}, ? FROM ${stage} WHERE ${seq} IN (SELECT ${seq} FROM "ranked" WHERE "_elt_rank" = 1) ORDER BY ${seq} ` +
          `ON CONFLICT (${keys.map((key) => `${key} COLLATE BINARY`).join(', ')}) DO UPDATE SET ${this.fields.map((field) => `${field} = excluded.${field}`).join(', ')}${guarded ? ` WHERE excluded.${cursor.quotedName} COLLATE BINARY > "_elt_target".${cursor.quotedName}` : ''}`,
      )
      .run(loadedAt);
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
