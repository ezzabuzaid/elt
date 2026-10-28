import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { readPassBundle } from './pass-bundle.ts';
import type { Pass } from './pass.ts';
import { lastPassesFetch } from './passes-fetch.ts';
import { walletRecords } from './wallet-records.ts';

// Where macOS keeps this user's Wallet passes; no privacy grant guards it.
export const walletStorePath = join(homedir(), 'Library/Passes');

// Wallet's passes on this Mac as passd keeps them: passes23.sqlite records
// when each pass was added, updated and archived, and Cards/<id>.pkpass holds
// the bundle its issuer signed. A pass the user removes, on this Mac or on a
// device that syncs it through iCloud, loses its row and its bundle, and
// passd records nothing of it.
export class WalletStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get #database(): string {
    return join(this.#directory, 'passes23.sqlite');
  }

  // Every pass Wallet holds. The bundles are read after the database closes,
  // one at a time, so a large Wallet never holds many files open.
  async passes(): Promise<Pass[]> {
    const passes: Pass[] = [];
    for (const record of walletRecords(this.#database))
      passes.push({
        ...record,
        ...(await readPassBundle(
          record.id,
          join(this.#directory, 'Cards', `${record.id}.pkpass`),
        )),
      });
    return passes;
  }

  // When passd last fetched the passes other devices sync through iCloud, or
  // null on a Mac that has never fetched them. passd fetches them once a day,
  // so a pass added, changed or removed on another device reaches this Mac up
  // to a day later.
  lastFetch(): Date | null {
    return lastPassesFetch(this.#database);
  }

  // A probe whose current value changes with each commit to the database,
  // such as passd adding, updating, archiving or removing a pass.
  version(): AppDatabaseVersion {
    return appDatabase.version(this.#database);
  }
}
