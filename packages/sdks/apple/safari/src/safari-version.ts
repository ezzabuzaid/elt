import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { AppDatabaseVersion } from '@workspace/sdk-apple-app-database';

import { SafariUnavailableError } from './errors.ts';
import {
  type SafariLocation,
  type SafariStore,
  storeFiles,
} from './safari-location.ts';

// A property list's identity on disk; a rewrite changes it. A missing file
// reads as its own state, so its return is a change too.
async function fingerprint(path: string): Promise<string> {
  try {
    const { ino, size, mtimeMs } = await stat(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return 'missing';
    throw error;
  }
}

// Every History.db: the default profile's, and each other profile's, so a
// profile created while watching is picked up.
async function historyFiles(location: SafariLocation): Promise<string[]> {
  const profiles = join(location.container, 'Profiles');
  const found = await readdir(profiles, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    },
  );
  const others = await Promise.all(
    found
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(profiles, entry.name, 'History.db');
        return (await fingerprint(path)) === 'missing' ? [] : [path];
      }),
  );
  return [storeFiles(location).history, ...others.flat()];
}

// What changes when one Safari store does. Databases report commits through
// data_version, since Safari commits through WALs it keeps open and FSEvents
// reports a write only when the file closes; Safari rewrites each property
// list whole, so a changed stat marks a new one.
export class SafariVersion implements Disposable {
  readonly #location: SafariLocation;
  readonly #store: SafariStore;
  readonly #databases = new Map<string, AppDatabaseVersion>();

  constructor(location: SafariLocation, store: SafariStore) {
    this.#location = location;
    this.#store = store;
  }

  async current(): Promise<string> {
    const files = storeFiles(this.#location);
    if (this.#store === 'history') {
      const paths = await historyFiles(this.#location);
      for (const [path, version] of this.#databases)
        if (!paths.includes(path)) {
          version[Symbol.dispose]();
          this.#databases.delete(path);
        }
      return paths.map((path) => this.#version(path)).join(',');
    }
    if (this.#store === 'tabs' || this.#store === 'cloudTabs')
      return String(this.#version(files[this.#store]));
    return fingerprint(files[this.#store]);
  }

  [Symbol.dispose](): void {
    for (const version of this.#databases.values()) version[Symbol.dispose]();
    this.#databases.clear();
  }

  #version(path: string): number {
    let version = this.#databases.get(path);
    if (version === undefined) {
      version = new AppDatabaseVersion(path, SafariUnavailableError);
      this.#databases.set(path, version);
    }
    return version.current;
  }
}
