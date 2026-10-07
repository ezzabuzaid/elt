import { type PlistValue, isDictionary } from '@workspace/codec-plist';

import { MailSchemaError } from './errors.ts';

// The shapes Mail's property lists hold, checked where they are read.

export function plistObject(value: PlistValue): Record<string, PlistValue> {
  if (!isDictionary(value))
    throw new MailSchemaError('Mail returned a non-dictionary property list');
  return value;
}

export function plistList(value: PlistValue): PlistValue[] {
  if (!Array.isArray(value))
    throw new MailSchemaError('Mail configuration is not a list');
  return value;
}

export function requiredString(
  object: Record<string, PlistValue>,
  key: string,
): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '')
    throw new MailSchemaError(`Mail configuration has no ${key}`);
  return value;
}
