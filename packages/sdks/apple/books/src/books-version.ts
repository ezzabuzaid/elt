import { stat } from 'node:fs/promises';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import {
  type BooksLocation,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';

// A preference file's identity on disk; a rewrite changes it. A missing file
// reads as its own state, so its return is a change too.
async function fingerprint(path: string): Promise<string> {
  const stats = await stat(path, { throwIfNoEntry: false });
  if (stats === undefined) return 'missing';
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version, opened when the probe is; preference files are rewritten
// whole, so a changed stat of either marks a new one.
export interface BooksVersion extends Disposable {
  current(): Promise<string>;
}

export class BooksDatabaseVersion implements BooksVersion {
  readonly #version: AppDatabaseVersion;

  constructor(version: AppDatabaseVersion) {
    this.#version = version;
  }

  async current(): Promise<string> {
    return String(this.#version.current);
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}

export class BooksPreferencesVersion implements BooksVersion {
  readonly #location: BooksLocation;

  constructor(location: BooksLocation) {
    this.#location = location;
  }

  async current(): Promise<string> {
    return `${await fingerprint(storeFiles(this.#location).preferences)}|${await fingerprint(sharedPreferences(this.#location))}`;
  }

  // A stat holds nothing open.
  [Symbol.dispose](): void {}
}
