import { isCalendarDate, isTimestamp } from './formats.ts';
import type { Stream } from './stream.ts';

// The JSON Schema subset stream properties use: scalar types, optionally
// nullable, with enum, range, length and date formats; or an array of one such
// scalar type, optionally nullable, whose items carry those constraints.
type ScalarSchema = {
  readonly description?: string;
  readonly format?: 'date-time' | 'date';
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
      ?
          | ScalarValue<F['items']['type']>[]
          | ScalarValue<Exclude<Types<F>, 'array'>>
      : never
    : ScalarValue<Types<F>>;

// The record type an `as const` properties schema describes.
export type SchemaRecord<P extends Readonly<Record<string, FieldSchema>>> = {
  -readonly [K in keyof P]: FieldValue<P[K]>;
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
      field.enum.includes(value as string | number)) &&
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
    !(field.format === 'date-time' && !isTimestamp(value)) &&
    !(field.format === 'date' && !isCalendarDate(value))
  );
}

// Every property is required and a record carries exactly those properties, so
// a projection that drops or misspells a field fails here instead of loading.
export function validateRecords(
  stream: Stream,
  records: unknown,
  source: string,
): Record<string, unknown>[] {
  if (!Array.isArray(records))
    throw new TypeError(`${source} returned invalid ${stream.name} records`);
  const fields = Object.entries(
    stream.jsonSchema.properties as Readonly<Record<string, FieldSchema>>,
  );
  for (const [name, field] of fields)
    if (!supported(field))
      throw new TypeError(
        `Stream ${stream.name}.${name} declares an unsupported type`,
      );
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).length !== fields.length
    )
      throw new TypeError(
        `${source} returned an invalid ${stream.name} record`,
      );
    for (const [name, field] of fields) {
      const value: unknown = Reflect.get(record, name);
      const types = typesOf(field);
      if (value === null && types.includes('null')) continue;
      const valid = isArrayField(field)
        ? Array.isArray(value) &&
          value.every((item) =>
            scalarValid(field.items, [field.items.type], item),
          )
        : scalarValid(field, types, value);
      if (!valid)
        throw new TypeError(
          `${source} returned invalid ${stream.name}.${name}`,
        );
    }
  }
  return records;
}
