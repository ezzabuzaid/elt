import type { SQLOutputValue } from 'node:sqlite';

import { type PlistValue, isDictionary } from '@workspace/codec-plist';

export type Row = Record<string, SQLOutputValue>;
type Dictionary = Readonly<Record<string, PlistValue>>;

type Stored = SQLOutputValue | PlistValue | undefined;

const appleEpochSeconds = 978_307_200;

// NSDate's distantPast (year 1) and distantFuture (year 4001), in seconds
// since 2001-01-01; Core Data stores them to mean "none" or "unbounded".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;

// Core Data stores times as seconds since 2001-01-01.
export const coreDataTime = (value: SQLOutputValue | undefined): Date | null =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > distantPast &&
  value < distantFuture
    ? new Date(Math.round((value + appleEpochSeconds) * 1000))
    : null;

// Property lists mark "never" with distantPast or distantFuture.
export const plistTime = (value: PlistValue | undefined): Date | null =>
  value instanceof Date &&
  value.getUTCFullYear() > 1 &&
  value.getUTCFullYear() < 4001
    ? value
    : null;

// Text Books wrote; an empty string means it wrote none.
export const text = (value: Stored): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

// A value Books stores as written, empty strings included.
export const stored = (value: Stored): string | null =>
  typeof value === 'string' ? value : null;

export const integer = (value: Stored): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

export const number = (value: Stored): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const flag = (value: Stored): boolean => value === 1 || value === true;

// A Core Data boolean that may be unset: NULL stays NULL.
export const nullableFlag = (value: SQLOutputValue | undefined) =>
  value === null || value === undefined ? null : value === 1;

// Bytes Books stored; an empty value means none.
export const bytes = (value: SQLOutputValue | undefined): Uint8Array | null =>
  value instanceof Uint8Array && value.length > 0 ? value : null;

export const dictionary = (value: PlistValue | undefined): Dictionary =>
  isDictionary(value) ? value : {};
