import { existsSync } from 'node:fs';

import { referenceDateInstant } from '@workspace/codec-apple-reference-date';

export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function requiredText(value: unknown, missing: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(missing);
  return value;
}

export function number(value: unknown): number | null {
  return value === null ? null : Number(value);
}

export function requiredNumber(value: unknown, missing: string): number {
  if (value === null) throw new TypeError(missing);
  return Number(value);
}

export function flag(value: unknown): boolean | null {
  return value === null ? null : Number(value) === 1;
}

export function requiredFlag(value: unknown, missing: string): boolean {
  const read = flag(value);
  if (read === null) throw new TypeError(missing);
  return read;
}

export function bytes(value: unknown): Uint8Array | null {
  if (value === null) return null;
  if (!(value instanceof Uint8Array))
    throw new TypeError('A WhatsApp blob column holds no bytes');
  return value;
}

// Core Data and WhatsApp's own stores keep a date as seconds since
// 2001-01-01 UTC.
export function instant(value: unknown): string | null {
  return value === null ? null : referenceDateInstant(Number(value));
}

// Unix seconds as an instant to the second.
export function unixSecondInstant(
  seconds: number | null | undefined,
): string | null {
  return seconds === undefined || seconds === null
    ? null
    : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// A file path WhatsApp records, when the file is on disk.
export function onDisk(path: string): string | null {
  return existsSync(path) ? path : null;
}
