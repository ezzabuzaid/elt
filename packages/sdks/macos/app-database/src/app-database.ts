import { DataVersion, lastWrite } from '@zukhruf/sqlite-data-version';
import {
  Snapshot,
  type SnapshotColumns,
  UnavailableError,
} from '@zukhruf/sqlite-snapshot';

import { AppDatabaseVersion } from './app-database-version.ts';
import type { Store } from './store.ts';
import { StoreUnavailableError, readOrUnavailable } from './unavailable.ts';

// One app's SQLite stores, read through the zukhruf packages. A store the
// process cannot open fails with StoreUnavailableError, whose message names
// the store and tells the user what to grant; a store without a column the
// reader reads fails with the package's MissingColumnsError, since no grant
// fixes an out-of-date reader.
export class AppDatabase {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  snapshot(path: string, columns?: SnapshotColumns): Snapshot {
    try {
      const snapshot = new Snapshot(path);
      if (columns) snapshot.requireColumns(columns);
      return snapshot;
    } catch (error) {
      if (error instanceof UnavailableError)
        throw new StoreUnavailableError(this.#store, path, error);
      throw error;
    }
  }

  // A store whose app holds SQLite's exclusive locking mode, as Chromium
  // holds its History, lets no reader in: the snapshot reads a checked copy
  // at the app's last commit.
  async snapshotOfExclusiveOwner(
    path: string,
    columns?: SnapshotColumns,
  ): Promise<Snapshot> {
    try {
      const snapshot = await Snapshot.ofExclusiveOwner(path);
      if (columns) snapshot.requireColumns(columns);
      return snapshot;
    } catch (error) {
      if (error instanceof UnavailableError)
        throw new StoreUnavailableError(this.#store, path, error);
      throw error;
    }
  }

  version(path: string): AppDatabaseVersion {
    return new AppDatabaseVersion(
      path,
      this.#store,
      () => new DataVersion(path),
    );
  }

  versionOfExclusiveOwner(path: string): AppDatabaseVersion {
    return new AppDatabaseVersion(path, this.#store, () =>
      DataVersion.ofExclusiveOwner(path),
    );
  }

  lastWrite(path: string): Date {
    return readOrUnavailable(path, this.#store, () => lastWrite(path));
  }
}
