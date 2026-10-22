import { homedir } from 'node:os';
import { join } from 'node:path';

import { DataVersion, lastWrite } from '@zukhruf/sqlite-data-version';

import { BusinessesSnapshot } from './businesses.ts';
import { CallsSnapshot } from './calls.ts';
import { ChatStorageSnapshot } from './chat-storage.ts';
import { ContactsSnapshot } from './contacts.ts';
import { WhatsAppUnavailableError } from './errors.ts';
import {
  BackedUpKeyValueSnapshot,
  LocalKeyValueSnapshot,
} from './key-values.ts';
import { MessageAssociationsSnapshot } from './message-associations.ts';
import { StatusesSnapshot } from './statuses.ts';
import { StickersSnapshot } from './stickers.ts';
import { UsersSnapshot } from './users.ts';

// The group container WhatsApp for Mac shares with its extensions.
export const whatsappContainer = join(
  homedir(),
  'Library/Group Containers/group.net.whatsapp.WhatsApp.shared',
);

// Each store's database, relative to the container.
const storeFiles = {
  chatStorage: 'ChatStorage.sqlite',
  contacts: 'ContactsV2.sqlite',
  users: 'LID.sqlite',
  calls: 'CallHistory.sqlite',
  messageAssociations: 'ExtChatDB/ExtChatDatabase.sqlite',
  businesses: 'Biz/Biz.sqlite',
  statuses: 'statusDB/Status.sqlite',
  stickers: 'Sticker.sqlite',
  localKeyValue: 'LocalKeyValue.sqlite',
  backedUpKeyValue: 'BackedUpKeyValue.sqlite',
} as const satisfies Record<string, string>;

export type WhatsAppStore = keyof typeof storeFiles;

// WhatsApp's own stores; it writes chats and messages only while the app
// runs. Each opens on its own, so a store WhatsApp has not created
// fails only what reads it.
export class WhatsApp {
  readonly container: string;

  constructor(container = whatsappContainer) {
    this.container = container;
  }

  chatStorage(): ChatStorageSnapshot {
    return new ChatStorageSnapshot(this.#file('chatStorage'), this.container);
  }

  contacts(): ContactsSnapshot {
    return new ContactsSnapshot(this.#file('contacts'));
  }

  users(): UsersSnapshot {
    return new UsersSnapshot(this.#file('users'));
  }

  calls(): CallsSnapshot {
    return new CallsSnapshot(this.#file('calls'));
  }

  messageAssociations(): MessageAssociationsSnapshot {
    return new MessageAssociationsSnapshot(this.#file('messageAssociations'));
  }

  businesses(): BusinessesSnapshot {
    return new BusinessesSnapshot(this.#file('businesses'));
  }

  statuses(): StatusesSnapshot {
    return new StatusesSnapshot(this.#file('statuses'), this.container);
  }

  stickers(): StickersSnapshot {
    return new StickersSnapshot(this.#file('stickers'), this.container);
  }

  localKeyValue(): LocalKeyValueSnapshot {
    return new LocalKeyValueSnapshot(this.#file('localKeyValue'));
  }

  backedUpKeyValue(): BackedUpKeyValueSnapshot {
    return new BackedUpKeyValueSnapshot(this.#file('backedUpKeyValue'));
  }

  // A probe whose current value changes with each commit to the store.
  version(store: WhatsAppStore): WhatsAppVersion {
    return new WhatsAppVersion(this.#file(store));
  }

  // When WhatsApp last wrote this store. While the app is closed it writes
  // no chats or messages, and its notification extension writes only
  // LocalKeyValue.sqlite, so each store keeps its own time.
  lastWrite(store: WhatsAppStore): Date {
    return lastWrite(this.#file(store), WhatsAppUnavailableError);
  }

  #file(store: WhatsAppStore): string {
    return join(this.container, storeFiles[store]);
  }
}

// What changes when a store does: SQLite's data_version, which changes with
// every commit WhatsApp makes. A store that cannot be opened reads as missing,
// so its appearance is a change; reading it reports why.
export class WhatsAppVersion implements Disposable {
  readonly #path: string;
  #probe?: DataVersion;

  constructor(path: string) {
    this.#path = path;
  }

  get current(): string {
    try {
      this.#probe ??= new DataVersion(this.#path, WhatsAppUnavailableError);
    } catch (error) {
      if (error instanceof WhatsAppUnavailableError) return 'missing';
      throw error;
    }
    return String(this.#probe.current);
  }

  [Symbol.dispose](): void {
    this.#probe?.[Symbol.dispose]();
  }
}
