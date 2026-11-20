import type { Stream } from '@eltjs/elt';
import { Target, targetFileReads } from '@eltjs/elt';

import { SQLiteColumn, canonical } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import { identifiers, quote, rawTable } from './sqlite-identifiers.ts';

// A reusable target definition. Empty columns mean infer from the Copy's
// stream. The host names only the reader view; the destination keeps the rows
// in the raw table beside it. Both names and the columns' follow the
// destination's naming rule, so a field SQLite would take for another still
// loads.
export class SQLiteTable extends Target {
  // The name readers query: the view of the external schema over the raw table.
  readonly name: string;
  // The table that the commits of the target write.
  readonly raw: string;
  readonly columns: readonly SQLiteColumn[];

  constructor(name: string, columns?: readonly SQLiteColumn[]) {
    const view = identifiers.reader(name);
    if (
      columns !== undefined &&
      (!Array.isArray(columns) ||
        columns.length === 0 ||
        !columns.every((column) => column instanceof SQLiteColumn))
    )
      throw new TypeError('A table requires at least one SQLite column');
    super(targetFileReads(columns ?? []));
    this.name = view;
    this.raw = rawTable(view);
    this.columns = Object.freeze(
      identifiers
        .columns(columns ?? [])
        .map(([column, stored]) => column.named(stored)),
    );
    Object.freeze(this);
  }

  resolve(stream: Stream): SQLiteTable {
    if (this.columns.length === 0)
      return new SQLiteTable(
        this.name,
        SQLiteColumns.fromSchema(stream.jsonSchema),
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

  // SQLite takes names that differ only in ASCII case for one, so one raw
  // table has one location.
  get location(): string {
    return identifiers.key(this.raw);
  }

  get quotedRaw(): string {
    return quote(this.raw);
  }

  get createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.definition(this.quotedRaw)}`;
  }

  // A table named name with these columns, as CREATE TABLE spells it.
  definition(name: string): string {
    if (this.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `${name} (${this.columns.map((column) => column.definition).join(', ')}, "loaded_at" TEXT NOT NULL${canonical('timestamp', '"loaded_at"')}, "committed_in" INTEGER NOT NULL, "_elt_row_hash" TEXT) STRICT`;
  }
}
