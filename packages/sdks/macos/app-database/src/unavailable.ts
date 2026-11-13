import { statSync } from 'node:fs';

import { UnavailableError } from '@zukhruf/sqlite-data-version';

import type { Store } from './store.ts';

// The message names the store, says whether it is not there or the system
// keeps the process from it, and gives what the user does for that reason.
// SQLite reports both as CANTOPEN (14), so the package's error cannot tell
// them apart; it stays reachable as the cause.
export class StoreUnavailableError extends Error {
  override name = 'StoreUnavailableError';
  readonly store: Store;
  readonly path: string;

  constructor(store: Store, path: string, cause: unknown) {
    const [reason, remedy] = isMissing(path)
      ? ['is not there', store.missing]
      : ['cannot be read', store.denied];
    super(`${store.name} at ${path} ${reason}.${remedy ? ` ${remedy}` : ''}`, {
      cause,
    });
    this.store = store;
    this.path = path;
  }
}

// Whether the file system has no entry at the path. A stat that the system
// refuses, as macOS refuses one in a folder behind a privacy grant, is no
// answer: the store can be there.
function isMissing(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

export function readOrUnavailable<T>(
  path: string,
  store: Store,
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof UnavailableError)
      throw new StoreUnavailableError(store, path, error);
    throw error;
  }
}
