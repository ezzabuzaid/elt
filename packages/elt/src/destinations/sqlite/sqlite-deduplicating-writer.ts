import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CopyConfiguration } from '../../core/copy-configuration.ts';
import type { Deduplication } from '../../core/deduplication.ts';
import type { SQLiteColumn } from './sqlite-column.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { SQLiteWriter } from './sqlite-writer.ts';

export class SQLiteDeduplicatingWriter extends SQLiteWriter {
  readonly deduplication: Deduplication;
  readonly keys: readonly SQLiteColumn[];
  readonly cursor: SQLiteColumn;

  constructor(
    readonly configuration: CopyConfiguration,
    path: string,
    table: SQLiteTable,
  ) {
    super(configuration.stream, path, table);
    this.deduplication = configuration.deduplication();
    const column = (field: string): SQLiteColumn => {
      const selected = table.columns.find((column) => column.name === field);
      if (selected === undefined)
        throw new TypeError(
          `Deduplication requires destination column ${field}`,
        );
      const kinds = {
        string: 'text',
        number: 'real',
        integer: 'integer',
        boolean: 'boolean',
      } as const;
      if (selected.kind !== kinds[this.deduplication.type(field)])
        throw new TypeError(
          `Deduplication column ${field} must preserve the source scalar type`,
        );
      return selected;
    };
    this.keys = Object.freeze(this.deduplication.primaryKey.map(column));
    this.cursor = column(this.deduplication.cursorField);
    Object.freeze(this);
  }

  protected override initialize(database: DatabaseSync): void {
    database.exec(this.table.createTableSQL);
    if (this.configuration.destinationSyncMode === 'overwrite_dedup')
      database.exec(`DELETE FROM ${this.table.quotedName}`);
    const existing = database
      .prepare(`PRAGMA table_info(${this.table.quotedName})`)
      .all();
    for (const column of [...this.keys, this.cursor]) {
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
          `SELECT 1 FROM ${this.table.quotedName} WHERE ${[...this.keys, this.cursor].map((column) => `${column.quotedName} IS NULL`).join(' OR ')} LIMIT 1`,
        )
        .get()
    )
      throw new TypeError(
        'Existing deduplication keys and cursors must be non-null',
      );
    database.exec(
      `CREATE UNIQUE INDEX ${this.dedupIndex} ON ${this.table.quotedName} (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(', ')})`,
    );
  }

  protected override get insertSQL(): string {
    const fields = [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"',
    ];
    // replace lets the newest extraction win, so a restated fact overwrites the
    // loaded one; cursor_newer keeps the guard that rejects out-of-order replay.
    const guard =
      this.configuration.dedupPolicy === 'replace'
        ? ''
        : ` WHERE excluded.${this.cursor.quotedName} COLLATE BINARY > "_mac_elt_target".${this.cursor.quotedName}`;
    return `${super.insertSQL} ON CONFLICT (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(', ')}) DO UPDATE SET ${fields.map((field) => `${field} = excluded.${field}`).join(', ')}${guard}`;
  }

  protected override encode(record: unknown): SQLInputValue[] {
    this.deduplication.key(record);
    this.deduplication.cursor(record);
    return super.encode(record);
  }
}
