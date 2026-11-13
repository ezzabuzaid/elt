import { MissingError, UnavailableError } from '@zukhruf/sqlite-data-version';

import { macOSAccess } from './macos-access.ts';
import type { Store } from './store.ts';

// The message names the store, says whether it is not there or the system
// keeps the process from it, and gives what the user does for that reason:
// for a denial, the grant, naming the program installed in this process,
// which is the one that failed. The cause decides, not the path: an SDK can
// name the folder of its store, which is there, for a file inside it that is
// not. A cause that does not say which keeps the grant, since the store can
// be there.
export class StoreUnavailableError extends Error {
  override name = 'StoreUnavailableError';
  readonly store: Store;
  readonly path: string;
  // The store, or the file that failed inside it, is not there; otherwise the
  // system keeps the process from it, or the cause does not say which.
  readonly missing: boolean;

  constructor(store: Store, path: string, cause: unknown) {
    const unavailable =
      cause instanceof UnavailableError
        ? cause
        : UnavailableError.from(path, cause);
    const missing = unavailable instanceof MissingError;
    const [reason, remedy] = missing
      ? ['is not there', store.missing]
      : [
          'cannot be read',
          store.grant === undefined ? '' : macOSAccess.remedy(store.grant),
        ];
    super(`${store.name} at ${path} ${reason}.${remedy ? ` ${remedy}` : ''}`, {
      cause,
    });
    this.store = store;
    this.path = path;
    this.missing = missing;
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
