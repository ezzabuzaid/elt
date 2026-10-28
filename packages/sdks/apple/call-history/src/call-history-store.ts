import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { CallHistorySnapshot } from './call-history-snapshot.ts';

// Where macOS keeps this user's call history.
export const callHistoryStorePath = join(
  homedir(),
  'Library/Application Support/CallHistoryDB/CallHistory.storedata',
);

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
