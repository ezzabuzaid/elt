import type { FieldSchema } from '@workspace/elt';
import {
  type CalendarDate,
  type ContactsAttributeKind,
  ContactsData,
  type ContactsValue,
  type ContactsValues,
  type ContactsView,
} from '@workspace/sdk-apple-contacts';
import { plistJSON } from '@workspace/sdk-apple-plist';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

const { text, nullableText, nullableTimestamp } = eventKitFields;
export const nullableInteger = { type: ['integer', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const nullableBoolean = { type: ['boolean', 'null'] } as const;

type ValueKind = Exclude<ContactsAttributeKind, 'calendarDate'>;

// Data loads as JSON when it is a property list and as base64 otherwise; a
// record reference loads as that record's uniqueId, the CNContact, CNGroup or
// CNContainer identifier.
const schemas = {
  text: nullableText,
  integer: nullableInteger,
  boolean: nullableBoolean,
  number: nullableNumber,
  time: nullableTimestamp,
  data: nullableText,
  record: nullableText,
} as const satisfies Record<ValueKind, FieldSchema>;

// How each kind's value reaches the record, as encode() writes it.
const conversions = {
  text: 'as stored',
  integer: 'as stored',
  number: 'as stored',
  boolean: 'with 0 read as false and any other stored value as true',
  time: 'Core Data seconds since 2001-01-01 converted to a UTC instant with millisecond precision',
  data: 'a binary property list as JSON (keyed archives unarchived, nested bytes as Base64), other bytes as Base64',
  record: "a ZABCDRECORD reference resolved to that record's ZUNIQUEID",
} as const satisfies Record<ValueKind, string>;

export const unverified =
  'Meaning not verified: Apple does not document this store.';

// Every stream reads the same local stores, so every description ends with it.
export const localStores =
  "Read from this Mac's Contacts stores, On My Mac and one per account under AddressBook/Sources, so it holds what has synced to this Mac rather than a complete cloud account; a configured container selection limits it further. Relationships name source streams, not destination tables, and identifiers name native records, not people merged across stores.";

// The description of a field that only passes a native column through.
function provenance(kind: ValueKind, table: string, column: string): string {
  const absent =
    kind === 'record'
      ? 'NULL when unset or no record matches'
      : 'NULL when the store holds no value';
  return `AddressBook ${table}.${column}, ${conversions[kind]}; ${absent}. ${unverified}`;
}

// How a stream names a view's attributes: renames for attributes it calls
// otherwise, and the year, month and day fields of each calendar date.
export type Naming = {
  readonly renames?: Readonly<Record<string, string>>;
  readonly dates?: Readonly<
    Record<string, readonly [year: string, month: string, day: string]>
  >;
};

function checked(view: ContactsView, naming: Naming): Naming {
  const unknown = [
    ...Object.keys(naming.renames ?? {}),
    ...Object.keys(naming.dates ?? {}),
  ].filter((name) => !Object.hasOwn(view.attributes, name));
  if (unknown.length > 0)
    throw new TypeError(
      `Contacts ${view.table} has no attributes ${unknown.join(', ')}`,
    );
  return naming;
}

function dateNames(
  naming: Naming,
  name: string,
): readonly [string, string, string] {
  const names = naming.dates?.[name];
  if (names === undefined)
    throw new TypeError(`Contacts names no fields for date ${name}`);
  return names;
}

// A view's attributes as fields, in the view's order, each described by
// where it comes from.
export function attributeFields(
  view: ContactsView,
  naming: Naming = {},
): Record<string, FieldSchema> {
  checked(view, naming);
  const fields: Record<string, FieldSchema> = {};
  for (const [name, { column, kind }] of Object.entries(view.attributes)) {
    if (kind !== 'calendarDate') {
      fields[naming.renames?.[name] ?? name] = {
        ...schemas[kind],
        description: provenance(kind, view.table, column),
      };
      continue;
    }
    // Contacts stores a birthday or date as noon UTC of the day, in year
    // 1604 when the year is unknown.
    const [year, month, day] = dateNames(naming, name);
    const read = `of the date in AddressBook ${view.table}.${column}, Core Data seconds since 2001-01-01 read as a Gregorian UTC date`;
    fields[year] = {
      ...nullableInteger,
      description: `Year ${read}; NULL when no date is stored or its year is 1604, the year Contacts stores for a date without a year.`,
    };
    fields[month] = {
      ...nullableInteger,
      description: `Month (1-12) ${read}; NULL when no date is stored.`,
    };
    fields[day] = {
      ...nullableInteger,
      description: `Day of the month ${read}; NULL when no date is stored.`,
    };
  }
  return fields;
}

// Hand-written meanings replace provenance where the code proves more; a name
// the fields lack is a typo that would otherwise ship the wrong text.
export function explained(
  fields: Record<string, FieldSchema>,
  meanings: Readonly<Record<string, string>>,
): Record<string, FieldSchema> {
  const described = { ...fields };
  for (const [name, description] of Object.entries(meanings)) {
    const field = fields[name];
    if (field === undefined)
      throw new TypeError(`Contacts has no field ${name} to describe`);
    described[name] = { ...field, description };
  }
  return described;
}

// The Core Data entity of a record as a kind field, with the names a stream
// gives each entity.
export function entityKind(kinds: Readonly<Record<string, string>>) {
  const meanings = Object.entries(kinds)
    .map(([entity, kind]) => `${kind} for ${entity}`)
    .join(', ');
  return {
    ...text,
    enum: Object.values(kinds),
    description: `Core Data entity of this record, from Z_PRIMARYKEY.Z_NAME: ${meanings}. Apple does not document how these entities differ.`,
  };
}

const isCalendarDate = (value: ContactsValue): value is CalendarDate =>
  value !== null &&
  typeof value === 'object' &&
  !(value instanceof Date) &&
  !(value instanceof ContactsData);

// A store value as a record holds it: an instant as ISO 8601, a property list
// as JSON text, any other bytes as Base64.
export function encode(value: ContactsValue): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ContactsData)
    return value.archived
      ? plistJSON(value.archive())
      : Buffer.from(value.bytes).toString('base64');
  return value;
}

// A row's attribute values as record fields, named as attributeFields names
// them.
export function attributeRecord(
  view: ContactsView,
  values: ContactsValues,
  naming: Naming = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, { kind }] of Object.entries(view.attributes)) {
    const value = values[name] ?? null;
    if (kind !== 'calendarDate') {
      record[naming.renames?.[name] ?? name] = encode(value);
      continue;
    }
    const [year, month, day] = dateNames(naming, name);
    const date = isCalendarDate(value) ? value : null;
    record[year] = date?.year ?? null;
    record[month] = date?.month ?? null;
    record[day] = date?.day ?? null;
  }
  return record;
}
