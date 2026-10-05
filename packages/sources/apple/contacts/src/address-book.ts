import { type Dirent, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AppDatabase,
  type AppDatabaseColumns,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

export const addressBookDirectory = join(
  homedir(),
  'Library/Application Support/AddressBook',
);

const storeFile = 'AddressBook-v22.abcddb';

export class ContactsUnavailableError extends Error {
  override name = 'ContactsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Contacts store at ${path} cannot be read. Allow the process that runs the export Contacts access or Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Contacts.app does not need to be open.`,
      { cause },
    );
  }
}

// The store's layout changes between macOS releases; reading one we have not
// verified would silently misplace fields.
export class ContactsSchemaError extends Error {
  override name = 'ContactsSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Contacts store at ${path} has a layout this connector does not read (missing ${missing.join(', ')}).`,
    );
  }
}

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

// A value of a Core Data attribute that allows external storage: 0x01 and
// the bytes, or 0x02 and the NUL-terminated UUID of a file in _EXTERNAL_DATA.
export type StoredData =
  | { readonly storage: 'inline'; readonly bytes: Uint8Array }
  | {
      readonly storage: 'external';
      readonly id: string;
      readonly path: string;
    };

// One account's store, read-only and pinned to one moment by a read
// transaction so a contact and its phones, groups and images agree.
export class AddressBookStore extends AppDatabase {
  // The Sources directory name, or null for the On My Mac store.
  readonly source: string | null;
  readonly directory: string;

  constructor(source: string | null, directory: string) {
    super(join(directory, storeFile), ContactsUnavailableError);
    this.source = source;
    this.directory = directory;
  }

  storedData(value: Uint8Array): StoredData {
    if (value[0] === 1) return { storage: 'inline', bytes: value.subarray(1) };
    if (value[0] === 2) {
      const end = value.indexOf(0, 1);
      const id = Buffer.from(
        value.subarray(1, end === -1 ? value.length : end),
      ).toString('ascii');
      return {
        storage: 'external',
        id,
        path: join(
          this.directory,
          '.AddressBook-v22_SUPPORT/_EXTERNAL_DATA',
          id,
        ),
      };
    }
    throw new TypeError(
      `Contacts store ${this.path} holds data in an unknown encoding (first byte ${value[0]})`,
    );
  }
}

// The tables' columns and the Core Data entities a reader depends on.
export type AddressBookSchema = {
  readonly columns: AppDatabaseColumns;
  readonly entities: readonly string[];
};

// Every account's store. Stores commit separately, so two accounts are not
// pinned to the same instant. Hold it only while reading: an open read stops
// contactsd checkpointing the WAL.
export class AddressBook implements AsyncDisposable {
  readonly stores: readonly AddressBookStore[];

  private constructor(stores: readonly AddressBookStore[]) {
    this.stores = stores;
  }

  static async open(
    directory: string,
    required: AddressBookSchema,
  ): Promise<AddressBook> {
    const stores: AddressBookStore[] = [];
    try {
      for (const found of storeDirectories(directory)) {
        const store = new AddressBookStore(found.source, found.directory);
        stores.push(store);
        store.requireColumns(required.columns, ContactsSchemaError);
        // A renamed entity would match no rows, and an account read as empty
        // loses its contacts from every target.
        const entities = new Set(
          store
            .all('SELECT Z_NAME FROM Z_PRIMARYKEY')
            .map((entity) => entity.Z_NAME),
        );
        const missing = required.entities
          .filter((entity) => !entities.has(entity))
          .map((entity) => `entity ${entity}`);
        if (missing.length > 0)
          throw new ContactsSchemaError(store.path, missing);
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
