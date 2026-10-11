import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
import { type SlackDownload, readSlackDownloads } from './slack-downloads.ts';

// The app's web client keeps its state in the IndexedDB of app.slack.com:
// one record per signed-in workspace and user in reduxPersistenceStore.
const indexedDB = 'IndexedDB/https_app.slack.com_0.indexeddb.leveldb';
const reduxDatabase = 'reduxPersistence';
const reduxStore = 'reduxPersistenceStore';
const clientRecord = /^persist:slack-client-[A-Z0-9]+-[A-Z0-9]+$/;
// The app's main process keeps its own state, its downloads among it, apart
// from the web client's, as JSON it rewrites whole.
const rootState = 'storage/root-state.json';
// The app rewrites a record every few minutes into a new blob file and
// deletes the old one; a read that loses that race reads again.
const attempts = 3;
// What the file system answers for a store that is missing, or that macOS
// keeps from a process without Full Disk Access.
const unreadable = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

// Both Slack builds use the same store format under Electron's userData.
// An old installation can leave its folder behind: use the database whose
// files were modified most recently, and hold that choice for this store.
export function slackDesktopDirectory(): string {
  const direct = join(homedir(), 'Library/Application Support/Slack');
  const appStore = join(
    homedir(),
    'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack',
  );
  let selected: string | undefined;
  let unavailable: string | undefined;
  let newest = -Infinity;
  for (const directory of [direct, appStore]) {
    try {
      const path = join(directory, indexedDB);
      const files = readdirSync(path);
      if (!files.includes('CURRENT')) continue;
      const modified = Math.max(
        ...files.map(
          (name) =>
            statSync(join(path, name), { throwIfNoEntry: false })?.mtimeMs ?? 0,
        ),
      );
      if (modified > newest) {
        selected = directory;
        newest = modified;
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      // If neither store is readable, keep the failing path so its read
      // reports the actual access error instead of a missing default folder.
      unavailable ??= directory;
    }
  }
  return selected ?? unavailable ?? direct;
}

export class SlackDesktopStore {
  readonly #directory: string;

  constructor(directory = slackDesktopDirectory()) {
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

  // The files the app downloaded, in every workspace: none until it has
  // saved its own state.
  async downloads(): Promise<SlackDownload[]> {
    const text = await this.#rootState();
    if (text === null) return [];
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch (error) {
      throw new SlackDesktopFormatError(rootState, 'it is not JSON', error);
    }
    return readSlackDownloads(state, rootState);
  }

  // A value that changes whenever the app saves its state, a client's or its
  // own.
  version(): string {
    const directory = join(this.#directory, indexedDB);
    try {
      return [
        ...readdirSync(directory)
          .sort()
          .map((name) => join(directory, name)),
        join(this.#directory, rootState),
      ]
        .map((path) => {
          const stats = statSync(path, { throwIfNoEntry: false });
          return `${path}:${stats?.size}:${stats?.mtimeMs}`;
        })
        .join('\n');
    } catch (error) {
      throw new SlackDesktopUnavailableError(this.#directory, error);
    }
  }

  async #rootState(): Promise<string | null> {
    try {
      return await readFile(join(this.#directory, rootState), 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return null;
      if (typeof code === 'string' && unreadable.has(code))
        throw new SlackDesktopUnavailableError(this.#directory, error);
      throw error;
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
