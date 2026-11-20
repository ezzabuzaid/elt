import {
  type DeclaredFormat,
  declaredFormat,
} from './formats/declared-format.ts';
import type { Stream } from './stream.ts';

// What a column that a destination infers from a stream holds: the kind of
// its JSON Schema type, or the format of a string, which decides the kind.
export type SchemaColumnType =
  'text' | 'integer' | 'real' | 'boolean' | 'object' | DeclaredFormat;

// A column of a stream's JSON Schema: a field with one scalar type, or an
// array of one, which a field that may be null or absent leaves out.
export type SchemaColumn = {
  readonly field: string;
  readonly type: SchemaColumnType;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly array: boolean;
};

function scalarType(
  name: string,
  type: string,
  format: DeclaredFormat | null,
): SchemaColumnType {
  switch (type) {
    case 'string':
      return format ?? 'text';
    case 'integer':
      return 'integer';
    case 'number':
      return 'real';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      throw new TypeError(
        `Unsupported JSON Schema type for field ${name}: ${type}`,
      );
  }
}

// The columns that a destination of engine infers from the JSON Schema of a
// stream, in the order of its properties. Each destination makes its own
// column of each.
export function schemaColumns(
  { properties, required = [] }: Stream['jsonSchema'],
  engine: string,
): readonly SchemaColumn[] {
  if (properties === undefined)
    throw new TypeError(
      `${engine} requires an object schema with explicit properties`,
    );
  const requiredFields = new Set(required);
  for (const name of requiredFields)
    if (!Object.hasOwn(properties, name))
      throw new TypeError(`Schema does not describe field ${name}`);
  return Object.entries(properties).map(([name, field]) => {
    const types = typeof field.type === 'string' ? [field.type] : field.type;
    if (new Set(types).size !== types.length)
      throw new TypeError(`Unsupported JSON Schema type for field ${name}`);
    const valueTypes = types.filter((type) => type !== 'null');
    const valueType = valueTypes[0];
    if (valueType === undefined || valueTypes.length !== 1)
      throw new TypeError(
        `${engine} requires one scalar type for field ${name}`,
      );
    const array = valueType === 'array';
    const items = array ? field.items : undefined;
    if (array && items === undefined)
      throw new TypeError(`Unsupported JSON Schema items for field ${name}`);
    return {
      field: name,
      type: scalarType(
        name,
        items?.type ?? valueType,
        declaredFormat(items ?? field),
      ),
      nullable: types.includes('null'),
      optional: !requiredFields.has(name),
      array,
    };
  });
}

// Refuses an explicit column of a target that holds a field the stream's
// schema does not describe; a column that reads a file holds what its read
// gives. A stream that declares no properties lets its explicit columns
// stand alone.
export function requireDescribed(
  stream: Stream,
  columns: readonly { readonly field: string; readonly fileRead?: unknown }[],
): void {
  const { properties } = stream.jsonSchema;
  if (properties === undefined) return;
  for (const column of columns)
    if (
      column.fileRead === undefined &&
      !Object.hasOwn(properties, column.field)
    )
      throw new TypeError(
        `Stream ${stream.name} does not describe field ${column.field}`,
      );
}
