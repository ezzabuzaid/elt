import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type PlistValue,
  isBinaryPlist,
  parseBinaryPlist,
} from '@workspace/macos-plist';
import {
  AppDatabase,
  type AppDatabaseColumns,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

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

// Books and bookdatastored commit through WALs they keep open; this probe
// changes with each commit to one database.
export class BooksDatabaseVersion extends AppDatabaseVersion {
  constructor(path: string) {
    super(path, BooksUnavailableError);
  }
}

// A read-only view of one Books database pinned to one moment, so its tables
// agree. Never immutable: Books keeps Core Data's persistent WAL, and most
// current rows live only there.
export class BooksDatabase extends AppDatabase {
  constructor(path: string, columns: AppDatabaseColumns) {
    super(path, BooksUnavailableError);
    this.requireColumns(columns, BooksSchemaError);
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
