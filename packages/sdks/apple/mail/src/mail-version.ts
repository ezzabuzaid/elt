import { watch } from 'node:fs';

import { DataVersion } from '@zukhruf/sqlite-data-version';

import { MailUnavailableError } from './errors.ts';
import { envelopeIndexPath } from './mail-location.ts';

// What changes when Mail's store does: Mail commits to its index through a
// WAL it keeps open, which data_version reports, and writes files, such as
// an attachment it downloads, without touching the index, which only a watch
// of the whole store sees. A failed watch fails the next read of current.
export class MailVersion implements Disposable {
  readonly #resources: DisposableStack;
  readonly #index: DataVersion;
  #events = 0;
  #failure: Error | null = null;

  constructor(root: string, directory: string) {
    using resources = new DisposableStack();
    this.#index = resources.use(
      new DataVersion(envelopeIndexPath(directory), MailUnavailableError),
    );
    const watcher = watch(root, { recursive: true }, () => {
      this.#events += 1;
    });
    resources.defer(() => watcher.close());
    watcher.on('error', (error) => {
      this.#failure = error;
    });
    this.#resources = resources.move();
  }

  get current(): string {
    if (this.#failure !== null) throw this.#failure;
    return `${this.#index.current}:${this.#events}`;
  }

  [Symbol.dispose](): void {
    this.#resources.dispose();
  }
}
