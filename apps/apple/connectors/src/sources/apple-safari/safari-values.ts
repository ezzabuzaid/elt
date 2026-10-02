import type { SQLOutputValue } from 'node:sqlite';

import { type PlistValue, isDictionary } from '../../platform/macos/plist.ts';

export type Row = Record<string, SQLOutputValue>;
export type Dictionary = Readonly<Record<string, PlistValue>>;

// The only profile every Safari has; its history lives in History.db.
export const defaultProfile = 'DefaultProfile';

const appleEpochSeconds = 978_307_200;

// NSDate's distantPast (year 1) and distantFuture (year 4001), in seconds
// since 2001-01-01; Safari stores them to mean "none" or "unbounded".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;

// Safari's databases store times as seconds since 2001-01-01.
export const appleTime = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > distantPast &&
  value < distantFuture
    ? new Date(Math.round((value + appleEpochSeconds) * 1000)).toISOString()
    : null;

// Property lists mark "never" with NSDate's distantPast (year 1) and
// distantFuture (year 4001); neither is a real time.
export const plistTime = (value: PlistValue | undefined) =>
  value instanceof Date &&
  value.getUTCFullYear() > 1 &&
  value.getUTCFullYear() < 4001
    ? value.toISOString()
    : null;

export const base64 = (value: SQLOutputValue | PlistValue | undefined) =>
  value instanceof Uint8Array ? Buffer.from(value).toString('base64') : null;

export const text = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'string' && value !== '' ? value : null;

export const integer = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

export const number = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const flag = (value: SQLOutputValue | PlistValue | undefined) =>
  value === 1 || value === true;

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
