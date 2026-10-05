import { setInterval } from 'node:timers/promises';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import { MessagesStore, chatDatabasePath } from '@workspace/sdk-apple-messages';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { MessagesReader } from './apple-messages-stream.ts';
import { MessagesScan } from './messages-scan.ts';
import { AttachmentsStream } from './streams/attachments-stream.ts';
import { ChatHandlesStream } from './streams/chat-handles-stream.ts';
import { ChatLookupsStream } from './streams/chat-lookups-stream.ts';
import { ChatMessagesStream } from './streams/chat-messages-stream.ts';
import { ChatServicesStream } from './streams/chat-services-stream.ts';
import { ChatsStream } from './streams/chats-stream.ts';
import { HandlesStream } from './streams/handles-stream.ts';
import { LinkPreviewsStream } from './streams/link-previews-stream.ts';
import { MessageAttachmentsStream } from './streams/message-attachments-stream.ts';
import { MessageEditsStream } from './streams/message-edits-stream.ts';
import { MessagesStream } from './streams/messages-stream.ts';
import { RecoverableMessagePartsStream } from './streams/recoverable-message-parts-stream.ts';
import { RecoverableMessagesStream } from './streams/recoverable-messages-stream.ts';

const readers = {
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
  messageAttachments: new MessageAttachmentsStream(),
} satisfies Record<string, MessagesReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, MessagesReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks chat.db for commits.
const pollIntervalMs = 1000;

export class AppleMessagesSource extends Source<MessagesScan> {
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly chats = readers.chats.describe();
  readonly handles = readers.handles.describe();
  readonly chatLookups = readers.chatLookups.describe();
  readonly chatServices = readers.chatServices.describe();
  readonly chatHandles = readers.chatHandles.describe();
  readonly messages = readers.messages.describe();
  readonly chatMessages = readers.chatMessages.describe();
  readonly linkPreviews = readers.linkPreviews.describe();
  readonly messageEdits = readers.messageEdits.describe();
  readonly recoverableMessages = readers.recoverableMessages.describe();
  readonly recoverableMessageParts = readers.recoverableMessageParts.describe();
  readonly attachments = readers.attachments.describe();
  readonly messageAttachments = readers.messageAttachments.describe();

  readonly path: string;
  readonly scope: ImportScope;
  readonly #store: MessagesStore;

  constructor(path = chatDatabasePath, scope: ImportScope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new MessagesStore(path);
    this.identity = `apple-messages:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<MessagesScan> {
    return new MessagesScan(this.#store.open(), this.scope);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    let seen = version.current;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
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
    scan: MessagesScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Messages has no stream ${stream.name}`);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data) };
    }
  }
}
