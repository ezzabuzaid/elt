import type { Stream } from '@workspace/elt';
import { Target } from '@workspace/elt';

import { SQLiteColumn, canonical } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import { identifiers } from './sqlite-identifiers.ts';

// A reusable target definition. Empty columns mean infer from the Copy's
// stream. Its own name, its view's and its columns' follow the destination's
// naming rule, so a field SQLite would take for another still loads.
export class SQLiteTable extends Target {
  readonly name: string;
  readonly columns: readonly SQLiteColumn[];
  // The name readers query: a documented view of exactly this table.
  readonly readerView: string | undefined;

  constructor(
    name: string,
    columns?: readonly SQLiteColumn[],
    readerView?: string,
  ) {
    if (
      typeof name !== 'string' ||
      (readerView !== undefined && typeof readerView !== 'string')
    )
      throw new TypeError('A table and its view are named by strings');
    const table = identifiers.relation(name);
    const view =
      readerView === undefined ? undefined : identifiers.relation(readerView);
    if (view !== undefined && identifiers.key(view) === identifiers.key(table))
      throw new TypeError('A reader view needs a name of its own');
    if (
      columns !== undefined &&
      (!Array.isArray(columns) ||
        columns.length === 0 ||
        !columns.every((column) => column instanceof SQLiteColumn))
    )
      throw new TypeError('A table requires at least one SQLite column');
    const fields = (columns ?? []).map((column) => column.field);
    if (new Set(fields).size !== fields.length)
      throw new TypeError('Two columns hold one field');
    if ((columns ?? []).filter((column) => column.isPrimaryKey).length > 1)
      throw new TypeError('Only one primary-key column is supported');
    const fileReads = (columns ?? []).flatMap((column) =>
      column.fileRead === undefined ? [] : [column.fileRead],
    );
    for (const column of columns ?? []) {
      if (column.fileRead === undefined) continue;
      if (
        column.fileRead.outputType === 'bytes'
          ? column.kind !== 'blob'
          : column.kind !== 'text'
      )
        throw new TypeError(
          'Original files require a BLOB column; parsed text and stored references require a TEXT column',
        );
    }
    super(fileReads);
    this.name = table;
    this.columns = Object.freeze(
      identifiers
        .columns(columns ?? [])
        .map(([column, stored]) => column.named(stored)),
    );
    this.readerView = view;
    Object.freeze(this);
  }

  // Loads also keep a view of this table under another name, created with the
  // table and described by the same descriptions, which every column then needs.
  withReaderView(name: string): SQLiteTable {
    return new SQLiteTable(
      this.name,
      this.columns.length === 0 ? undefined : this.columns,
      name,
    );
  }

  resolve(stream: Stream): SQLiteTable {
    if (this.columns.length === 0)
      return new SQLiteTable(
        this.name,
        SQLiteColumns.fromSchema(stream.jsonSchema),
        this.readerView,
      );
    const { properties } = stream.jsonSchema;
    // Explicit columns of a stream that declares no properties stand alone.
    if (properties === undefined) return this;
    for (const column of this.columns)
      if (
        column.fileRead === undefined &&
        !Object.hasOwn(properties, column.field)
      )
        throw new TypeError(
          `Stream ${stream.name} does not describe field ${column.field}`,
        );
    return this;
  }

  // SQLite takes names that differ only in ASCII case for one, so one table
  // has one location.
  get location(): string {
    return identifiers.key(this.name);
  }

  get quotedName(): string {
    return `"${this.name.replaceAll('"', '""')}"`;
  }

  get createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.definition(this.quotedName)}`;
  }

  // A table named name with these columns, as CREATE TABLE spells it.
  definition(name: string): string {
    if (this.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `${name} (${this.columns.map((column) => column.definition).join(', ')}, "loaded_at" TEXT NOT NULL${canonical('timestamp', '"loaded_at"')}) STRICT`;
  }
}
