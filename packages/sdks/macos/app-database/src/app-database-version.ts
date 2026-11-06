import { Gauge } from '@zukhruf/async';
import type { DataVersion } from '@zukhruf/sqlite-data-version';

import type { Store } from './store.ts';
import { readOrUnavailable } from './unavailable.ts';

// A DataVersion reopens a file the owner replaced, so every read, not only
// the first open, can find the database unavailable. A change watcher reads
// it as a gauge of the current version.
export class AppDatabaseVersion extends Gauge<number> implements Disposable {
  readonly #path: string;
  readonly #store: Store;
  readonly #version: DataVersion;

  // open makes the DataVersion of the owner's kind.
  constructor(path: string, store: Store, open: () => DataVersion) {
    super();
    this.#path = path;
    this.#store = store;
    this.#version = readOrUnavailable(path, store, open);
  }

  get current(): number {
    return readOrUnavailable(
      this.#path,
      this.#store,
      () => this.#version.current,
    );
  }

  protected async read(): Promise<number> {
    return this.current;
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}
