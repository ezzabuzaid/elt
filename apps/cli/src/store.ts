import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { ImportScope } from 'apple/sources/import-scope';

// One app's import: what it covers, and whether it keeps attachment files.
export type Selection = {
  readonly app: string;
  readonly scope: ImportScope;
  readonly attachments: boolean;
};

export class StoreBusyError extends Error {
  override name = 'StoreBusyError';
  constructor(options: ErrorOptions) {
    super(
      'Another sync is using this store. Wait for it, or stop it first.',
      options,
    );
  }
}

// The CLI's own imports, beside the exporter's under outputs/: config.json
// holds the selection, and each app's folder its data.sqlite, checkpoints and
// attachment files. Everything here can be rebuilt by syncing again.
export class Store {
  readonly root = resolve('outputs/cli');

  directory(app: string): string {
    return join(this.root, app);
  }

  database(app: string): string {
    return join(this.directory(app), 'data.sqlite');
  }

  // Opens an app's data.sqlite for reading only, waiting while a sync
  // commits. A sync stopped mid-write leaves a hot journal that only a
  // writable connection rolls back, so one reads first and recovers it.
  read(app: string): DatabaseSync {
    const path = this.database(app);
    {
      using recovery = new DatabaseSync(path, { timeout: 30_000 });
      recovery.prepare('SELECT count(*) FROM sqlite_schema').get();
    }
    return new DatabaseSync(path, { readOnly: true, timeout: 30_000 });
  }

  get #config(): string {
    return join(this.root, 'config.json');
  }

  selections(): Selection[] {
    return existsSync(this.#config)
      ? (
          JSON.parse(readFileSync(this.#config, 'utf8')) as {
            apps: Selection[];
          }
        ).apps
      : [];
  }

  // Replaces the selection. An app that left it, or whose scope changed, loses
  // its import, so the next sync reads it again from the start.
  select(selections: readonly Selection[]): void {
    using _ = this.lock();
    for (const previous of this.selections()) {
      const kept = selections.find(({ app }) => app === previous.app);
      if (!isDeepStrictEqual(kept, previous))
        rmSync(this.directory(previous.app), { recursive: true, force: true });
    }
    writeFileSync(
      `${this.#config}.tmp`,
      `${JSON.stringify({ apps: selections }, null, 2)}\n`,
    );
    renameSync(`${this.#config}.tmp`, this.#config);
  }

  // Held while a sync or a selection change writes here. SQLite keeps the lock
  // and the operating system releases it when this process exits.
  lock(): Disposable {
    mkdirSync(this.root, { recursive: true });
    const lock = new DatabaseSync(join(this.root, 'sync.lock'));
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      lock.close();
      throw new StoreBusyError({ cause: error });
    }
    return { [Symbol.dispose]: () => lock.close() };
  }

  busy(): boolean {
    try {
      using _ = this.lock();
      return false;
    } catch (error) {
      if (error instanceof StoreBusyError) return true;
      throw error;
    }
  }
}
