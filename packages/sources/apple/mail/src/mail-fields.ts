import type { FieldSchema } from '@workspace/elt';
import type {
  MailColumnKind,
  MailStoredValue,
  MailTable,
} from '@workspace/sdk-apple-mail';
import type { PlistValue } from '@workspace/sdk-apple-plist';

// How each kind of index column loads: its field type, the suffix its field
// name takes, and what a reader gets. Only confirmed Unix dates convert;
// unprobed native dates keep their raw numbers, with a Raw suffix, instead of
// guessing their epoch or sentinel values.
const kinds = {
  id: {
    scalar: 'string',
    suffix: '',
    loads: 'an integer loaded as decimal text to keep 64-bit precision',
  },
  text: { scalar: 'string', suffix: '', loads: 'text as stored' },
  number: { scalar: 'number', suffix: '', loads: 'number as stored' },
  undatedNumber: {
    scalar: 'number',
    suffix: 'Raw',
    loads:
      'raw number as stored; its date epoch is unverified, so it is not converted',
  },
  time: {
    scalar: 'string',
    suffix: '',
    loads:
      'Unix seconds converted to a UTC timestamp with millisecond precision',
  },
  bytes: {
    scalar: 'string',
    suffix: 'Base64',
    loads:
      'BLOB bytes encoded as Base64; a stored text value passes through unchanged',
  },
} as const satisfies Record<
  MailColumnKind,
  {
    readonly scalar: 'string' | 'number';
    readonly suffix: string;
    readonly loads: string;
  }
>;

// Apple documents none of the Envelope Index. Every column states where its
// value comes from and how it loads; only a meaning proven by the captured
// schema or this source's own joins replaces the unknown one.
export const undocumented = 'Meaning not documented by Apple.';

// What the code proves a table's columns mean, by index column.
export type Meanings<T extends MailTable> = {
  readonly [Column in keyof T['columns']]?: string;
};

export const fieldName = (column: string, kind: MailColumnKind) =>
  (column === 'ROWID'
    ? 'id'
    : column.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      )) + kinds[kind].suffix;

function provenance(
  table: MailTable,
  column: string,
  kind: MailColumnKind,
  key: boolean,
) {
  const value =
    column === 'ROWID'
      ? 'the local row identifier, loaded as decimal text'
      : kinds[kind].loads;
  return `Envelope Index ${table.name}.${column}, ${value}${key ? '' : '; NULL when the index stores no value'}.`;
}

// A table's columns as fields, in the index's column order.
export function tableProperties<T extends MailTable>(
  table: T,
  meanings: Meanings<T>,
): Record<string, FieldSchema> {
  const meaning: Readonly<Record<string, string | undefined>> = meanings;
  const properties: Record<string, FieldSchema> = {};
  for (const [column, kind] of Object.entries(table.columns)) {
    const key = table.keys.includes(column);
    const { scalar } = kinds[kind];
    const type = scalar === 'number' && key ? 'integer' : scalar;
    properties[fieldName(column, kind)] = {
      type: key ? type : [type, 'null'],
      ...(kind === 'time' ? { format: 'date-time' as const } : {}),
      description: `${provenance(table, column, kind, key)} ${meaning[column] ?? undocumented}`,
    };
  }
  return properties;
}

// A value as a record holds it: bytes as Base64, a time as ISO 8601, and
// anything else as stored, which validation rejects when its kind's type
// does not match.
function encode(
  kind: MailColumnKind,
  value: MailStoredValue | Date | undefined,
): unknown {
  if (kind === 'bytes' && value instanceof Uint8Array)
    return Buffer.from(value).toString('base64');
  if (kind === 'time' && value instanceof Date) return value.toISOString();
  return value;
}

// A table's row as a record, named as tableProperties names its fields.
export function tableRecord(
  table: MailTable,
  row: Readonly<Record<string, MailStoredValue | Date>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(table.columns).map(([column, kind]) => [
      fieldName(column, kind),
      encode(kind, row[column]),
    ]),
  );
}

// A property list as JSON text: data as Base64, big integers as decimal
// strings, dates as ISO 8601 and archiver UIDs as {"value":N}.
export function plistJSON(value: PlistValue): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item).toString('base64');
    return item;
  });
}

// Each stream describes every field for readers; the mapped type makes a
// missing description a compile error.
export function described<
  const Fields extends Readonly<Record<string, FieldSchema>>,
>(
  fields: Fields,
  descriptions: { readonly [Name in keyof Fields]: string },
): Record<string, FieldSchema> {
  const meaning: Readonly<Record<string, string>> = descriptions;
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      { ...field, description: meaning[name] },
    ]),
  );
}

export const text = { type: 'string' } as const;
export const nullableText = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const flag = { type: 'boolean' } as const;

export const partFields = {
  messageId: text,
  partId: text,
  parentPartId: nullableText,
  contentType: nullableText,
  charset: nullableText,
  transferEncoding: nullableText,
  disposition: nullableText,
  filename: nullableText,
  contentId: nullableText,
  isMultipart: flag,
  isAttachment: flag,
  declaredBytes: nullableNumber,
  decodedBytes: nullableNumber,
  availableLocally: flag,
  sha256: nullableText,
} as const;
export const metadata = { id: text, properties: text } as const;
export const scopedMetadata = { scope: text, ...metadata } as const;
export const conditionFields = {
  scope: text,
  ownerId: text,
  position: { type: 'integer' },
  properties: text,
} as const;
export const headersFields = {
  messageId: text,
  partId: text,
  position: { type: 'integer' },
  name: text,
  value: text,
  rawLineBase64: text,
} as const;
export const fileFields = {
  messageId: text,
  relativePath: nullableText,
  availableLocally: flag,
  partial: { type: ['boolean', 'null'] },
  size: nullableNumber,
  sha256: nullableText,
} as const;
export const plistFields = { relativePath: text, properties: text } as const;

export const plistProperties =
  'The property list converted to JSON: data values become Base64 strings, dates ISO 8601 strings and integers beyond 2^53 decimal strings. Kept as data; this source does not interpret its keys.';
export const localMessageId =
  'Refers to messages.id within this source (the local id, not the Message-ID hash in messages.messageId).';
export const partId =
  'Dotted MIME part number, such as 1 or 1.2. The root of a multipart message is TEXT; a single-part message is 1, as in the index. Equals indexedAttachments.attachmentId for attachments Mail indexes.';
export const sha256 = 'SHA-256 of the bytes as lowercase hexadecimal';
