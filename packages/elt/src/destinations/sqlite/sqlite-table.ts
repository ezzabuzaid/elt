import type { Stream } from '../../core/stream.ts';
import { Target } from '../../core/target.ts';
import { SQLiteColumn } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';

// A reusable target definition. Empty columns mean infer from the Copy's stream.
export class SQLiteTable extends Target {
  readonly name: string;
  readonly columns: readonly SQLiteColumn[];

  constructor(name: string, columns?: readonly SQLiteColumn[]) {
    if (!name || name.includes('\0')) throw new TypeError('Invalid table name');
    if (/^_mac_elt_/i.test(name))
      throw new TypeError('Table names starting with _mac_elt_ are reserved');
    if (
      columns !== undefined &&
      (!Array.isArray(columns) ||
        columns.length === 0 ||
        !columns.every((column) => column instanceof SQLiteColumn))
    )
      throw new TypeError('A table requires at least one SQLite column');
    const names = (columns ?? []).map((column) => column.name.toLowerCase());
    if (names.includes('loaded_at'))
      throw new TypeError('loaded_at is reserved for load metadata');
    if (new Set(names).size !== names.length)
      throw new TypeError('Duplicate column names');
    if ((columns ?? []).filter((column) => column.isPrimaryKey).length > 1)
      throw new TypeError('Only one primary-key column is supported');
    const fileReads = (columns ?? []).flatMap((column) =>
      column.fileRead === undefined ? [] : [column.fileRead],
    );
    for (const column of columns ?? []) {
      if (column.fileRead === undefined) continue;
      if (
        column.fileRead.parser === undefined
          ? column.kind !== 'blob'
          : column.kind !== 'text'
      )
        throw new TypeError(
          'Original files require a BLOB column; parsed files require a TEXT column',
        );
    }
    super(fileReads);
    this.name = name;
    this.columns = Object.freeze([...(columns ?? [])]);
    Object.freeze(this);
  }

  resolve(stream: Stream): SQLiteTable {
    if (this.columns.length === 0)
      return new SQLiteTable(
        this.name,
        SQLiteColumns.fromSchema(stream.jsonSchema),
      );
    const properties = stream.jsonSchema.properties;

    if (
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    ) {
      for (const column of this.columns) {
        if (
          column.fileRead === undefined &&
          !Object.hasOwn(properties, column.name)
        )
          throw new TypeError(
            `Stream ${stream.name} does not describe column ${column.name}`,
          );
      }
    }
    return this;
  }

  // SQLite compares ASCII identifiers case-insensitively, so one table has one location.
  get location(): string {
    return this.name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  }

  get quotedName(): string {
    return `"${this.name.replaceAll('"', '""')}"`;
  }

  get createTableSQL(): string {
    if (this.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `CREATE TABLE IF NOT EXISTS ${this.quotedName} (${this.columns.map((column) => column.definition).join(', ')}, "loaded_at" TEXT NOT NULL) STRICT`;
  }
}
