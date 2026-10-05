import { Catalog, type FieldSchema, Stream } from '@workspace/elt';
import {
  type PlistValue,
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  plistJSON,
} from '@workspace/sdk-apple-plist';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

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

// The order a table's columns load in.
const kindOrder = [
  'text',
  'nullableText',
  'integer',
  'boolean',
  'timestamp',
  'base64',
] as const;

type Kind = (typeof kindOrder)[number];

// How each kind of chat.db column loads: its schema, its SELECT expression and
// the loaded value, as appleMilliseconds and recordFrom produce it. Booleans
// are Messages' 0/1 flags, which all default to 0.
const kinds = {
  text: { schema: text, select: (column: string) => column, loads: 'text' },
  nullableText: {
    schema: nullableText,
    select: (column: string) => column,
    loads: 'text; NULL when chat.db stores NULL',
  },
  integer: {
    schema: nullableInteger,
    select: (column: string) => column,
    loads: 'integer passed through unchanged; NULL when chat.db stores NULL',
  },
  boolean: {
    schema: boolean,
    select: (column: string) => column,
    loads: '0/1 flag loaded as a boolean; any nonzero value is true',
  },
  timestamp: {
    schema: nullableTimestamp,
    select: appleMilliseconds,
    loads:
      'nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant truncated to milliseconds; NULL when chat.db stores 0 or NULL',
  },
  base64: {
    schema: nullableText,
    select: (column: string) => column,
    loads:
      'bytes; a binary property list loads as JSON text, with NSKeyedArchiver archives unarchived, nested data as Base64, dates as ISO 8601 and integers beyond 2^53 as strings, and any other bytes load as Base64; NULL when chat.db stores NULL',
  },
} as const satisfies Record<
  Kind,
  {
    readonly schema: FieldSchema;
    readonly select: (column: string) => string;
    readonly loads: string;
  }
>;

// A chat.db table and the alias its SQL uses.
type Table = { readonly name: string; readonly alias: string };

const unverified = 'Meaning not documented by Apple.';

// Where a field comes from: its chat.db column and how that column loads.
const provenance = ({ name }: Table, column: string, kind: Kind) =>
  `chat.db ${name}.${column}: ${kinds[kind].loads}.`;

// One chat.db column as a field: its schema, described by its provenance, and
// its SELECT expression.
function native(
  table: Table,
  column: string,
  kind: Kind,
): [FieldSchema, string] {
  const { schema, select } = kinds[kind];
  return [
    {
      ...schema,
      description: `${provenance(table, column, kind)} ${unverified}`,
    },
    select(`${table.alias}.${column}`),
  ];
}

// A table's columns grouped by how they load. meanings replaces the generated
// description of a column whose meaning the code proves.
function columns(
  table: Table,
  list: Partial<Record<Kind, string>>,
  meanings: Readonly<Record<string, string>>,
) {
  const listed = Object.values(list).flatMap(words);
  const unknown = Object.keys(meanings).filter(
    (column) => !listed.includes(column),
  );
  if (unknown.length > 0)
    throw new TypeError(
      `Meanings for columns ${table.name} does not list: ${unknown.join(', ')}`,
    );
  const properties: Record<string, FieldSchema> = {};
  const select: string[] = [];
  for (const kind of kindOrder)
    for (const column of words(list[kind])) {
      const [schema, expression] = native(table, column, kind);
      const meaning = meanings[column];
      properties[camel(column)] =
        meaning === undefined ? schema : { ...schema, description: meaning };
      select.push(`${expression} AS "${camel(column)}"`);
    }
  return { properties, select };
}

type Definition = {
  readonly description: string;
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
): Omit<Definition, 'description' | 'primaryKey' | 'files'> {
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

const tables = {
  message: { name: 'message', alias: 'm' },
  chat: { name: 'chat', alias: 'c' },
  handle: { name: 'handle', alias: 'h' },
  attachment: { name: 'attachment', alias: 'a' },
  chatLookup: { name: 'chat_lookup', alias: 'l' },
  chatService: { name: 'chat_service', alias: 's' },
  chatMessage: { name: 'chat_message_join', alias: 'j' },
  chatRecoverable: { name: 'chat_recoverable_message_join', alias: 'j' },
  recoverablePart: { name: 'recoverable_message_part', alias: 'p' },
} satisfies Record<string, Table>;

const message = columns(
  tables.message,
  {
    nullableText:
      'text subject service_center country service account account_guid cache_roomnames group_title associated_message_guid balloon_bundle_id expressive_send_style_id ck_record_id ck_record_change_tag destination_caller_id reply_to_guid thread_originator_guid thread_originator_part syndication_ranges synced_syndication_ranges bia_reference_id fallback_hash associated_message_emoji ck_chat_id',
    integer:
      'replace version type error item_type group_action_type share_status share_direction expire_state message_action_type message_source associated_message_type associated_message_range_location associated_message_range_length ck_sync_state sort_id part_count schedule_type schedule_state index_state',
    boolean:
      'is_delivered is_finished is_emote is_from_me is_empty is_delayed is_auto_reply is_prepared is_read is_system_message is_sent has_dd_results is_service_message is_forward was_downgraded is_archive cache_has_attachments was_data_detected was_deduplicated is_audio_message is_played is_expirable is_corrupt is_spam has_unseen_mention was_delivered_quietly did_notify_recipient was_detonated is_stewie is_sos is_critical is_kt_verified is_pending_satellite_send needs_relay sent_or_received_off_grid is_time_sensitive',
    timestamp:
      'date date_read date_delivered date_played time_expressive_send_played date_retracted date_edited date_recovered',
    base64: 'attributedBody payload_data message_summary_info',
  },
  {
    text: 'Message body: chat.db message.text, or, when that is NULL, the plain text of the NSAttributedString archived in message.attributedBody, which is its first NSString. NULL when neither holds text. attributedBody keeps the archive itself.',
    date: `${provenance(tables.message, 'date', 'timestamp')} An import date scope selects messages by this time; which moment Messages records is not documented by Apple.`,
    attributedBody: `${provenance(tables.message, 'attributedBody', 'base64')} Messages archives the message body here as an NSAttributedString in NeXT typedstream form, which is not a property list and so loads as Base64; text is decoded from it when message.text is NULL. Its other attributes are not decoded.`,
    payload_data: `${provenance(tables.message, 'payload_data', 'base64')} A richLinkMetadata object in it is decoded into the linkPreviews stream; the meaning of its other contents is not documented by Apple.`,
    message_summary_info: `${provenance(tables.message, 'message_summary_info', 'base64')} Its "ec" entry is decoded into the messageEdits stream; the meaning of its other keys is not documented by Apple.`,
  },
);

const chat = columns(
  tables.chat,
  {
    nullableText:
      'chat_identifier service_name room_name account_id account_login last_addressed_handle display_name group_id engram_id server_change_token original_group_id cloudkit_record_id last_addressed_sim_id',
    integer: 'style state successful_query ck_sync_state syndication_type',
    boolean:
      'is_archived is_filtered is_blackholed is_recovered is_deleting_incoming_messages is_pending_review',
    timestamp: 'last_read_message_timestamp syndication_date',
    base64: 'properties',
  },
  {
    account_id: `${provenance(tables.chat, 'account_id', 'nullableText')} An import scope's account selection matches chats by this value. ${unverified}`,
  },
);

const handle = columns(
  tables.handle,
  {
    text: 'id service',
    nullableText: 'country uncanonicalized_id person_centric_id',
  },
  {
    id: `${provenance(tables.handle, 'id', 'text')} Unique only together with service: the same id can recur under another service. messages.handle, messages.otherHandle and chatHandles.handleId refer to it within this source, each together with its service field. ${unverified}`,
    service: `${provenance(tables.handle, 'service', 'text')} The second half of this stream's composite key (id, service). messages.handleService, messages.otherHandleService and chatHandles.handleService refer to it within this source. ${unverified}`,
  },
);

const attachment = columns(
  tables.attachment,
  {
    text: 'original_guid',
    nullableText:
      'filename uti mime_type transfer_name ck_record_id emoji_image_content_identifier emoji_image_short_description',
    integer:
      'transfer_state total_bytes ck_sync_state preview_generation_state',
    boolean: 'is_outgoing is_sticker hide_attachment is_commsafety_sensitive',
    timestamp: 'created_date start_date',
    base64:
      'user_info sticker_user_info attribution_info ck_server_change_token_blob',
  },
  {
    filename: `${provenance(tables.attachment, 'filename', 'nullableText')} The path Messages stores for the attachment's file, absolute or home-relative as ~/…; the file is exported from this path. A path does not prove the file exists: see availableLocally.`,
  },
);

const chatGuid: [FieldSchema, string] = [
  {
    ...id,
    description:
      'chat.db chat.guid of the chat; refers to chats.guid within this source.',
  },
  'c.guid',
];
const integer = eventKitFields.integer;
const messageReference = {
  ...id,
  description:
    'chat.db message.guid of the message; refers to messages.guid within this source.',
};
const messageGuid: [FieldSchema, string] = [messageReference, 'm.guid'];

// Every stream's source and its limits.
const localStore =
  "Read from this Mac's chat.db, not from iCloud: it holds only what Messages keeps locally, and an import scope recorded in extraction coverage can narrow it further. Relationships use GUIDs, which survive the renumbering of local ROWIDs when Messages in iCloud rebuilds chat.db, and name source streams, not destination tables.";

const countAtMessageGrain =
  'Many-to-many: joining messages through this stream repeats a message once per linked row, so count messages at message grain, as distinct messageGuid.';

// Relationships are exported by guid: ROWIDs are local and change when
// Messages in iCloud rebuilds the database. Every column of each table loads;
// only iCloud sync bookkeeping (deleted_messages, sync_deleted_*) is left out.
export const definitions = {
  chats: {
    description: `One record per chat in chat.db's chat table, keyed by guid. Its handles are in chatHandles, its messages in chatMessages, or in recoverableMessages while recoverable after deletion, its lookup identifiers in chatLookups and its services in chatServices, each by chatGuid. ${localStore}`,
    ...definition(
      {
        guid: [
          {
            ...id,
            description:
              "chat.db chat.guid; this stream's primary key. chatGuid in chatLookups, chatServices, chatHandles, chatMessages, recoverableMessages and recoverableMessageParts refers to it within this source.",
          },
          'c.guid',
        ],
      },
      'chat c',
      chat,
    ),
    primaryKey: ['guid'],
  },
  handles: {
    description: `One record per handle in chat.db's handle table, keyed by the composite (id, service): the same id can appear once per service, so every join uses both fields. messages.handle and messages.handleService join handles.id and handles.service, likewise messages.otherHandle and messages.otherHandleService; chatHandles joins by handleId and handleService. ${localStore}`,
    ...definition({}, 'handle h', handle),
    primaryKey: ['id', 'service'],
  },
  // chat.db's chat_lookup rows, unique per identifier and domain.
  chatLookups: {
    description: `One record per row of chat.db chat_lookup, keyed by (identifier, domain), which chat.db keeps unique; what a lookup means is not documented by Apple. chatGuid refers to chats.guid. ${localStore}`,
    ...definition(
      {
        identifier: native(tables.chatLookup, 'identifier', 'text'),
        domain: native(tables.chatLookup, 'domain', 'text'),
        chatGuid,
        priority: native(tables.chatLookup, 'priority', 'integer'),
      },
      'chat_lookup l JOIN chat c ON c.ROWID = l.chat',
    ),
    primaryKey: ['identifier', 'domain'],
  },
  chatServices: {
    description: `One record per chat and service pair in chat.db chat_service, keyed by (chatGuid, service). chatGuid refers to chats.guid. ${localStore}`,
    ...definition(
      { chatGuid, service: native(tables.chatService, 'service', 'text') },
      'chat_service s JOIN chat c ON c.ROWID = s.chat',
    ),
    primaryKey: ['chatGuid', 'service'],
  },
  chatHandles: {
    description: `One record per handle linked to a chat in chat.db chat_handle_join, keyed by (chatGuid, handleId, handleService). chatGuid refers to chats.guid; handleId and handleService together join handles.id and handles.service. A chat can link many handles and a handle many chats. ${localStore}`,
    ...definition(
      {
        chatGuid,
        handleId: [
          {
            ...text,
            description:
              'chat.db handle.id of the linked handle; together with handleService refers to handles (id, service) within this source.',
          },
          'h.id',
        ],
        handleService: [
          {
            ...text,
            description:
              'chat.db handle.service of the linked handle; together with handleId refers to handles (id, service) within this source.',
          },
          'h.service',
        ],
      },
      'chat_handle_join j JOIN chat c ON c.ROWID = j.chat_id JOIN handle h ON h.ROWID = j.handle_id',
    ),
    primaryKey: ['chatGuid', 'handleId', 'handleService'],
  },
  messages: {
    description: `One record per message in chat.db's message table, keyed by guid. A message recoverable after deletion keeps its record, and its chat link is in recoverableMessages instead of chatMessages (observed on a live store; Apple does not document this table). handle and handleService join handles.id and handles.service, likewise otherHandle and otherHandleService. Chats link through chatMessages and attachments through messageAttachments; both are many-to-many, so joining through them repeats a message: count messages in this stream, or as distinct guid after such a join. Edit versions decoded from messageSummaryInfo are in messageEdits and rich links decoded from payloadData in linkPreviews. chat.db's iCloud deletion bookkeeping (deleted_messages, sync_deleted_*) is not exported. ${localStore}`,
    ...definition(
      {
        guid: [
          {
            ...id,
            description:
              "chat.db message.guid; this stream's primary key. messageGuid in chatMessages, messageAttachments, messageEdits, linkPreviews, recoverableMessages and recoverableMessageParts refers to it within this source.",
          },
          'm.guid',
        ],
        handle: [
          {
            ...nullableText,
            description:
              'chat.db handle.id of the handle message.handle_id points to; together with handleService refers to handles (id, service) within this source. NULL when message.handle_id matches no handle. Which participant it names is not documented by Apple.',
          },
          'h.id',
        ],
        handleService: [
          {
            ...nullableText,
            description:
              'chat.db handle.service of the handle message.handle_id points to; together with handle refers to handles (id, service) within this source. NULL when message.handle_id matches no handle.',
          },
          'h.service',
        ],
        otherHandle: [
          {
            ...nullableText,
            description:
              'chat.db handle.id of the handle message.other_handle points to; together with otherHandleService refers to handles (id, service) within this source. NULL when message.other_handle matches no handle. Which participant it names is not documented by Apple.',
          },
          'o.id',
        ],
        otherHandleService: [
          {
            ...nullableText,
            description:
              'chat.db handle.service of the handle message.other_handle points to; together with otherHandle refers to handles (id, service) within this source. NULL when message.other_handle matches no handle.',
          },
          'o.service',
        ],
      },
      'message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN handle o ON o.ROWID = m.other_handle',
      message,
    ),
    primaryKey: ['guid'],
  },
  chatMessages: {
    description: `One record per chat and message link in chat.db chat_message_join, keyed by (chatGuid, messageGuid). chatGuid refers to chats.guid and messageGuid to messages.guid. ${countAtMessageGrain} A message recoverable after deletion is linked through recoverableMessages instead (observed on a live store; Apple does not document this table). ${localStore}`,
    ...definition(
      {
        chatGuid,
        messageGuid,
        messageDate: native(tables.chatMessage, 'message_date', 'timestamp'),
        indexState: native(tables.chatMessage, 'index_state', 'integer'),
      },
      'chat_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid'],
  },
  // The rich link a URL message shows, decoded from its payload_data archive.
  linkPreviews: {
    description: `One record per message whose chat.db message.payload_data archive holds a richLinkMetadata object, keyed by messageGuid, which refers to messages.guid. metadata keeps the object's archived class as "$class"; url, originalUrl and title follow Apple's LPLinkMetadata documentation. Other messages have no record; messages.payloadData keeps the archive. ${localStore}`,
    properties: {
      messageGuid: messageReference,
      url: {
        ...nullableText,
        description:
          'richLinkMetadata.URL, which Apple documents as the URL that returned the metadata, taking server-side redirects into account; NULL when absent or not text.',
      },
      originalUrl: {
        ...nullableText,
        description:
          'richLinkMetadata.originalURL, which Apple documents as the original URL of the metadata request; NULL when absent or not text.',
      },
      title: {
        ...nullableText,
        description:
          'richLinkMetadata.title, which Apple documents as a representative title for the URL; NULL when absent or not text.',
      },
      summary: {
        ...nullableText,
        description: `richLinkMetadata.summary; NULL when absent or not text. ${unverified}`,
      },
      siteName: {
        ...nullableText,
        description: `richLinkMetadata.siteName; NULL when absent or not text. ${unverified}`,
      },
      itemType: {
        ...nullableText,
        description: `richLinkMetadata.itemType; NULL when absent or not text. ${unverified}`,
      },
      creator: {
        ...nullableText,
        description: `richLinkMetadata.creator; NULL when absent or not text. ${unverified}`,
      },
      metadata: {
        ...text,
        description:
          'The whole unarchived richLinkMetadata object as JSON, with its "$class", nested data as Base64 and dates as ISO 8601; keeps the fields not extracted above.',
      },
    },
    primaryKey: ['messageGuid'],
    sql: `SELECT m.guid AS messageGuid, m.payload_data AS payload FROM message m WHERE m.payload_data IS NOT NULL`,
    expand: linkPreviews,
  },
  // Earlier versions of edited message parts, from message_summary_info's
  // "ec" (edited content): part index -> versions, each a date and an archived body.
  messageEdits: {
    description: `One record per edit-history entry that chat.db message.message_summary_info stores under "ec", keyed by (messageGuid, partIndex, version); messageGuid refers to messages.guid. Messages without that history have no record; messages.messageSummaryInfo keeps the archive. ${localStore}`,
    properties: {
      messageGuid: messageReference,
      partIndex: {
        ...integer,
        description: `The "ec" key the entry is stored under, as a number, which the connector reads as the index of the edited message part. ${unverified}`,
      },
      version: {
        ...integer,
        description:
          "The entry's 0-based position in its part's stored list, in stored order.",
      },
      editedAt: {
        ...nullableTimestamp,
        description: `The entry's "d" time: a property list date, or nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant; NULL when d is absent or not a time. Which moment it records is not documented by Apple.`,
      },
      text: {
        ...nullableText,
        description:
          'Plain text of the entry\'s "t" NSAttributedString archive in typedstream form, its first NSString; NULL when t is absent, not bytes or holds no string.',
      },
      entry: {
        ...text,
        description:
          'The whole entry as JSON, with "t" as Base64 and dates as ISO 8601; keeps the keys not extracted above.',
      },
    },
    primaryKey: ['messageGuid', 'partIndex', 'version'],
    sql: `SELECT m.guid AS messageGuid, m.message_summary_info AS summary FROM message m WHERE m.message_summary_info IS NOT NULL`,
    expand: messageEdits,
  },
  // A recoverable message keeps its message row but is linked to its chat here.
  recoverableMessages: {
    description: `One record per chat and message link in chat.db chat_recoverable_message_join, keyed by (chatGuid, messageGuid): a message recoverable after deletion keeps its messages record and is linked to its chat here instead of in chatMessages (observed on a live store; Apple does not document this table). chatGuid refers to chats.guid and messageGuid to messages.guid; the message's parts are in recoverableMessageParts. ${countAtMessageGrain} ${localStore}`,
    ...definition(
      {
        chatGuid,
        messageGuid,
        deleteDate: native(tables.chatRecoverable, 'delete_date', 'timestamp'),
        ckSyncState: native(tables.chatRecoverable, 'ck_sync_state', 'integer'),
      },
      'chat_recoverable_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid'],
  },
  recoverableMessageParts: {
    description: `One record per message part in chat.db recoverable_message_part, for messages recoverable after deletion, keyed by (chatGuid, messageGuid, partIndex). chatGuid refers to chats.guid and messageGuid to messages.guid; (chatGuid, messageGuid) joins recoverableMessages. ${localStore}`,
    ...definition(
      {
        chatGuid,
        messageGuid,
        partIndex: [
          {
            ...eventKitFields.integer,
            description: `chat.db recoverable_message_part.part_index: integer passed through unchanged. ${unverified}`,
          },
          'p.part_index',
        ],
        deleteDate: native(tables.recoverablePart, 'delete_date', 'timestamp'),
        partText: native(tables.recoverablePart, 'part_text', 'base64'),
        ckSyncState: native(tables.recoverablePart, 'ck_sync_state', 'integer'),
      },
      'recoverable_message_part p JOIN chat c ON c.ROWID = p.chat_id JOIN message m ON m.ROWID = p.message_id',
    ),
    primaryKey: ['chatGuid', 'messageGuid', 'partIndex'],
  },
  attachments: {
    description: `One record per attachment in chat.db's attachment table, keyed by guid; messageAttachments links attachments to messages, many-to-many. A record can exist without a readable file: availableLocally reports whether the stored filename was reachable when read, which changes, for example when an offloaded file downloads, independently of message and attachment dates. ${localStore}`,
    ...definition(
      {
        guid: [
          {
            ...id,
            description:
              "chat.db attachment.guid; this stream's primary key. messageAttachments.attachmentGuid refers to it within this source.",
          },
          'a.guid',
        ],
      },
      'attachment a',
      attachment,
      {
        // Changes when an offloaded file downloads, so the diff reloads its bytes.
        availableLocally: {
          ...boolean,
          description:
            'Whether the file at filename, with ~/ expanded to the home directory, was accessible to the export when this record was read; false when filename is NULL or the path is not accessible, such as a file not downloaded to this Mac. File bytes are exported only when true.',
        },
      },
    ),
    primaryKey: ['guid'],
    files: true,
  },
  messageAttachments: {
    description: `One record per message and attachment link in chat.db message_attachment_join, keyed by (messageGuid, attachmentGuid). messageGuid refers to messages.guid and attachmentGuid to attachments.guid. ${countAtMessageGrain} ${localStore}`,
    ...definition(
      {
        messageGuid,
        attachmentGuid: [
          {
            ...id,
            description:
              'chat.db attachment.guid of the linked attachment; refers to attachments.guid within this source.',
          },
          'a.guid',
        ],
      },
      'message_attachment_join j JOIN message m ON m.ROWID = j.message_id JOIN attachment a ON a.ROWID = j.attachment_id',
    ),
    primaryKey: ['messageGuid', 'attachmentGuid'],
  },
} satisfies Record<string, Definition>;

export type StreamName = keyof typeof definitions;

export const catalog = new Catalog(
  Object.entries(definitions).map(
    ([name, definition]) =>
      new Stream({
        name,
        jsonSchema: {
          type: 'object',
          description: definition.description,
          properties: definition.properties,
          required: Object.keys(definition.properties),
        },
        primaryKey: [...definition.primaryKey],
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
        emitsDeletes: true,
        ...('files' in definition && { supportsFileTransfer: true }),
      }),
  ),
);

const appleEpoch = Date.UTC(2001, 0, 1);

const textOf = (value: PlistValue | undefined) =>
  typeof value === 'string' ? value : null;

function linkPreviews(row: Record<string, unknown>) {
  if (!(row.payload instanceof Uint8Array))
    throw new TypeError('chat.db message.payload_data is not a blob');
  const root = decodeArchive(row.payload);
  const metadata = isDictionary(root) ? root.richLinkMetadata : undefined;
  if (!isDictionary(metadata)) return [];
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
  if (!(row.summary instanceof Uint8Array))
    throw new TypeError('chat.db message.message_summary_info is not a blob');
  const summary = decodeArchive(row.summary);
  const edited = isDictionary(summary) ? summary.ec : undefined;
  if (!isDictionary(edited)) return [];
  return Object.entries(edited).flatMap(([part, versions]) =>
    (Array.isArray(versions) ? versions : []).map((entry, version) => {
      const body = isDictionary(entry) ? entry.t : undefined;
      return {
        messageGuid: row.messageGuid,
        partIndex: Number(part),
        version,
        editedAt: isDictionary(entry) ? appleTime(entry.d) : null,
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
