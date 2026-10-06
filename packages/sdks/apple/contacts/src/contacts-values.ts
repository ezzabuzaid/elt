import { join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';

import {
  type PlistValue,
  decodeArchive,
  isBinaryPlist,
} from '@workspace/sdk-apple-plist';

import type { ContactsAttributeKind } from './contacts-tables.ts';

// Bytes from the store, decoded only when asked: many are property lists, and
// a row the reader skips is never decoded.
export class ContactsData {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get archived(): boolean {
    return isBinaryPlist(this.bytes);
  }

  archive(): PlistValue {
    return decodeArchive(this.bytes);
  }
}

// A date Contacts stores at noon UTC, read as Gregorian UTC parts; year is
// null for a date stored without one, in 1604.
export type CalendarDate = {
  readonly year: number | null;
  readonly month: number | null;
  readonly day: number | null;
};

export type ContactsValue =
  string | number | boolean | Date | ContactsData | CalendarDate | null;

// A row's attributes by their Core Data names.
export type ContactsValues = Readonly<Record<string, ContactsValue>>;

// One stored attribute value as its kind reads: a flag as a boolean, a time
// as a Date from SQLite's own conversion, bytes as data whatever the kind,
// anything else as stored.
export function attributeValue(
  kind: Exclude<ContactsAttributeKind, 'calendarDate'>,
  stored: SQLOutputValue | undefined,
): ContactsValue {
  if (stored === undefined || stored === null) return null;
  if (kind === 'boolean') return stored !== 0;
  if (stored instanceof Uint8Array) return new ContactsData(stored);
  if (kind === 'time') return new Date(String(stored));
  return typeof stored === 'bigint' ? Number(stored) : stored;
}

// A value of a Core Data attribute that allows external storage: 0x01 and
// the bytes, or 0x02 and the NUL-terminated UUID of a file in _EXTERNAL_DATA.
export type StoredData =
  | { readonly storage: 'inline'; readonly bytes: Uint8Array }
  | {
      readonly storage: 'external';
      readonly id: string;
      readonly path: string;
    };

export function storedData(
  path: string,
  directory: string,
  value: Uint8Array,
): StoredData {
  if (value[0] === 1) return { storage: 'inline', bytes: value.subarray(1) };
  if (value[0] === 2) {
    const end = value.indexOf(0, 1);
    const id = Buffer.from(
      value.subarray(1, end === -1 ? value.length : end),
    ).toString('ascii');
    return {
      storage: 'external',
      id,
      path: join(directory, '.AddressBook-v22_SUPPORT/_EXTERNAL_DATA', id),
    };
  }
  throw new TypeError(
    `Contacts store ${path} holds data in an unknown encoding (first byte ${value[0]})`,
  );
}
