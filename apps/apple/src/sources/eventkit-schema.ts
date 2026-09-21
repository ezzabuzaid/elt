import { Catalog, Stream } from 'elt';

export type Field = {
  readonly type: string | readonly string[];
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly enum?: readonly (string | number)[];
};

const text = { type: 'string' } as const;
const id = { ...text, minLength: 1 };
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const ordinal = { ...integer, minimum: 0 };
const boolean = { type: 'boolean' } as const;
const number = { type: 'number' } as const;
const timestamp = { ...text, format: 'date-time' };
const nullableTimestamp = { ...nullableText, format: 'date-time' };
const nullableDate = { ...nullableText, format: 'date' };
const color = { type: ['number', 'null'], minimum: 0, maximum: 1 } as const;
const location = {
  locationTitle: nullableText,
  latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
  longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
  radius: { type: ['number', 'null'], minimum: 0 },
} as const;

export const eventKitFields = {
  text,
  id,
  nullableText,
  integer,
  ordinal,
  boolean,
  number,
  timestamp,
  nullableTimestamp,
  nullableDate,
  location,
};

export const eventKitAccountFields = {
  id,
  name: text,
  type: ordinal,
  isDelegate: boolean,
};

export const eventKitCalendarFields = {
  id,
  accountId: id,
  name: text,
  type: ordinal,
  writable: boolean,
  subscribed: boolean,
  immutable: boolean,
  colorRed: color,
  colorGreen: color,
  colorBlue: color,
  colorAlpha: color,
  supportedAvailabilities: ordinal,
  allowedEntityTypes: ordinal,
};

export function eventKitRelatedFields(ownerKey: 'eventId' | 'reminderId') {
  return {
    attendees: {
      id,
      [ownerKey]: id,
      position: ordinal,
      kind: text,
      name: nullableText,
      url: nullableText,
      status: ordinal,
      role: ordinal,
      type: ordinal,
      isCurrentUser: boolean,
    },
    alarms: {
      id,
      [ownerKey]: id,
      position: ordinal,
      type: ordinal,
      relativeOffset: number,
      absoluteAt: nullableTimestamp,
      emailAddress: nullableText,
      soundName: nullableText,
      proximity: ordinal,
      ...location,
    },
    recurrenceRules: {
      id,
      [ownerKey]: id,
      position: ordinal,
      calendarIdentifier: text,
      frequency: ordinal,
      interval: { ...integer, minimum: 1 },
      firstDayOfWeek: { ...integer, minimum: 0, maximum: 7 },
      endAt: nullableTimestamp,
      occurrenceCount: ordinal,
    },
    recurrenceRuleValues: {
      id,
      [ownerKey]: id,
      ruleId: id,
      component: text,
      position: ordinal,
      value: integer,
      weekNumber: { type: ['integer', 'null'] },
    },
  } satisfies Record<string, Record<string, Field>>;
}

export function eventKitCatalog(
  properties: Record<string, Record<string, Field>>,
): Catalog {
  return new Catalog(
    Object.entries(properties).map(
      ([name, fields]) =>
        new Stream({
          name,
          jsonSchema: {
            type: 'object',
            properties: fields,
            required: Object.keys(fields),
          },
          primaryKey: ['id'],
          supportedSyncModes: ['full_refresh'],
        }),
    ),
  );
}

export function validateEventKitRecords(
  stream: Stream,
  records: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(records))
    throw new TypeError(`EventKit returned invalid ${stream.name} records`);
  const fields = stream.jsonSchema.properties as Record<string, Field>;
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).length !== Object.keys(fields).length
    )
      throw new TypeError(`EventKit returned an invalid ${stream.name} record`);
    for (const [name, field] of Object.entries(fields)) {
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
        (field.format === 'date' &&
          (typeof value !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !isTimestamp(`${value}T00:00:00.000Z`)))
      )
        throw new TypeError(`EventKit returned invalid ${stream.name}.${name}`);
    }
  }
  return records;
}

export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
