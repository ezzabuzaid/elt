import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';
import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from 'elt';
import { Catalog, diffSnapshot, Source, validateRecords } from 'elt';
import {
  ChatDatabase,
  ChatDatabaseVersion,
  messagesDirectory,
} from '../../platform/macos/chat-database.ts';
import { type ImportScope, selected, withinDates } from '../import-scope.ts';
import { localAppleStoreCoverage } from '../local-apple-store-coverage.ts';
import {
  definitions,
  recordFrom,
  type StreamName,
  streams,
} from './messages-streams.ts';
import { attributedText } from './typedstream.ts';

const catalog = new Catalog(Object.values(streams));

// Attachment paths are stored home-relative, as ~/Library/Messages/Attachments/…
const attachmentPath = (filename: string) =>
  filename.startsWith('~/') ? join(homedir(), filename.slice(2)) : filename;

export class AppleMessagesSource extends Source<ChatDatabase> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly chats = streams.chats;
  readonly handles = streams.handles;
  readonly chatLookups = streams.chatLookups;
  readonly chatServices = streams.chatServices;
  readonly chatHandles = streams.chatHandles;
  readonly messages = streams.messages;
  readonly chatMessages = streams.chatMessages;
  readonly linkPreviews = streams.linkPreviews;
  readonly messageEdits = streams.messageEdits;
  readonly recoverableMessages = streams.recoverableMessages;
  readonly recoverableMessageParts = streams.recoverableMessageParts;
  readonly attachments = streams.attachments;
  readonly messageAttachments = streams.messageAttachments;
  readonly #scopes = new WeakMap<
    ChatDatabase,
    (name: StreamName, row: Record<string, unknown>) => boolean
  >();

  constructor(
    readonly path = join(messagesDirectory, 'chat.db'),
    // How often a watch checks chat.db for commits.
    readonly pollIntervalMs = 1000,
    readonly scope: ImportScope = {},
  ) {
    super();
    this.identity = `apple-messages:${path}`;
    Object.freeze(this);
  }

  protected override open(): Promise<ChatDatabase> {
    return ChatDatabase.open(this.path);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = new ChatDatabaseVersion(this.path);
    let seen = version.current;
    yield streams;
    try {
      for await (const _ of setInterval(this.pollIntervalMs, undefined, {
        signal,
      })) {
        const current = version.current;
        if (current === seen) continue;
        seen = current;
        yield streams;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    database: ChatDatabase,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const records = validateRecords(
      stream,
      await this.#scan(stream.name as StreamName, database),
      'Messages',
    );
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0) {
        yield message;
        continue;
      }
      const { filename, availableLocally } = message.data;
      // The original file, not a staged copy: attachments reach gigabytes and
      // readers only read it.
      yield {
        ...message,
        file:
          availableLocally === true && typeof filename === 'string'
            ? attachmentPath(filename)
            : null,
      };
    }
  }

  async #scan(
    name: StreamName,
    database: ChatDatabase,
  ): Promise<Record<string, unknown>[]> {
    const definition: {
      expand?: (row: Record<string, unknown>) => Record<string, unknown>[];
    } = definitions[name];
    let accepts = this.#scopes.get(database);
    if (accepts === undefined) {
      accepts = messageSelection(database, this.scope);
      this.#scopes.set(database, accepts);
    }
    const rows = database
      .all(definitions[name].sql)
      .filter((row) => accepts(name, row));
    if (definition.expand !== undefined) return rows.flatMap(definition.expand);
    return Promise.all(
      rows.map(async (row) => {
        const record = recordFrom(name, row);
        if (name === 'messages' && record.text === null)
          record.text =
            row.attributedBody instanceof Uint8Array
              ? attributedText(row.attributedBody)
              : null;
        if (name === 'attachments')
          record.availableLocally =
            typeof row.filename === 'string' &&
            (await access(attachmentPath(row.filename)).then(
              () => true,
              () => false,
            ));
        return record;
      }),
    );
  }
}

function messageSelection(database: ChatDatabase, scope: ImportScope) {
  if (Object.keys(scope).length === 0) return () => true;
  const chats = new Set<unknown>(
    database
      .all(definitions.chats.sql)
      .filter(
        (row) =>
          selected(scope.collectionIds, row.guid) &&
          selected(scope.accountIds, row.accountId),
      )
      .map((row) => row.guid),
  );
  const memberships = [
    ...database.all(definitions.chatMessages.sql),
    ...database.all(definitions.recoverableMessages.sql),
  ];
  const linked = new Set<unknown>(
    memberships
      .filter((row) => chats.has(row.chatGuid))
      .map((row) => row.messageGuid),
  );
  const messages = database
    .all(definitions.messages.sql)
    .filter(
      (row) =>
        ((scope.collectionIds === undefined &&
          scope.accountIds === undefined) ||
          linked.has(row.guid)) &&
        withinDates(
          scope,
          typeof row.date === 'number'
            ? new Date(Date.UTC(2001, 0, 1) + row.date).toISOString()
            : null,
        ),
    );
  const messageIds = new Set<unknown>(messages.map((row) => row.guid));
  const attachmentIds = new Set<unknown>(
    database
      .all(definitions.messageAttachments.sql)
      .filter((row) => messageIds.has(row.messageGuid))
      .map((row) => row.attachmentGuid),
  );
  const handles = new Set<unknown>(
    messages.flatMap((row) => [
      JSON.stringify([row.handle, row.handleService]),
      JSON.stringify([row.otherHandle, row.otherHandleService]),
    ]),
  );
  for (const row of database.all(definitions.chatHandles.sql))
    if (chats.has(row.chatGuid))
      handles.add(JSON.stringify([row.handleId, row.handleService]));
  return (name: StreamName, row: Record<string, unknown>): boolean => {
    if (name === 'chats') return chats.has(row.guid);
    if (name === 'messages') return messageIds.has(row.guid);
    if (name === 'attachments') return attachmentIds.has(row.guid);
    if (name === 'handles')
      return handles.has(JSON.stringify([row.id, row.service]));
    return (
      (!('chatGuid' in row) || chats.has(row.chatGuid)) &&
      (!('messageGuid' in row) || messageIds.has(row.messageGuid))
    );
  };
}
