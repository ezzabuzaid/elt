import { stat } from 'node:fs/promises';

import { AppDatabaseVersion } from '@workspace/sdk-apple-app-database';

import {
  type BooksLocation,
  type BooksStore,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';
import { BooksUnavailableError } from './errors.ts';

// A preference file's identity on disk; a rewrite changes it. A missing file
// reads as its own state, so its return is a change too.
async function fingerprint(path: string): Promise<string> {
  try {
    const { ino, size, mtimeMs } = await stat(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return 'missing';
    throw error;
  }
}

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version, opened when the probe is; preference files are rewritten
// whole, so a changed stat of either marks a new one.
export class BooksVersion implements Disposable {
  readonly #location: BooksLocation;
  readonly #database: AppDatabaseVersion | null;

  constructor(location: BooksLocation, store: BooksStore) {
    this.#location = location;
    this.#database =
      store === 'preferences'
        ? null
        : new AppDatabaseVersion(
            storeFiles(location)[store],
            BooksUnavailableError,
          );
  }

  async current(): Promise<string> {
    if (this.#database !== null) return String(this.#database.current);
    return `${await fingerprint(storeFiles(this.#location).preferences)}|${await fingerprint(sharedPreferences(this.#location))}`;
  }

  [Symbol.dispose](): void {
    this.#database?.[Symbol.dispose]();
  }
}
