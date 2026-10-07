import type { SQLOutputValue } from 'node:sqlite';

import { type PlistValue, decodeArchive } from '@workspace/codec-plist';

type Value = SQLOutputValue | undefined;

const appleEpochSeconds = 978_307_200;

export const text = (value: Value) =>
  typeof value === 'string' ? value : undefined;

// knowledgeC, like Biome, writes an absent string as an empty one.
export const optionalText = (value: Value) =>
  typeof value === 'string' && value !== '' ? value : undefined;

export const integer = (value: Value) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

export const flag = (value: Value) =>
  typeof value === 'number' ? value !== 0 : undefined;

// Core Data's seconds since 2001-01-01.
export const appleDate = (value: Value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Date(Math.round((value + appleEpochSeconds) * 1000))
    : undefined;

// An NSKeyedArchiver or plain property list; a root of nil decodes to null.
export const archive = (value: Value): PlistValue | undefined =>
  value instanceof Uint8Array && value.length > 0
    ? decodeArchive(value)
    : undefined;
