import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ConnectionFailure,
  ImportStore,
  lease,
  leaseHeld,
  type Selection,
} from 'import-store';
import type { AppleApp } from './apps/apple-app.ts';

export type { Selection };

export class StoreBusyError extends Error {
  override name = 'StoreBusyError';
  constructor() {
    super('Another sync is using this store. Wait for it, or stop it first.');
  }
}

// The CLI's own imports under outputs/cli, beside the exporter's, kept by
// import-store: settings.sqlite holds the selection, and each selection's
// folder its data.sqlite, checkpoints and attachment files. One sync or
// selection change writes at a time; another is refused, not queued.
// Everything here can be rebuilt by syncing again.
export class Store {
  readonly root = resolve('outputs/cli');

  #open(): ImportStore {
    return new ImportStore(this.root);
  }

  selections(): Selection[] {
    using store = this.#open();
    return store.selections();
  }

  selection(app: string): Selection | undefined {
    return this.selections().find((selection) => selection.app === app);
  }

  // Replaces the selection. An app that left it, or whose scope changed, loses
  // its import, so the next sync reads it again from the start.
  select(selections: readonly Selection[], app: (name: string) => AppleApp) {
    using _ = this.lock();
    using store = this.#open();
    store.select(selections, {
      facts: app,
      permissions: ({ app: name }) => app(name).guidance(),
    });
  }

  // Held while a sync or a selection change writes here; the operating system
  // releases it when this process exits.
  lock(): Disposable {
    const held = lease(this.root);
    if (held === null) throw new StoreBusyError();
    return held;
  }

  busy(): boolean {
    return leaseHeld(this.root);
  }

  directory(selection: Selection): string {
    using store = this.#open();
    return store.directory(selection);
  }

  database(selection: Selection): string {
    using store = this.#open();
    return store.database(selection);
  }

  // Opens an import for reading only, first rolling back what a sync stopped
  // mid-commit left.
  read(selection: Selection): DatabaseSync {
    using store = this.#open();
    return store.read(selection);
  }

  connectionFailure(selection: Selection): ConnectionFailure | undefined {
    using store = this.#open();
    return store.connectionFailure(selection);
  }

  saveConnectionFailure(selection: Selection, error: string) {
    using store = this.#open();
    store.saveConnectionFailure(selection, error);
  }

  clearConnectionFailure(selection: Selection) {
    using store = this.#open();
    store.clearConnectionFailure(selection);
  }
}
