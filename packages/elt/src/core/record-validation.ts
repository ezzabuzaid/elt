import {
  type DeclaredFormat,
  declaredFormat,
} from './formats/declared-format.ts';

// The JSON Schema subset stream properties use: scalar types, optionally
// nullable, with enum, range, length and string formats; or an array of one
// such scalar type, optionally nullable, whose items carry those constraints.
export type ScalarSchema = {
  readonly description?: string;
  readonly format?:
    | 'date-time'
    | 'date'
    | 'date-time-local'
    | 'time-local'
    | 'int64'
    | 'decimal';
  // Fraction-of-second digits of a temporal format (3 when absent), or the
  // most significant digits of a decimal.
  readonly precision?: number;
  // Digits after the point of a decimal.
  readonly scale?: number;
  readonly contentEncoding?: 'base64';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly enum?: readonly (string | number)[];
};

export type ItemSchema = ScalarSchema & {
  readonly type: Exclude<ScalarType, 'null'>;
};

export type FieldSchema = ScalarSchema & {
  readonly type: FieldType | readonly FieldType[];
  // Required when type includes 'array': the schema of every element.
  readonly items?: ItemSchema;
};

type FieldType = ScalarType | 'array';

type ScalarType = 'string' | 'integer' | 'number' | 'boolean' | 'null';

type ScalarValue<T> = T extends 'string'
  ? string
  : T extends 'integer' | 'number'
    ? number
    : T extends 'boolean'
      ? boolean
      : T extends 'null'
        ? null
        : never;

type Types<F extends FieldSchema> = F['type'] extends readonly (infer T)[]
  ? T
  : F['type'];

type FieldValue<F extends FieldSchema> =
  'array' extends Types<F>
    ? F['items'] extends ItemSchema
      ? | ScalarValue<F['items']['type']>[]
        | ScalarValue<Exclude<Types<F>, 'array'>>
      : never
    : ScalarValue<Types<F>>;

export type Properties = Readonly<Record<string, FieldSchema>>;

// What a stream declares about its records: an object of required properties.
// A stream without properties loads only into explicit targets, and its
// records cannot be validated.
export type StreamSchema = {
  readonly type: 'object';
  readonly description?: string;
  readonly properties?: Properties;
  readonly required?: readonly string[];
};

// The record type an `as const` properties schema describes. A schema known
// only as Properties describes records only as named values.
export type SchemaRecord<P extends Properties> = string extends keyof P
  ? Record<string, unknown>
  : { -readonly [K in keyof P]: FieldValue<P[K]> };

// A record before validateRecords checks its values against the schema: every
// property named, none typed yet.
export type RecordDraft<P extends Properties> = {
  readonly [K in keyof P]: unknown;
};

const itemTypes = new Set<unknown>(['string', 'integer', 'number', 'boolean']);
const scalarTypes = new Set<unknown>([...itemTypes, 'null']);

const typesOf = (field: { readonly type: string | readonly string[] }) =>
  typeof field.type === 'string' ? [field.type] : field.type;

const isArrayField = (
  field: FieldSchema,
): field is FieldSchema & { readonly items: ItemSchema } =>
  typesOf(field).includes('array');

// Whether a field declares a type validateRecords can check: scalar types, or
// an array (alone or with null) of one non-null scalar type.
function supported(field: FieldSchema): boolean {
  const types = typesOf(field);
  if (!isArrayField(field))
    return (
      field.items === undefined && types.every((type) => scalarTypes.has(type))
    );
  const { items } = field;
  return (
    types.every((type) => type === 'array' || type === 'null') &&
    // Constraints on an array field belong on its items.
    field.enum === undefined &&
    field.format === undefined &&
    field.precision === undefined &&
    field.scale === undefined &&
    field.contentEncoding === undefined &&
    field.minimum === undefined &&
    field.maximum === undefined &&
    field.minLength === undefined &&
    items !== null &&
    typeof items === 'object' &&
    itemTypes.has(items.type)
  );
}

// Whether a non-null value satisfies a scalar schema's type and constraints.
function scalarValid(
  field: ScalarSchema,
  types: readonly string[],
  format: DeclaredFormat | null,
  value: unknown,
): boolean {
  const typed = types.some((type) =>
    type === 'integer'
      ? Number.isSafeInteger(value)
      : type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : (type === 'string' || type === 'boolean') && typeof value === type,
  );
  return (
    typed &&
    (field.enum === undefined ||
      field.enum.some((member) => member === value)) &&
    !(
      typeof value === 'number' &&
      ((field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum))
    ) &&
    !(
      typeof value === 'string' &&
      field.minLength !== undefined &&
      value.length < field.minLength
    ) &&
    (format === null || (typeof value === 'string' && format.accepts(value)))
  );
}

type CheckedField = {
  readonly name: string;
  readonly schema: FieldSchema;
  // Of the field, or of each item of an array field.
  readonly format: DeclaredFormat | null;
};

// Every property is required and a record carries exactly those properties, so
// a projection that drops or misspells a field fails here instead of loading.
export function validateRecords<P extends Properties>(
  stream: {
    readonly name: string;
    readonly jsonSchema: { readonly properties?: P };
  },
  records: unknown,
  source: string,
): SchemaRecord<P>[] {
  if (!Array.isArray(records))
    throw new TypeError(`${source} returned invalid ${stream.name} records`);
  const { properties } = stream.jsonSchema;
  if (properties === undefined)
    throw new TypeError(
      `Stream ${stream.name} declares no properties to validate`,
    );
  const fields = Object.entries(properties).map(
    ([name, schema]): CheckedField => {
      const unsupported = (cause?: unknown) =>
        new TypeError(
          `Stream ${stream.name}.${name} declares an unsupported type`,
          { cause },
        );
      if (!supported(schema)) throw unsupported();
      try {
        return {
          name,
          schema,
          format: declaredFormat(isArrayField(schema) ? schema.items : schema),
        };
      } catch (error) {
        throw unsupported(error);
      }
    },
  );
  const valid: SchemaRecord<P>[] = [];
  for (const record of records) {
    assertRecord<P>(record, fields, stream.name, source);
    valid.push(record);
  }
  return valid;
}

function assertRecord<P extends Properties>(
  record: unknown,
  fields: readonly CheckedField[],
  stream: string,
  source: string,
): asserts record is SchemaRecord<P> {
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).length !== fields.length
  )
    throw new TypeError(`${source} returned an invalid ${stream} record`);
  for (const { name, schema, format } of fields) {
    const value: unknown = Reflect.get(record, name);
    const types = typesOf(schema);
    if (value === null && types.includes('null')) continue;
    const valid = isArrayField(schema)
      ? Array.isArray(value) &&
        value.every((item) =>
          scalarValid(schema.items, [schema.items.type], format, item),
        )
      : scalarValid(schema, types, format, value);
    if (!valid)
      throw new TypeError(`${source} returned invalid ${stream}.${name}`);
  }
}
