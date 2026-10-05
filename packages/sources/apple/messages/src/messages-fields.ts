import type { FieldSchema } from '@workspace/elt';
import {
  type ChatColumnKind,
  ChatData,
  type ChatTable,
  type ChatValue,
  type ChatValues,
} from '@workspace/sdk-apple-messages';
import { plistJSON } from '@workspace/sdk-apple-plist';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

const { text, id, nullableText, boolean, nullableTimestamp } = eventKitFields;
const nullableInteger = { type: ['integer', 'null'] } as const;

// How each kind of chat.db column loads: its schema and what a reader gets,
// as encode() produces it. Flags are Messages' 0/1 integers, which all
// default to 0.
const kinds = {
  text: { schema: text, loads: 'text' },
  nullableText: {
    schema: nullableText,
    loads: 'text; NULL when chat.db stores NULL',
  },
  integer: {
    schema: nullableInteger,
    loads: 'integer passed through unchanged; NULL when chat.db stores NULL',
  },
  flag: {
    schema: boolean,
    loads: '0/1 flag loaded as a boolean; any nonzero value is true',
  },
  time: {
    schema: nullableTimestamp,
    loads:
      'nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant truncated to milliseconds; NULL when chat.db stores 0 or NULL',
  },
  data: {
    schema: nullableText,
    loads:
      'bytes; a binary property list loads as JSON text, with NSKeyedArchiver archives unarchived, nested data as Base64, dates as ISO 8601 and integers beyond 2^53 as strings, and any other bytes load as Base64; NULL when chat.db stores NULL',
  },
} as const satisfies Record<
  ChatColumnKind,
  { readonly schema: FieldSchema; readonly loads: string }
>;

export const unverified = 'Meaning not documented by Apple.';

// Every stream's source and its limits.
export const localStore =
  "Read from this Mac's chat.db, not from iCloud: it holds only what Messages keeps locally, and an import scope recorded in extraction coverage can narrow it further. Relationships use GUIDs, which survive the renumbering of local ROWIDs when Messages in iCloud rebuilds chat.db, and name source streams, not destination tables.";

export const countAtMessageGrain =
  'Many-to-many: joining messages through this stream repeats a message once per linked row, so count messages at message grain, as distinct messageGuid.';

export const chatGuid: FieldSchema = {
  ...id,
  description:
    'chat.db chat.guid of the chat; refers to chats.guid within this source.',
};

export const messageGuid: FieldSchema = {
  ...id,
  description:
    'chat.db message.guid of the message; refers to messages.guid within this source.',
};

const camel = (column: string) =>
  column.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function kindOf(table: ChatTable, column: string): ChatColumnKind {
  const kind = table.columns[column];
  if (kind === undefined)
    throw new TypeError(`chat.db ${table.name} has no column ${column}`);
  return kind;
}

// Where a field comes from: its chat.db column and how that column loads.
export const provenance = (table: ChatTable, column: string) =>
  `chat.db ${table.name}.${column}: ${kinds[kindOf(table, column)].loads}.`;

// One chat.db column as a field, described by its provenance.
export function columnField(table: ChatTable, column: string): FieldSchema {
  return {
    ...kinds[kindOf(table, column)].schema,
    description: `${provenance(table, column)} ${unverified}`,
  };
}

// A table's columns as fields named in camelCase, in the order they load.
// meanings replaces the generated description of a column whose meaning the
// code proves.
export function tableFields(
  table: ChatTable,
  meanings: Readonly<Record<string, string>> = {},
): Record<string, FieldSchema> {
  const columns = Object.keys(table.columns);
  const unknown = Object.keys(meanings).filter(
    (column) => !columns.includes(column),
  );
  if (unknown.length > 0)
    throw new TypeError(
      `Meanings for columns ${table.name} does not list: ${unknown.join(', ')}`,
    );
  return Object.fromEntries(
    columns.map((column) => {
      const field = columnField(table, column);
      const meaning = meanings[column];
      return [
        camel(column),
        meaning === undefined ? field : { ...field, description: meaning },
      ];
    }),
  );
}

// A chat.db value as a record holds it: an instant as ISO 8601, an archived
// property list as JSON text, any other bytes as Base64.
export function encode(value: ChatValue): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ChatData)
    return value.archived
      ? plistJSON(value.archive())
      : Buffer.from(value.bytes).toString('base64');
  return value;
}

// A table's values as record fields, named as tableFields names them.
export function tableRecord(
  table: ChatTable,
  values: ChatValues,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(table.columns).map((column) => [
      camel(column),
      encode(values[column] ?? null),
    ]),
  );
}
