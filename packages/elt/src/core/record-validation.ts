import { isCalendarDate, isTimestamp } from './formats.ts';
import type { Stream } from './stream.ts';

// The JSON Schema subset stream properties use: scalar types, optionally
// nullable, with enum, range, length and date formats.
export type FieldSchema = {
  readonly type: ScalarType | readonly ScalarType[];
  readonly format?: 'date-time' | 'date';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly enum?: readonly (string | number)[];
};

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

// The record type an `as const` properties schema describes.
export type SchemaRecord<P extends Readonly<Record<string, FieldSchema>>> = {
  -readonly [K in keyof P]: P[K]['type'] extends readonly (infer T)[]
    ? ScalarValue<T>
    : ScalarValue<P[K]['type']>;
};

const scalarTypes = new Set(['string', 'integer', 'number', 'boolean', 'null']);

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
  for (const [name, field] of fields) {
    const types = typeof field.type === 'string' ? [field.type] : field.type;
    if (!types.every((type) => scalarTypes.has(type)))
      throw new TypeError(
        `Stream ${stream.name}.${name} declares an unsupported type`,
      );
  }
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
      const types = typeof field.type === 'string' ? [field.type] : field.type;
      if (value === null && types.includes('null')) continue;
      const valid = types.some((type) =>
        type === 'integer'
          ? Number.isSafeInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : (type === 'string' || type === 'boolean') &&
              typeof value === type,
      );
      if (
        !valid ||
        (field.enum !== undefined &&
          !field.enum.includes(value as string | number)) ||
        (typeof value === 'number' &&
          ((field.minimum !== undefined && value < field.minimum) ||
            (field.maximum !== undefined && value > field.maximum))) ||
        (typeof value === 'string' &&
          field.minLength !== undefined &&
          value.length < field.minLength) ||
        (field.format === 'date-time' && !isTimestamp(value)) ||
        (field.format === 'date' && !isCalendarDate(value))
      )
        throw new TypeError(
          `${source} returned invalid ${stream.name}.${name}`,
        );
    }
  }
  return records;
}
