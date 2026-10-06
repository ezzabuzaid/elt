import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
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
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  plistJSON
} from "../../chunks/chunk-2VSN4436.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-BCEAKYBY.mjs";
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
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/messages/dist/chat-database.js
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// packages/sdks/apple/messages/dist/chat-tables.js
var order = [
  "text",
  "nullableText",
  "integer",
  "flag",
  "time",
  "data"
];
function table(name, joins, lists) {
  const columns = {};
  for (const kind of order)
    for (const column of (lists[kind] ?? "").split(/\s+/).filter(Boolean))
      columns[column] = kind;
  return { name, joins, columns };
}
var messageTable = table("message", ["ROWID", "guid", "handle_id", "other_handle"], {
  nullableText: "text subject service_center country service account account_guid cache_roomnames group_title associated_message_guid balloon_bundle_id expressive_send_style_id ck_record_id ck_record_change_tag destination_caller_id reply_to_guid thread_originator_guid thread_originator_part syndication_ranges synced_syndication_ranges bia_reference_id fallback_hash associated_message_emoji ck_chat_id",
  integer: "replace version type error item_type group_action_type share_status share_direction expire_state message_action_type message_source associated_message_type associated_message_range_location associated_message_range_length ck_sync_state sort_id part_count schedule_type schedule_state index_state filter_action filter_sub_action retry_count",
  flag: "is_delivered is_finished is_emote is_from_me is_empty is_delayed is_auto_reply is_prepared is_read is_system_message is_sent has_dd_results is_service_message is_forward was_downgraded is_archive cache_has_attachments was_data_detected was_deduplicated is_audio_message is_played is_expirable is_corrupt is_spam has_unseen_mention was_delivered_quietly did_notify_recipient was_detonated is_stewie is_sos is_critical is_kt_verified is_pending_satellite_send needs_relay sent_or_received_off_grid is_time_sensitive is_preview_sent is_preview_delivered",
  time: "date date_read date_delivered date_played time_expressive_send_played date_retracted date_edited date_recovered date_preview_sent date_preview_delivered date_updated",
  data: "attributedBody payload_data message_summary_info"
});
var chatTable = table("chat", ["ROWID", "guid"], {
  nullableText: "chat_identifier service_name room_name account_id account_login last_addressed_handle display_name group_id engram_id server_change_token original_group_id cloudkit_record_id last_addressed_sim_id",
  integer: "style state successful_query ck_sync_state syndication_type",
  flag: "is_archived is_filtered is_blackholed is_recovered is_deleting_incoming_messages is_pending_review",
  time: "last_read_message_timestamp syndication_date",
  data: "properties"
});
var handleTable = table("handle", ["ROWID"], {
  text: "id service",
  nullableText: "country uncanonicalized_id person_centric_id"
});
var attachmentTable = table("attachment", ["ROWID", "guid"], {
  text: "original_guid",
  nullableText: "filename uti mime_type transfer_name ck_record_id emoji_image_content_identifier emoji_image_short_description",
  integer: "transfer_state total_bytes ck_sync_state preview_generation_state sensitivity_analysis",
  flag: "is_outgoing is_sticker hide_attachment is_commsafety_sensitive",
  time: "created_date start_date",
  data: "user_info sticker_user_info attribution_info ck_server_change_token_blob preflight_info"
});
var chatLookupTable = table("chat_lookup", ["chat"], {
  text: "identifier domain",
  integer: "priority"
});
var chatServiceTable = table("chat_service", ["chat"], {
  text: "service"
});
var chatHandleTable = table("chat_handle_join", ["chat_id", "handle_id"], {});
var chatMessageTable = table("chat_message_join", ["chat_id", "message_id"], {
  integer: "index_state filter_action filter_sub_action",
  time: "message_date"
});
var recoverableMessageTable = table("chat_recoverable_message_join", ["chat_id", "message_id"], { integer: "ck_sync_state", time: "delete_date" });
var recoverablePartTable = table("recoverable_message_part", ["chat_id", "message_id", "part_index"], { integer: "ck_sync_state", time: "delete_date", data: "part_text" });
var messageAttachmentTable = table("message_attachment_join", ["message_id", "attachment_id"], {});
var chatTables = [
  messageTable,
  chatTable,
  handleTable,
  attachmentTable,
  chatLookupTable,
  chatServiceTable,
  chatHandleTable,
  chatMessageTable,
  recoverableMessageTable,
  recoverablePartTable,
  messageAttachmentTable
];

// packages/sdks/apple/messages/dist/chat-values.js
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// packages/sdks/apple/messages/dist/typedstream.js
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

// packages/sdks/apple/messages/dist/chat-values.js
var appleEpoch = Date.UTC(2001, 0, 1);
var ChatData = class {
  bytes;
  constructor(bytes) {
    this.bytes = bytes;
  }
  get archived() {
    return isBinaryPlist(this.bytes);
  }
  archive() {
    return decodeArchive(this.bytes);
  }
};
var attachmentPath = (filename) => filename.startsWith("~/") ? join(homedir(), filename.slice(2)) : filename;
var Message = class {
  guid;
  // The handles message.handle_id and message.other_handle point to; null
  // when the ROWID matches no handle.
  handle;
  otherHandle;
  values;
  constructor(guid2, handle, otherHandle, values2) {
    this.guid = guid2;
    this.handle = handle;
    this.otherHandle = otherHandle;
    this.values = values2;
  }
  // The message body: message.text, or when that is NULL the plain text of
  // the NSAttributedString archived in attributedBody, its first NSString.
  get text() {
    const stored = this.values.text ?? null;
    if (stored !== null)
      return stored;
    const body = this.values.attributedBody;
    return body instanceof ChatData ? attributedText(body.bytes) : null;
  }
};
var Attachment = class {
  guid;
  values;
  constructor(guid2, values2) {
    this.guid = guid2;
    this.values = values2;
  }
  // Whether the stored filename is reachable now; false without a filename,
  // or for a file not downloaded to this Mac.
  async availableLocally() {
    const { filename } = this.values;
    if (typeof filename !== "string")
      return false;
    return access(attachmentPath(filename)).then(() => true, () => false);
  }
};
var textOf = (value2) => typeof value2 === "string" ? value2 : null;
var MessagePayload = class {
  messageGuid;
  #payload;
  constructor(messageGuid2, payload) {
    this.messageGuid = messageGuid2;
    this.#payload = payload;
  }
  linkPreview() {
    if (!(this.#payload instanceof Uint8Array))
      throw new TypeError("chat.db message.payload_data is not a blob");
    const root = decodeArchive(this.#payload);
    const metadata = isDictionary(root) ? root.richLinkMetadata : void 0;
    if (!isDictionary(metadata))
      return null;
    return {
      url: textOf(metadata.URL),
      originalUrl: textOf(metadata.originalURL),
      title: textOf(metadata.title),
      summary: textOf(metadata.summary),
      siteName: textOf(metadata.siteName),
      itemType: textOf(metadata.itemType),
      creator: textOf(metadata.creator),
      metadata
    };
  }
};
function appleTime(value2) {
  if (value2 instanceof Date)
    return value2;
  if (typeof value2 !== "number" && typeof value2 !== "bigint")
    return null;
  const milliseconds = typeof value2 === "bigint" ? Number(value2 / 1000000n) : Math.abs(value2) > 1e11 ? value2 / 1e6 : value2 * 1e3;
  return new Date(appleEpoch + Math.trunc(milliseconds));
}
var MessageSummary = class {
  messageGuid;
  #summary;
  constructor(messageGuid2, summary) {
    this.messageGuid = messageGuid2;
    this.#summary = summary;
  }
  edits() {
    if (!(this.#summary instanceof Uint8Array))
      throw new TypeError("chat.db message.message_summary_info is not a blob");
    const summary = decodeArchive(this.#summary);
    const edited = isDictionary(summary) ? summary.ec : void 0;
    if (!isDictionary(edited))
      return [];
    return Object.entries(edited).flatMap(([part, versions]) => (Array.isArray(versions) ? versions : []).map((entry, version) => {
      const body = isDictionary(entry) ? entry.t : void 0;
      return {
        partIndex: Number(part),
        version,
        editedAt: isDictionary(entry) ? appleTime(entry.d) : null,
        text: body instanceof Uint8Array ? attributedText(body) : null,
        entry
      };
    }));
  }
};

// packages/sdks/apple/messages/dist/chat-database.js
var chatDatabasePath = join2(homedir2(), "Library/Messages/chat.db");
var MessagesUnavailableError = class extends Error {
  name = "MessagesUnavailableError";
  constructor(path, cause) {
    super(`Messages history at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Messages.app does not need to be open.`, { cause });
  }
};
var MessagesSchemaError = class extends Error {
  name = "MessagesSchemaError";
  constructor(path, missing) {
    super(`Messages history at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};
var appleMilliseconds = (column) => `CASE WHEN ${column} IS NULL OR ${column} = 0 THEN NULL WHEN abs(${column}) > 100000000000 THEN ${column} / 1000000 ELSE ${column} * 1000 END`;
var select = (table2, alias) => Object.entries(table2.columns).map(([column, kind]) => kind === "time" ? `${appleMilliseconds(`${alias}.${column}`)} AS "${column}"` : `${alias}.${column} AS "${column}"`).join(", ");
function value(kind, stored) {
  if (stored === void 0 || stored === null)
    return null;
  if (kind === "time")
    return new Date(appleEpoch + Number(stored));
  if (kind === "flag")
    return stored !== 0;
  if (stored instanceof Uint8Array)
    return new ChatData(stored);
  return typeof stored === "bigint" ? Number(stored) : stored;
}
var values = (table2, row) => Object.fromEntries(Object.entries(table2.columns).map(([column, kind]) => [
  column,
  value(kind, row[column])
]));
function guid(stored, what) {
  if (typeof stored !== "string")
    throw new TypeError(`${what} has no GUID`);
  return stored;
}
function handleKey(id3, service) {
  return typeof id3 === "string" && typeof service === "string" ? { id: id3, service } : null;
}
function linkedHandle(id3, service) {
  const handle = handleKey(id3, service);
  if (handle === null)
    throw new TypeError("A chat handle links a handle without id or service");
  return handle;
}
var required = Object.fromEntries(chatTables.map((table2) => [
  table2.name,
  [...table2.joins, ...Object.keys(table2.columns)]
]));
var ChatDatabase = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, MessagesUnavailableError);
    this.#database.requireColumns(required, MessagesSchemaError);
  }
  chats() {
    return this.#database.all(`SELECT c.guid AS "@guid", ${select(chatTable, "c")} FROM chat c`).map((row) => ({
      guid: guid(row["@guid"], "A chat"),
      values: values(chatTable, row)
    }));
  }
  handles() {
    return this.#database.all(`SELECT ${select(handleTable, "h")} FROM handle h`).map((row) => values(handleTable, row));
  }
  chatLookups() {
    return this.#database.all(`SELECT c.guid AS "@chatGuid", ${select(chatLookupTable, "l")} FROM chat_lookup l JOIN chat c ON c.ROWID = l.chat`).map((row) => ({
      chatGuid: guid(row["@chatGuid"], "A chat lookup"),
      values: values(chatLookupTable, row)
    }));
  }
  chatServices() {
    return this.#database.all(`SELECT c.guid AS "@chatGuid", ${select(chatServiceTable, "s")} FROM chat_service s JOIN chat c ON c.ROWID = s.chat`).map((row) => ({
      chatGuid: guid(row["@chatGuid"], "A chat service"),
      values: values(chatServiceTable, row)
    }));
  }
  chatHandles() {
    return this.#database.all('SELECT c.guid AS "@chatGuid", h.id AS "@handleId", h.service AS "@handleService" FROM chat_handle_join j JOIN chat c ON c.ROWID = j.chat_id JOIN handle h ON h.ROWID = j.handle_id').map((row) => ({
      chatGuid: guid(row["@chatGuid"], "A chat handle"),
      handle: linkedHandle(row["@handleId"], row["@handleService"])
    }));
  }
  messages() {
    return this.#database.all(`SELECT m.guid AS "@guid", h.id AS "@handleId", h.service AS "@handleService", o.id AS "@otherHandleId", o.service AS "@otherHandleService", ${select(messageTable, "m")} FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN handle o ON o.ROWID = m.other_handle`).map((row) => new Message(guid(row["@guid"], "A message"), handleKey(row["@handleId"], row["@handleService"]), handleKey(row["@otherHandleId"], row["@otherHandleService"]), values(messageTable, row)));
  }
  chatMessages() {
    return this.#links(chatMessageTable, "chat_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id");
  }
  recoverableMessages() {
    return this.#links(recoverableMessageTable, "chat_recoverable_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id");
  }
  recoverableMessageParts() {
    return this.#database.all(`SELECT c.guid AS "@chatGuid", m.guid AS "@messageGuid", p.part_index AS "@partIndex", ${select(recoverablePartTable, "p")} FROM recoverable_message_part p JOIN chat c ON c.ROWID = p.chat_id JOIN message m ON m.ROWID = p.message_id`).map((row) => {
      const partIndex = row["@partIndex"];
      if (typeof partIndex !== "number")
        throw new TypeError("A recoverable message part has no part_index");
      return {
        chatGuid: guid(row["@chatGuid"], "A recoverable message part"),
        messageGuid: guid(row["@messageGuid"], "A recoverable message part"),
        partIndex,
        values: values(recoverablePartTable, row)
      };
    });
  }
  attachments() {
    return this.#database.all(`SELECT a.guid AS "@guid", ${select(attachmentTable, "a")} FROM attachment a`).map((row) => new Attachment(guid(row["@guid"], "An attachment"), values(attachmentTable, row)));
  }
  messageAttachments() {
    return this.#database.all('SELECT m.guid AS "@messageGuid", a.guid AS "@attachmentGuid" FROM message_attachment_join j JOIN message m ON m.ROWID = j.message_id JOIN attachment a ON a.ROWID = j.attachment_id').map((row) => ({
      messageGuid: guid(row["@messageGuid"], "A message attachment"),
      attachmentGuid: guid(row["@attachmentGuid"], "A message attachment")
    }));
  }
  // Messages whose payload_data is stored, the rich links among them decoded
  // only when asked.
  payloads() {
    return this.#database.all('SELECT m.guid AS "@guid", m.payload_data AS payload FROM message m WHERE m.payload_data IS NOT NULL').map((row) => new MessagePayload(guid(row["@guid"], "A message"), row.payload));
  }
  // Messages whose message_summary_info is stored, their edit history decoded
  // only when asked.
  summaries() {
    return this.#database.all('SELECT m.guid AS "@guid", m.message_summary_info AS summary FROM message m WHERE m.message_summary_info IS NOT NULL').map((row) => new MessageSummary(guid(row["@guid"], "A message"), row.summary));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  #links(table2, from) {
    return this.#database.all(`SELECT c.guid AS "@chatGuid", m.guid AS "@messageGuid", ${select(table2, "j")} FROM ${from}`).map((row) => ({
      chatGuid: guid(row["@chatGuid"], `A ${table2.name} row`),
      messageGuid: guid(row["@messageGuid"], `A ${table2.name} row`),
      values: values(table2, row)
    }));
  }
};
var MessagesStore = class {
  path;
  constructor(path = chatDatabasePath) {
    this.path = path;
  }
  open() {
    return new ChatDatabase(this.path);
  }
  version() {
    return new AppDatabaseVersion(this.path, MessagesUnavailableError);
  }
};

// packages/sources/apple/messages/dist/messages-scan.js
var MessageSelection = class {
  #chats;
  #messages;
  #attachments;
  #handles;
  constructor(database, scope) {
    this.#chats = new Set(database.chats().filter(({ guid: guid2, values: values2 }) => selected(scope.collectionIds, guid2) && selected(scope.accountIds, values2.account_id)).map(({ guid: guid2 }) => guid2));
    const linked = new Set([...database.chatMessages(), ...database.recoverableMessages()].filter(({ chatGuid: chatGuid2 }) => this.#chats.has(chatGuid2)).map(({ messageGuid: messageGuid2 }) => messageGuid2));
    const messages = database.messages().filter((message) => {
      const { date } = message.values;
      return (scope.collectionIds === void 0 && scope.accountIds === void 0 || linked.has(message.guid)) && withinDates(scope, date instanceof Date ? date.toISOString() : null);
    });
    this.#messages = new Set(messages.map(({ guid: guid2 }) => guid2));
    this.#attachments = new Set(database.messageAttachments().filter(({ messageGuid: messageGuid2 }) => this.#messages.has(messageGuid2)).map(({ attachmentGuid }) => attachmentGuid));
    const handles = /* @__PURE__ */ new Set();
    for (const message of messages)
      for (const handle of [message.handle, message.otherHandle])
        if (handle !== null)
          handles.add(handleKey2(handle.id, handle.service));
    for (const { chatGuid: chatGuid2, handle } of database.chatHandles())
      if (this.#chats.has(chatGuid2) && handle !== null)
        handles.add(handleKey2(handle.id, handle.service));
    this.#handles = handles;
  }
  chat(guid2) {
    return this.#chats.has(guid2);
  }
  message(guid2) {
    return this.#messages.has(guid2);
  }
  attachment(guid2) {
    return this.#attachments.has(guid2);
  }
  handle(id3, service) {
    return this.#handles.has(handleKey2(id3, service));
  }
};
var handleKey2 = (id3, service) => JSON.stringify([id3, service]);
var MessagesScan = class {
  database;
  #scope;
  #selection;
  constructor(database, scope) {
    this.database = database;
    this.#scope = scope;
  }
  // null when the import takes everything.
  get selection() {
    if (Object.keys(this.#scope).length === 0)
      return null;
    this.#selection ??= new MessageSelection(this.database, this.#scope);
    return this.#selection;
  }
  async [Symbol.asyncDispose]() {
    this.database[Symbol.dispose]();
  }
};

// packages/sources/apple/messages/dist/apple-messages-stream.js
var AppleMessagesStream = class {
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async read(scan) {
    const { selection } = scan;
    const rows = this.rows(scan.database).filter((row) => selection === null || this.accepts(row, selection));
    const records = await Promise.all(rows.map((row) => this.records(row)));
    return validateRecords(this, records.flat(), "Messages");
  }
  // The file a record carries, for streams that support file reads.
  file(_record) {
    return null;
  }
};

// packages/sources/apple/messages/dist/messages-fields.js
var { text, id, nullableText, boolean, nullableTimestamp } = eventKitFields;
var nullableInteger = { type: ["integer", "null"] };
var kinds = {
  text: { schema: text, loads: "text" },
  nullableText: {
    schema: nullableText,
    loads: "text; NULL when chat.db stores NULL"
  },
  integer: {
    schema: nullableInteger,
    loads: "integer passed through unchanged; NULL when chat.db stores NULL"
  },
  flag: {
    schema: boolean,
    loads: "0/1 flag loaded as a boolean; any nonzero value is true"
  },
  time: {
    schema: nullableTimestamp,
    loads: "nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant truncated to milliseconds; NULL when chat.db stores 0 or NULL"
  },
  data: {
    schema: nullableText,
    loads: "bytes; a binary property list loads as JSON text, with NSKeyedArchiver archives unarchived, nested data as Base64, dates as ISO 8601 and integers beyond 2^53 as strings, and any other bytes load as Base64; NULL when chat.db stores NULL"
  }
};
var unverified = "Meaning not documented by Apple.";
var localStore = "Read from this Mac's chat.db, not from iCloud: it holds only what Messages keeps locally, and an import scope recorded in extraction coverage can narrow it further. Relationships use GUIDs, which survive the renumbering of local ROWIDs when Messages in iCloud rebuilds chat.db, and name source streams, not destination tables.";
var countAtMessageGrain = "Many-to-many: joining messages through this stream repeats a message once per linked row, so count messages at message grain, as distinct messageGuid.";
var chatGuid = {
  ...id,
  description: "chat.db chat.guid of the chat; refers to chats.guid within this source."
};
var messageGuid = {
  ...id,
  description: "chat.db message.guid of the message; refers to messages.guid within this source."
};
var camel = (column) => column.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
function kindOf(table2, column) {
  const kind = table2.columns[column];
  if (kind === void 0)
    throw new TypeError(`chat.db ${table2.name} has no column ${column}`);
  return kind;
}
var provenance = (table2, column) => `chat.db ${table2.name}.${column}: ${kinds[kindOf(table2, column)].loads}.`;
function columnField(table2, column, meaning) {
  return {
    ...kinds[kindOf(table2, column)].schema,
    description: meaning ?? `${provenance(table2, column)} ${unverified}`
  };
}
function tableFields(table2, meanings = {}) {
  const columns = Object.keys(table2.columns);
  const unknown = Object.keys(meanings).filter((column) => !columns.includes(column));
  if (unknown.length > 0)
    throw new TypeError(`Meanings for columns ${table2.name} does not list: ${unknown.join(", ")}`);
  return Object.fromEntries(columns.map((column) => [
    camel(column),
    columnField(table2, column, meanings[column])
  ]));
}
function encode(value2) {
  if (value2 instanceof Date)
    return value2.toISOString();
  if (value2 instanceof ChatData)
    return value2.archived ? plistJSON(value2.archive()) : Buffer.from(value2.bytes).toString("base64");
  return value2;
}
function tableRecord(table2, values2) {
  return Object.fromEntries(Object.keys(table2.columns).map((column) => [
    camel(column),
    encode(values2[column] ?? null)
  ]));
}

// packages/sources/apple/messages/dist/streams/attachments-stream.js
var properties = {
  guid: {
    ...eventKitFields.id,
    description: "chat.db attachment.guid; this stream's primary key. messageAttachments.attachmentGuid refers to it within this source."
  },
  ...tableFields(attachmentTable, {
    filename: `${provenance(attachmentTable, "filename")} The path Messages stores for the attachment's file, absolute or home-relative as ~/\u2026; the file is exported from this path. A path does not prove the file exists: see availableLocally.`,
    sensitivity_analysis: `${provenance(attachmentTable, "sensitivity_analysis")} Communication Safety's sensitivity analysis of the attachment, as Messages' own code records it beside whether the content is sensitive. Which value means what is not documented by Apple.`
  }),
  // Changes when an offloaded file downloads, so the diff reloads its bytes.
  availableLocally: {
    ...eventKitFields.boolean,
    description: "Whether the file at filename, with ~/ expanded to the home directory, was accessible to the export when this record was read; false when filename is NULL or the path is not accessible, such as a file not downloaded to this Mac. File bytes are exported only when true."
  }
};
var AttachmentsStream = class extends AppleMessagesStream {
  name = "attachments";
  primaryKey = ["guid"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: `One record per attachment in chat.db's attachment table, keyed by guid; messageAttachments links attachments to messages, many-to-many. A record can exist without a readable file: availableLocally reports whether the stored filename was reachable when read, which changes, for example when an offloaded file downloads, independently of message and attachment dates. ${localStore}`,
    properties,
    required: Object.keys(properties)
  };
  rows(database) {
    return database.attachments();
  }
  accepts(attachment, selection) {
    return selection.attachment(attachment.guid);
  }
  async records(attachment) {
    return [
      {
        guid: attachment.guid,
        ...tableRecord(attachmentTable, attachment.values),
        availableLocally: await attachment.availableLocally()
      }
    ];
  }
  // The original file, not a staged copy: attachments reach gigabytes and
  // readers only read it.
  file({ filename, availableLocally }) {
    return availableLocally === true && typeof filename === "string" ? attachmentPath(filename) : null;
  }
};

// packages/sources/apple/messages/dist/streams/chat-handles-stream.js
var properties2 = {
  chatGuid,
  handleId: {
    ...eventKitFields.text,
    description: "chat.db handle.id of the linked handle; together with handleService refers to handles (id, service) within this source."
  },
  handleService: {
    ...eventKitFields.text,
    description: "chat.db handle.service of the linked handle; together with handleId refers to handles (id, service) within this source."
  }
};
var ChatHandlesStream = class extends AppleMessagesStream {
  name = "chatHandles";
  primaryKey = ["chatGuid", "handleId", "handleService"];
  jsonSchema = {
    type: "object",
    description: `One record per handle linked to a chat in chat.db chat_handle_join, keyed by (chatGuid, handleId, handleService). chatGuid refers to chats.guid; handleId and handleService together join handles.id and handles.service. A chat can link many handles and a handle many chats. ${localStore}`,
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(database) {
    return database.chatHandles();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid);
  }
  records(row) {
    return [
      {
        chatGuid: row.chatGuid,
        handleId: row.handle.id,
        handleService: row.handle.service
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/chat-lookups-stream.js
var properties3 = {
  identifier: columnField(chatLookupTable, "identifier"),
  domain: columnField(chatLookupTable, "domain"),
  chatGuid,
  priority: columnField(chatLookupTable, "priority")
};
var ChatLookupsStream = class extends AppleMessagesStream {
  name = "chatLookups";
  primaryKey = ["identifier", "domain"];
  jsonSchema = {
    type: "object",
    description: `One record per row of chat.db chat_lookup, keyed by (identifier, domain), which chat.db keeps unique; what a lookup means is not documented by Apple. chatGuid refers to chats.guid. ${localStore}`,
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(database) {
    return database.chatLookups();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid);
  }
  records(row) {
    return [
      {
        identifier: encode(row.values.identifier ?? null),
        domain: encode(row.values.domain ?? null),
        chatGuid: row.chatGuid,
        priority: encode(row.values.priority ?? null)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/chat-messages-stream.js
var properties4 = {
  chatGuid,
  messageGuid,
  messageDate: columnField(chatMessageTable, "message_date"),
  indexState: columnField(chatMessageTable, "index_state"),
  filterAction: columnField(chatMessageTable, "filter_action", `${provenance(chatMessageTable, "filter_action")} A copy of the message's message.filter_action (messages.filterAction), which Messages keeps in step.`),
  filterSubAction: columnField(chatMessageTable, "filter_sub_action", `${provenance(chatMessageTable, "filter_sub_action")} A copy of the message's message.filter_sub_action (messages.filterSubAction), which Messages keeps in step.`)
};
var ChatMessagesStream = class extends AppleMessagesStream {
  name = "chatMessages";
  primaryKey = ["chatGuid", "messageGuid"];
  jsonSchema = {
    type: "object",
    description: `One record per chat and message link in chat.db chat_message_join, keyed by (chatGuid, messageGuid). chatGuid refers to chats.guid and messageGuid to messages.guid. ${countAtMessageGrain} A message recoverable after deletion is linked through recoverableMessages instead (observed on a live store; Apple does not document this table). ${localStore}`,
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(database) {
    return database.chatMessages();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }
  records(row) {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        messageDate: encode(row.values.message_date ?? null),
        indexState: encode(row.values.index_state ?? null),
        filterAction: encode(row.values.filter_action ?? null),
        filterSubAction: encode(row.values.filter_sub_action ?? null)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/chat-services-stream.js
var properties5 = {
  chatGuid,
  service: columnField(chatServiceTable, "service")
};
var ChatServicesStream = class extends AppleMessagesStream {
  name = "chatServices";
  primaryKey = ["chatGuid", "service"];
  jsonSchema = {
    type: "object",
    description: `One record per chat and service pair in chat.db chat_service, keyed by (chatGuid, service). chatGuid refers to chats.guid. ${localStore}`,
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(database) {
    return database.chatServices();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid);
  }
  records(row) {
    return [
      { chatGuid: row.chatGuid, service: encode(row.values.service ?? null) }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/chats-stream.js
var properties6 = {
  guid: {
    ...eventKitFields.id,
    description: "chat.db chat.guid; this stream's primary key. chatGuid in chatLookups, chatServices, chatHandles, chatMessages, recoverableMessages and recoverableMessageParts refers to it within this source."
  },
  ...tableFields(chatTable, {
    account_id: `${provenance(chatTable, "account_id")} An import scope's account selection matches chats by this value. ${unverified}`
  })
};
var ChatsStream = class extends AppleMessagesStream {
  name = "chats";
  primaryKey = ["guid"];
  jsonSchema = {
    type: "object",
    description: `One record per chat in chat.db's chat table, keyed by guid. Its handles are in chatHandles, its messages in chatMessages, or in recoverableMessages while recoverable after deletion, its lookup identifiers in chatLookups and its services in chatServices, each by chatGuid. ${localStore}`,
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(database) {
    return database.chats();
  }
  accepts(row, selection) {
    return selection.chat(row.guid);
  }
  records(row) {
    return [{ guid: row.guid, ...tableRecord(chatTable, row.values) }];
  }
};

// packages/sources/apple/messages/dist/streams/handles-stream.js
var properties7 = tableFields(handleTable, {
  id: `${provenance(handleTable, "id")} Unique only together with service: the same id can recur under another service. messages.handle, messages.otherHandle and chatHandles.handleId refer to it within this source, each together with its service field. ${unverified}`,
  service: `${provenance(handleTable, "service")} The second half of this stream's composite key (id, service). messages.handleService, messages.otherHandleService and chatHandles.handleService refer to it within this source. ${unverified}`
});
var HandlesStream = class extends AppleMessagesStream {
  name = "handles";
  primaryKey = ["id", "service"];
  jsonSchema = {
    type: "object",
    description: `One record per handle in chat.db's handle table, keyed by the composite (id, service): the same id can appear once per service, so every join uses both fields. messages.handle and messages.handleService join handles.id and handles.service, likewise messages.otherHandle and messages.otherHandleService; chatHandles joins by handleId and handleService. ${localStore}`,
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(database) {
    return database.handles();
  }
  accepts(row, selection) {
    return selection.handle(row.id, row.service);
  }
  records(row) {
    return [tableRecord(handleTable, row)];
  }
};

// packages/sources/apple/messages/dist/streams/link-previews-stream.js
var { text: text2, nullableText: nullableText2 } = eventKitFields;
var properties8 = {
  messageGuid,
  url: {
    ...nullableText2,
    description: "richLinkMetadata.URL, which Apple documents as the URL that returned the metadata, taking server-side redirects into account; NULL when absent or not text."
  },
  originalUrl: {
    ...nullableText2,
    description: "richLinkMetadata.originalURL, which Apple documents as the original URL of the metadata request; NULL when absent or not text."
  },
  title: {
    ...nullableText2,
    description: "richLinkMetadata.title, which Apple documents as a representative title for the URL; NULL when absent or not text."
  },
  summary: {
    ...nullableText2,
    description: `richLinkMetadata.summary; NULL when absent or not text. ${unverified}`
  },
  siteName: {
    ...nullableText2,
    description: `richLinkMetadata.siteName; NULL when absent or not text. ${unverified}`
  },
  itemType: {
    ...nullableText2,
    description: `richLinkMetadata.itemType; NULL when absent or not text. ${unverified}`
  },
  creator: {
    ...nullableText2,
    description: `richLinkMetadata.creator; NULL when absent or not text. ${unverified}`
  },
  metadata: {
    ...text2,
    description: 'The whole unarchived richLinkMetadata object as JSON, with its "$class", nested data as Base64 and dates as ISO 8601; keeps the fields not extracted above.'
  }
};
var LinkPreviewsStream = class extends AppleMessagesStream {
  name = "linkPreviews";
  primaryKey = ["messageGuid"];
  jsonSchema = {
    type: "object",
    description: `One record per message whose chat.db message.payload_data archive holds a richLinkMetadata object, keyed by messageGuid, which refers to messages.guid. metadata keeps the object's archived class as "$class"; url, originalUrl and title follow Apple's LPLinkMetadata documentation. Other messages have no record; messages.payloadData keeps the archive. ${localStore}`,
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(database) {
    return database.payloads();
  }
  accepts(payload, selection) {
    return selection.message(payload.messageGuid);
  }
  records(payload) {
    const preview = payload.linkPreview();
    if (preview === null)
      return [];
    return [
      {
        messageGuid: payload.messageGuid,
        url: preview.url,
        originalUrl: preview.originalUrl,
        title: preview.title,
        summary: preview.summary,
        siteName: preview.siteName,
        itemType: preview.itemType,
        creator: preview.creator,
        metadata: plistJSON(preview.metadata)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/message-attachments-stream.js
var properties9 = {
  messageGuid,
  attachmentGuid: {
    ...eventKitFields.id,
    description: "chat.db attachment.guid of the linked attachment; refers to attachments.guid within this source."
  }
};
var MessageAttachmentsStream = class extends AppleMessagesStream {
  name = "messageAttachments";
  primaryKey = ["messageGuid", "attachmentGuid"];
  jsonSchema = {
    type: "object",
    description: `One record per message and attachment link in chat.db message_attachment_join, keyed by (messageGuid, attachmentGuid). messageGuid refers to messages.guid and attachmentGuid to attachments.guid. ${countAtMessageGrain} ${localStore}`,
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(database) {
    return database.messageAttachments();
  }
  accepts(row, selection) {
    return selection.message(row.messageGuid);
  }
  records(row) {
    return [
      { messageGuid: row.messageGuid, attachmentGuid: row.attachmentGuid }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/message-edits-stream.js
var { integer, nullableTimestamp: nullableTimestamp2, nullableText: nullableText3, text: text3 } = eventKitFields;
var properties10 = {
  messageGuid,
  partIndex: {
    ...integer,
    description: `The "ec" key the entry is stored under, as a number, which the connector reads as the index of the edited message part. ${unverified}`
  },
  version: {
    ...integer,
    description: "The entry's 0-based position in its part's stored list, in stored order."
  },
  editedAt: {
    ...nullableTimestamp2,
    description: `The entry's "d" time: a property list date, or nanoseconds, or seconds for magnitudes up to 10^11, since 2001-01-01 UTC, converted to a UTC instant; NULL when d is absent or not a time. Which moment it records is not documented by Apple.`
  },
  text: {
    ...nullableText3,
    description: `Plain text of the entry's "t" NSAttributedString archive in typedstream form, its first NSString; NULL when t is absent, not bytes or holds no string.`
  },
  entry: {
    ...text3,
    description: 'The whole entry as JSON, with "t" as Base64 and dates as ISO 8601; keeps the keys not extracted above.'
  }
};
var MessageEditsStream = class extends AppleMessagesStream {
  name = "messageEdits";
  primaryKey = ["messageGuid", "partIndex", "version"];
  jsonSchema = {
    type: "object",
    description: `One record per edit-history entry that chat.db message.message_summary_info stores under "ec", keyed by (messageGuid, partIndex, version); messageGuid refers to messages.guid. Messages without that history have no record; messages.messageSummaryInfo keeps the archive. ${localStore}`,
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(database) {
    return database.summaries();
  }
  accepts(summary, selection) {
    return selection.message(summary.messageGuid);
  }
  records(summary) {
    return summary.edits().map((edit) => ({
      messageGuid: summary.messageGuid,
      partIndex: edit.partIndex,
      version: edit.version,
      editedAt: edit.editedAt?.toISOString() ?? null,
      text: edit.text,
      entry: plistJSON(edit.entry)
    }));
  }
};

// packages/sources/apple/messages/dist/streams/messages-stream.js
var { id: id2, nullableText: nullableText4 } = eventKitFields;
var properties11 = {
  guid: {
    ...id2,
    description: "chat.db message.guid; this stream's primary key. messageGuid in chatMessages, messageAttachments, messageEdits, linkPreviews, recoverableMessages and recoverableMessageParts refers to it within this source."
  },
  handle: {
    ...nullableText4,
    description: "chat.db handle.id of the handle message.handle_id points to; together with handleService refers to handles (id, service) within this source. NULL when message.handle_id matches no handle. Which participant it names is not documented by Apple."
  },
  handleService: {
    ...nullableText4,
    description: "chat.db handle.service of the handle message.handle_id points to; together with handle refers to handles (id, service) within this source. NULL when message.handle_id matches no handle."
  },
  otherHandle: {
    ...nullableText4,
    description: "chat.db handle.id of the handle message.other_handle points to; together with otherHandleService refers to handles (id, service) within this source. NULL when message.other_handle matches no handle. Which participant it names is not documented by Apple."
  },
  otherHandleService: {
    ...nullableText4,
    description: "chat.db handle.service of the handle message.other_handle points to; together with otherHandle refers to handles (id, service) within this source. NULL when message.other_handle matches no handle."
  },
  ...tableFields(messageTable, {
    text: "Message body: chat.db message.text, or, when that is NULL, the plain text of the NSAttributedString archived in message.attributedBody, which is its first NSString. NULL when neither holds text. attributedBody keeps the archive itself.",
    date: `${provenance(messageTable, "date")} An import date scope selects messages by this time; which moment Messages records is not documented by Apple.`,
    attributedBody: `${provenance(messageTable, "attributedBody")} Messages archives the message body here as an NSAttributedString in NeXT typedstream form, which is not a property list and so loads as Base64; text is decoded from it when message.text is NULL. Its other attributes are not decoded.`,
    payload_data: `${provenance(messageTable, "payload_data")} A richLinkMetadata object in it is decoded into the linkPreviews stream; the meaning of its other contents is not documented by Apple.`,
    message_summary_info: `${provenance(messageTable, "message_summary_info")} Its "ec" entry is decoded into the messageEdits stream; the meaning of its other keys is not documented by Apple.`,
    filter_action: `${provenance(messageTable, "filter_action")} The message-filter action Messages recorded for the message, as Messages' own code names it; Messages indexes it, and chatMessages.filterAction copies it. Which value means which action is not documented by Apple.`,
    filter_sub_action: `${provenance(messageTable, "filter_sub_action")} The sub-action of that filter. Messages' own code names SMS sub-actions such as Transactional, Promotional, Finance, Orders and Reminder; which value means which is not documented by Apple.`,
    retry_count: `${provenance(messageTable, "retry_count")} How many times Messages has retried sending the message, as its name and Messages' own retry count say; Messages' code picks unsent messages to send again while their count is below a maximum. Not documented by Apple.`
  })
};
var MessagesStream = class extends AppleMessagesStream {
  name = "messages";
  primaryKey = ["guid"];
  jsonSchema = {
    type: "object",
    description: `One record per message in chat.db's message table, keyed by guid. A message recoverable after deletion keeps its record, and its chat link is in recoverableMessages instead of chatMessages (observed on a live store; Apple does not document this table). handle and handleService join handles.id and handles.service, likewise otherHandle and otherHandleService. Chats link through chatMessages and attachments through messageAttachments; both are many-to-many, so joining through them repeats a message: count messages in this stream, or as distinct guid after such a join. Edit versions decoded from messageSummaryInfo are in messageEdits and rich links decoded from payloadData in linkPreviews. chat.db's iCloud deletion bookkeeping (deleted_messages, sync_deleted_*) is not exported. ${localStore}`,
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(database) {
    return database.messages();
  }
  accepts(message, selection) {
    return selection.message(message.guid);
  }
  records(message) {
    return [
      {
        guid: message.guid,
        handle: message.handle?.id ?? null,
        handleService: message.handle?.service ?? null,
        otherHandle: message.otherHandle?.id ?? null,
        otherHandleService: message.otherHandle?.service ?? null,
        ...tableRecord(messageTable, message.values),
        text: encode(message.text)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/recoverable-message-parts-stream.js
var properties12 = {
  chatGuid,
  messageGuid,
  partIndex: {
    ...eventKitFields.integer,
    description: `chat.db recoverable_message_part.part_index: integer passed through unchanged. ${unverified}`
  },
  deleteDate: columnField(recoverablePartTable, "delete_date"),
  partText: columnField(recoverablePartTable, "part_text"),
  ckSyncState: columnField(recoverablePartTable, "ck_sync_state")
};
var RecoverableMessagePartsStream = class extends AppleMessagesStream {
  name = "recoverableMessageParts";
  primaryKey = ["chatGuid", "messageGuid", "partIndex"];
  jsonSchema = {
    type: "object",
    description: `One record per message part in chat.db recoverable_message_part, for messages recoverable after deletion, keyed by (chatGuid, messageGuid, partIndex). chatGuid refers to chats.guid and messageGuid to messages.guid; (chatGuid, messageGuid) joins recoverableMessages. ${localStore}`,
    properties: properties12,
    required: Object.keys(properties12)
  };
  rows(database) {
    return database.recoverableMessageParts();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }
  records(row) {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        partIndex: row.partIndex,
        deleteDate: encode(row.values.delete_date ?? null),
        partText: encode(row.values.part_text ?? null),
        ckSyncState: encode(row.values.ck_sync_state ?? null)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/streams/recoverable-messages-stream.js
var properties13 = {
  chatGuid,
  messageGuid,
  deleteDate: columnField(recoverableMessageTable, "delete_date"),
  ckSyncState: columnField(recoverableMessageTable, "ck_sync_state")
};
var RecoverableMessagesStream = class extends AppleMessagesStream {
  name = "recoverableMessages";
  primaryKey = ["chatGuid", "messageGuid"];
  jsonSchema = {
    type: "object",
    description: `One record per chat and message link in chat.db chat_recoverable_message_join, keyed by (chatGuid, messageGuid): a message recoverable after deletion keeps its messages record and is linked to its chat here instead of in chatMessages (observed on a live store; Apple does not document this table). chatGuid refers to chats.guid and messageGuid to messages.guid; the message's parts are in recoverableMessageParts. ${countAtMessageGrain} ${localStore}`,
    properties: properties13,
    required: Object.keys(properties13)
  };
  rows(database) {
    return database.recoverableMessages();
  }
  accepts(row, selection) {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }
  records(row) {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        deleteDate: encode(row.values.delete_date ?? null),
        ckSyncState: encode(row.values.ck_sync_state ?? null)
      }
    ];
  }
};

// packages/sources/apple/messages/dist/apple-messages-source.js
var readers = {
  chats: new ChatsStream(),
  handles: new HandlesStream(),
  chatLookups: new ChatLookupsStream(),
  chatServices: new ChatServicesStream(),
  chatHandles: new ChatHandlesStream(),
  messages: new MessagesStream(),
  chatMessages: new ChatMessagesStream(),
  linkPreviews: new LinkPreviewsStream(),
  messageEdits: new MessageEditsStream(),
  recoverableMessages: new RecoverableMessagesStream(),
  recoverableMessageParts: new RecoverableMessagePartsStream(),
  attachments: new AttachmentsStream(),
  messageAttachments: new MessageAttachmentsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleMessagesSource = class extends Source {
  identity;
  catalog = catalog;
  chats = readers.chats.describe();
  handles = readers.handles.describe();
  chatLookups = readers.chatLookups.describe();
  chatServices = readers.chatServices.describe();
  chatHandles = readers.chatHandles.describe();
  messages = readers.messages.describe();
  chatMessages = readers.chatMessages.describe();
  linkPreviews = readers.linkPreviews.describe();
  messageEdits = readers.messageEdits.describe();
  recoverableMessages = readers.recoverableMessages.describe();
  recoverableMessageParts = readers.recoverableMessageParts.describe();
  attachments = readers.attachments.describe();
  messageAttachments = readers.messageAttachments.describe();
  path;
  scope;
  #store;
  constructor(path = chatDatabasePath, scope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new MessagesStore(path);
    this.identity = `apple-messages:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new MessagesScan(this.#store.open(), this.scope);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, this.#store.version());
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
  async *extract(configuration, state, _partition, scan) {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new TypeError(`Messages has no stream ${stream.name}`);
    const records = await reader.read(scan);
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ("type" in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield { ...message, file: reader.file(message.data) };
    }
  }
};

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
