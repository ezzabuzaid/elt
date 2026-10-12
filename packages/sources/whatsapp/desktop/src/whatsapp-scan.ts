import type {
  BackedUpKeyValueSnapshot,
  BusinessesSnapshot,
  CallsSnapshot,
  ContactsSnapshot,
  LocalKeyValueSnapshot,
  MessageAssociation,
  MessageAssociationsSnapshot,
  StatusesSnapshot,
  StickersSnapshot,
  UsersSnapshot,
  WhatsApp,
  WhatsAppStore,
} from '@workspace/sdk-whatsapp-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { ChatStorageRecords } from './chat-storage-records.ts';

type Readers = {
  chatStorage: ChatStorageRecords;
  contacts: ContactsSnapshot;
  users: UsersSnapshot;
  calls: CallsSnapshot;
  messageAssociations: MessageAssociationsSnapshot;
  businesses: BusinessesSnapshot;
  statuses: StatusesSnapshot;
  stickers: StickersSnapshot;
  localKeyValue: LocalKeyValueSnapshot;
  backedUpKeyValue: BackedUpKeyValueSnapshot;
};

// A store this run opened, or why it could not be.
type Opened<T> = { readonly reader: T } | { readonly error: unknown };

type OpenedStores = { [S in WhatsAppStore]?: Opened<Readers[S]> };

// One run's read of WhatsApp: each store the selected streams read is opened
// once, as of one moment, and each stream reads its own records from it, so
// a store that cannot be opened, or a record that cannot be decoded, fails
// only the streams that read it. The import scope narrows ChatStorage's chats
// and messages; the other stores hold no chat, so it narrows nothing there.
export class WhatsAppScan implements AsyncDisposable {
  readonly container: string;
  // When the run opened the stores, which expiring streams count from.
  readonly startedAt = new Date();
  readonly #resources: DisposableStack;
  readonly #opened: OpenedStores;
  readonly #scoped: boolean;

  private constructor(
    container: string,
    resources: DisposableStack,
    opened: OpenedStores,
    scoped: boolean,
  ) {
    this.container = container;
    this.#resources = resources;
    this.#opened = opened;
    this.#scoped = scoped;
  }

  static open(
    whatsapp: WhatsApp,
    stores: ReadonlySet<WhatsAppStore>,
    scope: ImportScope,
  ): WhatsAppScan {
    using resources = new DisposableStack();
    // A narrowed import keeps an association only for a message it keeps,
    // which only ChatStorage knows.
    const scoped = Object.keys(scope).length > 0;
    const needed = new Set(stores);
    if (scoped && stores.has('messageAssociations')) needed.add('chatStorage');
    const open = <S extends WhatsAppStore>(
      store: S,
      reader: () => Readers[S],
    ): Opened<Readers[S]> | undefined => {
      if (!needed.has(store)) return undefined;
      try {
        return { reader: reader() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      chatStorage: open(
        'chatStorage',
        () =>
          new ChatStorageRecords(resources.use(whatsapp.chatStorage()), scope),
      ),
      contacts: open('contacts', () => resources.use(whatsapp.contacts())),
      users: open('users', () => resources.use(whatsapp.users())),
      calls: open('calls', () => resources.use(whatsapp.calls())),
      messageAssociations: open('messageAssociations', () =>
        resources.use(whatsapp.messageAssociations()),
      ),
      businesses: open('businesses', () =>
        resources.use(whatsapp.businesses()),
      ),
      statuses: open('statuses', () => resources.use(whatsapp.statuses())),
      stickers: open('stickers', () => resources.use(whatsapp.stickers())),
      localKeyValue: open('localKeyValue', () =>
        resources.use(whatsapp.localKeyValue()),
      ),
      backedUpKeyValue: open('backedUpKeyValue', () =>
        resources.use(whatsapp.backedUpKeyValue()),
      ),
    };
    return new WhatsAppScan(
      whatsapp.container,
      resources.move(),
      opened,
      scoped,
    );
  }

  get chatStorage(): ChatStorageRecords {
    return this.#reader('chatStorage');
  }

  get contacts(): ContactsSnapshot {
    return this.#reader('contacts');
  }

  get users(): UsersSnapshot {
    return this.#reader('users');
  }

  get calls(): CallsSnapshot {
    return this.#reader('calls');
  }

  get businesses(): BusinessesSnapshot {
    return this.#reader('businesses');
  }

  get statuses(): StatusesSnapshot {
    return this.#reader('statuses');
  }

  get stickers(): StickersSnapshot {
    return this.#reader('stickers');
  }

  get localKeyValue(): LocalKeyValueSnapshot {
    return this.#reader('localKeyValue');
  }

  get backedUpKeyValue(): BackedUpKeyValueSnapshot {
    return this.#reader('backedUpKeyValue');
  }

  messageAssociations(): MessageAssociation[] {
    const associations = this.#reader('messageAssociations').associations();
    if (!this.#scoped) return associations;
    const chats = this.chatStorage;
    return associations.filter(({ chatJid, stanzaId }) =>
      chats.stanza(chatJid, stanzaId),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#resources.dispose();
  }

  #reader<S extends WhatsAppStore>(store: S): Readers[S] {
    const opened = this.#opened[store];
    if (opened === undefined)
      throw new Error(`WhatsApp's ${store} store was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.reader;
  }
}
