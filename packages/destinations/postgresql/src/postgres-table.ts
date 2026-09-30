import { type Stream, Target } from 'elt';
import { identifier, quote } from './identifier.ts';
import { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { schemaName } from './postgres-session.ts';

// Where readers see the table: a documented view of exactly its columns.
export type PostgresReaderView = {
  readonly schema: string;
  readonly name: string;
};

// A reusable target definition. Empty columns mean infer from the Copy's stream.
export class PostgresTable extends Target {
  readonly name: string;
  readonly columns: readonly PostgresColumn[];
  readonly readerView: PostgresReaderView | undefined;

  constructor(
    name: string,
    columns?: readonly PostgresColumn[],
    readerView?: PostgresReaderView,
  ) {
    identifier(name, 'table name');
    if (readerView !== undefined) {
      schemaName(readerView.schema);
      identifier(readerView.name, 'view name');
    }
    if (/^_mac_elt_/i.test(name))
      throw new TypeError('Table names starting with _mac_elt_ are reserved');
    if (
      columns !== undefined &&
      (!Array.isArray(columns) ||
        columns.length === 0 ||
        !columns.every((column) => column instanceof PostgresColumn))
    )
      throw new TypeError('A table requires at least one Postgres column');
    // Quoted identifiers are case-sensitive in Postgres.
    const names = (columns ?? []).map((column) => column.name);
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
        column.fileRead.outputType === 'bytes'
          ? column.kind !== 'blob'
          : column.kind !== 'text'
      )
        throw new TypeError(
          'Original files require a BLOB column; parsed text and stored references require a TEXT column',
        );
    }
    super(fileReads);
    this.name = name;
    this.columns = Object.freeze([...(columns ?? [])]);
    this.readerView = readerView && Object.freeze({ ...readerView });
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

  get quotedName(): string {
    return quote(this.name);
  }
}
