import type { SQLOutputValue } from 'node:sqlite';

import type { PlistValue } from '@workspace/source-apple-macos/plist';

export type Row = Record<string, SQLOutputValue>;

const appleEpochSeconds = 978_307_200;

// NSDate's distantPast (year 1) and distantFuture (year 4001), in seconds
// since 2001-01-01; Core Data stores them to mean "none" or "unbounded".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;

// Core Data stores times as seconds since 2001-01-01.
export const coreDataTime = (value: SQLOutputValue | undefined) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > distantPast &&
  value < distantFuture
    ? new Date(Math.round((value + appleEpochSeconds) * 1000)).toISOString()
    : null;

// Property lists mark "never" with distantPast or distantFuture.
export const plistTime = (value: PlistValue | undefined) =>
  value instanceof Date &&
  value.getUTCFullYear() > 1 &&
  value.getUTCFullYear() < 4001
    ? value.toISOString()
    : null;

export const text = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'string' && value !== '' ? value : null;

export const integer = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

export const number = (value: SQLOutputValue | PlistValue | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const flag = (value: SQLOutputValue | PlistValue | undefined) =>
  value === 1 || value === true;

// A Core Data boolean that may be unset: NULL stays NULL.
export const nullableFlag = (value: SQLOutputValue | undefined) =>
  value === null || value === undefined ? null : value === 1;

export const base64 = (value: SQLOutputValue | PlistValue | undefined) =>
  value instanceof Uint8Array && value.length > 0
    ? Buffer.from(value).toString('base64')
    : null;
