import {
  type Chat,
  type ChatPushConfig,
  type ChatStorageSnapshot,
  type GroupMember,
  type GroupMembersChange,
  type Message,
  type MessageDataItem,
  type MessageInput,
  type MessageKey,
  type ProfilePicture,
  type PushName,
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
export function* unique<T>(
  rows: Iterable<T>,
  key: (row: T) => string,
): Generator<T> {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) continue;
    seen.add(id);
    yield row;
  }
}

// A message date cut to the millisecond, the precision of an import's dates,
// so it compares with them as text.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// ChatStorage as one run reads it: the import scope's chats select chats,
// their members and settings, and their messages, which its dates narrow
// further; what hangs off a message follows the messages kept. Messages, and
// what is decoded from them, are read as each stream iterates them, never
// held for the run: a store keeps tens of thousands.
export class ChatStorageRecords {
  readonly #snapshot: ChatStorageSnapshot;
  readonly #scope: ImportScope;
  readonly #narrowed: boolean;
  #chats?: Chat[];
  #messageIds?: ReadonlySet<string>;
  #stanzaIds?: ReadonlySet<string>;

  constructor(snapshot: ChatStorageSnapshot, scope: ImportScope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
    this.#narrowed = Object.keys(scope).length > 0;
  }

  get chats(): readonly Chat[] {
    this.#chats ??= [
      ...unique(
        this.#snapshot.chats().filter(({ jid }) => this.#chat(jid)),
        ({ jid }) => jid,
      ),
    ];
    return this.#chats;
  }

  messages(id?: number): Generator<Message> {
    return this.#selected(this.#snapshot.messages(id));
  }

  messageInputs(): Generator<MessageInput> {
    return this.#selected(this.#snapshot.messageInputs());
  }

  get dataItems(): Iterable<MessageDataItem> {
    return this.#snapshot.dataItems().filter((item) => this.message(item));
  }

  get groupMembers(): Iterable<GroupMember> {
    return this.#snapshot
      .groupMembers()
      .filter(({ groupJid }) => this.#chat(groupJid));
  }

  get groupMembersChanges(): Iterable<GroupMembersChange> {
    return this.#snapshot
      .groupMembersChanges()
      .filter(({ groupJid }) => this.#chat(groupJid));
  }

  get chatPushConfigs(): Iterable<ChatPushConfig> {
    return this.#snapshot
      .chatPushConfigs()
      .filter(({ jid }) => this.#chat(jid));
  }

  // Who people are and whom the account blocked belongs to no chat, so no
  // import scope narrows them.
  get pushNames(): Iterable<PushName> {
    return this.#snapshot.pushNames();
  }

  get profilePictures(): Iterable<ProfilePicture> {
    return this.#snapshot.profilePictures();
  }

  get blockedJids(): Iterable<string> {
    return this.#snapshot.blockedJids();
  }

  // Whether the import keeps the message a record of the same chat hangs
  // off, by its key.
  message(key: MessageKey): boolean {
    if (!this.#narrowed) return true;
    this.#messageIds ??= new Set(this.messageInputs().map(messageId));
    return this.#messageIds.has(messageId(key));
  }

  // The same for a record that names its message by chat and stanza ID only.
  stanza(chatJid: string, stanzaId: string): boolean {
    if (!this.#narrowed) return true;
    this.#stanzaIds ??= new Set(
      this.messageInputs().map((kept) =>
        JSON.stringify([kept.chatJid, kept.stanzaId]),
      ),
    );
    return this.#stanzaIds.has(JSON.stringify([chatJid, stanzaId]));
  }

  #chat(jid: string): boolean {
    return selected(this.#scope.collectionIds, jid);
  }

  #selected<T extends MessageKey & { readonly messageDate: string | null }>(
    rows: IteratorObject<T>,
  ): Generator<T> {
    return unique(
      rows.filter(
        ({ chatJid, messageDate }) =>
          this.#chat(chatJid) &&
          withinDates(
            this.#scope,
            messageDate === null ? null : toMilliseconds(messageDate),
          ),
      ),
      messageId,
    );
  }
}
