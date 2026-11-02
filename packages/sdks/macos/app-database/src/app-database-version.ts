import type { DataVersion } from '@zukhruf/sqlite-data-version';

import {
  type UnavailableErrorClass,
  readOrUnavailable,
} from './unavailable.ts';

// A DataVersion reopens a file the owner replaced, so every read, not only
// the first open, can find the database unavailable.
export class AppDatabaseVersion implements Disposable {
  readonly #path: string;
  readonly #unavailable: UnavailableErrorClass;
  readonly #version: DataVersion;

  // open makes the DataVersion of the owner's kind.
  constructor(
    path: string,
    unavailable: UnavailableErrorClass,
    open: () => DataVersion,
  ) {
    this.#path = path;
    this.#unavailable = unavailable;
    this.#version = readOrUnavailable(path, unavailable, open);
  }

  get current(): number {
    return readOrUnavailable(
      this.#path,
      this.#unavailable,
      () => this.#version.current,
    );
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}
