import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setInterval } from 'node:timers/promises';
import type { ExtractionCoverage } from 'elt';
import {
  Catalog,
  type CopyConfiguration,
  diffGroupedSnapshot,
  diffSnapshot,
  type FieldSchema,
  type SchemaRecord,
  type SnapshotGroup,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  validateRecords,
} from 'elt';
import { readMailMime } from '../../platform/macos/mail-mime.ts';
import {
  assertMailFile,
  hashMailFile,
  type MailFile,
  MailSchemaError,
  MailStore,
  mailVersionDirectory,
  plistJSON,
  plistObject,
} from '../../platform/macos/mail-store.ts';
import osa from '../../platform/macos/osa.ts';
import type { PlistValue } from '../../platform/macos/plist.ts';
import { type ImportScope, selected, withinDates } from '../import-scope.ts';
import { localAppleStoreCoverage } from '../local-apple-store-coverage.ts';
import { mailStream, mailTables, tableStreams } from './mail-tables.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const flag = { type: 'boolean' } as const;
const partFields = {
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
const metadata = { id: text, properties: text } as const;
const scopedMetadata = { scope: text, ...metadata } as const;
const conditionFields = {
  scope: text,
  ownerId: text,
  position: { type: 'integer' },
  properties: text,
} as const;
const headersFields = {
  messageId: text,
  partId: text,
  position: { type: 'integer' },
  name: text,
  value: text,
  rawLineBase64: text,
} as const;
const fileFields = {
  messageId: text,
  relativePath: nullableText,
  availableLocally: flag,
  partial: { type: ['boolean', 'null'] },
  size: nullableNumber,
  sha256: nullableText,
} as const;

// Each stream describes every field for readers; the mapped type makes a
// missing description a compile error.
function described<const Fields extends Readonly<Record<string, FieldSchema>>>(
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

const plistProperties =
  'The property list converted to JSON: data values become Base64 strings, dates ISO 8601 strings and integers beyond 2^53 decimal strings. Kept as data; this source does not interpret its keys.';
const localMessageId =
  'Refers to messages.id within this source (the local id, not the Message-ID hash in messages.messageId).';
const partId =
  'Dotted MIME part number, such as 1 or 1.2. The root of a multipart message is TEXT; a single-part message is 1, as in the index. Equals indexedAttachments.attachmentId for attachments Mail indexes.';
const sha256 = 'SHA-256 of the bytes as lowercase hexadecimal';

const streams = {
  accounts: mailStream(
    'accounts',
    'One record per Mail account reported by Mail scripting, plus one On My Mac record for each local:// mailbox host that scripting does not list. Primary key id. The host of mailboxes.url matches id. properties is JSON data; no password or authentication property is read.',
    described(metadata, {
      id: 'Account id returned by Mail scripting, or the host of a local:// mailbox URL for an added On My Mac account. The host of mailboxes.url matches it within this source.',
      properties:
        'JSON object of the account properties read through Mail scripting: id, name, type, enabled, emailAddresses, fullName, userName, serverName, port, usesSsl and directory. An added On My Mac account has only type local and name On My Mac. Kept as data without interpretation.',
    }),
    ['id'],
    false,
  ),
  smtpServers: mailStream(
    'smtpServers',
    'One record per SMTP server reported by Mail scripting. Primary key id, the server name. No link to accounts is proven, so no join is stated and scoped imports omit this stream.',
    described(metadata, {
      id: 'Server name returned by Mail scripting.',
      properties:
        'JSON object of the server properties read through Mail scripting: name, userName, serverName, port, usesSsl and enabled. No password is read. Kept as data without interpretation.',
    }),
    ['id'],
    false,
  ),
  ...tableStreams,
  mailboxProperties: mailStream(
    'mailboxProperties',
    'One record per Info.plist file inside a .mbox directory of the current Mail store. Primary key relativePath. This source does not map these files to mailboxes.id, so no join is stated; scoped imports omit this stream.',
    described(
      { relativePath: text, properties: text },
      {
        relativePath:
          'Path of the Info.plist file relative to the current Mail version directory.',
        properties: plistProperties,
      },
    ),
    ['relativePath'],
    false,
  ),
  rules: mailStream(
    'rules',
    'One record per Mail rule in MailData/SyncedRules.plist (scope Synced) or MailData/UnsyncedRules.plist (scope Unsynced). Primary key (scope, id). Conditions are ruleConditions rows, joined by (scope, ownerId) to (scope, id). Scoped imports omit this stream.',
    described(
      { ...scopedMetadata, enabled: { type: ['boolean', 'null'] } },
      {
        scope:
          'Synced for a rule read from MailData/SyncedRules.plist, Unsynced for one read from MailData/UnsyncedRules.plist.',
        id: 'RuleId value of the rule; with scope, the primary key.',
        properties: `The whole rule dictionary, including its Criteria. ${plistProperties}`,
        enabled:
          'Value stored for this RuleId in MailData/RulesActiveState.plist; NULL when that file is absent or has no entry for the rule.',
      },
    ),
    ['scope', 'id'],
    false,
  ),
  ruleConditions: mailStream(
    'ruleConditions',
    "One record per entry of a rule's Criteria list, in stored order. Primary key (scope, ownerId, position). Join (scope, ownerId) to rules (scope, id) within this source. A rule without Criteria has no rows. Scoped imports omit this stream.",
    described(conditionFields, {
      scope:
        'Scope of the owning rule, Synced or Unsynced; joins to rules.scope together with ownerId.',
      ownerId:
        'RuleId of the owning rule; join (scope, ownerId) to rules (scope, id) within this source.',
      position:
        "Zero-based position of the condition in the rule's Criteria list.",
      properties: `The condition dictionary. ${plistProperties}`,
    }),
    ['scope', 'ownerId', 'position'],
    false,
  ),
  smartMailboxes: mailStream(
    'smartMailboxes',
    'One record per smart mailbox dictionary in MailData/SyncedSmartMailboxes.plist, including those nested under MailboxChildren. Primary key id. parentId refers to the containing smart mailbox. Conditions are smartMailboxConditions rows whose ownerId is id. Scoped imports omit this stream.',
    described(
      { ...metadata, parentId: nullableText },
      {
        id: 'MailboxID value of the smart mailbox.',
        properties: `The whole smart mailbox dictionary, including its MailboxCriteria and nested MailboxChildren. ${plistProperties}`,
        parentId:
          'Refers to smartMailboxes.id of the smart mailbox whose MailboxChildren contains this one; NULL at the top level.',
      },
    ),
    ['id'],
    false,
  ),
  smartMailboxConditions: mailStream(
    'smartMailboxConditions',
    "One record per entry of a smart mailbox's MailboxCriteria list, in stored order. Primary key (scope, ownerId, position). ownerId refers to smartMailboxes.id within this source; these conditions do not join to rules. Scoped imports omit this stream.",
    described(conditionFields, {
      scope:
        'Always Synced: only MailData/SyncedSmartMailboxes.plist is read. smartMailboxes has no scope field, so join on ownerId alone.',
      ownerId:
        'MailboxID of the owning smart mailbox; refers to smartMailboxes.id within this source.',
      position:
        "Zero-based position of the condition in the smart mailbox's MailboxCriteria list.",
      properties: `The condition dictionary. ${plistProperties}`,
    }),
    ['scope', 'ownerId', 'position'],
    false,
  ),
  signatures: mailStream(
    'signatures',
    'One record per .mailsignature file in the current Mail store. Primary key id. No link to accounts is stated; scoped imports omit this stream.',
    described(
      { id: text, content: text },
      {
        id: 'File name of the .mailsignature file without its extension.',
        content:
          'The whole file read as UTF-8 text, including its MIME headers; not parsed.',
      },
    ),
    ['id'],
    false,
  ),
  configuration: mailStream(
    'configuration',
    'One record per property list file under a MailData or Signatures directory of the current Mail store, except files under RemoteContentURLCache or BiomeStream. Primary key relativePath. It includes the rule and smart mailbox files that rules and smartMailboxes also read. Scoped imports omit this stream.',
    described(
      { relativePath: text, properties: text },
      {
        relativePath:
          'Path of the property list file relative to the current Mail version directory.',
        properties: plistProperties,
      },
    ),
    ['relativePath'],
    false,
  ),
  messageFiles: mailStream(
    'messageFiles',
    "One record per messages row, describing its EMLX message file on this Mac. Primary key messageId. The row exists even when no file is present: availableLocally is false and the file fields are NULL. EMLX files that no messages row names are not included. The transferred file is the original EMLX bytes, including Mail's leading byte count line and trailing property list.",
    described(fileFields, {
      messageId: localMessageId,
      relativePath:
        'Path of <id>.emlx or <id>.partial.emlx relative to the current Mail version directory; NULL when no file is present.',
      availableLocally:
        'Whether an EMLX file for this message was present when the run read the store. False does not mean the message was deleted.',
      partial:
        'True when the file is named <id>.partial.emlx, false when <id>.emlx; NULL when no file is present. This source does not interpret the name further; detached attachment bytes are resolved in messageParts and attachments.',
      size: 'Size of the EMLX file in bytes; NULL when no file is present.',
      sha256: `${sha256} of the whole EMLX file; NULL when no file is present.`,
    }),
    ['messageId'],
    true,
  ),
  messageHeaders: mailStream(
    'messageHeaders',
    'One record per header line of each MIME part of a locally available message file, in stored order; repeated header names stay separate rows. Primary key (messageId, partId, position). (messageId, partId) joins to messageParts (messageId, partId). Messages without a local file have no rows. An attached message/rfc822 is one part; its inner headers are not split out.',
    described(headersFields, {
      messageId: localMessageId,
      partId: `${partId} Joins to messageParts.partId with messageId.`,
      position:
        "Zero-based position of the header within its part's header block, preserving the stored order.",
      name: 'Header name as keyed by the MIME parser, in lowercase.',
      value:
        'Header value with folded lines joined and encoded words decoded to text; the original line is in rawLineBase64.',
      rawLineBase64:
        'Bytes of the whole header line as the MIME parser keeps it, including folded continuation lines joined with CRLF, as Base64.',
    }),
    ['messageId', 'partId', 'position'],
    false,
  ),
  messageParts: mailStream(
    'messageParts',
    'One record per MIME part, including multipart containers, of each locally available message file. Primary key (messageId, partId). parentPartId links a part to its container: join (messageId, parentPartId) to messageParts (messageId, partId). Messages without a local file have no rows (see messageFiles). A detached part whose separate file is missing stays as a row with availableLocally false. An attached message/rfc822 is one part; its inner parts are not expanded.',
    described(
      { ...partFields, text: nullableText },
      {
        messageId: localMessageId,
        partId,
        parentPartId:
          'partId of the containing multipart part; join (messageId, parentPartId) to messageParts (messageId, partId). NULL for the root part.',
        contentType:
          'Media type as parsed from Content-Type by the MIME parser, which supplies its own default when the header is absent; NULL when the parser reports none.',
        charset: 'Charset parameter of Content-Type; NULL when absent.',
        transferEncoding:
          'Content-Transfer-Encoding value; NULL when absent or empty.',
        disposition:
          'Content-Disposition type, such as attachment or inline; NULL when absent.',
        filename:
          "Filename as parsed from the part's headers by the MIME parser; NULL when absent.",
        contentId: 'Content-ID header value; NULL when absent.',
        isMultipart:
          'Whether the part is a multipart container; containers carry no decoded bytes.',
        isAttachment:
          'True when indexedAttachments lists this part, or when a non-multipart part has a filename, an attachment disposition, is an attached message or has a media type other than text/*.',
        declaredBytes:
          "Byte count from the part's X-Apple-Content-Length header; NULL when absent. A part with this count and an empty body is read from its separate file under the message's Attachments directory.",
        decodedBytes:
          'Bytes after transfer decoding, or the size of the separate file for a detached part; NULL for multipart containers and for detached parts whose file is missing.',
        availableLocally:
          'False only for a detached part whose separate file is missing on this Mac; true otherwise, including multipart containers.',
        sha256: `${sha256} after transfer decoding, or of the separate file for a detached part; NULL for multipart containers and missing detached parts.`,
        text: 'Text of a text/* part decoded with its charset (UTF-8 when none is declared), including a detached part read from its separate file; NULL for other media types, multipart containers and missing detached parts. Decoded from the message itself; no document parser is applied.',
      },
    ),
    ['messageId', 'partId'],
    false,
  ),
  attachments: mailStream(
    'attachments',
    'One record per attachment: each MIME part with isAttachment true in a locally available message file, plus each indexedAttachments row whose part was not found in one (index-only rows). Index attachment metadata can exist before the message or attachment file is downloaded. Primary key (messageId, partId), the same key as messageParts and as (message, attachmentId) in indexedAttachments. Index-only rows have NULL MIME fields. availableLocally tells whether the bytes are on this Mac; the transferred file is the decoded attachment, and an attached message stays one complete file.',
    described(partFields, {
      messageId: localMessageId,
      partId,
      parentPartId:
        'partId of the containing multipart part; join (messageId, parentPartId) to messageParts (messageId, partId). NULL for a root part and for index-only rows.',
      contentType:
        'Media type as parsed from Content-Type by the MIME parser; NULL for index-only rows or when the parser reports none.',
      charset:
        'Charset parameter of Content-Type; NULL when absent or for index-only rows.',
      transferEncoding:
        'Content-Transfer-Encoding value; NULL when absent, empty or for index-only rows.',
      disposition:
        'Content-Disposition type, such as attachment or inline; NULL when absent or for index-only rows.',
      filename:
        "Filename as parsed from the part's headers by the MIME parser; for index-only rows, the name in indexedAttachments.name. NULL when neither exists.",
      contentId:
        'Content-ID header value; NULL when absent or for index-only rows.',
      isMultipart:
        'Whether the part is a multipart container; false for index-only rows.',
      isAttachment: 'Always true in this stream.',
      declaredBytes:
        "Byte count from the part's X-Apple-Content-Length header; NULL when absent or for index-only rows.",
      decodedBytes:
        "Bytes after transfer decoding, or the size of the separate file under the message's Attachments directory; NULL when the bytes are not on this Mac.",
      availableLocally:
        'Whether the attachment bytes are on this Mac. False for a detached or index-only attachment whose file has not been downloaded; a later run updates the row once the file appears.',
      sha256: `${sha256} of the attachment; NULL when the bytes are not on this Mac.`,
    }),
    ['messageId', 'partId'],
    true,
  ),
};
const catalog = new Catalog(Object.values(streams));
type StreamName = keyof typeof streams;

// Streams read from each message's files, one snapshot group per message.
const messageStreams = [
  'messageFiles',
  'messageHeaders',
  'messageParts',
  'attachments',
] as const;
type MessageStream = (typeof messageStreams)[number];
const isMessageStream = (name: StreamName): name is MessageStream =>
  (messageStreams as readonly string[]).includes(name);

// Part of every message group's fingerprint: raise it whenever parsing or a
// message stream's records change, so saved messages are read again.
const messageParserVersion = 1;

type Entry = { data: Record<string, unknown>; file: string | null };
type IndexedAttachment = Record<string, unknown> & { message: string };
type MessageInputs = {
  detached: Map<string, [string, MailFile[]][]>;
  indexed: Map<string, IndexedAttachment[]>;
};

function requiredString(
  object: Record<string, PlistValue>,
  key: string,
): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '')
    throw new MailSchemaError(`Mail configuration has no ${key}`);
  return value;
}

function list(value: PlistValue): PlistValue[] {
  if (!Array.isArray(value))
    throw new MailSchemaError('Mail configuration is not a list');
  return value;
}

const accountsScript = `
  // apple-mail:account-metadata
  const mail = Application('/System/Applications/Mail.app');
  const accounts = mail.accounts().map(a => ({ id: a.id(), name: a.name(), type: String(a.accountType()), enabled: a.enabled(), emailAddresses: a.emailAddresses(), fullName: a.fullName(), userName: a.userName(), serverName: a.serverName(), port: a.port(), usesSsl: a.usesSsl(), directory: String(a.accountDirectory()) }));
  const smtpServers = mail.smtpServers().map(s => ({ name: s.name(), userName: s.userName(), serverName: s.serverName(), port: s.port(), usesSsl: s.usesSsl(), enabled: s.enabled() }));
  JSON.stringify({ accounts, smtpServers });
`;

// These native records have no proven account/message ownership. A restricted
// import omits them rather than copying unrelated settings or guessing joins.
export const restrictedMailStreams = [
  'messageMetadata',
  'dataDetectionResults',
  'protectedMessageData',
  'smtpServers',
  'mailboxProperties',
  'configuration',
  'rules',
  'ruleConditions',
  'smartMailboxes',
  'smartMailboxConditions',
  'signatures',
] as const;

function mailSelection(store: MailStore, scope: ImportScope) {
  if (Object.keys(scope).length === 0) return () => true;
  const rows = (name: keyof typeof mailTables) =>
    store.database.prepare(mailTables[name].sql).all();
  const mailboxes = new Set<unknown>(
    rows('mailboxes')
      .filter((row) => {
        const account =
          typeof row.url === 'string'
            ? URL.parse(row.url)?.hostname
            : undefined;
        return (
          selected(scope.accountIds, account) &&
          selected(scope.collectionIds, row.id)
        );
      })
      .map((row) => row.id),
  );
  const labelled = new Set<unknown>(
    rows('messageMailboxes')
      .filter((row) => mailboxes.has(row.mailboxId))
      .map((row) => row.messageId),
  );
  const messages = rows('messages').filter(
    (row) =>
      (mailboxes.has(row.mailbox) ||
        mailboxes.has(row.remoteMailbox) ||
        labelled.has(row.id)) &&
      withinDates(scope, row.dateReceived ?? row.dateSent),
  );
  const ids = new Set<unknown>(messages.map((row) => row.id));
  const hashes = new Set<unknown>(messages.map((row) => row.messageId));
  const globals = new Set<unknown>(messages.map((row) => row.globalMessageId));
  const recipients = rows('recipients').filter((row) => ids.has(row.message));
  const addresses = new Set<unknown>([
    ...messages.map((row) => row.sender),
    ...recipients.map((row) => row.address),
  ]);
  const addressText = new Set<unknown>(
    rows('addresses')
      .filter((row) => addresses.has(row.id))
      .map((row) => row.address),
  );
  const servers = new Set<unknown>(
    rows('serverMessages')
      .filter((row) => ids.has(row.message) && mailboxes.has(row.mailbox))
      .map((row) => row.id),
  );
  const conversations = new Set<unknown>(
    rows('conversationMessages')
      .filter((row) => hashes.has(row.messageId))
      .map((row) => row.conversationId),
  );
  const links = new Set<unknown>(
    rows('messageRichLinks')
      .filter((row) => globals.has(row.globalMessageId))
      .map((row) => row.richLink),
  );
  const summaries = new Set<unknown>(
    rows('messageGlobalData')
      .filter((row) => globals.has(row.id))
      .map((row) => row.generatedSummary),
  );
  const brands = new Set<unknown>(messages.map((row) => row.brandIndicator));
  const businesses = new Set<unknown>(
    rows('businessAddresses')
      .filter((row) => addresses.has(row.address))
      .map((row) => row.business),
  );
  const senders = new Set<unknown>(
    rows('senderAddresses')
      .filter((row) => addresses.has(row.address))
      .map((row) => row.sender),
  );
  const subjects = new Set<unknown>(messages.map((row) => row.subject));
  const texts = new Set<unknown>(messages.map((row) => row.summary));
  return (name: StreamName, row: Record<string, unknown>): boolean => {
    switch (name) {
      case 'accounts':
        return selected(scope.accountIds, row.id);
      case 'mailboxes':
        return mailboxes.has(row.id);
      case 'messages':
        return ids.has(row.id);
      case 'recipients':
      case 'indexedAttachments':
      case 'messageReferences':
        return ids.has(row.message);
      case 'messageFiles':
      case 'messageHeaders':
      case 'messageParts':
      case 'attachments':
      case 'events':
        return ids.has(row.messageId);
      case 'messageMailboxes':
        return ids.has(row.messageId) && mailboxes.has(row.mailboxId);
      case 'serverMessages':
        return servers.has(row.id);
      case 'serverMessageMailboxes':
        return servers.has(row.serverMessage) && mailboxes.has(row.label);
      case 'conversationMessages':
        return hashes.has(row.messageId);
      case 'conversations':
        return conversations.has(row.conversationId);
      case 'messageGlobalData':
        return globals.has(row.id);
      case 'addresses':
        return addresses.has(row.id);
      case 'addressMetadata':
        return addressText.has(row.address);
      case 'subjects':
        return subjects.has(row.id);
      case 'summaries':
        return texts.has(row.id);
      case 'generatedSummaries':
        return summaries.has(row.id);
      case 'messageRichLinks':
        return globals.has(row.globalMessageId);
      case 'richLinks':
        return links.has(row.id);
      case 'brandIndicators':
        return brands.has(row.id);
      case 'brandIndicatorEvidence':
        return brands.has(row.brandIndicator);
      case 'businessAddresses':
        return addresses.has(row.address);
      case 'businesses':
        return businesses.has(row.id);
      case 'businessCategories':
        return businesses.has(row.business);
      case 'senderAddresses':
        return addresses.has(row.address);
      case 'senders':
        return senders.has(row.id);
      default:
        return false;
    }
  };
}

class MailScan implements AsyncDisposable {
  readonly accepts: (name: StreamName, row: Record<string, unknown>) => boolean;
  #accounts: Promise<{
    accounts: SchemaRecord<typeof metadata>[];
    smtpServers: SchemaRecord<typeof metadata>[];
  }> | null = null;
  #inputs: MessageInputs | null = null;

  constructor(
    readonly store: MailStore,
    scope: ImportScope = {},
  ) {
    this.accepts = mailSelection(store, scope);
  }

  // Each message's inputs besides its .emlx, gathered once per scan: detached
  // files by part, and the attachment rows the index knows for it.
  #messageInputs(): MessageInputs {
    this.#inputs ??= (() => {
      const detached = new Map<string, [string, MailFile[]][]>();
      for (const [key, files] of [...this.store.attachments].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const id = key.slice(0, key.indexOf(':'));
        detached.set(id, [...(detached.get(id) ?? []), [key, files]]);
      }
      const indexed = new Map<string, IndexedAttachment[]>();
      for (const row of this.store.database
        .prepare(
          'SELECT CAST(message AS TEXT) AS message, attachment_id, name FROM attachments ORDER BY ROWID',
        )
        .all()) {
        if (!this.accepts('indexedAttachments', row)) continue;
        const message = row.message as string;
        indexed.set(message, [
          ...(indexed.get(message) ?? []),
          { ...row, message },
        ]);
      }
      return { detached, indexed };
    })();
    return this.#inputs;
  }

  // Everything a message's records are read from. The .emlx and detached
  // files are identified by their stat (device, inode, size, and mtime and
  // ctime in nanoseconds); a rewrite within one timestamp tick still changes
  // ctime, and a file that changes while it is read fails the read, so a
  // matching fingerprint means the saved records came from these bytes.
  #fingerprint(id: string, file: MailFile | undefined): string {
    const { detached, indexed } = this.#messageInputs();
    const identity = ({ path, version }: MailFile) => [
      relative(this.store.path, path),
      version,
    ];
    return createHash('sha256')
      .update(
        JSON.stringify([
          messageParserVersion,
          file === undefined ? null : identity(file),
          (detached.get(id) ?? []).map(([key, files]) => [
            key,
            files.map(identity),
          ]),
          (indexed.get(id) ?? []).map((row) => [row.attachment_id, row.name]),
        ]),
      )
      .digest('base64url');
  }

  // One group per selected message, in index order. Selection runs on every
  // scan; only reading a message whose inputs are unchanged is skipped.
  async *groups(name: MessageStream): AsyncGenerator<SnapshotGroup<Entry>> {
    const { indexed } = this.#messageInputs();
    const listed = new Set<string>();
    for (const row of this.store.database
      .prepare('SELECT CAST(ROWID AS TEXT) AS id FROM messages ORDER BY ROWID')
      .iterate()) {
      if (!this.accepts('messages', row)) continue;
      const id = row.id as string;
      listed.add(id);
      const file = this.store.messages.get(id);
      if (
        file === undefined &&
        (name === 'messageHeaders' ||
          name === 'messageParts' ||
          (name === 'attachments' && !indexed.has(id)))
      )
        continue;
      yield {
        key: id,
        fingerprint: this.#fingerprint(id, file),
        records: () => this.#messageEntries(name, id, file),
      };
    }
    if (name !== 'attachments') return;
    // The index can know an attachment of a message it no longer lists.
    for (const [id, rows] of indexed)
      if (!listed.has(id))
        yield {
          key: id,
          fingerprint: this.#fingerprint(id, undefined),
          records: () => this.#indexedEntries(rows),
        };
  }

  async *#messageEntries(
    name: MessageStream,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<Entry> {
    if (name === 'messageFiles') {
      const data: SchemaRecord<typeof fileFields> = {
        messageId: id,
        relativePath:
          file === undefined ? null : relative(this.store.path, file.path),
        availableLocally: file !== undefined,
        partial:
          file === undefined ? null : file.path.endsWith('.partial.emlx'),
        size: file === undefined ? null : file.size,
        sha256: file === undefined ? null : await hashMailFile(file),
      };
      yield { data, file: file === undefined ? null : file.path };
      if (file !== undefined) await assertMailFile(file);
      return;
    }
    // Index rows no MIME part claimed; attachments reports them on their own.
    const unclaimed = new Map(
      (this.#messageInputs().indexed.get(id) ?? []).map((row) => [
        String(row.attachment_id),
        row,
      ]),
    );
    if (file !== undefined) {
      const { headers, parts } = await readMailMime(
        this.store,
        id,
        file,
        name === 'messageHeaders',
        name === 'attachments',
        (part) =>
          name === 'messageParts' ||
          part.isAttachment ||
          unclaimed.has(part.partId),
      );
      try {
        if (name === 'messageHeaders')
          for (const header of headers)
            yield { data: { ...header }, file: null };
        else
          for (const part of parts) {
            const indexed = unclaimed.delete(part.record.partId);
            part.record.isAttachment ||= indexed;
            if (name === 'messageParts')
              yield { data: { ...part.record, text: part.text }, file: null };
            else if (part.record.isAttachment)
              yield { data: { ...part.record }, file: part.path };
          }
      } finally {
        for (const part of parts) if (part.path !== null) await rm(part.path);
      }
    }
    if (name === 'attachments') yield* this.#indexedEntries(unclaimed.values());
  }

  // Attachments the index knows before their message or MIME file arrives.
  async *#indexedEntries(
    rows: Iterable<IndexedAttachment>,
  ): AsyncGenerator<Entry> {
    for (const row of rows) {
      const key = `${row.message}:${row.attachment_id}`;
      if (
        typeof row.attachment_id !== 'string' ||
        !/^\d+(?:\.\d+)*$/.test(row.attachment_id)
      )
        throw new MailSchemaError(
          `Invalid indexed Mail attachment part ${key}`,
        );
      const candidates = this.store.attachments.get(key);
      if (candidates !== undefined && candidates.length !== 1)
        throw new MailSchemaError(`Ambiguous indexed Mail attachment ${key}`);
      const file = candidates?.[0];
      const record: SchemaRecord<typeof partFields> = {
        messageId: row.message,
        partId: row.attachment_id,
        parentPartId: null,
        contentType: null,
        charset: null,
        transferEncoding: null,
        disposition: null,
        filename: row.name as string | null,
        contentId: null,
        isMultipart: false,
        isAttachment: true,
        declaredBytes: null,
        decodedBytes: file === undefined ? null : file.size,
        availableLocally: file !== undefined,
        sha256: file === undefined ? null : await hashMailFile(file),
      };
      let path: string | null = null;
      if (file !== undefined) {
        path = join(
          this.store.scratch.path,
          `indexed-${row.message}-${row.attachment_id}${extname(file.path)}`,
        );
        await assertMailFile(file);
        await copyFile(file.path, path);
        await assertMailFile(file);
      }
      try {
        yield { data: record, file: path };
      } finally {
        if (path !== null) await rm(path);
      }
    }
  }

  async #accountMetadata() {
    let value: unknown;
    try {
      value = JSON.parse(await osa.execute(accountsScript));
    } catch (cause) {
      throw new Error(
        'Mail account metadata requires Automation access to Mail for the exporting process.',
        { cause },
      );
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      !('accounts' in value) ||
      !('smtpServers' in value) ||
      !Array.isArray(value.accounts) ||
      !Array.isArray(value.smtpServers)
    )
      throw new MailSchemaError(
        'Mail scripting returned invalid account metadata',
      );
    const accounts = value.accounts.map((account: unknown) => {
      if (
        account === null ||
        typeof account !== 'object' ||
        !('id' in account) ||
        typeof account.id !== 'string'
      )
        throw new MailSchemaError(
          'Mail scripting returned an account without an ID',
        );
      return { id: account.id, properties: JSON.stringify(account) };
    });
    for (const row of this.store.database
      .prepare('SELECT url FROM mailboxes ORDER BY ROWID')
      .iterate()) {
      const url = new URL(row.url as string);
      if (
        url.protocol === 'local:' &&
        !accounts.some((account) => account.id === url.hostname)
      )
        accounts.push({
          id: url.hostname,
          properties: JSON.stringify({ type: 'local', name: 'On My Mac' }),
        });
    }
    const smtpServers = value.smtpServers.map((server: unknown) => {
      if (
        server === null ||
        typeof server !== 'object' ||
        !('name' in server) ||
        typeof server.name !== 'string'
      )
        throw new MailSchemaError(
          'Mail scripting returned an SMTP server without a name',
        );
      return { id: server.name, properties: JSON.stringify(server) };
    });
    return { accounts, smtpServers };
  }

  async *read(name: StreamName): AsyncGenerator<Entry> {
    if (name in mailTables) {
      const definition = mailTables[name as keyof typeof mailTables];
      for (const row of this.store.database.prepare(definition.sql).iterate()) {
        if (!this.accepts(name, row)) continue;
        for (const column of definition.blobs)
          if (row[column] instanceof Uint8Array)
            row[column] = Buffer.from(row[column]).toString('base64');
        yield { data: { ...row }, file: null };
      }
      return;
    }
    if (name === 'accounts' || name === 'smtpServers') {
      this.#accounts ??= this.#accountMetadata();
      for (const data of (await this.#accounts)[name])
        if (this.accepts(name, data)) yield { data, file: null };
      return;
    }
    if (isMessageStream(name)) {
      for await (const group of this.groups(name)) yield* group.records();
      return;
    }
    if (name === 'mailboxProperties' || name === 'configuration') {
      for (const path of [...this.store.plists.keys()].sort()) {
        const mailbox =
          path.endsWith('/Info.plist') &&
          path.split('/').some((part) => part.endsWith('.mbox'));
        const configuration =
          /(^|\/)(Signatures|MailData)\//.test(path) &&
          !/(RemoteContentURLCache|BiomeStream)\//.test(path);
        if (
          (name === 'mailboxProperties' && !mailbox) ||
          (name === 'configuration' && !configuration)
        )
          continue;
        const value = await this.store.plist(path);
        if (value === null)
          throw new MailSchemaError(`Mail configuration disappeared: ${path}`);
        yield {
          data: { relativePath: path, properties: plistJSON(value) },
          file: null,
        };
      }
      return;
    }
    if (name === 'signatures') {
      for (const file of this.store.signatures)
        yield { data: await this.store.signature(file), file: null };
      return;
    }
    if (name === 'rules' || name === 'ruleConditions') {
      const activeValue = await this.store.plist(
        'MailData/RulesActiveState.plist',
      );
      const active = activeValue === null ? null : plistObject(activeValue);
      for (const scope of ['Synced', 'Unsynced']) {
        const value = await this.store.plist(`MailData/${scope}Rules.plist`);
        if (value === null) continue;
        for (const entry of list(value)) {
          const rule = plistObject(entry);
          const id = requiredString(rule, 'RuleId');
          const enabled = active === null ? undefined : active[id];
          if (name === 'rules')
            yield {
              data: {
                scope,
                id,
                properties: plistJSON(rule),
                enabled: enabled === undefined ? null : enabled,
              },
              file: null,
            };
          else if (rule.Criteria !== undefined)
            for (const [position, condition] of list(rule.Criteria).entries())
              yield {
                data: {
                  scope,
                  ownerId: id,
                  position,
                  properties: plistJSON(condition),
                },
                file: null,
              };
        }
      }
      return;
    }
    const value = await this.store.plist('MailData/SyncedSmartMailboxes.plist');
    if (value === null) return;
    function* smart(
      entries: PlistValue[],
      parentId: string | null,
    ): Generator<Record<string, unknown>> {
      for (const entry of entries) {
        const mailbox = plistObject(entry);
        const id = requiredString(mailbox, 'MailboxID');
        if (name === 'smartMailboxes')
          yield { id, parentId, properties: plistJSON(mailbox) };
        else if (mailbox.MailboxCriteria !== undefined)
          for (const [position, criterion] of list(
            mailbox.MailboxCriteria,
          ).entries())
            yield {
              scope: 'Synced',
              ownerId: id,
              position,
              properties: plistJSON(criterion),
            };
        if (mailbox.MailboxChildren !== undefined)
          yield* smart(list(mailbox.MailboxChildren), id);
      }
    }
    for (const data of smart(list(value), null)) yield { data, file: null };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.store[Symbol.asyncDispose]();
  }
}

export class AppleMailSource extends Source<MailScan> {
  readonly indexedAttachments = streams.indexedAttachments;
  readonly serverMessages = streams.serverMessages;
  readonly serverMessageMailboxes = streams.serverMessageMailboxes;
  readonly conversationMessages = streams.conversationMessages;
  readonly messageReferences = streams.messageReferences;
  readonly messageGlobalData = streams.messageGlobalData;
  readonly subjects = streams.subjects;
  readonly summaries = streams.summaries;
  readonly generatedSummaries = streams.generatedSummaries;
  readonly messageMetadata = streams.messageMetadata;
  readonly dataDetectionResults = streams.dataDetectionResults;
  readonly richLinks = streams.richLinks;
  readonly messageRichLinks = streams.messageRichLinks;
  readonly protectedMessageData = streams.protectedMessageData;
  readonly brandIndicators = streams.brandIndicators;
  readonly brandIndicatorEvidence = streams.brandIndicatorEvidence;
  readonly addressMetadata = streams.addressMetadata;
  readonly businesses = streams.businesses;
  readonly businessAddresses = streams.businessAddresses;
  readonly businessCategories = streams.businessCategories;
  readonly senders = streams.senders;
  readonly senderAddresses = streams.senderAddresses;
  readonly events = streams.events;
  readonly smtpServers = streams.smtpServers;
  readonly mailboxProperties = streams.mailboxProperties;
  readonly smartMailboxConditions = streams.smartMailboxConditions;
  readonly configuration = streams.configuration;
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly accounts = streams.accounts;
  readonly messages = streams.messages;
  readonly mailboxes = streams.mailboxes;
  readonly messageMailboxes = streams.messageMailboxes;
  readonly addresses = streams.addresses;
  readonly recipients = streams.recipients;
  readonly conversations = streams.conversations;
  readonly messageFiles = streams.messageFiles;
  readonly messageHeaders = streams.messageHeaders;
  readonly messageParts = streams.messageParts;
  readonly attachments = streams.attachments;
  readonly rules = streams.rules;
  readonly ruleConditions = streams.ruleConditions;
  readonly smartMailboxes = streams.smartMailboxes;
  readonly signatures = streams.signatures;

  constructor(
    readonly path: string,
    readonly scope: ImportScope = {},
  ) {
    super();
    this.identity = `apple-mail:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<MailScan> {
    return new MailScan(
      await MailStore.open(
        this.path,
        Object.fromEntries(
          Object.values(mailTables).map((table) => [table.name, table.columns]),
        ),
      ),
      this.scope,
    );
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: MailScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const name = stream.name as StreamName;
    let file: string | null = null;
    async function* records(entries: AsyncIterable<Entry> | Iterable<Entry>) {
      for await (const entry of entries) {
        if (!scan.accepts(name, entry.data)) continue;
        file = entry.file;
        yield* validateRecords(stream, [entry.data], 'Mail');
      }
    }
    async function* groups(from: MessageStream) {
      for await (const group of scan.groups(from))
        yield {
          key: group.key,
          fingerprint: group.fingerprint,
          records: () => records(group.records()),
        };
    }
    const messages =
      configuration.syncMode !== 'incremental'
        ? (async function* () {
            for await (const data of records(scan.read(name)))
              yield { stream: stream.name, data };
          })()
        : isMessageStream(name)
          ? diffGroupedSnapshot(stream, groups(name), state)
          : diffSnapshot(stream, records(scan.read(name)), state);
    for await (const message of messages)
      yield 'type' in message || configuration.fileReads.length === 0
        ? message
        : { ...message, file };
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams: selected,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    const path = await mailVersionDirectory(this.path);
    using database = new DatabaseSync(join(path, 'MailData/Envelope Index'), {
      readOnly: true,
    });
    const version = database.prepare('PRAGMA data_version');
    let seen = version.get()?.data_version;
    let changed = false;
    let failure: Error | null = null;
    using resources = new DisposableStack();
    const watcher = watch(this.path, { recursive: true, signal }, () => {
      changed = true;
    });
    resources.defer(() => watcher.close());
    watcher.on('error', (error) => {
      failure = error;
    });
    yield selected;
    try {
      for await (const _ of setInterval(1000, undefined, { signal })) {
        if (failure !== null) throw failure;
        const current = version.get()?.data_version;
        if (!changed && current === seen) continue;
        changed = false;
        seen = current;
        yield selected;
      }
    } catch (error) {
      if (
        !(
          signal.aborted &&
          error instanceof Error &&
          error.name === 'AbortError'
        )
      )
        throw error;
    }
  }
}
