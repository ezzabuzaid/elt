import { watch } from 'node:fs';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { envelopeIndexPath } from './mail-location.ts';

// What changes when Mail's store does: Mail commits to its index through a
// WAL it keeps open, which data_version reports, and writes files, such as
// an attachment it downloads, without touching the index, which only a watch
// of the whole store sees. A failed watch fails the next read of current.
export class MailVersion implements Disposable {
  readonly #resources: DisposableStack;
  readonly #index: AppDatabaseVersion;
  #events = 0;
  // A failed watch replaces this read with one that throws its error.
  #read = (): string => `${this.#index.current}:${this.#events}`;

  constructor(root: string, directory: string) {
    using resources = new DisposableStack();
    this.#index = resources.use(
      appDatabase.version(envelopeIndexPath(directory)),
    );
    const watcher = watch(root, { recursive: true }, () => {
      this.#events += 1;
    });
    resources.defer(() => watcher.close());
    watcher.on('error', (error) => {
      this.#read = () => {
        throw error;
      };
    });
    this.#resources = resources.move();
  }

  get current(): string {
    return this.#read();
  }

  [Symbol.dispose](): void {
    this.#resources.dispose();
  }
}
