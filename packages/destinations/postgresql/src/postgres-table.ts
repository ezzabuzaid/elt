import { type Stream, Target } from '@workspace/elt';

import { quote } from './identifier.ts';
import { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { identifiers } from './postgres-identifiers.ts';
import { schemaName } from './postgres-session.ts';

// Where readers see the table: a documented view of exactly its columns.
export type PostgresReaderView = {
  readonly schema: string;
  readonly name: string;
};

// A reusable target definition. Empty columns mean infer from the Copy's
// stream. Its own name, its view's and its columns' follow the destination's
// naming rule, so a field Postgres cannot hold as it is still loads.
export class PostgresTable extends Target {
  readonly name: string;
  readonly columns: readonly PostgresColumn[];
  readonly readerView: PostgresReaderView | undefined;

  constructor(
    name: string,
    columns?: readonly PostgresColumn[],
    readerView?: PostgresReaderView,
  ) {
    if (
      typeof name !== 'string' ||
      (readerView !== undefined && typeof readerView.name !== 'string')
    )
      throw new TypeError('A table and its view are named by strings');
    if (readerView !== undefined) schemaName(readerView.schema);
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
    this.name = identifiers.relation(name);
    this.columns = Object.freeze(
      identifiers
        .columns(columns ?? [])
        .map(([column, stored]) => column.named(stored)),
    );
    this.readerView =
      readerView &&
      Object.freeze({
        schema: readerView.schema,
        name: identifiers.relation(readerView.name),
      });
    Object.freeze(this);
  }

  // Loads also keep a view of this table in another schema, created with the
  // table and described by the same comments, which every column then needs.
  withReaderView(schema: string, name: string): PostgresTable {
    return new PostgresTable(
      this.name,
      this.columns.length === 0 ? undefined : this.columns,
      { schema, name },
    );
  }

  resolve(stream: Stream): PostgresTable {
    if (this.columns.length === 0)
      return new PostgresTable(
        this.name,
        PostgresColumns.fromSchema(stream.jsonSchema),
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

  get quotedName(): string {
    return quote(this.name);
  }
}
