import { type PlistValue, decodeArchive } from '@workspace/codec-plist';

const appleEpochSeconds = 978_307_200;

const instant = (seconds: number) => new Date(Math.round(seconds * 1000));

const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

// Seconds since 2001-01-01, as most Biome payloads store times.
export const appleDate = (seconds: number | undefined) =>
  finite(seconds) ? instant(seconds + appleEpochSeconds) : undefined;

// Seconds since 1970, as a few Biome payloads store times.
export const unixDate = (seconds: number | undefined) =>
  finite(seconds) ? instant(seconds) : undefined;

// Biome writes an absent string as an empty one.
export const optionalText = (value: string | undefined) =>
  value === '' ? undefined : value;

export const flag = (value: number | undefined) =>
  value === undefined ? undefined : value !== 0;

// An NSKeyedArchiver or plain property list; a root of nil decodes to null.
export const archive = (
  bytes: Uint8Array | undefined,
): PlistValue | undefined =>
  bytes !== undefined && bytes.length > 0 ? decodeArchive(bytes) : undefined;
