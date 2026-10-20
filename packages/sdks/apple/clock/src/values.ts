import { referenceDateInstant } from '@workspace/codec-apple-reference-date';
import {
  PlistDate,
  type PlistValue,
  decodeArchive,
  isDictionary,
  parseBinaryPlist,
  plistJSON,
} from '@workspace/codec-plist';

export function dictionary(value: unknown): { [key: string]: PlistValue } {
  if (!isDictionary(value))
    throw new TypeError('Clock expected a property-list dictionary');
  return value;
}
export function array(value: unknown): PlistValue[] {
  if (!Array.isArray(value))
    throw new TypeError('Clock expected a property-list array');
  return value;
}
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError('Clock expected text');
  return value;
}
export function requiredText(value: unknown): string {
  const result = text(value);
  if (!result) throw new TypeError('Clock record has no identifier');
  return result;
}
export function number(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('Clock expected a finite number');
  return value;
}
export function flag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new TypeError('Clock expected a boolean');
}
export function instant(value: unknown): string | null {
  const seconds = number(value);
  return seconds === null ? null : referenceDateInstant(seconds);
}
export function uuid(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new TypeError('Clock UUID is not 16 bytes');
  const hex = Buffer.from(value).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function bytes(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Uint8Array))
    throw new TypeError('Clock expected binary data');
  return Buffer.from(value).toString('base64');
}
export function timerTime(value: unknown): {
  fireAt: string | null;
  remainingSeconds: number | null;
  fireTime: string | null;
} {
  if (value === null)
    return { fireAt: null, remainingSeconds: null, fireTime: null };
  if (!(value instanceof Uint8Array))
    throw new TypeError('Clock timer fire time is not an archive');
  const decoded = dictionary(decodeArchive(value));
  let fireAt: string | null = null;
  let remainingSeconds: number | null = null;
  if (decoded.$class === 'MTTimerDate') {
    if (!(decoded.MTTimerTimeDate instanceof PlistDate))
      throw new TypeError('Clock timer date archive has no date');
    fireAt = instant(decoded.MTTimerTimeDate.referenceSeconds);
  } else if (decoded.$class === 'MTTimerTimeInterval') {
    remainingSeconds = number(decoded.MTTimerTimeInterval);
  } else
    throw new TypeError(
      `Unknown Clock timer fire-time class ${text(decoded.$class)}`,
    );
  return {
    fireAt,
    remainingSeconds,
    fireTime: plistJSON(parseBinaryPlist(value)),
  };
}
