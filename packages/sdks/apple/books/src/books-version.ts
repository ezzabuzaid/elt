import { Gauge } from '@zukhruf/async';
import { FileStamps } from '@zukhruf/fs';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import {
  type BooksLocation,
  type BooksStore,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version, opened when the probe is; preference files are rewritten
// whole, so a changed file stamp of either marks a new one. A change watcher
// reads it as a gauge.
export abstract class BooksVersion extends Gauge<string> implements Disposable {
  readonly store: BooksStore;

  constructor(store: BooksStore) {
    super();
    this.store = store;
  }

  abstract [Symbol.dispose](): void;
}

export class BooksDatabaseVersion extends BooksVersion {
  readonly #version: AppDatabaseVersion;

  constructor(
    store: Exclude<BooksStore, 'preferences'>,
    version: AppDatabaseVersion,
  ) {
    super(store);
    this.#version = version;
  }

  protected async read(): Promise<string> {
    return String(this.#version.current);
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}

export class BooksPreferencesVersion extends BooksVersion {
  readonly #location: BooksLocation;

  constructor(location: BooksLocation) {
    super('preferences');
    this.#location = location;
  }

  protected async read(): Promise<string> {
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
