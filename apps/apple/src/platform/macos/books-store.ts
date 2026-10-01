import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';
import { isBinaryPlist, type PlistValue, parseBinaryPlist } from './plist.ts';

// Books.app's own container: the library, annotations, themes and its
// preferences.
export const booksContainer = join(
  homedir(),
  'Library/Containers/com.apple.iBooksX/Data',
);
// The group container bookdatastored writes: per-book reading state, reading
// history, store purchases and the shared preferences.
export const booksGroupContainer = join(
  homedir(),
  'Library/Group Containers/group.com.apple.iBooks',
);

export class BooksUnavailableError extends Error {
  override name = 'BooksUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Books data at ${path} cannot be read. Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security. Books does not need to be open.`,
      { cause },
    );
  }
}

// Books changes its stores between releases; reading one we have not
// verified would silently misplace fields.
export class BooksSchemaError extends Error {
  override name = 'BooksSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Books store at ${path} has a layout this connector does not read (missing ${missing.join(', ')}).`,
    );
  }
}

// SQLite's CANTOPEN and AUTH: a missing file or a Full Disk Access denial.
const unavailableCodes = new Set([14, 23]);

// Read-only, never immutable: Books keeps Core Data's persistent WAL, and most
// current rows live only there.
const open = (path: string) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new BooksUnavailableError(path, cause);
    throw cause;
  }
};

// Books and bookdatastored commit through WALs they keep open, and FSEvents
// reports a write only when the file closes. SQLite's data_version changes on
// every commit by another connection, so polling it sees each one.
export class BooksDatabaseVersion implements Disposable {
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(path: string) {
    this.#database = open(path);
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  get current(): number {
    return Number(this.#version.get()?.data_version);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// A read-only view of one Books database pinned to one moment, so its tables
// agree. Hold it only while reading: an open read stops Books checkpointing
// its WAL.
export class BooksDatabase implements AsyncDisposable {
  readonly path: string;
  readonly #database: DatabaseSync;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  static async open(
    path: string,
    required: Readonly<Record<string, readonly string[]>>,
  ): Promise<BooksDatabase> {
    const database = open(path);
    try {
      database.exec('BEGIN');
      const missing = Object.entries(required).flatMap(([table, columns]) => {
        const present = new Set(
          database
            .prepare('SELECT name FROM pragma_table_info(?)')
            .all(table)
            .map((column) => column.name),
        );
        return columns
          .filter((column) => !present.has(column))
          .map((column) => `${table}.${column}`);
      });
      if (missing.length > 0) throw new BooksSchemaError(path, missing);
      return new BooksDatabase(path, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  all(sql: string): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}

// One of Books' preference files, whole. A missing or unreadable file fails
// the read; it never reads as empty preferences.
export async function readBooksPlist(path: string): Promise<PlistValue> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new BooksUnavailableError(path, cause);
  }
  if (!isBinaryPlist(bytes))
    throw new BooksSchemaError(path, ['binary property list']);
  return parseBinaryPlist(bytes);
}
