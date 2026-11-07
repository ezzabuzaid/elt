import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Gauge } from '@zukhruf/async';
import { FileStamp } from '@zukhruf/fs';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { type SafariLocation, storeFiles } from './safari-location.ts';

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
        return (await stat(path, { throwIfNoEntry: false })) === undefined
          ? []
          : [path];
      }),
  );
  return [storeFiles(location).history, ...others.flat()];
}

// What changes when one Safari store does. Databases report commits through
// data_version, since Safari commits through WALs it keeps open and FSEvents
// reports a write only when the file closes; Safari rewrites each property
// list whole, so a changed file stamp marks a new one.
export type SafariVersion =
  AppDatabaseVersion | SafariHistoryVersion | SafariPropertyListVersion;

// The data_version of every History.db, so a profile created while watching
// is a change of history.
export class SafariHistoryVersion extends Gauge<string> implements Disposable {
  readonly #location: SafariLocation;
  readonly #databases = new Map<string, AppDatabaseVersion>();

  constructor(location: SafariLocation) {
    super();
    this.#location = location;
  }

  protected async read(): Promise<string> {
    const paths = await historyFiles(this.#location);
    for (const [path, version] of this.#databases)
      if (!paths.includes(path)) {
        version[Symbol.dispose]();
        this.#databases.delete(path);
      }
    return paths.map((path) => this.#version(path)).join(',');
  }

  [Symbol.dispose](): void {
    for (const version of this.#databases.values()) version[Symbol.dispose]();
    this.#databases.clear();
  }

  #version(path: string): number | 'unavailable' {
    let version = this.#databases.get(path);
    if (version === undefined) {
      version = appDatabase.version(path);
      this.#databases.set(path, version);
    }
    return version.current;
  }
}

export class SafariPropertyListVersion extends Gauge<string> {
  readonly #path: string;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  protected async read(): Promise<string> {
    return String(await FileStamp.read(this.#path));
  }
}
