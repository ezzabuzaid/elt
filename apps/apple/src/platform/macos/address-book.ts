import { type Dirent, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

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

// SQLite's CANTOPEN and AUTH: a missing file or a privacy denial.
const unavailableCodes = new Set([14, 23]);

const open = (path: string) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new ContactsUnavailableError(path, cause);
    throw cause;
  }
};

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

export class AddressBookStore {
  readonly #database: DatabaseSync;

  constructor(
    // The Sources directory name, or null for the On My Mac store.
    readonly source: string | null,
    readonly directory: string,
    database: DatabaseSync,
  ) {
    this.#database = database;
  }

  get path(): string {
    return join(this.directory, storeFile);
  }

  all(sql: string): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all();
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

  close(): void {
    if (this.#database.isOpen) {
      if (this.#database.isTransaction) this.#database.exec('COMMIT');
      this.#database.close();
    }
  }
}

// The tables' columns and the Core Data entities a reader depends on.
export type AddressBookSchema = {
  readonly columns: Readonly<Record<string, readonly string[]>>;
  readonly entities: readonly string[];
};

// Every store read-only, each pinned to one moment by a read transaction so a
// contact and its phones, groups and images agree. Stores commit separately,
// so two accounts are not pinned to the same instant. Hold it only while
// reading: an open read stops contactsd checkpointing the WAL.
export class AddressBook implements AsyncDisposable {
  private constructor(readonly stores: readonly AddressBookStore[]) {}

  static async open(
    directory: string,
    required: AddressBookSchema,
  ): Promise<AddressBook> {
    const stores: AddressBookStore[] = [];
    try {
      for (const store of storeDirectories(directory)) {
        const path = join(store.directory, storeFile);
        const database = open(path);
        stores.push(
          new AddressBookStore(store.source, store.directory, database),
        );
        database.exec('BEGIN');
        const missing = Object.entries(required.columns).flatMap(
          ([table, columns]) => {
            const present = new Set(
              database
                .prepare('SELECT name FROM pragma_table_info(?)')
                .all(table)
                .map((column) => column.name),
            );
            return columns
              .filter((column) => !present.has(column))
              .map((column) => `${table}.${column}`);
          },
        );
        // A renamed entity would match no rows, and an account read as empty
        // loses its contacts from every target.
        if (missing.length === 0) {
          const entities = new Set(
            database
              .prepare('SELECT Z_NAME FROM Z_PRIMARYKEY')
              .all()
              .map((entity) => entity.Z_NAME),
          );
          for (const entity of required.entities)
            if (!entities.has(entity)) missing.push(`entity ${entity}`);
        }
        if (missing.length > 0) throw new ContactsSchemaError(path, missing);
      }
      return new AddressBook(stores);
    } catch (cause) {
      for (const store of stores) store.close();
      throw cause;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const store of this.stores) store.close();
  }
}

// contactsd commits through WALs it keeps open, and FSEvents reports a write
// only when a file closes. SQLite's data_version changes on every commit by
// another connection, so polling it sees each one; an added or removed
// account changes the store set.
export class AddressBookVersion implements Disposable {
  readonly #stores = new Map<
    string,
    { readonly database: DatabaseSync; readonly version: StatementSync }
  >();

  constructor(readonly directory: string) {}

  get current(): string {
    const paths = storeDirectories(this.directory).map(({ directory }) =>
      join(directory, storeFile),
    );
    for (const [path, { database }] of this.#stores)
      if (!paths.includes(path)) {
        database.close();
        this.#stores.delete(path);
      }
    return JSON.stringify(
      paths.map((path) => {
        let store = this.#stores.get(path);
        if (store === undefined) {
          const database = open(path);
          store = {
            database,
            version: database.prepare('PRAGMA data_version'),
          };
          this.#stores.set(path, store);
        }
        return [path, Number(store.version.get()?.data_version)];
      }),
    );
  }

  [Symbol.dispose](): void {
    for (const { database } of this.#stores.values()) database.close();
    this.#stores.clear();
  }
}
