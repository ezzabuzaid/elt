import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type IndexedDBDatabase,
  IndexedDBFormatError,
  readIndexedDB,
} from '@workspace/codec-chromium-indexeddb';

import {
  SlackDesktopFormatError,
  SlackDesktopUnavailableError,
} from './errors.ts';
import { readSlackClient } from './slack-client-record.ts';
import type { SlackClient } from './slack-client.ts';

// Where the Mac App Store build of Slack keeps its data.
export const slackDesktopDirectory = join(
  homedir(),
  'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack',
);

// The app's web client keeps its state in the IndexedDB of app.slack.com:
// one record per signed-in workspace and user in reduxPersistenceStore.
const indexedDB = 'IndexedDB/https_app.slack.com_0.indexeddb.leveldb';
const reduxDatabase = 'reduxPersistence';
const reduxStore = 'reduxPersistenceStore';
const clientRecord = /^persist:slack-client-[A-Z0-9]+-[A-Z0-9]+$/;
// The app rewrites a record every few minutes into a new blob file and
// deletes the old one; a read that loses that race reads again.
const attempts = 3;
// What the file system answers for a store that is missing, or that macOS
// keeps from a process without Full Disk Access.
const unreadable = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

export class SlackDesktopStore {
  readonly #directory: string;

  constructor(directory = slackDesktopDirectory) {
    this.#directory = directory;
  }

  // Every signed-in workspace's client as the app last saved it. A workspace
  // appears once its client has saved, which it does every few minutes while
  // it is open and when the app quits.
  async clients(): Promise<SlackClient[]> {
    const databases = await this.#read();
    return databases
      .filter(({ name }) => name === reduxDatabase)
      .flatMap(({ objectStores }) => objectStores)
      .filter(({ name }) => name === reduxStore)
      .flatMap(({ records }) => records)
      .flatMap(({ key, value }) =>
        typeof key === 'string' && clientRecord.test(key)
          ? [readSlackClient(value, key)]
          : [],
      );
  }

  // A value that changes whenever the app saves its state.
  version(): string {
    const directory = join(this.#directory, indexedDB);
    try {
      return readdirSync(directory)
        .sort()
        .map((name) => {
          const { size, mtimeMs } = statSync(join(directory, name));
          return `${name}:${size}:${mtimeMs}`;
        })
        .join('\n');
    } catch (error) {
      throw new SlackDesktopUnavailableError(this.#directory, error);
    }
  }

  async #read(): Promise<IndexedDBDatabase[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readIndexedDB(join(this.#directory, indexedDB));
      } catch (error) {
        if (error instanceof IndexedDBFormatError)
          throw new SlackDesktopFormatError('IndexedDB', error.message, error);
        const code = errorCode(error);
        if (code === 'ENOENT' && attempt < attempts && this.#exists()) continue;
        if (typeof code === 'string' && unreadable.has(code))
          throw new SlackDesktopUnavailableError(this.#directory, error);
        throw error;
      }
    }
  }

  #exists(): boolean {
    try {
      return statSync(join(this.#directory, indexedDB)).isDirectory();
    } catch {
      return false;
    }
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
