import { join } from 'node:path';

import type { AppDatabaseVersion } from '@eltjs/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { CallHistorySnapshot } from './call-history-snapshot.ts';

// Where macOS keeps the call history in the home folder `home`.
export const callHistoryStorePath = (home: string): string =>
  join(home, 'Library/Application Support/CallHistoryDB/CallHistory.storedata');

// The CallHistory framework's Core Data store, which callhistoryd writes for
// Phone and FaceTime and fills from the user's other devices through iCloud.
export class CallHistoryStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // The store as of one moment, so a call and its participants agree.
  open(): CallHistorySnapshot {
    return new CallHistorySnapshot(this.#path);
  }

  // A probe whose current value changes with each commit to the store, such
  // as callhistoryd recording a call or syncing one from iCloud.
  version(): AppDatabaseVersion {
    return appDatabase.version(this.#path);
  }
}
