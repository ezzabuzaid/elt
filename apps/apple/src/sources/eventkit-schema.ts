import { Catalog, type FieldSchema, Stream } from 'elt';

const text = { type: 'string' } as const;
const id = { ...text, minLength: 1 };
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const ordinal = { ...integer, minimum: 0 };
const boolean = { type: 'boolean' } as const;
const number = { type: 'number' } as const;
const timestamp = { ...text, format: 'date-time' } as const;
const nullableTimestamp = { ...nullableText, format: 'date-time' } as const;
const nullableDate = { ...nullableText, format: 'date' } as const;
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
  } satisfies Record<string, Record<string, FieldSchema>>;
}

export function eventKitCatalog(
  properties: Record<string, Record<string, FieldSchema>>,
  // Snapshot streams load incrementally by diffing full scans (elt diffSnapshot).
  { snapshot = false }: { snapshot?: boolean } = {},
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
          supportedSyncModes: snapshot
            ? ['full_refresh', 'incremental']
            : ['full_refresh'],
          ...(snapshot && {
            sourceDefinedCursor: true,
            emitsDeletes: true,
          }),
        }),
    ),
  );
}
