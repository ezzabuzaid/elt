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

function described(column: SqlServerColumn): string {
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
      ? `The UTC instant; ${column.name}_offset holds the offset it was written with.`
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

// The sibling a column adds beside itself, which no column of the table may
// already be called.
function sibling(column: SqlServerColumn): string | undefined {
  switch (column.codec.value.kind) {
    case 'timestamp':
      return `${column.name}_offset`;
    case 'variant':
      return `${column.name}_type`;
    default:
      return undefined;
  }
}

// The properties of a table's records: one per readable column, plus the
// offset beside a datetimeoffset and the base type beside a sql_variant.
export function properties(table: SqlServerTable): Properties {
  const fields: Record<string, FieldSchema> = {};
  for (const column of table.columns) {
    fields[column.name] = field(
      scalar(column),
      column.nullable,
      described(column),
    );
    const name = sibling(column);
    if (name === undefined) continue;
    if (
      table.columns.some(
        (other) => other.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new TypeError(
        `${table.quoted} has a column ${name}, the name its ${column.name} needs for its ${column.codec.value.kind === 'timestamp' ? 'offset' : 'base type'}`,
      );
    fields[name] =
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
export function primaryKey(table: SqlServerTable): string[] {
  return table.primaryKey.flatMap((column) =>
    column.codec.value.kind === 'variant'
      ? [column.name, `${column.name}_type`]
      : [column.name],
  );
}

function plain(
  column: SqlServerColumn,
  value: SqlServerValue,
): Record<string, unknown> {
  if (value instanceof OffsetTimestamp)
    return {
      [column.name]: value.instant,
      [`${column.name}_offset`]: value.offset,
    };
  if (value instanceof VariantValue)
    return { [column.name]: value.text, [`${column.name}_type`]: value.type };
  const name = sibling(column);
  return name === undefined
    ? { [column.name]: value }
    : { [column.name]: null, [name]: null };
}

export function record(row: SqlServerRow): Record<string, unknown> {
  return Object.assign(
    {},
    ...row.table.columns.map((column, index) =>
      plain(column, row.values[index] ?? null),
    ),
  );
}

// A deleted row's key fields, from its primary key values in key order.
export function key(
  table: SqlServerTable,
  values: readonly SqlServerValue[],
): Record<string, KeyValue> {
  const fields: Record<string, KeyValue> = {};
  for (const [index, column] of table.primaryKey.entries()) {
    const value = values[index] ?? null;
    for (const [name, part] of Object.entries(plain(column, value))) {
      if (
        typeof part !== 'string' &&
        typeof part !== 'number' &&
        typeof part !== 'boolean'
      )
        throw new TypeError(`${table.quoted} key ${column.name} has no value`);
      if (name === column.name || column.codec.value.kind === 'variant')
        fields[name] = part;
    }
  }
  return fields;
}
