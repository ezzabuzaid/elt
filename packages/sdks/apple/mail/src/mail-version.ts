import { watch } from 'node:fs';

import { Gauge } from '@zukhruf/async';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { envelopeIndexPath } from './mail-location.ts';

// What changes when Mail's store does: Mail commits to its index through a
// WAL it keeps open, which data_version reports, and writes files, such as
// an attachment it downloads, without touching the index, which only a watch
// of the whole store sees. A change watcher reads it as a gauge; a failed
// watch fails the next read.
export class MailVersion extends Gauge<string> implements Disposable {
  readonly #resources: DisposableStack;
  readonly #index: AppDatabaseVersion;
  #events = 0;
  // A failed watch replaces this read with one that throws its error.
  #current = (): string => `${this.#index.current}:${this.#events}`;

  constructor(root: string, directory: string) {
    super();
    using resources = new DisposableStack();
    this.#index = resources.use(
      appDatabase.version(envelopeIndexPath(directory)),
    );
    const watcher = watch(root, { recursive: true }, () => {
      this.#events += 1;
    });
    resources.defer(() => watcher.close());
    watcher.on('error', (error) => {
      this.#current = () => {
        throw error;
      };
    });
    this.#resources = resources.move();
  }

  protected async read(): Promise<string> {
    return this.#current();
  }

  [Symbol.dispose](): void {
    this.#resources.dispose();
  }
}
