import { type FSWatcher, watch } from 'node:fs';

import { Gauge } from '@zukhruf/async';

import type { AppDatabaseVersion } from '@eltjs/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { envelopeIndexPath, mailVersionDirectory } from './mail-location.ts';

// What changes when Mail's store does: Mail commits to its index through a
// WAL it keeps open, which data_version reports, and writes files, such as
// an attachment it downloads, without touching the index, which only a watch
// of the whole store sees. A change watcher reads it as a gauge. It opens the
// store in its first read, so a PersistenceInfo.plist that cannot be read
// fails a read, not the gauge's creation (elt ADR 0020). A failed watch fails
// the next read, and the read after it watches the store again.
export class MailVersion extends Gauge<string> implements Disposable {
  readonly #root: string;
  #state: VersionState | Failed;

  constructor(root: string) {
    super();
    this.#root = root;
    this.#state = this.#closed();
  }

  protected async read(): Promise<string> {
    const reading = this.#state;
    // The errno of a failed watch is a system failure, which the next check
    // reads again (elt ADR 0020).
    if (reading instanceof Failed) {
      this.#state = this.#closed();
      throw reading.error;
    }
    const { value, state } = await reading.read();
    // A change watcher abandons a read at a stop or a timeout, and the read
    // goes on. When another state took over meanwhile, the watch that this
    // read opened closes.
    if (this.#state === reading) this.#state = state;
    else if (state !== reading) state[Symbol.dispose]();
    return value;
  }

  [Symbol.dispose](): void {
    this.#state[Symbol.dispose]();
    this.#state = new Disposed();
  }

  #closed(): Closed {
    return new Closed(this.#root, (error) => {
      this.#state[Symbol.dispose]();
      this.#state = new Failed(error);
    });
  }
}

type VersionRead = { readonly value: string; readonly state: VersionState };

interface VersionState extends Disposable {
  read(): Promise<VersionRead>;
}

// Nothing is open: the read finds the current version folder, then watches
// the store.
class Closed implements VersionState {
  readonly #root: string;
  readonly #failed: (error: unknown) => void;

  constructor(root: string, failed: (error: unknown) => void) {
    this.#root = root;
    this.#failed = failed;
  }

  async read(): Promise<VersionRead> {
    const directory = await mailVersionDirectory(this.#root);
    // An index that fails its first read closes the watch, and the next read
    // tries again.
    using opened = new DisposableStack();
    const watching = opened.use(
      new Watching(
        this.#root,
        appDatabase.version(envelopeIndexPath(directory)),
        this.#failed,
      ),
    );
    const value = watching.value;
    opened.move();
    return { value, state: watching };
  }

  // Nothing is open.
  [Symbol.dispose](): void {}
}

class Watching implements VersionState {
  readonly #index: AppDatabaseVersion;
  readonly #watcher: FSWatcher;
  #events = 0;

  constructor(
    root: string,
    index: AppDatabaseVersion,
    failed: (error: unknown) => void,
  ) {
    this.#index = index;
    this.#watcher = watch(root, { recursive: true }, () => {
      this.#events += 1;
    });
    this.#watcher.on('error', failed);
  }

  get value(): string {
    return `${this.#index.current}:${this.#events}`;
  }

  async read(): Promise<VersionRead> {
    return { value: this.value, state: this };
  }

  [Symbol.dispose](): void {
    this.#watcher.close();
    this.#index[Symbol.dispose]();
  }
}

// The watch of the store failed: the next read fails with its error.
class Failed implements Disposable {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }

  // The watch closed when it failed.
  [Symbol.dispose](): void {}
}

// The owner of the gauge disposed it: nothing reads it again.
class Disposed implements VersionState {
  async read(): Promise<VersionRead> {
    throw new Error('Mail’s version was disposed');
  }

  [Symbol.dispose](): void {}
}
