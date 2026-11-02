import {
  type DeclaredFormat,
  declaredFormat,
} from './formats/declared-format.ts';

// The JSON Schema subset stream properties use: scalar types, optionally
// nullable, with enum, range, length and string formats; or an array,
// optionally nullable, whose items are one such scalar type, or objects whose
// fields are such scalars, every field required, as a record's properties are.
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

export type ScalarItemSchema = ScalarSchema & {
  readonly type: Exclude<ScalarType, 'null'>;
};

// A field of an object item: a scalar, optionally nullable.
export type ObjectFieldSchema = ScalarSchema & {
  readonly type: ScalarType | readonly ScalarType[];
};

// An item that is an object of scalar fields, such as a page's language copy
// { language, url }; it names every field as required. Airbyte's type system
// nests objects in arrays the same way.
export type ObjectItemSchema = {
  readonly type: 'object';
  readonly description?: string;
  readonly properties: Readonly<Record<string, ObjectFieldSchema>>;
  readonly required: readonly string[];
};

export type ItemSchema = ScalarItemSchema | ObjectItemSchema;

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

type Types<F extends { readonly type: unknown }> =
  F['type'] extends readonly (infer T)[] ? T : F['type'];

type ItemValue<I extends ItemSchema> = I extends ObjectItemSchema
  ? {
      -readonly [K in keyof I['properties']]: ScalarValue<
        Types<I['properties'][K]>
      >;
    }
  : ScalarValue<I['type']>;

type FieldValue<F extends FieldSchema> =
  'array' extends Types<F>
    ? F['items'] extends ItemSchema
      ? ItemValue<F['items']>[] | ScalarValue<Exclude<Types<F>, 'array'>>
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

// Whether a scalar declares only scalar types.
function scalarSupported(field: {
  readonly type: unknown;
  readonly items?: unknown;
}): boolean {
  const { type } = field;
  const types: readonly unknown[] = Array.isArray(type) ? type : [type];
  return (
    field.items === undefined && types.every((each) => scalarTypes.has(each))
  );
}

// Whether an object item declares scalar fields and names each one required.
function objectSupported(items: ObjectItemSchema): boolean {
  const { properties, required } = items;
  if (properties === null || typeof properties !== 'object') return false;
  const names = Object.keys(properties);
  return (
    names.length > 0 &&
    Array.isArray(required) &&
    required.length === names.length &&
    names.every((name) => required.includes(name)) &&
    Object.values(properties).every(scalarSupported)
  );
}

// Whether a field declares a type validateRecords can check: scalar types, or
// an array (alone or with null) of one non-null scalar type or of objects of
// scalar fields.
function supported(field: FieldSchema): boolean {
  if (!isArrayField(field)) return scalarSupported(field);
  const types = typesOf(field);
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
    (items.type === 'object'
      ? objectSupported(items)
      : itemTypes.has(items.type))
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
  // Whether a value of the field is valid.
  readonly valid: (value: unknown) => boolean;
};

// A check of one scalar value against its schema, nulls included when the
// schema allows them; the format is read once.
function scalarCheck(
  field: ScalarSchema & { readonly type: string | readonly string[] },
) {
  const types = typesOf(field);
  const format = declaredFormat(field);
  return (value: unknown) =>
    (value === null && types.includes('null')) ||
    scalarValid(field, types, format, value);
}

// A check of one item of an array field.
function itemCheck(items: ItemSchema): (item: unknown) => boolean {
  if (items.type !== 'object') return scalarCheck(items);
  const fields = Object.entries(items.properties).map(
    ([name, field]) => [name, scalarCheck(field)] as const,
  );
  return (item) =>
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item).length === fields.length &&
    fields.every(
      ([name, valid]) =>
        Object.hasOwn(item, name) && valid(Reflect.get(item, name)),
    );
}

// A check of one field: a scalar, or an array whose every item is valid.
function fieldCheck(field: FieldSchema): (value: unknown) => boolean {
  if (!isArrayField(field)) return scalarCheck(field);
  const item = itemCheck(field.items);
  const nullable = typesOf(field).includes('null');
  return (value) =>
    (value === null && nullable) || (Array.isArray(value) && value.every(item));
}

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
        return { name, valid: fieldCheck(schema) };
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
  for (const { name, valid } of fields)
    if (!valid(Reflect.get(record, name)))
      throw new TypeError(`${source} returned invalid ${stream}.${name}`);
}
