import type { SQLOutputValue } from 'node:sqlite';

import { decodeArchive, plistJSON } from '@workspace/sdk-apple-plist';

export type Row = Record<string, SQLOutputValue>;

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

const appleEpochSeconds = 978_307_200;

const instant = (seconds: number) =>
  new Date(Math.round(seconds * 1000)).toISOString();

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// Seconds since 2001-01-01, as Core Data and most Biome payloads store times.
export const appleTime = (value: unknown) =>
  finite(value) ? instant(value + appleEpochSeconds) : null;

// Seconds since 1970, as a few Biome payloads store times.
export const unixTime = (value: unknown) =>
  finite(value) ? instant(value) : null;

// Biome writes absent strings as empty ones.
export const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : null;

export const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

// A protobuf or SQLite boolean; absent stays null.
export const flag = (value: unknown) =>
  typeof value === 'number' ? value !== 0 : null;

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

// An NSKeyedArchiver or plain property list, as JSON text.
export const archiveJSON = (value: unknown) =>
  value instanceof Uint8Array && value.length > 0
    ? plistJSON(decodeArchive(value))
    : null;
