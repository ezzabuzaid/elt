import { UnavailableError } from '@zukhruf/sqlite-data-version';

import type { Store } from './store.ts';

// The message names the store and the grant the user must give; the
// package's error stays reachable as its cause.
export class StoreUnavailableError extends Error {
  override name = 'StoreUnavailableError';
  readonly store: Store;
  readonly path: string;

  constructor(store: Store, path: string, cause: unknown) {
    super(
      `${store.name} at ${path} cannot be read.${store.remedy ? ` ${store.remedy}` : ''}`,
      { cause },
    );
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
