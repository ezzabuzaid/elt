import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileStamps } from '@zukhruf/fs';
import { MissingError, UnavailableError } from '@zukhruf/sqlite-data-version';

import {
  type IndexedDBDatabase,
  IndexedDBFormatError,
  readIndexedDB,
} from '@eltjs/codec-chromium-indexeddb';
import {
  AppFilesVersion,
  StoreUnavailableError,
} from '@eltjs/sdk-macos-app-database';

import { slackStore } from './app-database.ts';
import { SlackDesktopFormatError } from './errors.ts';
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

// Both Slack builds use the same store format under Electron's userData in
// the given home folder. An old installation can leave its folder behind: use
// the database whose files were modified most recently.
export function slackDesktopDirectory(home: string): string {
  const direct = join(home, 'Library/Application Support/Slack');
  const appStore = join(
    home,
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
      const modified = FileStamps.readSync(
        files.map((name) => join(path, name)),
      ).modifiedAt;
      if (modified !== undefined && modified.getTime() > newest) {
        selected = directory;
        newest = modified.getTime();
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

  constructor(directory: string) {
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

  // The change signal: it changes whenever the app saves its state, a
  // client's or its own.
  version(): AppFilesVersion {
    return new AppFilesVersion(() => this.#files());
  }

  // When the app last saved its state, a client's or its own. It saves every
  // few minutes while it is open and when it quits, so a closed app's store
  // stays as of then.
  lastWrite(): Date {
    const written = this.#saved().modifiedAt;
    // The app has saved neither its database nor its own state yet.
    if (written === undefined)
      throw new StoreUnavailableError(
        slackStore,
        this.#directory,
        new MissingError(join(this.#directory, indexedDB), undefined),
      );
    return written;
  }

  #saved(): FileStamps {
    try {
      return FileStamps.readSync(this.#files());
    } catch (error) {
      throw this.#unavailable(error);
    }
  }

  // A StoreUnavailableError for a store that is not there, or that macOS
  // keeps from a process without Full Disk Access; any other error as it is.
  #unavailable(error: unknown): unknown {
    const unavailable = UnavailableError.from(this.#directory, error);
    return unavailable === undefined
      ? error
      : new StoreUnavailableError(slackStore, this.#directory, unavailable);
  }

  // The files the app saves its state to. A file LevelDB removed after the
  // folder was listed, or a state the app has not saved yet, is missing.
  // CURRENT never is: LevelDB replaces it by a rename, never removes it.
  #files(): string[] {
    const directory = join(this.#directory, indexedDB);
    return [
      ...readdirSync(directory)
        .sort()
        .map((name) => join(directory, name)),
      join(this.#directory, rootState),
    ];
  }

  async #rootState(): Promise<string | null> {
    try {
      return await readFile(join(this.#directory, rootState), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw this.#unavailable(error);
    }
  }

  async #read(): Promise<IndexedDBDatabase[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readIndexedDB(join(this.#directory, indexedDB));
      } catch (error) {
        if (error instanceof IndexedDBFormatError)
          throw new SlackDesktopFormatError('IndexedDB', error.message, error);
        if (
          errorCode(error) === 'ENOENT' &&
          attempt < attempts &&
          this.#exists()
        )
          continue;
        throw this.#unavailable(error);
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
  return Error.isError(error) && 'code' in error ? error.code : undefined;
}
