import type { FieldSchema, KeyValue, Properties } from '@workspace/elt';
import {
  OffsetTimestamp,
  type SqlServerColumn,
  type SqlServerRow,
  type SqlServerTable,
  type SqlServerValue,
  VariantValue,
} from '@workspace/sdk-microsoft-sql-server';

type Scalar = Omit<FieldSchema, 'type' | 'description'> & {
  readonly type: 'string' | 'integer' | 'number' | 'boolean';
};

// The JSON Schema of a column's values, before nullability and description.
function scalar(column: SqlServerColumn): Scalar {
  const { value } = column.codec;
  switch (value.kind) {
    case 'text':
    case 'spatial':
    case 'variant':
      return { type: 'string' };
    case 'integer':
      return { type: 'integer' };
    case 'int64':
      return { type: 'string', format: 'int64' };
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: 'number' };
    case 'decimal':
      return {
        type: 'string',
        format: 'decimal',
        precision: value.precision,
        scale: value.scale,
      };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'local-timestamp':
      return {
        type: 'string',
        format: 'date-time-local',
        precision: value.precision,
      };
    case 'timestamp':
      return {
        type: 'string',
        format: 'date-time',
        precision: value.precision,
      };
    case 'local-time':
      return {
        type: 'string',
        format: 'time-local',
        precision: value.precision,
      };
    case 'bytes':
      return { type: 'string', contentEncoding: 'base64' };
  }
}

// A description from SQL Server ends its sentence, so the notes after it
// read as sentences of their own.
export function sentence(text: string): string {
  return /[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;
}

function described(column: SqlServerColumn, sibling?: string): string {
  const type =
    column.type === 'timestamp'
      ? 'rowversion, which SQL Server raises on every insert and update of the row'
      : column.type;
  const own =
    column.description === null
      ? `SQL Server column ${column.name} (${type}).`
      : sentence(column.description);
  const notes = [
    column.codec.value.kind === 'timestamp'
      ? `The UTC instant; ${sibling} holds the offset it was written with.`
      : undefined,
    column.codec.value.kind === 'spatial'
      ? 'Extended well-known text: SRID=<id>; then the shape with its Z and M.'
      : undefined,
    column.masked
      ? 'Dynamic data masking applies: a login without UNMASK reads masked values.'
      : undefined,
  ];
  return [own, ...notes.filter((note) => note !== undefined)].join(' ');
}

function field(
  schema: Scalar,
  nullable: boolean,
  description: string,
): FieldSchema {
  return {
    ...schema,
    type: nullable ? [schema.type, 'null'] : schema.type,
    description,
  };
}

// What a column adds beside itself: the offset of a datetimeoffset, and the
// base type of a sql_variant.
function suffix(column: SqlServerColumn): string | undefined {
  switch (column.codec.value.kind) {
    case 'timestamp':
      return '_offset';
    case 'variant':
      return '_type';
    default:
      return undefined;
  }
}

// A table's record fields: one per readable column, plus the field a
// datetimeoffset or sql_variant column adds beside itself, named once for
// the table. A column may already hold <column>_offset, so the sibling takes
// the next free name: <column>_offset_1, then _2. Names compare without case,
// as SQL Server's default collation compares them.
export class TableFields {
  readonly #table: SqlServerTable;
  readonly #siblings: ReadonlyMap<SqlServerColumn, string>;

  constructor(table: SqlServerTable) {
    this.#table = table;
    const taken = new Set(table.columns.map(({ name }) => name.toLowerCase()));
    const siblings = new Map<SqlServerColumn, string>();
    for (const column of table.columns) {
      const added = suffix(column);
      if (added === undefined) continue;
      const base = `${column.name}${added}`;
      let name = base;
      for (let next = 1; taken.has(name.toLowerCase()); next += 1)
        name = `${base}_${next}`;
      taken.add(name.toLowerCase());
      siblings.set(column, name);
    }
    this.#siblings = siblings;
    Object.freeze(this);
  }

  get properties(): Properties {
    const fields: Record<string, FieldSchema> = {};
    for (const column of this.#table.columns) {
      const sibling = this.#siblings.get(column);
      fields[column.name] = field(
        scalar(column),
        column.nullable,
        described(column, sibling),
      );
      if (sibling === undefined) continue;
      fields[sibling] =
        column.codec.value.kind === 'timestamp'
          ? field(
              { type: 'integer' },
              column.nullable,
              `The offset from UTC, in minutes, ${column.name} was written with.`,
            )
          : field(
              { type: 'string' },
              column.nullable,
              `The SQL Server type of the value ${column.name} holds.`,
            );
    }
    return fields;
  }

  // The stream's key: the table's primary key, with the base type of a
  // sql_variant key column, since its text alone can repeat across types.
  get primaryKey(): string[] {
    return this.#table.primaryKey.flatMap((column) => {
      const type =
        column.codec.value.kind === 'variant'
          ? this.#siblings.get(column)
          : undefined;
      return type === undefined ? [column.name] : [column.name, type];
    });
  }

  record(row: SqlServerRow): Record<string, unknown> {
    return Object.assign(
      {},
      ...this.#table.columns.map((column, index) =>
        this.#plain(column, row.values[index] ?? null),
      ),
    );
  }

  // A deleted row's key fields, from its primary key values in key order.
  key(values: readonly SqlServerValue[]): Record<string, KeyValue> {
    const fields: Record<string, KeyValue> = {};
    for (const [index, column] of this.#table.primaryKey.entries()) {
      const value = values[index] ?? null;
      for (const [name, part] of Object.entries(this.#plain(column, value))) {
        if (
          typeof part !== 'string' &&
          typeof part !== 'number' &&
          typeof part !== 'boolean'
        )
          throw new TypeError(
            `${this.#table.quoted} key ${column.name} has no value`,
          );
        if (name === column.name || column.codec.value.kind === 'variant')
          fields[name] = part;
      }
    }
    return fields;
  }

  #plain(
    column: SqlServerColumn,
    value: SqlServerValue,
  ): Record<string, unknown> {
    const sibling = this.#siblings.get(column);
    if (sibling === undefined) return { [column.name]: value };
    if (value instanceof OffsetTimestamp)
      return { [column.name]: value.instant, [sibling]: value.offset };
    if (value instanceof VariantValue)
      return { [column.name]: value.text, [sibling]: value.type };
    return { [column.name]: null, [sibling]: null };
  }
}
