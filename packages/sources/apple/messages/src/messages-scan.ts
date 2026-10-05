import type { ChatDatabase } from '@workspace/sdk-apple-messages';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// What an import scope keeps: its chats, the messages linked to them within
// its dates, their attachments, and the handles those chats and messages name.
export class MessageSelection {
  readonly #chats: ReadonlySet<string>;
  readonly #messages: ReadonlySet<string>;
  readonly #attachments: ReadonlySet<string>;
  readonly #handles: ReadonlySet<string>;

  constructor(database: ChatDatabase, scope: ImportScope) {
    this.#chats = new Set(
      database
        .chats()
        .filter(
          ({ guid, values }) =>
            selected(scope.collectionIds, guid) &&
            selected(scope.accountIds, values.account_id),
        )
        .map(({ guid }) => guid),
    );
    const linked = new Set(
      [...database.chatMessages(), ...database.recoverableMessages()]
        .filter(({ chatGuid }) => this.#chats.has(chatGuid))
        .map(({ messageGuid }) => messageGuid),
    );
    const messages = database.messages().filter((message) => {
      const { date } = message.values;
      return (
        ((scope.collectionIds === undefined &&
          scope.accountIds === undefined) ||
          linked.has(message.guid)) &&
        withinDates(scope, date instanceof Date ? date.toISOString() : null)
      );
    });
    this.#messages = new Set(messages.map(({ guid }) => guid));
    this.#attachments = new Set(
      database
        .messageAttachments()
        .filter(({ messageGuid }) => this.#messages.has(messageGuid))
        .map(({ attachmentGuid }) => attachmentGuid),
    );
    const handles = new Set<string>();
    for (const message of messages)
      for (const handle of [message.handle, message.otherHandle])
        if (handle !== null) handles.add(handleKey(handle.id, handle.service));
    for (const { chatGuid, handle } of database.chatHandles())
      if (this.#chats.has(chatGuid) && handle !== null)
        handles.add(handleKey(handle.id, handle.service));
    this.#handles = handles;
  }

  chat(guid: string): boolean {
    return this.#chats.has(guid);
  }

  message(guid: string): boolean {
    return this.#messages.has(guid);
  }

  attachment(guid: string): boolean {
    return this.#attachments.has(guid);
  }

  handle(id: unknown, service: unknown): boolean {
    return this.#handles.has(handleKey(id, service));
  }
}

const handleKey = (id: unknown, service: unknown) =>
  JSON.stringify([id, service]);

// One run's read of chat.db: every stream reads the same snapshot, and the
// import scope's selection is worked out once, when a stream first needs it.
export class MessagesScan implements AsyncDisposable {
  readonly database: ChatDatabase;
  readonly #scope: ImportScope;
  #selection?: MessageSelection;

  constructor(database: ChatDatabase, scope: ImportScope) {
    this.database = database;
    this.#scope = scope;
  }

  // null when the import takes everything.
  get selection(): MessageSelection | null {
    if (Object.keys(this.#scope).length === 0) return null;
    this.#selection ??= new MessageSelection(this.database, this.#scope);
    return this.#selection;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.database[Symbol.dispose]();
  }
}
