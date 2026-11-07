import { Gauge } from '@zukhruf/async';
import { FileStamps } from '@zukhruf/fs';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import {
  type BooksLocation,
  sharedPreferences,
  storeFiles,
} from './books-location.ts';

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version; preference files are rewritten whole, so a changed file stamp
// of either marks a new one.
export type BooksVersion = AppDatabaseVersion | BooksPreferencesVersion;

export class BooksPreferencesVersion extends Gauge<string> {
  readonly #location: BooksLocation;

  constructor(location: BooksLocation) {
    super();
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
}
