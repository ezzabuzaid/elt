import { FileStamps } from '@zukhruf/fs';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import {
  type BooksLocation,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version, opened when the probe is; preference files are rewritten
// whole, so a changed file stamp of either marks a new one.
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
    return String(
      await FileStamps.read([
        storeFiles(this.#location).preferences,
        sharedPreferences(this.#location),
      ]),
    );
  }

  // A stat holds nothing open.
  [Symbol.dispose](): void {}
}
