import { ClosedWorld } from '@zukhruf/snapshot-differential';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  Stream,
} from '@eltjs/elt';
import { Catalog, Source, diffSnapshot } from '@eltjs/elt';
import {
  MessagesStore,
  StoreUnavailableError,
} from '@eltjs/sdk-apple-messages';
import type { ImportScope } from '@eltjs/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@eltjs/source-apple-macos/local-apple-store-coverage';

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
  readonly identity = 'apple-messages';
  protected readonly catalog = catalog;
  readonly chats = catalog.get(readers.chats.name);
  readonly handles = catalog.get(readers.handles.name);
  readonly chatLookups = catalog.get(readers.chatLookups.name);
  readonly chatServices = catalog.get(readers.chatServices.name);
  readonly chatHandles = catalog.get(readers.chatHandles.name);
  readonly messages = catalog.get(readers.messages.name);
  readonly chatMessages = catalog.get(readers.chatMessages.name);
  readonly linkPreviews = catalog.get(readers.linkPreviews.name);
  readonly messageEdits = catalog.get(readers.messageEdits.name);
  readonly recoverableMessages = catalog.get(readers.recoverableMessages.name);
  readonly recoverableMessageParts = catalog.get(
    readers.recoverableMessageParts.name,
  );
  readonly attachments = catalog.get(readers.attachments.name);
  readonly messageAttachments = catalog.get(readers.messageAttachments.name);

  readonly path: string;
  readonly home: string;
  readonly scope: ImportScope;
  readonly #store: MessagesStore;

  constructor({
    path,
    home,
    scope = {},
  }: {
    path: string;
    home: string;
    scope?: ImportScope;
  }) {
    super();
    this.path = path;
    this.home = home;
    this.scope = scope;
    this.#store = new MessagesStore({ path, home });
    Object.freeze(this);
  }

  protected override async open(): Promise<MessagesScan> {
    return new MessagesScan(this.#store.open(), this.scope);
  }

  protected override readonly configErrors = [StoreUnavailableError];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  override async currentAsOf() {
    return null;
  }

  override changeSignals(streams: readonly Stream[]) {
    return [
      {
        gauge: this.#store.version(),
        streams,
        interval: pollIntervalMs,
        // A data_version read is local: a check that takes the whole interval
        // is stuck.
        timeout: pollIntervalMs,
      },
    ];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: MessagesScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new TypeError(`Messages has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
    for await (const message of messages) {
      if ('type' in message || configuration.fileReads.length === 0)
        yield message;
      else yield { ...message, file: reader.file(message.data, this.home) };
    }
  }
}
