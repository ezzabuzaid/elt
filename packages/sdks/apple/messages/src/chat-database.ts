import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';

import {
  AppDatabase,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

import {
  type ChatColumnKind,
  type ChatTable,
  attachmentTable,
  chatLookupTable,
  chatMessageTable,
  chatServiceTable,
  chatTable,
  chatTables,
  handleTable,
  messageTable,
  recoverableMessageTable,
  recoverablePartTable,
} from './chat-tables.ts';
import {
  Attachment,
  ChatData,
  type ChatValue,
  type ChatValues,
  type HandleKey,
  Message,
  MessagePayload,
  MessageSummary,
  appleEpoch,
} from './chat-values.ts';

export const chatDatabasePath = join(homedir(), 'Library/Messages/chat.db');

export class MessagesUnavailableError extends Error {
  override name = 'MessagesUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Messages history at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Messages.app does not need to be open.`,
      { cause },
    );
  }
}

// chat.db's layout changes between macOS releases; reading one we have not
// verified would misplace fields.
export class MessagesSchemaError extends Error {
  override name = 'MessagesSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `Messages history at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}

// Messages stores times since 2001-01-01 UTC, in nanoseconds since macOS 10.13
// and in seconds before it and in attachment dates. Converted in SQL, because
// nanoseconds exceed 2^53 and node:sqlite refuses to read them.
const appleMilliseconds = (column: string) =>
  `CASE WHEN ${column} IS NULL OR ${column} = 0 THEN NULL WHEN abs(${column}) > 100000000000 THEN ${column} / 1000000 ELSE ${column} * 1000 END`;

// A table's exported columns as a SELECT list under its alias, each keeping
// its chat.db name; times arrive as milliseconds.
const select = (table: ChatTable, alias: string) =>
  Object.entries(table.columns)
    .map(([column, kind]) =>
      kind === 'time'
        ? `${appleMilliseconds(`${alias}.${column}`)} AS "${column}"`
        : `${alias}.${column} AS "${column}"`,
    )
    .join(', ');

function value(
  kind: ChatColumnKind,
  stored: SQLOutputValue | undefined,
): ChatValue {
  if (stored === undefined || stored === null) return null;
  if (kind === 'time') return new Date(appleEpoch + Number(stored));
  if (kind === 'flag') return stored !== 0;
  if (stored instanceof Uint8Array) return new ChatData(stored);
  return typeof stored === 'bigint' ? Number(stored) : stored;
}

const values = (
  table: ChatTable,
  row: Record<string, SQLOutputValue>,
): ChatValues =>
  Object.fromEntries(
    Object.entries(table.columns).map(([column, kind]) => [
      column,
      value(kind, row[column]),
    ]),
  );

function guid(stored: SQLOutputValue | undefined, what: string): string {
  if (typeof stored !== 'string') throw new TypeError(`${what} has no GUID`);
  return stored;
}

function handleKey(
  id: SQLOutputValue | undefined,
  service: SQLOutputValue | undefined,
): HandleKey | null {
  return typeof id === 'string' && typeof service === 'string'
    ? { id, service }
    : null;
}

function linkedHandle(
  id: SQLOutputValue | undefined,
  service: SQLOutputValue | undefined,
): HandleKey {
  const handle = handleKey(id, service);
  if (handle === null)
    throw new TypeError('A chat handle links a handle without id or service');
  return handle;
}

// A row of a table keyed by its GUID.
export type ChatRow = { readonly guid: string; readonly values: ChatValues };
// A row of a table that belongs to a chat.
export type ChatPartRow = {
  readonly chatGuid: string;
  readonly values: ChatValues;
};
// A handle linked to a chat.
export type ChatHandleRow = {
  readonly chatGuid: string;
  readonly handle: HandleKey;
};
// A link between a chat and a message.
export type ChatMessageRow = {
  readonly chatGuid: string;
  readonly messageGuid: string;
  readonly values: ChatValues;
};
// A part of a message recoverable after deletion.
export type RecoverablePartRow = {
  readonly chatGuid: string;
  readonly messageGuid: string;
  readonly partIndex: number;
  readonly values: ChatValues;
};
// A link between a message and an attachment.
export type MessageAttachmentRow = {
  readonly messageGuid: string;
  readonly attachmentGuid: string;
};

const required = Object.fromEntries(
  chatTables.map((table) => [
    table.name,
    [...table.joins, ...Object.keys(table.columns)],
  ]),
);

// A read-only view of Messages' chat.db pinned to one moment: chat.db runs in
// WAL mode, so a read transaction sees one snapshot however Messages writes.
// Relationships resolve local ROWIDs to GUIDs, which survive Messages in
// iCloud rebuilding chat.db. Hold it only while reading: an open read stops
// Messages checkpointing its WAL.
export class ChatDatabase implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, MessagesUnavailableError);
    this.#database.requireColumns(required, MessagesSchemaError);
  }

  chats(): ChatRow[] {
    return this.#database
      .all(`SELECT c.guid AS "@guid", ${select(chatTable, 'c')} FROM chat c`)
      .map((row) => ({
        guid: guid(row['@guid'], 'A chat'),
        values: values(chatTable, row),
      }));
  }

  handles(): ChatValues[] {
    return this.#database
      .all(`SELECT ${select(handleTable, 'h')} FROM handle h`)
      .map((row) => values(handleTable, row));
  }

  chatLookups(): ChatPartRow[] {
    return this.#database
      .all(
        `SELECT c.guid AS "@chatGuid", ${select(chatLookupTable, 'l')} FROM chat_lookup l JOIN chat c ON c.ROWID = l.chat`,
      )
      .map((row) => ({
        chatGuid: guid(row['@chatGuid'], 'A chat lookup'),
        values: values(chatLookupTable, row),
      }));
  }

  chatServices(): ChatPartRow[] {
    return this.#database
      .all(
        `SELECT c.guid AS "@chatGuid", ${select(chatServiceTable, 's')} FROM chat_service s JOIN chat c ON c.ROWID = s.chat`,
      )
      .map((row) => ({
        chatGuid: guid(row['@chatGuid'], 'A chat service'),
        values: values(chatServiceTable, row),
      }));
  }

  chatHandles(): ChatHandleRow[] {
    return this.#database
      .all(
        'SELECT c.guid AS "@chatGuid", h.id AS "@handleId", h.service AS "@handleService" FROM chat_handle_join j JOIN chat c ON c.ROWID = j.chat_id JOIN handle h ON h.ROWID = j.handle_id',
      )
      .map((row) => ({
        chatGuid: guid(row['@chatGuid'], 'A chat handle'),
        handle: linkedHandle(row['@handleId'], row['@handleService']),
      }));
  }

  messages(): Message[] {
    return this.#database
      .all(
        `SELECT m.guid AS "@guid", h.id AS "@handleId", h.service AS "@handleService", o.id AS "@otherHandleId", o.service AS "@otherHandleService", ${select(messageTable, 'm')} FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN handle o ON o.ROWID = m.other_handle`,
      )
      .map(
        (row) =>
          new Message(
            guid(row['@guid'], 'A message'),
            handleKey(row['@handleId'], row['@handleService']),
            handleKey(row['@otherHandleId'], row['@otherHandleService']),
            values(messageTable, row),
          ),
      );
  }

  chatMessages(): ChatMessageRow[] {
    return this.#links(
      chatMessageTable,
      'chat_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    );
  }

  recoverableMessages(): ChatMessageRow[] {
    return this.#links(
      recoverableMessageTable,
      'chat_recoverable_message_join j JOIN chat c ON c.ROWID = j.chat_id JOIN message m ON m.ROWID = j.message_id',
    );
  }

  recoverableMessageParts(): RecoverablePartRow[] {
    return this.#database
      .all(
        `SELECT c.guid AS "@chatGuid", m.guid AS "@messageGuid", p.part_index AS "@partIndex", ${select(recoverablePartTable, 'p')} FROM recoverable_message_part p JOIN chat c ON c.ROWID = p.chat_id JOIN message m ON m.ROWID = p.message_id`,
      )
      .map((row) => {
        const partIndex = row['@partIndex'];
        if (typeof partIndex !== 'number')
          throw new TypeError('A recoverable message part has no part_index');
        return {
          chatGuid: guid(row['@chatGuid'], 'A recoverable message part'),
          messageGuid: guid(row['@messageGuid'], 'A recoverable message part'),
          partIndex,
          values: values(recoverablePartTable, row),
        };
      });
  }

  attachments(): Attachment[] {
    return this.#database
      .all(
        `SELECT a.guid AS "@guid", ${select(attachmentTable, 'a')} FROM attachment a`,
      )
      .map(
        (row) =>
          new Attachment(
            guid(row['@guid'], 'An attachment'),
            values(attachmentTable, row),
          ),
      );
  }

  messageAttachments(): MessageAttachmentRow[] {
    return this.#database
      .all(
        'SELECT m.guid AS "@messageGuid", a.guid AS "@attachmentGuid" FROM message_attachment_join j JOIN message m ON m.ROWID = j.message_id JOIN attachment a ON a.ROWID = j.attachment_id',
      )
      .map((row) => ({
        messageGuid: guid(row['@messageGuid'], 'A message attachment'),
        attachmentGuid: guid(row['@attachmentGuid'], 'A message attachment'),
      }));
  }

  // Messages whose payload_data is stored, the rich links among them decoded
  // only when asked.
  payloads(): MessagePayload[] {
    return this.#database
      .all(
        'SELECT m.guid AS "@guid", m.payload_data AS payload FROM message m WHERE m.payload_data IS NOT NULL',
      )
      .map(
        (row) =>
          new MessagePayload(guid(row['@guid'], 'A message'), row.payload),
      );
  }

  // Messages whose message_summary_info is stored, their edit history decoded
  // only when asked.
  summaries(): MessageSummary[] {
    return this.#database
      .all(
        'SELECT m.guid AS "@guid", m.message_summary_info AS summary FROM message m WHERE m.message_summary_info IS NOT NULL',
      )
      .map(
        (row) =>
          new MessageSummary(guid(row['@guid'], 'A message'), row.summary),
      );
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  #links(table: ChatTable, from: string): ChatMessageRow[] {
    return this.#database
      .all(
        `SELECT c.guid AS "@chatGuid", m.guid AS "@messageGuid", ${select(table, 'j')} FROM ${from}`,
      )
      .map((row) => ({
        chatGuid: guid(row['@chatGuid'], `A ${table.name} row`),
        messageGuid: guid(row['@messageGuid'], `A ${table.name} row`),
        values: values(table, row),
      }));
  }
}

// Messages' chat.db, and the probe that reports each commit to it: Messages
// commits through a WAL it keeps open.
export class MessagesStore {
  readonly path: string;

  constructor(path: string = chatDatabasePath) {
    this.path = path;
  }

  open(): ChatDatabase {
    return new ChatDatabase(this.path);
  }

  version(): AppDatabaseVersion {
    return new AppDatabaseVersion(this.path, MessagesUnavailableError);
  }
}
