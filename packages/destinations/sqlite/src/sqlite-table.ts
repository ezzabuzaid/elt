import type { Stream } from '@eltjs/elt';
import { Target, readerCatalog, syncHistoryRelations } from '@eltjs/elt';

import { SQLiteColumn, canonical } from './sqlite-column.ts';
import { SQLiteColumns } from './sqlite-columns.ts';
import { identifiers, quote, rawTable } from './sqlite-identifiers.ts';

// The relations that the destination makes in each file under a fixed name,
// in the case SQLite compares them in: the catalog and the views of the sync
// history. The naming rule already renames a name that starts with _elt_.
const made = new Set(
  [readerCatalog, ...Object.values(syncHistoryRelations)].map(({ name }) =>
    identifiers.key(name),
  ),
);

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
    if (typeof name !== 'string')
      throw new TypeError('A table is named by a string');
    const view = identifiers.relation(name);
    if (made.has(identifiers.key(view)))
      throw new TypeError(
        `Reader name ${view} is a relation the destination makes`,
      );
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
