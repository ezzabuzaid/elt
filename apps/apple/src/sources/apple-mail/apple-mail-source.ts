import { watch } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setInterval } from 'node:timers/promises';
import type { ExtractionCoverage } from 'elt';
import {
  Catalog,
  type CopyConfiguration,
  diffSnapshot,
  type SchemaRecord,
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

const streams = {
  accounts: mailStream('accounts', metadata, ['id'], false),
  smtpServers: mailStream('smtpServers', metadata, ['id'], false),
  ...tableStreams,
  mailboxProperties: mailStream(
    'mailboxProperties',
    { relativePath: text, properties: text },
    ['relativePath'],
    false,
  ),
  rules: mailStream(
    'rules',
    { ...scopedMetadata, enabled: { type: ['boolean', 'null'] } },
    ['scope', 'id'],
    false,
  ),
  ruleConditions: mailStream(
    'ruleConditions',
    conditionFields,
    ['scope', 'ownerId', 'position'],
    false,
  ),
  smartMailboxes: mailStream(
    'smartMailboxes',
    { ...metadata, parentId: nullableText },
    ['id'],
    false,
  ),
  smartMailboxConditions: mailStream(
    'smartMailboxConditions',
    conditionFields,
    ['scope', 'ownerId', 'position'],
    false,
  ),
  signatures: mailStream(
    'signatures',
    { id: text, content: text },
    ['id'],
    false,
  ),
  configuration: mailStream(
    'configuration',
    { relativePath: text, properties: text },
    ['relativePath'],
    false,
  ),
  messageFiles: mailStream('messageFiles', fileFields, ['messageId'], true),
  messageHeaders: mailStream(
    'messageHeaders',
    headersFields,
    ['messageId', 'partId', 'position'],
    false,
  ),
  messageParts: mailStream(
    'messageParts',
    { ...partFields, text: nullableText },
    ['messageId', 'partId'],
    false,
  ),
  attachments: mailStream(
    'attachments',
    partFields,
    ['messageId', 'partId'],
    true,
  ),
};
const catalog = new Catalog(Object.values(streams));
type StreamName = keyof typeof streams;

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

  constructor(
    readonly store: MailStore,
    scope: ImportScope = {},
  ) {
    this.accepts = mailSelection(store, scope);
  }

  async *mime(
    name: 'messageHeaders' | 'messageParts' | 'attachments',
  ): AsyncGenerator<{ data: Record<string, unknown>; file: string | null }> {
    const indexedAttachments = this.store.database.prepare(
      'SELECT CAST(message AS TEXT) AS message, attachment_id, name FROM attachments ORDER BY ROWID',
    );
    const remaining = new Map(
      indexedAttachments
        .all()
        .filter((row) => this.accepts('indexedAttachments', row))
        .map((row) => [`${row.message}:${row.attachment_id}`, row]),
    );
    // ponytail: one archive scan per MIME view, with staging bounded by one
    // message. A shared streaming scan could reduce repeated I/O.
    for (const row of this.store.database
      .prepare('SELECT CAST(ROWID AS TEXT) AS id FROM messages ORDER BY ROWID')
      .iterate()) {
      const id = row.id as string;
      if (!this.accepts('messages', row)) continue;
      const file = this.store.messages.get(id);
      if (file === undefined) continue;
      const { headers, parts } = await readMailMime(
        this.store,
        id,
        file,
        name === 'messageHeaders',
        name === 'attachments',
        (part) =>
          name === 'messageParts' ||
          part.isAttachment ||
          remaining.has(`${id}:${part.partId}`),
      );
      try {
        if (name === 'messageHeaders') {
          for (const header of headers)
            yield { data: { ...header }, file: null };
        } else {
          for (const part of parts) {
            const indexKey = `${id}:${part.record.partId}`;
            const indexed = remaining.has(indexKey);
            part.record.isAttachment ||= indexed;
            remaining.delete(indexKey);
            if (name === 'messageParts')
              yield {
                data: { ...part.record, text: part.text },
                file: null,
              };
            else if (part.record.isAttachment)
              yield { data: { ...part.record }, file: part.path };
          }
        }
      } finally {
        for (const part of parts) if (part.path !== null) await rm(part.path);
      }
    }
    if (name !== 'attachments') return;
    // The index can know an attachment before its message/MIME file arrives.
    for (const [key, row] of remaining) {
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
        messageId: row.message as string,
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

  async *read(
    name: StreamName,
  ): AsyncGenerator<{ data: Record<string, unknown>; file: string | null }> {
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
    if (name === 'messageFiles') {
      for (const row of this.store.database
        .prepare(
          'SELECT CAST(ROWID AS TEXT) AS id FROM messages ORDER BY ROWID',
        )
        .iterate()) {
        if (!this.accepts('messages', row)) continue;
        const file = this.store.messages.get(row.id as string);
        const data: SchemaRecord<typeof fileFields> = {
          messageId: row.id as string,
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
      }
      return;
    }
    if (
      name === 'messageHeaders' ||
      name === 'messageParts' ||
      name === 'attachments'
    ) {
      yield* this.mime(name);
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
    let file: string | null = null;
    async function* records() {
      for await (const entry of scan.read(stream.name as StreamName)) {
        if (!scan.accepts(stream.name as StreamName, entry.data)) continue;
        file = entry.file;
        yield* validateRecords(stream, [entry.data], 'Mail');
      }
    }
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records(), state)
        : (async function* () {
            for await (const data of records())
              yield { stream: stream.name, data };
          })();
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
