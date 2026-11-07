import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { BusinessesSnapshot } from './businesses.ts';
import { CallsSnapshot } from './calls.ts';
import { ChatStorageSnapshot } from './chat-storage.ts';
import { ContactsSnapshot } from './contacts.ts';
import {
  BackedUpKeyValueSnapshot,
  LocalKeyValueSnapshot,
} from './key-values.ts';
import { MessageAssociationsSnapshot } from './message-associations.ts';
import { StatusesSnapshot } from './statuses.ts';
import { StickersSnapshot } from './stickers.ts';
import { UsersSnapshot } from './users.ts';

// The group container WhatsApp for Mac shares with its extensions, in the
// given home folder.
export const whatsappContainer = (home: string): string =>
  join(home, 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');

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

  constructor(container: string) {
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

  // What changes when a store does: SQLite's data_version, which changes with
  // every commit WhatsApp makes. A store that cannot be opened reads as
  // unavailable, so its appearance is a change; reading it reports why.
  version(store: WhatsAppStore): AppDatabaseVersion {
    return appDatabase.version(this.#file(store));
  }

  // When WhatsApp last wrote this store. While the app is closed it writes
  // no chats or messages, and its notification extension writes only
  // LocalKeyValue.sqlite, so each store keeps its own time.
  lastWrite(store: WhatsAppStore): Date {
    return appDatabase.lastWrite(this.#file(store));
  }

  #file(store: WhatsAppStore): string {
    return join(this.container, storeFiles[store]);
  }
}
