import {
  type Chat,
  type ChatPushConfig,
  type ChatStorageSnapshot,
  type GroupMember,
  type GroupMembersChange,
  type Message,
  type MessageDataItem,
  type MessageKey,
  type ProfilePicture,
  type PushName,
  type Reaction,
  type ReactionCount,
  type Receipt,
  ReceiptInfo,
} from '@workspace/sdk-whatsapp-desktop';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// A record decoded from a message's receipt info, with the message it is on.
export type OnMessage<T> = { readonly message: MessageKey; readonly item: T };

const messageId = ({ chatJid, isFromMe, stanzaId }: MessageKey) =>
  JSON.stringify([chatJid, isFromMe, stanzaId]);

// The first of the rows sharing a key stands for all of them: WhatsApp keeps
// a second copy of a few messages and a second, empty session for a few chats.
export function unique<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = key(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// A message date cut to the millisecond, the precision of an import's dates,
// so it compares with them as text.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// ChatStorage as one run reads it: each kind of record is read once, and the
// import scope's chats select chats, their members and settings, and their
// messages, which its dates narrow further; what hangs off a message follows
// the messages kept.
export class ChatStorageRecords {
  readonly #snapshot: ChatStorageSnapshot;
  readonly #scope: ImportScope;
  readonly #narrowed: boolean;
  #chats?: Chat[];
  #messages?: Message[];
  #messageIds?: ReadonlySet<string>;
  #stanzaIds?: ReadonlySet<string>;
  #receiptInfos?: OnMessage<ReceiptInfo>[];

  constructor(snapshot: ChatStorageSnapshot, scope: ImportScope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
    this.#narrowed = Object.keys(scope).length > 0;
  }

  get chats(): readonly Chat[] {
    this.#chats ??= unique(
      this.#snapshot.chats().filter(({ jid }) => this.#chat(jid)),
      ({ jid }) => jid,
    );
    return this.#chats;
  }

  get messages(): readonly Message[] {
    this.#messages ??= unique(
      this.#snapshot
        .messages()
        .filter(
          ({ chatJid, messageDate }) =>
            this.#chat(chatJid) &&
            withinDates(
              this.#scope,
              messageDate === null ? null : toMilliseconds(messageDate),
            ),
        ),
      messageId,
    );
    return this.#messages;
  }

  get receipts(): readonly OnMessage<Receipt>[] {
    return this.#decoded().flatMap(({ message, item }) =>
      item.receipts.map((receipt) => ({ message, item: receipt })),
    );
  }

  get reactions(): readonly OnMessage<Reaction>[] {
    return this.#decoded().flatMap(({ message, item }) =>
      item.reactions.map((reaction) => ({ message, item: reaction })),
    );
  }

  get reactionCounts(): readonly OnMessage<ReactionCount>[] {
    return this.#decoded().flatMap(({ message, item }) =>
      item.reactionCounts.map((count) => ({ message, item: count })),
    );
  }

  get dataItems(): readonly MessageDataItem[] {
    return this.#snapshot.dataItems().filter((item) => this.message(item));
  }

  get groupMembers(): readonly GroupMember[] {
    return this.#snapshot
      .groupMembers()
      .filter(({ groupJid }) => this.#chat(groupJid));
  }

  get groupMembersChanges(): readonly GroupMembersChange[] {
    return this.#snapshot
      .groupMembersChanges()
      .filter(({ groupJid }) => this.#chat(groupJid));
  }

  get chatPushConfigs(): readonly ChatPushConfig[] {
    return this.#snapshot
      .chatPushConfigs()
      .filter(({ jid }) => this.#chat(jid));
  }

  // Who people are and whom the account blocked belongs to no chat, so no
  // import scope narrows them.
  get pushNames(): readonly PushName[] {
    return this.#snapshot.pushNames();
  }

  get profilePictures(): readonly ProfilePicture[] {
    return this.#snapshot.profilePictures();
  }

  get blockedJids(): readonly string[] {
    return this.#snapshot.blockedJids();
  }

  // Whether the import keeps the message a record of the same chat hangs
  // off, by its key.
  message(key: MessageKey): boolean {
    if (!this.#narrowed) return true;
    this.#messageIds ??= new Set(this.messages.map(messageId));
    return this.#messageIds.has(messageId(key));
  }

  // The same for a record that names its message by chat and stanza ID only.
  stanza(chatJid: string, stanzaId: string): boolean {
    if (!this.#narrowed) return true;
    this.#stanzaIds ??= new Set(
      this.messages.map((kept) =>
        JSON.stringify([kept.chatJid, kept.stanzaId]),
      ),
    );
    return this.#stanzaIds.has(JSON.stringify([chatJid, stanzaId]));
  }

  #chat(jid: string): boolean {
    return selected(this.#scope.collectionIds, jid);
  }

  #decoded(): OnMessage<ReceiptInfo>[] {
    this.#receiptInfos ??= this.messages.flatMap((message) =>
      message.receiptInfo === null
        ? []
        : [{ message, item: new ReceiptInfo(message.receiptInfo) }],
    );
    return this.#receiptInfos;
  }
}
