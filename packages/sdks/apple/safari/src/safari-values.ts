import type { SQLOutputValue } from 'node:sqlite';

import { type PlistValue, isDictionary } from '@workspace/sdk-apple-plist';

export type Row = Record<string, SQLOutputValue>;
export type Dictionary = Readonly<Record<string, PlistValue>>;

type Stored = SQLOutputValue | PlistValue | undefined;

const appleEpochSeconds = 978_307_200;

// NSDate's distantPast (year 1) and distantFuture (year 4001), in seconds
// since 2001-01-01; Safari stores them to mean "none" or "unbounded".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;

// Safari's databases store times as seconds since 2001-01-01.
export const appleTime = (value: Stored): Date | null =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > distantPast &&
  value < distantFuture
    ? new Date(Math.round((value + appleEpochSeconds) * 1000))
    : null;

// Property lists mark "never" with NSDate's distantPast (year 1) and
// distantFuture (year 4001); neither is a real time.
export const plistTime = (value: PlistValue | undefined): Date | null =>
  value instanceof Date &&
  value.getUTCFullYear() > 1 &&
  value.getUTCFullYear() < 4001
    ? value
    : null;

// Text Safari wrote; an empty string means it wrote none, so a fallback
// key can supply the value.
export const text = (value: Stored): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

// A value Safari stores as written, empty strings included.
export const stored = (value: Stored): string | null =>
  typeof value === 'string' ? value : null;

export const storedNumber = (value: Stored): number | null =>
  typeof value === 'number' ? value : null;

export const integer = (value: Stored): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

export const number = (value: Stored): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const flag = (value: Stored): boolean => value === 1 || value === true;

export const dictionary = (value: PlistValue | undefined): Dictionary =>
  isDictionary(value) ? value : {};

export const list = (value: PlistValue | undefined): readonly PlistValue[] =>
  Array.isArray(value) ? value : [];

export const strings = (value: PlistValue | undefined): string[] =>
  list(value).filter((item) => typeof item === 'string');

// History.db keeps visit counts as little-endian 32-bit integers.
export function counts(value: SQLOutputValue | undefined): number[] | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength % 4 !== 0)
    throw new TypeError('Safari visit counts are not 32-bit integers');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: value.byteLength / 4 }, (_, index) =>
    view.getInt32(index * 4, true),
  );
}
