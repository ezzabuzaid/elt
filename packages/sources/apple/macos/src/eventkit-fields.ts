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
const location = {
  locationTitle: nullableText,
  latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
  longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
  radius: { type: ['number', 'null'], minimum: 0 },
} as const;

// Undescribed primitives shared by Notes, Contacts, Messages, Calendar and
// Reminders.
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
