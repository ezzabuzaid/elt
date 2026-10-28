import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { ClockDatabase } from './clock-database.ts';
import { stopwatches, worldClocks } from './clock-preferences.ts';
import { ClockUnavailableError } from './errors.ts';

export { ClockUnavailableError } from './errors.ts';

export type ClockLocation = {
  readonly database: string;
  readonly cities: string;
  readonly stopwatches: string;
};
export type ClockStoreKind = keyof ClockLocation;
export const clockLocation: ClockLocation = Object.freeze({
  database: join(
    homedir(),
    'Library/Group Containers/group.com.apple.mobiletimerd/local.sqlite',
  ),
  cities: join(
    homedir(),
    'Library/Containers/com.apple.clock/Data/Library/Preferences/com.apple.mobiletimer.plist',
  ),
  stopwatches: join(
    homedir(),
    'Library/Preferences/com.apple.mobiletimerd.plist',
  ),
});

export class ClockStore {
  readonly #location: ClockLocation;
  constructor(location: ClockLocation = clockLocation) {
    this.#location = location;
  }
  open(stores: ReadonlySet<ClockStoreKind>): Promise<ClockSnapshot> {
    return ClockSnapshot.open(this.#location, stores);
  }
  version(store: ClockStoreKind): ClockVersion {
    const path = this.#location[store];
    return store === 'database'
      ? new ClockDatabaseVersion(appDatabase.version(path))
      : new ClockPreferencesVersion(path);
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

// SQLite sees WAL commits; preferences are atomically rewritten. A version
// probe never loads records. Missing preference files still change on return.
export interface ClockVersion extends Disposable {
  current(): Promise<string>;
}

class ClockDatabaseVersion implements ClockVersion {
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

class ClockPreferencesVersion implements ClockVersion {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  async current(): Promise<string> {
    try {
      const stats = await stat(this.#path, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (stats === undefined) return 'missing';
      return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch (cause) {
      throw new ClockUnavailableError(this.#path, cause);
    }
  }
  // A stat holds nothing open.
  [Symbol.dispose](): void {}
}
