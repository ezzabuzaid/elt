import { DataVersion, lastWrite } from '@zukhruf/sqlite-data-version';
import {
  Snapshot,
  type SnapshotColumns,
  UnavailableError,
} from '@zukhruf/sqlite-snapshot';

import { AppDatabaseVersion } from './app-database-version.ts';
import {
  type UnavailableErrorClass,
  readOrUnavailable,
} from './unavailable.ts';

export interface AppDatabaseErrors {
  unavailable: UnavailableErrorClass;
}

// One app's SQLite stores, read through the zukhruf packages. A store the
// process cannot open fails with the SDK's own error, whose message tells the
// user what to grant; a store without a column the reader reads fails with the
// package's MissingColumnsError, since no grant fixes an out-of-date reader.
export class AppDatabase {
  readonly #errors: AppDatabaseErrors;

  constructor(errors: AppDatabaseErrors) {
    this.#errors = errors;
  }

  snapshot(path: string, columns?: SnapshotColumns): Snapshot {
    try {
      const snapshot = new Snapshot(path);
      if (columns) snapshot.requireColumns(columns);
      return snapshot;
    } catch (error) {
      if (error instanceof UnavailableError)
        throw new this.#errors.unavailable(path, error);
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
        throw new this.#errors.unavailable(path, error);
      throw error;
    }
  }

  version(path: string): AppDatabaseVersion {
    return new AppDatabaseVersion(
      path,
      this.#errors.unavailable,
      () => new DataVersion(path),
    );
  }

  versionOfExclusiveOwner(path: string): AppDatabaseVersion {
    return new AppDatabaseVersion(path, this.#errors.unavailable, () =>
      DataVersion.ofExclusiveOwner(path),
    );
  }

  lastWrite(path: string): Date {
    return readOrUnavailable(path, this.#errors.unavailable, () =>
      lastWrite(path),
    );
  }
}
