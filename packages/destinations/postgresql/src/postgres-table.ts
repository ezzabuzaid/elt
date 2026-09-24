import { type Stream, Target } from 'elt';
import { identifier, quote } from './identifier.ts';
import { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';

// A reusable target definition. Empty columns mean infer from the Copy's stream.
export class PostgresTable extends Target {
  readonly name: string;
  readonly columns: readonly PostgresColumn[];

  constructor(name: string, columns?: readonly PostgresColumn[]) {
    identifier(name, 'table name');
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
    super();
    this.name = name;
    this.columns = Object.freeze([...(columns ?? [])]);
    Object.freeze(this);
  }

  resolve(stream: Stream): PostgresTable {
    if (this.columns.length === 0)
      return new PostgresTable(
        this.name,
        PostgresColumns.fromSchema(stream.jsonSchema),
      );
    const properties = stream.jsonSchema.properties;
    if (
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    ) {
      for (const column of this.columns) {
        if (!Object.hasOwn(properties, column.name))
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
