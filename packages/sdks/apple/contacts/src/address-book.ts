import { type Dirent, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AppDatabaseVersion } from '@workspace/sdk-apple-app-database';

import { AddressBookStore, storeFile } from './address-book-store.ts';
import { ContactsUnavailableError } from './errors.ts';

export const addressBookDirectory = join(
  homedir(),
  'Library/Application Support/AddressBook',
);

// Contacts keeps one Core Data store per account under Sources/<id>, and the
// On My Mac store at the root. A store that cannot be listed or opened throws:
// an account read as empty would delete its contacts from every target.
function storeDirectories(
  directory: string,
): { readonly source: string | null; readonly directory: string }[] {
  const sources = join(directory, 'Sources');
  let entries: Dirent[];
  try {
    entries = readdirSync(sources, { withFileTypes: true });
  } catch (cause) {
    throw new ContactsUnavailableError(sources, cause);
  }
  return [
    { source: null, directory },
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((source) => ({ source, directory: join(sources, source) })),
  ];
}

// Every account's store. Stores commit separately, so two accounts are not
// pinned to the same instant. Hold it only while reading: an open read stops
// contactsd checkpointing the WAL.
export class AddressBook implements AsyncDisposable {
  readonly stores: readonly AddressBookStore[];

  private constructor(stores: readonly AddressBookStore[]) {
    this.stores = stores;
  }

  static async open(directory: string): Promise<AddressBook> {
    const stores: AddressBookStore[] = [];
    try {
      for (const found of storeDirectories(directory)) {
        const store = new AddressBookStore(found.source, found.directory);
        stores.push(store);
        store.requireLayout();
      }
      return new AddressBook(stores);
    } catch (cause) {
      for (const store of stores) store[Symbol.dispose]();
      throw cause;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const store of this.stores) store[Symbol.dispose]();
  }
}

// contactsd commits through WALs it keeps open; each store's probe changes
// with each commit to it, and an added or removed account changes the store
// set.
export class AddressBookVersion implements Disposable {
  readonly #stores = new Map<string, AppDatabaseVersion>();
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  get current(): string {
    const paths = storeDirectories(this.directory).map(({ directory }) =>
      join(directory, storeFile),
    );
    for (const [path, version] of this.#stores)
      if (!paths.includes(path)) {
        version[Symbol.dispose]();
        this.#stores.delete(path);
      }
    return JSON.stringify(
      paths.map((path) => {
        let version = this.#stores.get(path);
        if (version === undefined) {
          version = new AppDatabaseVersion(path, ContactsUnavailableError);
          this.#stores.set(path, version);
        }
        return [path, version.current];
      }),
    );
  }

  [Symbol.dispose](): void {
    for (const version of this.#stores.values()) version[Symbol.dispose]();
    this.#stores.clear();
  }
}

// Contacts' own Core Data stores, read without Contacts.app or the Contacts
// framework.
export class ContactsStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  open(): Promise<AddressBook> {
    return AddressBook.open(this.#directory);
  }

  version(): AddressBookVersion {
    return new AddressBookVersion(this.#directory);
  }
}
