import { type PlistValue, plistJSON } from '@workspace/codec-plist';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

export const activityFields = {
  text,
  nullableText,
  integer: { type: 'integer' },
  nullableInteger: { type: ['integer', 'null'] },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  nullableBoolean: { type: ['boolean', 'null'] },
  timestamp: { ...text, format: 'date-time' },
  nullableTimestamp: { ...nullableText, format: 'date-time' },
  bundleId: {
    ...text,
    minLength: 1,
    description: 'Bundle identifier of the app, such as com.apple.Safari.',
  },
} as const;

export const isoTime = (at: Date | undefined) => at?.toISOString() ?? null;

// A decoded archive or property list as JSON text; an archive of nil is
// "null", an absent one NULL.
export const plistText = (value: PlistValue | undefined) =>
  value === undefined ? null : plistJSON(value);

const dayMs = 86_400_000;
// macOS drops a record no sooner than its stream's maximum age: every Biome
// pruning tombstone on record sits 28.000 days or more after a 28-day record.
// An hour inside the age counts every dropped record as expired.
const marginMs = 3_600_000;

// The earliest instant macOS still keeps a stream's records from, for a read
// that started at startedAt.
export const retainedSince = (startedAt: Date, retentionDays: number) =>
  new Date(
    startedAt.getTime() - retentionDays * dayMs + marginMs,
  ).toISOString();
