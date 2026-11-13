import { MissingError, UnavailableError } from '@zukhruf/sqlite-data-version';

import type { Store } from './store.ts';

// The message names the store, says whether it is not there or the system
// keeps the process from it, and gives what the user does for that reason.
// The cause decides, not the path: an SDK can name the folder of its store,
// which is there, for a file inside it that is not. A cause that does not
// say which keeps the grant, since the store can be there.
export class StoreUnavailableError extends Error {
  override name = 'StoreUnavailableError';
  readonly store: Store;
  readonly path: string;

  constructor(store: Store, path: string, cause: unknown) {
    const unavailable =
      cause instanceof UnavailableError
        ? cause
        : UnavailableError.from(path, cause);
    const [reason, remedy] =
      unavailable instanceof MissingError
        ? ['is not there', store.missing]
        : ['cannot be read', store.denied];
    super(`${store.name} at ${path} ${reason}.${remedy ? ` ${remedy}` : ''}`, {
      cause,
    });
    this.store = store;
    this.path = path;
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
