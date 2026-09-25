import { type FieldSchema, Stream } from 'elt';
import {
  decodeArchive,
  isBinaryPlist,
  type PlistValue,
  plistJSON,
} from '../../platform/macos/plist.ts';
import { eventKitFields } from '../eventkit-schema.ts';
import { attributedText } from './typedstream.ts';

const { text, id, nullableText, boolean, nullableTimestamp } = eventKitFields;
const nullableInteger = { type: ['integer', 'null'] } as const;

// Messages stores times since 2001-01-01 UTC, in nanoseconds since macOS 10.13
// and in seconds before it and in attachment dates. Converted in SQL, because
// nanoseconds exceed 2^53 and node:sqlite refuses to read them.
const appleMilliseconds = (column: string) =>
  `CASE WHEN ${column} IS NULL OR ${column} = 0 THEN NULL WHEN abs(${column}) > 100000000000 THEN ${column} / 1000000 ELSE ${column} * 1000 END`;

const camel = (column: string) =>
  column.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const words = (list = '') => list.split(/\s+/).filter(Boolean);

// A table's columns grouped by how they load. Booleans are Messages' 0/1
// flags, which all default to 0; archived Foundation objects load as base64.
type Columns = {
  readonly text?: string;
  readonly nullableText?: string;
  readonly integer?: string;
  readonly boolean?: string;
  readonly timestamp?: string;
  readonly base64?: string;
};

function columns(alias: string, kinds: Columns) {
  const loaders: [keyof Columns, FieldSchema, (column: string) => string][] = [
    ['text', text, (column) => column],
    ['nullableText', nullableText, (column) => column],
    ['integer', nullableInteger, (column) => column],
    ['boolean', boolean, (column) => column],
    ['timestamp', nullableTimestamp, appleMilliseconds],
    ['base64', nullableText, (column) => column],
  ];
  const properties: Record<string, FieldSchema> = {};
  const select: string[] = [];
  for (const [kind, schema, expression] of loaders)
    for (const column of words(kinds[kind])) {
      properties[camel(column)] = schema;
      select.push(`${expression(`${alias}.${column}`)} AS "${camel(column)}"`);
    }
  return { properties, select };
}

type Definition = {
  readonly properties: Record<string, FieldSchema>;
  readonly primaryKey: readonly string[];
  readonly sql: string;
  readonly files?: true;
  // A stream decoded from archived values: each SQL row becomes 0..n records.
  readonly expand?: (row: Record<string, unknown>) => Record<string, unknown>[];
};

function definition(
  keys: Record<string, [FieldSchema, string]>,
  from: string,
  table: ReturnType<typeof columns> = { properties: {}, select: [] },
  extra: Record<string, FieldSchema> = {},
): Omit<Definition, 'primaryKey' | 'files'> {
  return {
    properties: {
      ...Object.fromEntries(
        Object.entries(keys).map(([name, [schema]]) => [name, schema]),
      ),
      ...table.properties,
      ...extra,
    },
    sql: `SELECT ${[
      ...Object.entries(keys).map(([name, [, sql]]) => `${sql} AS "${name}"`),
      ...table.select,
    ].join(', ')} FROM ${from}`,
  };
}

const message = columns('m', {
  nullableText:
    'text subject service_center country service account account_guid cache_roomnames group_title associated_message_guid balloon_bundle_id expressive_send_style_id ck_record_id ck_record_change_tag destination_caller_id reply_to_guid thread_originator_guid thread_originator_part syndication_ranges synced_syndication_ranges bia_reference_id fallback_hash associated_message_emoji ck_chat_id',
  integer:
    'replace version type error item_type group_action_type share_status share_direction expire_state message_action_type message_source associated_message_type associated_message_range_location associated_message_range_length ck_sync_state sort_id part_count schedule_type schedule_state index_state',
  boolean:
    'is_delivered is_finished is_emote is_from_me is_empty is_delayed is_auto_reply is_prepared is_read is_system_message is_sent has_dd_results is_service_message is_forward was_downgraded is_archive cache_has_attachments was_data_detected was_deduplicated is_audio_message is_played is_expirable is_corrupt is_spam has_unseen_mention was_delivered_quietly did_notify_recipient was_detonated is_stewie is_sos is_critical is_kt_verified is_pending_satellite_send needs_relay sent_or_received_off_grid is_time_sensitive',
  timestamp:
    'date date_read date_delivered date_played time_expressive_send_played date_retracted date_edited date_recovered',
  base64: 'attributedBody payload_data message_summary_info',
});

const chat = columns('c', {
  nullableText:
    'chat_identifier service_name room_name account_id account_login last_addressed_handle display_name group_id engram_id server_change_token original_group_id cloudkit_record_id last_addressed_sim_id',
  integer: 'style state successful_query ck_sync_state syndication_type',
  boolean:
    'is_archived is_filtered is_blackholed is_recovered is_deleting_incoming_messages is_pending_review',
  timestamp: 'last_read_message_timestamp syndication_date',
  base64: 'properties',
});

const handle = columns('h', {
  text: 'id service',
  nullableText: 'country uncanonicalized_id person_centric_id',
});

const attachment = columns('a', {
  text: 'original_guid',
  nullableText:
    'filename uti mime_type transfer_name ck_record_id emoji_image_content_identifier emoji_image_short_description',
  integer: 'transfer_state total_bytes ck_sync_state preview_generation_state',
  boolean: 'is_outgoing is_sticker hide_attachment is_commsafety_sensitive',
  timestamp: 'created_date start_date',
  base64:
    'user_info sticker_user_info attribution_info ck_server_change_token_blob',
});

const chatGuid: [FieldSchema, string] = [id, 'c.guid'];
const integer = eventKitFields.integer;
const messageGuid: [FieldSchema, string] = [id, 'm.guid'];

// Relationships are exported by guid: ROWIDs are local and change when
// Messages in iCloud rebuilds the database. Every column of each table loads;
// only iCloud sync bookkeeping (deleted_messages, sync_deleted_*) is left out.
export const definitions = {
  chats: {
    ...definition({ guid: chatGuid }, 'chat c', chat),
    primaryKey: ['guid'],
  },
  handles: {
    ...definition({}, 'handle h', handle),
    primaryKey: ['id', 'service'],
  },
  // The identifiers Messages resolves to a chat, unique per domain.
  chatLookups: {
    ...definition(
      {
        identifier: [text, 'l.identifier'],
        domain: [text, 'l.domain'],
        chatGuid,
        priority: [nullableInteger, 'l.priority'],
      },
      'chat_lookup l JOIN chat c ON c.ROWID = l.chat',
    ),
    primaryKey: ['identifier', 'domain'],
  },
  chatServices: {
    ...definition(
      { chatGuid, service: [text, 's.service'] },
      'chat_service s JOIN chat c ON c.ROWID = s.chat',
    ),
    primaryKey: ['chatGuid', 'service'],
  },
  chatHandles: {
    ...definition(
      {
        chatGuid,
        handleId: [text, 'h.id'],
        handleService: [text, 'h.service'],
      },
      'chat_handle_join j JOIN chat c ON c.ROWID = j.chat_id JOIN handle h ON h.ROWID = j.handle_id',
    ),
    primaryKey: ['chatGuid', 'handleId', 'handleService'],
  },
  messages: {
    ...definition(
      {
        guid: messageGuid,
        handle: [nullableText, 'h.id'],
        handleService: [nullableText, 'h.service'],
        otherHandle: [nullableText, 'o.id'],
        otherHandleService: [nullableText, 'o.service'],
      },
      'message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN handle o ON o.ROWID = m.other_handle',
      message,
    ),
    primaryKey: ['guid'],
  },
  chatMessages: {
    ...definition(
      {
        chatGuid,
        messageGuid,
        messageDate: [nullableTimestamp, appleMilliseconds('j.message_date')],
        indexState: [nullableInteger, 'j.index_state'],
      },
      'chat_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid'],
  },
  // The rich link a URL message shows, decoded from its payload_data archive.
  linkPreviews: {
    properties: {
      messageGuid: id,
      url: nullableText,
      originalUrl: nullableText,
      title: nullableText,
      summary: nullableText,
      siteName: nullableText,
      itemType: nullableText,
      creator: nullableText,
      metadata: text,
    },
    primaryKey: ['messageGuid'],
    sql: `SELECT m.guid AS messageGuid, m.payload_data AS payload FROM message m WHERE m.payload_data IS NOT NULL`,
    expand: linkPreviews,
  },
  // Earlier versions of edited message parts, from message_summary_info's
  // "ec" (edited content): part index -> versions, each a date and an archived body.
  messageEdits: {
    properties: {
      messageGuid: id,
      partIndex: integer,
      version: integer,
      editedAt: nullableTimestamp,
      text: nullableText,
      entry: text,
    },
    primaryKey: ['messageGuid', 'partIndex', 'version'],
    sql: `SELECT m.guid AS messageGuid, m.message_summary_info AS summary FROM message m WHERE m.message_summary_info IS NOT NULL`,
    expand: messageEdits,
  },
  // Recently Deleted: Messages keeps the message row but moves its chat link here.
  recoverableMessages: {
    ...definition(
      {
        chatGuid,
        messageGuid,
        deleteDate: [nullableTimestamp, appleMilliseconds('j.delete_date')],
        ckSyncState: [nullableInteger, 'j.ck_sync_state'],
      },
      'chat_recoverable_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid'],
  },
  recoverableMessageParts: {
    ...definition(
      {
        chatGuid,
        messageGuid,
        partIndex: [eventKitFields.integer, 'p.part_index'],
        deleteDate: [nullableTimestamp, appleMilliseconds('p.delete_date')],
        partText: [nullableText, 'p.part_text'],
        ckSyncState: [nullableInteger, 'p.ck_sync_state'],
      },
      'recoverable_message_part p JOIN chat c ON c.ROWID = p.chat_id JOIN message m ON m.ROWID = p.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid', 'partIndex'],
  },
  attachments: {
    ...definition({ guid: [id, 'a.guid'] }, 'attachment a', attachment, {
      // Changes when an offloaded file downloads, so the diff reloads its bytes.
      availableLocally: boolean,
    }),
    primaryKey: ['guid'],
    files: true,
  },
  messageAttachments: {
    ...definition(
      { messageGuid, attachmentGuid: [id, 'a.guid'] },
      'message_attachment_join j JOIN message m ON m.ROWID = j.message_id JOIN attachment a ON a.ROWID = j.attachment_id',
    ),
    primaryKey: ['messageGuid', 'attachmentGuid'],
  },
} satisfies Record<string, Definition>;

export type StreamName = keyof typeof definitions;

export const streams = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => [
    name,
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        properties: definition.properties,
        required: Object.keys(definition.properties),
      },
      primaryKey: [...definition.primaryKey],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      ...('files' in definition && { supportsFileTransfer: true }),
    }),
  ]),
) as Record<StreamName, Stream>;

const appleEpoch = Date.UTC(2001, 0, 1);

const isObject = (
  value: PlistValue | undefined,
): value is { [key: string]: PlistValue } =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  !(value instanceof Date);

const textOf = (value: PlistValue | undefined) =>
  typeof value === 'string' ? value : null;

function linkPreviews(row: Record<string, unknown>) {
  const root = decodeArchive(row.payload as Uint8Array);
  const metadata = isObject(root) ? root.richLinkMetadata : undefined;
  if (!isObject(metadata)) return [];
  return [
    {
      messageGuid: row.messageGuid,
      url: textOf(metadata.URL),
      originalUrl: textOf(metadata.originalURL),
      title: textOf(metadata.title),
      summary: textOf(metadata.summary),
      siteName: textOf(metadata.siteName),
      itemType: textOf(metadata.itemType),
      creator: textOf(metadata.creator),
      metadata: plistJSON(metadata),
    },
  ];
}

// Messages writes edit times as it writes message dates: nanoseconds since
// 2001, or seconds in older formats.
function appleTime(value: PlistValue | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'number' && typeof value !== 'bigint') return null;
  const milliseconds =
    typeof value === 'bigint'
      ? Number(value / 1_000_000n)
      : Math.abs(value) > 100_000_000_000
        ? value / 1_000_000
        : value * 1000;
  return new Date(appleEpoch + Math.trunc(milliseconds)).toISOString();
}

function messageEdits(row: Record<string, unknown>) {
  const summary = decodeArchive(row.summary as Uint8Array);
  const edited = isObject(summary) ? summary.ec : undefined;
  if (!isObject(edited)) return [];
  return Object.entries(edited).flatMap(([part, versions]) =>
    (Array.isArray(versions) ? versions : []).map((entry, version) => {
      const body = isObject(entry) ? entry.t : undefined;
      return {
        messageGuid: row.messageGuid,
        partIndex: Number(part),
        version,
        editedAt: isObject(entry) ? appleTime(entry.d) : null,
        text: body instanceof Uint8Array ? attributedText(body) : null,
        entry: plistJSON(entry),
      };
    }),
  );
}

// Converts one SQL row to its stream's record shape, field by field from the
// schema. Archived Foundation values load as JSON; other bytes as base64.
export function recordFrom(
  name: StreamName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(definitions[name].properties)) {
    const value = row[field] ?? null;
    record[field] =
      value === null
        ? null
        : schema.format === 'date-time'
          ? new Date(appleEpoch + Number(value)).toISOString()
          : schema.type === 'boolean'
            ? value !== 0
            : value instanceof Uint8Array
              ? isBinaryPlist(value)
                ? plistJSON(decodeArchive(value))
                : Buffer.from(value).toString('base64')
              : value;
  }
  return record;
}
