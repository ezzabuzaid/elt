import {
  type Stream,
  Target,
  readerCatalog,
  syncHistoryRelations,
} from '@eltjs/elt';

import { quote } from './identifier.ts';
import { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { identifiers, rawTable } from './postgres-identifiers.ts';

// The views that the sync history publishes in marts under a fixed name: the
// catalog and the views of the history. The naming rule already renames a
// name that starts with _elt_.
const made = new Set(
  [readerCatalog, ...Object.values(syncHistoryRelations)].map(({ name }) =>
    identifiers.key(name),
  ),
);

// A reusable target definition. Empty columns mean infer from the Copy's
// stream. The host names only the reader view in marts; the destination
// keeps the rows in the raw table in _warehouse. Both names and the columns'
// follow the destination's naming rule, so a field Postgres cannot hold as it
// is still loads.
export class PostgresTable extends Target {
  // The name readers query: the view in marts over the raw table.
  readonly name: string;
  // The table in _warehouse that the commits of the target write.
  readonly raw: string;
  readonly columns: readonly PostgresColumn[];

  constructor(name: string, columns?: readonly PostgresColumn[]) {
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
        !columns.every((column) => column instanceof PostgresColumn))
    )
      throw new TypeError('A table requires at least one Postgres column');
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

  resolve(stream: Stream): PostgresTable {
    if (this.columns.length === 0)
      return new PostgresTable(
        this.name,
        PostgresColumns.fromSchema(stream.jsonSchema),
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

  get quotedRaw(): string {
    return quote(this.raw);
  }
}
