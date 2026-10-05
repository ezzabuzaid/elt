import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  plistJSON
} from "../../chunks/chunk-YLKLHO7E.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  selected,
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-NHBH24IB.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-7XFLCHNF.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-C5AZWDBZ.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/messages/dist/apple-messages-source.js
import { access } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { setInterval } from "node:timers/promises";

// packages/sources/apple/messages/dist/chat-database.js
import { homedir } from "node:os";
import { join } from "node:path";
var messagesDirectory = join(homedir(), "Library/Messages");
var MessagesUnavailableError = class extends Error {
  name = "MessagesUnavailableError";
  constructor(path, cause) {
    super(`Messages history at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Messages.app does not need to be open.`, { cause });
  }
};
var ChatDatabaseVersion = class extends AppDatabaseVersion {
  constructor(path) {
    super(path, MessagesUnavailableError);
  }
};
var ChatDatabase = class extends AppDatabase {
  constructor(path) {
    super(path, MessagesUnavailableError);
  }
  async [Symbol.asyncDispose]() {
    this[Symbol.dispose]();
  }
};

// packages/sources/apple/messages/dist/typedstream.js
var decoder = new TextDecoder("utf-8", { fatal: true });
var stringClass = new TextEncoder().encode("NSString");
var cString = 43;
var int16 = 129;
var int32 = 130;
function attributedText(body) {
  const name = indexOf(body, stringClass);
  if (name === -1)
    return null;
  const type = body.indexOf(cString, name + stringClass.length);
  if (type === -1 || type > name + stringClass.length + 8)
    throw new TypeError("attributedBody has no string after NSString");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = type + 1;
  let length = body[offset] ?? -1;
  offset += 1;
  if (length === int16) {
    length = view.getUint16(offset, true);
    offset += 2;
  } else if (length === int32) {
    length = view.getUint32(offset, true);
    offset += 4;
  }
  if (length < 0 || offset + length > body.length)
    throw new TypeError("attributedBody string runs past its end");
  return decoder.decode(body.subarray(offset, offset + length));
}
function indexOf(haystack, needle) {
  const first = needle[0];
  if (first === void 0)
    return -1;
  for (let start = haystack.indexOf(first); start !== -1 && start + needle.length <= haystack.length; start = haystack.indexOf(first, start + 1))
    if (needle.every((byte, index) => haystack[start + index] === byte))
      return start;
  return -1;
}

// packages/sources/apple/messages/dist/messages-streams.js
var { text, id, nullableText, boolean, nullableTimestamp } = eventKitFields;
var nullableInteger = { type: ["integer", "null"] };
var appleMilliseconds = (column) => `CASE WHEN ${column} IS NULL OR ${column} = 0 THEN NULL WHEN abs(${column}) > 100000000000 THEN ${column} / 1000000 ELSE ${column} * 1000 END`;
var camel = (column) => column.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
var words = (list = "") => list.split(/\s+/).filter(Boolean);
var kindOrder = [
  "text",
  "nullableText",
  "integer",
  "boolean",
  "timestamp",
  "base64"
];
var kinds = {
  text: { schema: text, select: (column) => column, loads: "text" },
  nullableText: {
    schema: nullableText,
    select: (column) => column,
    loads: "text; NULL when chat.db stores NULL"
  },
  integer: {
    schema: nullableInteger,
    select: (column) => column,
    loads: "integer passed through unchanged; NULL when chat.db stores NULL"
  },
  boolean: {
    schema: boolean,
    select: (column) => column,
    loads: "0/1 flag loaded as a boolean; any nonzero value is true"
  },
  timestamp: {
    schema: nullableTimestamp,
    select: appleMilliseconds,
    loads: "nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant truncated to milliseconds; NULL when chat.db stores 0 or NULL"
  },
  base64: {
    schema: nullableText,
    select: (column) => column,
    loads: "bytes; a binary property list loads as JSON text, with NSKeyedArchiver archives unarchived, nested data as Base64, dates as ISO 8601 and integers beyond 2^53 as strings, and any other bytes load as Base64; NULL when chat.db stores NULL"
  }
};
var unverified = "Meaning not documented by Apple.";
var provenance = ({ name }, column, kind) => `chat.db ${name}.${column}: ${kinds[kind].loads}.`;
function native(table, column, kind) {
  const { schema, select } = kinds[kind];
  return [
    {
      ...schema,
      description: `${provenance(table, column, kind)} ${unverified}`
    },
    select(`${table.alias}.${column}`)
  ];
}
function columns(table, list, meanings) {
  const listed = Object.values(list).flatMap(words);
  const unknown = Object.keys(meanings).filter((column) => !listed.includes(column));
  if (unknown.length > 0)
    throw new TypeError(`Meanings for columns ${table.name} does not list: ${unknown.join(", ")}`);
  const properties = {};
  const select = [];
  for (const kind of kindOrder)
    for (const column of words(list[kind])) {
      const [schema, expression] = native(table, column, kind);
      const meaning = meanings[column];
      properties[camel(column)] = meaning === void 0 ? schema : { ...schema, description: meaning };
      select.push(`${expression} AS "${camel(column)}"`);
    }
  return { properties, select };
}
function definition(keys, from, table = { properties: {}, select: [] }, extra = {}) {
  return {
    properties: {
      ...Object.fromEntries(Object.entries(keys).map(([name, [schema]]) => [name, schema])),
      ...table.properties,
      ...extra
    },
    sql: `SELECT ${[
      ...Object.entries(keys).map(([name, [, sql]]) => `${sql} AS "${name}"`),
      ...table.select
    ].join(", ")} FROM ${from}`
  };
}
var tables = {
  message: { name: "message", alias: "m" },
  chat: { name: "chat", alias: "c" },
  handle: { name: "handle", alias: "h" },
  attachment: { name: "attachment", alias: "a" },
  chatLookup: { name: "chat_lookup", alias: "l" },
  chatService: { name: "chat_service", alias: "s" },
  chatMessage: { name: "chat_message_join", alias: "j" },
  chatRecoverable: { name: "chat_recoverable_message_join", alias: "j" },
  recoverablePart: { name: "recoverable_message_part", alias: "p" }
};
var message = columns(tables.message, {
  nullableText: "text subject service_center country service account account_guid cache_roomnames group_title associated_message_guid balloon_bundle_id expressive_send_style_id ck_record_id ck_record_change_tag destination_caller_id reply_to_guid thread_originator_guid thread_originator_part syndication_ranges synced_syndication_ranges bia_reference_id fallback_hash associated_message_emoji ck_chat_id",
  integer: "replace version type error item_type group_action_type share_status share_direction expire_state message_action_type message_source associated_message_type associated_message_range_location associated_message_range_length ck_sync_state sort_id part_count schedule_type schedule_state index_state",
  boolean: "is_delivered is_finished is_emote is_from_me is_empty is_delayed is_auto_reply is_prepared is_read is_system_message is_sent has_dd_results is_service_message is_forward was_downgraded is_archive cache_has_attachments was_data_detected was_deduplicated is_audio_message is_played is_expirable is_corrupt is_spam has_unseen_mention was_delivered_quietly did_notify_recipient was_detonated is_stewie is_sos is_critical is_kt_verified is_pending_satellite_send needs_relay sent_or_received_off_grid is_time_sensitive",
  timestamp: "date date_read date_delivered date_played time_expressive_send_played date_retracted date_edited date_recovered",
  base64: "attributedBody payload_data message_summary_info"
}, {
  text: "Message body: chat.db message.text, or, when that is NULL, the plain text of the NSAttributedString archived in message.attributedBody, which is its first NSString. NULL when neither holds text. attributedBody keeps the archive itself.",
  date: `${provenance(tables.message, "date", "timestamp")} An import date scope selects messages by this time; which moment Messages records is not documented by Apple.`,
  attributedBody: `${provenance(tables.message, "attributedBody", "base64")} Messages archives the message body here as an NSAttributedString in NeXT typedstream form, which is not a property list and so loads as Base64; text is decoded from it when message.text is NULL. Its other attributes are not decoded.`,
  payload_data: `${provenance(tables.message, "payload_data", "base64")} A richLinkMetadata object in it is decoded into the linkPreviews stream; the meaning of its other contents is not documented by Apple.`,
  message_summary_info: `${provenance(tables.message, "message_summary_info", "base64")} Its "ec" entry is decoded into the messageEdits stream; the meaning of its other keys is not documented by Apple.`
});
var chat = columns(tables.chat, {
  nullableText: "chat_identifier service_name room_name account_id account_login last_addressed_handle display_name group_id engram_id server_change_token original_group_id cloudkit_record_id last_addressed_sim_id",
  integer: "style state successful_query ck_sync_state syndication_type",
  boolean: "is_archived is_filtered is_blackholed is_recovered is_deleting_incoming_messages is_pending_review",
  timestamp: "last_read_message_timestamp syndication_date",
  base64: "properties"
}, {
  account_id: `${provenance(tables.chat, "account_id", "nullableText")} An import scope's account selection matches chats by this value. ${unverified}`
});
var handle = columns(tables.handle, {
  text: "id service",
  nullableText: "country uncanonicalized_id person_centric_id"
}, {
  id: `${provenance(tables.handle, "id", "text")} Unique only together with service: the same id can recur under another service. messages.handle, messages.otherHandle and chatHandles.handleId refer to it within this source, each together with its service field. ${unverified}`,
  service: `${provenance(tables.handle, "service", "text")} The second half of this stream's composite key (id, service). messages.handleService, messages.otherHandleService and chatHandles.handleService refer to it within this source. ${unverified}`
});
var attachment = columns(tables.attachment, {
  text: "original_guid",
  nullableText: "filename uti mime_type transfer_name ck_record_id emoji_image_content_identifier emoji_image_short_description",
  integer: "transfer_state total_bytes ck_sync_state preview_generation_state",
  boolean: "is_outgoing is_sticker hide_attachment is_commsafety_sensitive",
  timestamp: "created_date start_date",
  base64: "user_info sticker_user_info attribution_info ck_server_change_token_blob"
}, {
  filename: `${provenance(tables.attachment, "filename", "nullableText")} The path Messages stores for the attachment's file, absolute or home-relative as ~/\u2026; the file is exported from this path. A path does not prove the file exists: see availableLocally.`
});
var chatGuid = [
  {
    ...id,
    description: "chat.db chat.guid of the chat; refers to chats.guid within this source."
  },
  "c.guid"
];
var integer = eventKitFields.integer;
var messageReference = {
  ...id,
  description: "chat.db message.guid of the message; refers to messages.guid within this source."
};
var messageGuid = [messageReference, "m.guid"];
var localStore = "Read from this Mac's chat.db, not from iCloud: it holds only what Messages keeps locally, and an import scope recorded in extraction coverage can narrow it further. Relationships use GUIDs, which survive the renumbering of local ROWIDs when Messages in iCloud rebuilds chat.db, and name source streams, not destination tables.";
var countAtMessageGrain = "Many-to-many: joining messages through this stream repeats a message once per linked row, so count messages at message grain, as distinct messageGuid.";
var definitions = {
  chats: {
    description: `One record per chat in chat.db's chat table, keyed by guid. Its handles are in chatHandles, its messages in chatMessages, or in recoverableMessages while recoverable after deletion, its lookup identifiers in chatLookups and its services in chatServices, each by chatGuid. ${localStore}`,
    ...definition({
      guid: [
        {
          ...id,
          description: "chat.db chat.guid; this stream's primary key. chatGuid in chatLookups, chatServices, chatHandles, chatMessages, recoverableMessages and recoverableMessageParts refers to it within this source."
        },
        "c.guid"
      ]
    }, "chat c", chat),
    primaryKey: ["guid"]
  },
  handles: {
    description: `One record per handle in chat.db's handle table, keyed by the composite (id, service): the same id can appear once per service, so every join uses both fields. messages.handle and messages.handleService join handles.id and handles.service, likewise messages.otherHandle and messages.otherHandleService; chatHandles joins by handleId and handleService. ${localStore}`,
    ...definition({}, "handle h", handle),
    primaryKey: ["id", "service"]
  },
  // chat.db's chat_lookup rows, unique per identifier and domain.
  chatLookups: {
    description: `One record per row of chat.db chat_lookup, keyed by (identifier, domain), which chat.db keeps unique; what a lookup means is not documented by Apple. chatGuid refers to chats.guid. ${localStore}`,
    ...definition({
      identifier: native(tables.chatLookup, "identifier", "text"),
      domain: native(tables.chatLookup, "domain", "text"),
      chatGuid,
      priority: native(tables.chatLookup, "priority", "integer")
    }, "chat_lookup l JOIN chat c ON c.ROWID = l.chat"),
    primaryKey: ["identifier", "domain"]
  },
  chatServices: {
    description: `One record per chat and service pair in chat.db chat_service, keyed by (chatGuid, service). chatGuid refers to chats.guid. ${localStore}`,
    ...definition({ chatGuid, service: native(tables.chatService, "service", "text") }, "chat_service s JOIN chat c ON c.ROWID = s.chat"),
    primaryKey: ["chatGuid", "service"]
  },
  chatHandles: {
    description: `One record per handle linked to a chat in chat.db chat_handle_join, keyed by (chatGuid, handleId, handleService). chatGuid refers to chats.guid; handleId and handleService together join handles.id and handles.service. A chat can link many handles and a handle many chats. ${localStore}`,
    ...definition({
      chatGuid,
      handleId: [
        {
          ...text,
          description: "chat.db handle.id of the linked handle; together with handleService refers to handles (id, service) within this source."
        },
        "h.id"
      ],
      handleService: [
        {
          ...text,
          description: "chat.db handle.service of the linked handle; together with handleId refers to handles (id, service) within this source."
        },
        "h.service"
      ]
    }, "chat_handle_join j JOIN chat c ON c.ROWID = j.chat_id JOIN handle h ON h.ROWID = j.handle_id"),
    primaryKey: ["chatGuid", "handleId", "handleService"]
  },
  messages: {
    description: `One record per message in chat.db's message table, keyed by guid. A message recoverable after deletion keeps its record, and its chat link is in recoverableMessages instead of chatMessages (observed on a live store; Apple does not document this table). handle and handleService join handles.id and handles.service, likewise otherHandle and otherHandleService. Chats link through chatMessages and attachments through messageAttachments; both are many-to-many, so joining through them repeats a message: count messages in this stream, or as distinct guid after such a join. Edit versions decoded from messageSummaryInfo are in messageEdits and rich links decoded from payloadData in linkPreviews. chat.db's iCloud deletion bookkeeping (deleted_messages, sync_deleted_*) is not exported. ${localStore}`,
    ...definition({
      guid: [
        {
          ...id,
          description: "chat.db message.guid; this stream's primary key. messageGuid in chatMessages, messageAttachments, messageEdits, linkPreviews, recoverableMessages and recoverableMessageParts refers to it within this source."
        },
        "m.guid"
      ],
      handle: [
        {
          ...nullableText,
          description: "chat.db handle.id of the handle message.handle_id points to; together with handleService refers to handles (id, service) within this source. NULL when message.handle_id matches no handle. Which participant it names is not documented by Apple."
        },
        "h.id"
      ],
      handleService: [
        {
          ...nullableText,
          description: "chat.db handle.service of the handle message.handle_id points to; together with handle refers to handles (id, service) within this source. NULL when message.handle_id matches no handle."
        },
        "h.service"
      ],
      otherHandle: [
        {
          ...nullableText,
          description: "chat.db handle.id of the handle message.other_handle points to; together with otherHandleService refers to handles (id, service) within this source. NULL when message.other_handle matches no handle. Which participant it names is not documented by Apple."
        },
        "o.id"
      ],
      otherHandleService: [
        {
          ...nullableText,
          description: "chat.db handle.service of the handle message.other_handle points to; together with otherHandle refers to handles (id, service) within this source. NULL when message.other_handle matches no handle."
        },
        "o.service"
      ]
    }, "message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN handle o ON o.ROWID = m.other_handle", message),
    primaryKey: ["guid"]
  },
  chatMessages: {
    description: `One record per chat and message link in chat.db chat_message_join, keyed by (chatGuid, messageGuid). chatGuid refers to chats.guid and messageGuid to messages.guid. ${countAtMessageGrain} A message recoverable after deletion is linked through recoverableMessages instead (observed on a live store; Apple does not document this table). ${localStore}`,
    ...definition({
      chatGuid,
      messageGuid,
      messageDate: native(tables.chatMessage, "message_date", "timestamp"),
      indexState: native(tables.chatMessage, "index_state", "integer")
    }, "chat_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id"),
    primaryKey: ["chatGuid", "messageGuid"]
  },
  // The rich link a URL message shows, decoded from its payload_data archive.
  linkPreviews: {
    description: `One record per message whose chat.db message.payload_data archive holds a richLinkMetadata object, keyed by messageGuid, which refers to messages.guid. metadata keeps the object's archived class as "$class"; url, originalUrl and title follow Apple's LPLinkMetadata documentation. Other messages have no record; messages.payloadData keeps the archive. ${localStore}`,
    properties: {
      messageGuid: messageReference,
      url: {
        ...nullableText,
        description: "richLinkMetadata.URL, which Apple documents as the URL that returned the metadata, taking server-side redirects into account; NULL when absent or not text."
      },
      originalUrl: {
        ...nullableText,
        description: "richLinkMetadata.originalURL, which Apple documents as the original URL of the metadata request; NULL when absent or not text."
      },
      title: {
        ...nullableText,
        description: "richLinkMetadata.title, which Apple documents as a representative title for the URL; NULL when absent or not text."
      },
      summary: {
        ...nullableText,
        description: `richLinkMetadata.summary; NULL when absent or not text. ${unverified}`
      },
      siteName: {
        ...nullableText,
        description: `richLinkMetadata.siteName; NULL when absent or not text. ${unverified}`
      },
      itemType: {
        ...nullableText,
        description: `richLinkMetadata.itemType; NULL when absent or not text. ${unverified}`
      },
      creator: {
        ...nullableText,
        description: `richLinkMetadata.creator; NULL when absent or not text. ${unverified}`
      },
      metadata: {
        ...text,
        description: 'The whole unarchived richLinkMetadata object as JSON, with its "$class", nested data as Base64 and dates as ISO 8601; keeps the fields not extracted above.'
      }
    },
    primaryKey: ["messageGuid"],
    sql: `SELECT m.guid AS messageGuid, m.payload_data AS payload FROM message m WHERE m.payload_data IS NOT NULL`,
    expand: linkPreviews
  },
  // Earlier versions of edited message parts, from message_summary_info's
  // "ec" (edited content): part index -> versions, each a date and an archived body.
  messageEdits: {
    description: `One record per edit-history entry that chat.db message.message_summary_info stores under "ec", keyed by (messageGuid, partIndex, version); messageGuid refers to messages.guid. Messages without that history have no record; messages.messageSummaryInfo keeps the archive. ${localStore}`,
    properties: {
      messageGuid: messageReference,
      partIndex: {
        ...integer,
        description: `The "ec" key the entry is stored under, as a number, which the connector reads as the index of the edited message part. ${unverified}`
      },
      version: {
        ...integer,
        description: "The entry's 0-based position in its part's stored list, in stored order."
      },
      editedAt: {
        ...nullableTimestamp,
        description: `The entry's "d" time: a property list date, or nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant; NULL when d is absent or not a time. Which moment it records is not documented by Apple.`
      },
      text: {
        ...nullableText,
        description: `Plain text of the entry's "t" NSAttributedString archive in typedstream form, its first NSString; NULL when t is absent, not bytes or holds no string.`
      },
      entry: {
        ...text,
        description: 'The whole entry as JSON, with "t" as Base64 and dates as ISO 8601; keeps the keys not extracted above.'
      }
    },
    primaryKey: ["messageGuid", "partIndex", "version"],
    sql: `SELECT m.guid AS messageGuid, m.message_summary_info AS summary FROM message m WHERE m.message_summary_info IS NOT NULL`,
    expand: messageEdits
  },
  // A recoverable message keeps its message row but is linked to its chat here.
  recoverableMessages: {
    description: `One record per chat and message link in chat.db chat_recoverable_message_join, keyed by (chatGuid, messageGuid): a message recoverable after deletion keeps its messages record and is linked to its chat here instead of in chatMessages (observed on a live store; Apple does not document this table). chatGuid refers to chats.guid and messageGuid to messages.guid; the message's parts are in recoverableMessageParts. ${countAtMessageGrain} ${localStore}`,
    ...definition({
      chatGuid,
      messageGuid,
      deleteDate: native(tables.chatRecoverable, "delete_date", "timestamp"),
      ckSyncState: native(tables.chatRecoverable, "ck_sync_state", "integer")
    }, "chat_recoverable_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id"),
    primaryKey: ["chatGuid", "messageGuid"]
  },
  recoverableMessageParts: {
    description: `One record per message part in chat.db recoverable_message_part, for messages recoverable after deletion, keyed by (chatGuid, messageGuid, partIndex). chatGuid refers to chats.guid and messageGuid to messages.guid; (chatGuid, messageGuid) joins recoverableMessages. ${localStore}`,
    ...definition({
      chatGuid,
      messageGuid,
      partIndex: [
        {
          ...eventKitFields.integer,
          description: `chat.db recoverable_message_part.part_index: integer passed through unchanged. ${unverified}`
        },
        "p.part_index"
      ],
      deleteDate: native(tables.recoverablePart, "delete_date", "timestamp"),
      partText: native(tables.recoverablePart, "part_text", "base64"),
      ckSyncState: native(tables.recoverablePart, "ck_sync_state", "integer")
    }, "recoverable_message_part p JOIN chat c ON c.ROWID = p.chat_id JOIN message m ON m.ROWID = p.message_id"),
    primaryKey: ["chatGuid", "messageGuid", "partIndex"]
  },
  attachments: {
    description: `One record per attachment in chat.db's attachment table, keyed by guid; messageAttachments links attachments to messages, many-to-many. A record can exist without a readable file: availableLocally reports whether the stored filename was reachable when read, which changes, for example when an offloaded file downloads, independently of message and attachment dates. ${localStore}`,
    ...definition({
      guid: [
        {
          ...id,
          description: "chat.db attachment.guid; this stream's primary key. messageAttachments.attachmentGuid refers to it within this source."
        },
        "a.guid"
      ]
    }, "attachment a", attachment, {
      // Changes when an offloaded file downloads, so the diff reloads its bytes.
      availableLocally: {
        ...boolean,
        description: "Whether the file at filename, with ~/ expanded to the home directory, was accessible to the export when this record was read; false when filename is NULL or the path is not accessible, such as a file not downloaded to this Mac. File bytes are exported only when true."
      }
    }),
    primaryKey: ["guid"],
    files: true
  },
  messageAttachments: {
    description: `One record per message and attachment link in chat.db message_attachment_join, keyed by (messageGuid, attachmentGuid). messageGuid refers to messages.guid and attachmentGuid to attachments.guid. ${countAtMessageGrain} ${localStore}`,
    ...definition({
      messageGuid,
      attachmentGuid: [
        {
          ...id,
          description: "chat.db attachment.guid of the linked attachment; refers to attachments.guid within this source."
        },
        "a.guid"
      ]
    }, "message_attachment_join j JOIN message m ON m.ROWID = j.message_id JOIN attachment a ON a.ROWID = j.attachment_id"),
    primaryKey: ["messageGuid", "attachmentGuid"]
  }
};
var catalog = new Catalog(Object.entries(definitions).map(([name, definition2]) => new Stream({
  name,
  jsonSchema: {
    type: "object",
    description: definition2.description,
    properties: definition2.properties,
    required: Object.keys(definition2.properties)
  },
  primaryKey: [...definition2.primaryKey],
  supportedSyncModes: ["full_refresh", "incremental"],
  sourceDefinedCursor: true,
  emitsDeletes: true,
  ..."files" in definition2 && { supportsFileTransfer: true }
})));
var appleEpoch = Date.UTC(2001, 0, 1);
var textOf = (value) => typeof value === "string" ? value : null;
function linkPreviews(row) {
  if (!(row.payload instanceof Uint8Array))
    throw new TypeError("chat.db message.payload_data is not a blob");
  const root = decodeArchive(row.payload);
  const metadata = isDictionary(root) ? root.richLinkMetadata : void 0;
  if (!isDictionary(metadata))
    return [];
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
      metadata: plistJSON(metadata)
    }
  ];
}
function appleTime(value) {
  if (value instanceof Date)
    return value.toISOString();
  if (typeof value !== "number" && typeof value !== "bigint")
    return null;
  const milliseconds = typeof value === "bigint" ? Number(value / 1000000n) : Math.abs(value) > 1e11 ? value / 1e6 : value * 1e3;
  return new Date(appleEpoch + Math.trunc(milliseconds)).toISOString();
}
function messageEdits(row) {
  if (!(row.summary instanceof Uint8Array))
    throw new TypeError("chat.db message.message_summary_info is not a blob");
  const summary = decodeArchive(row.summary);
  const edited = isDictionary(summary) ? summary.ec : void 0;
  if (!isDictionary(edited))
    return [];
  return Object.entries(edited).flatMap(([part, versions]) => (Array.isArray(versions) ? versions : []).map((entry, version) => {
    const body = isDictionary(entry) ? entry.t : void 0;
    return {
      messageGuid: row.messageGuid,
      partIndex: Number(part),
      version,
      editedAt: isDictionary(entry) ? appleTime(entry.d) : null,
      text: body instanceof Uint8Array ? attributedText(body) : null,
      entry: plistJSON(entry)
    };
  }));
}
function recordFrom(name, row) {
  const record = {};
  for (const [field, schema] of Object.entries(definitions[name].properties)) {
    const value = row[field] ?? null;
    record[field] = value === null ? null : schema.format === "date-time" ? new Date(appleEpoch + Number(value)).toISOString() : schema.type === "boolean" ? value !== 0 : value instanceof Uint8Array ? isBinaryPlist(value) ? plistJSON(decodeArchive(value)) : Buffer.from(value).toString("base64") : value;
  }
  return record;
}

// packages/sources/apple/messages/dist/apple-messages-source.js
var isStreamName = (name) => Object.hasOwn(definitions, name);
var pollIntervalMs = 1e3;
var attachmentPath = (filename) => filename.startsWith("~/") ? join2(homedir2(), filename.slice(2)) : filename;
var AppleMessagesSource = class extends Source {
  identity;
  catalog = catalog;
  chats = catalog.get("chats");
  handles = catalog.get("handles");
  chatLookups = catalog.get("chatLookups");
  chatServices = catalog.get("chatServices");
  chatHandles = catalog.get("chatHandles");
  messages = catalog.get("messages");
  chatMessages = catalog.get("chatMessages");
  linkPreviews = catalog.get("linkPreviews");
  messageEdits = catalog.get("messageEdits");
  recoverableMessages = catalog.get("recoverableMessages");
  recoverableMessageParts = catalog.get("recoverableMessageParts");
  attachments = catalog.get("attachments");
  messageAttachments = catalog.get("messageAttachments");
  #scopes = /* @__PURE__ */ new WeakMap();
  path;
  scope;
  constructor(path = join2(messagesDirectory, "chat.db"), scope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.identity = `apple-messages:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new ChatDatabase(this.path);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, new ChatDatabaseVersion(this.path));
      let seen = version.current;
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const current = version.current;
          if (current === seen)
            continue;
          seen = current;
          yield streams;
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  async *extract(configuration, state, _partition, database) {
    const { stream } = configuration;
    const { name } = stream;
    if (!isStreamName(name))
      throw new TypeError(`Messages has no stream ${name}`);
    const records = validateRecords(stream, await this.#scan(name, database), "Messages");
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message2 of messages) {
      if ("type" in message2 || configuration.fileReads.length === 0) {
        yield message2;
        continue;
      }
      const { filename, availableLocally } = message2.data;
      yield {
        ...message2,
        file: availableLocally === true && typeof filename === "string" ? attachmentPath(filename) : null
      };
    }
  }
  async #scan(name, database) {
    const definition2 = definitions[name];
    let accepts = this.#scopes.get(database);
    if (accepts === void 0) {
      accepts = messageSelection(database, this.scope);
      this.#scopes.set(database, accepts);
    }
    const rows = database.all(definitions[name].sql).filter((row) => accepts(name, row));
    if (definition2.expand !== void 0)
      return rows.flatMap(definition2.expand);
    return Promise.all(rows.map(async (row) => {
      const record = recordFrom(name, row);
      if (name === "messages" && record.text === null)
        record.text = row.attributedBody instanceof Uint8Array ? attributedText(row.attributedBody) : null;
      if (name === "attachments")
        record.availableLocally = typeof row.filename === "string" && await access(attachmentPath(row.filename)).then(() => true, () => false);
      return record;
    }));
  }
};
function messageSelection(database, scope) {
  if (Object.keys(scope).length === 0)
    return () => true;
  const chats = new Set(database.all(definitions.chats.sql).filter((row) => selected(scope.collectionIds, row.guid) && selected(scope.accountIds, row.accountId)).map((row) => row.guid));
  const memberships = [
    ...database.all(definitions.chatMessages.sql),
    ...database.all(definitions.recoverableMessages.sql)
  ];
  const linked = new Set(memberships.filter((row) => chats.has(row.chatGuid)).map((row) => row.messageGuid));
  const messages = database.all(definitions.messages.sql).filter((row) => (scope.collectionIds === void 0 && scope.accountIds === void 0 || linked.has(row.guid)) && withinDates(scope, typeof row.date === "number" ? new Date(Date.UTC(2001, 0, 1) + row.date).toISOString() : null));
  const messageIds = new Set(messages.map((row) => row.guid));
  const attachmentIds = new Set(database.all(definitions.messageAttachments.sql).filter((row) => messageIds.has(row.messageGuid)).map((row) => row.attachmentGuid));
  const handles = new Set(messages.flatMap((row) => [
    JSON.stringify([row.handle, row.handleService]),
    JSON.stringify([row.otherHandle, row.otherHandleService])
  ]));
  for (const row of database.all(definitions.chatHandles.sql))
    if (chats.has(row.chatGuid))
      handles.add(JSON.stringify([row.handleId, row.handleService]));
  return (name, row) => {
    if (name === "chats")
      return chats.has(row.guid);
    if (name === "messages")
      return messageIds.has(row.guid);
    if (name === "attachments")
      return attachmentIds.has(row.guid);
    if (name === "handles")
      return handles.has(JSON.stringify([row.id, row.service]));
    return (!("chatGuid" in row) || chats.has(row.chatGuid)) && (!("messageGuid" in row) || messageIds.has(row.messageGuid));
  };
}

// packages/connectors/apple/messages/dist/messages-connector.js
var MessagesConnector = class extends AppleConnector {
  datedBy = "message date";
  fullDiskAccess = true;
  choices = [
    {
      stream: "chats",
      scope: "collectionIds",
      title: "chats",
      id: (row) => String(row.guid),
      label: (row) => String(row.displayName || row.chatIdentifier)
    }
  ];
  unscoped = [];
  storeCopies = [];
  access() {
    return "Only messages synced to this Mac can be imported.";
  }
  source(scope) {
    return new AppleMessagesSource(void 0, scope);
  }
};
export {
  MessagesConnector as default
};
