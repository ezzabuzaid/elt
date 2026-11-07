import { join } from 'node:path';

import {
  type AppDatabaseVersion,
  AppFilesVersion,
} from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { ClockDatabase } from './clock-database.ts';
import { stopwatches, worldClocks } from './clock-preferences.ts';

export { StoreUnavailableError } from '@workspace/sdk-macos-app-database';

export type ClockLocation = {
  readonly database: string;
  readonly cities: string;
  readonly stopwatches: string;
};
export type ClockStoreKind = keyof ClockLocation;
// Where Clock keeps its three stores in the home folder `home`.
export const clockLocation = (home: string): ClockLocation =>
  Object.freeze({
    database: join(
      home,
      'Library/Group Containers/group.com.apple.mobiletimerd/local.sqlite',
    ),
    cities: join(
      home,
      'Library/Containers/com.apple.clock/Data/Library/Preferences/com.apple.mobiletimer.plist',
    ),
    stopwatches: join(home, 'Library/Preferences/com.apple.mobiletimerd.plist'),
  });

export class ClockStore {
  readonly #location: ClockLocation;
  constructor(location: ClockLocation) {
    this.#location = location;
  }
  open(stores: ReadonlySet<ClockStoreKind>): Promise<ClockSnapshot> {
    return ClockSnapshot.open(this.#location, stores);
  }
  version(store: ClockStoreKind): ClockVersion {
    const path = this.#location[store];
    return store === 'database'
      ? appDatabase.version(path)
      : new AppFilesVersion(() => [path]);
  }
}

// Independent stores retain their own failures; a missing city file must not
// hide alarms, and malformed stopwatch data must never look like a reset.
export class ClockSnapshot implements AsyncDisposable {
  #database?: ClockDatabase;
  #cities?: Awaited<ReturnType<typeof worldClocks>>;
  #stopwatches?: Awaited<ReturnType<typeof stopwatches>>;
  readonly #errors = new Map<ClockStoreKind, unknown>();
  static async open(
    location: ClockLocation,
    stores: ReadonlySet<ClockStoreKind>,
  ): Promise<ClockSnapshot> {
    const snapshot = new ClockSnapshot();
    for (const store of stores) {
      try {
        switch (store) {
          case 'database':
            snapshot.#database = new ClockDatabase(location.database);
            break;
          case 'cities':
            snapshot.#cities = await worldClocks(location.cities);
            break;
          case 'stopwatches':
            snapshot.#stopwatches = await stopwatches(location.stopwatches);
            break;
        }
      } catch (error) {
        snapshot.#errors.set(store, error);
      }
    }
    return snapshot;
  }
  get database(): ClockDatabase {
    this.#check('database');
    if (!this.#database) throw new Error('Clock database was not selected');
    return this.#database;
  }
  get cities(): Awaited<ReturnType<typeof worldClocks>> {
    this.#check('cities');
    if (!this.#cities) throw new Error('Clock cities were not selected');
    return this.#cities;
  }
  get stopwatches(): Awaited<ReturnType<typeof stopwatches>> {
    this.#check('stopwatches');
    if (!this.#stopwatches)
      throw new Error('Clock stopwatches were not selected');
    return this.#stopwatches;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.#database?.[Symbol.dispose]();
  }
  #check(store: ClockStoreKind): void {
    if (this.#errors.has(store)) throw this.#errors.get(store);
  }
}

// SQLite sees WAL commits; preferences are atomically rewritten, so a changed
// file stamp marks a new one. A version never loads records.
export type ClockVersion = AppDatabaseVersion | AppFilesVersion;
