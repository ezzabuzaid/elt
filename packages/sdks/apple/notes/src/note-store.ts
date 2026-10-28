import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppDatabaseVersion } from '@workspace/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { NoteStoreSnapshot } from './note-store-snapshot.ts';

// Where Notes keeps this user's store.
export const noteStorePath = join(
  homedir(),
  'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite',
);

// Notes' own Core Data store, read without Notes.app, which need not run.
export class NotesStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // The store as of one moment, so notes, their attachments and folders
  // agree.
  open(): NoteStoreSnapshot {
    return new NoteStoreSnapshot(this.#path);
  }

  // Notes keeps NoteStore.sqlite and its WAL open while it runs; this probe
  // changes with each commit Notes makes.
  version(): AppDatabaseVersion {
    return appDatabase.version(this.#path);
  }

  // When Notes last wrote the store. Only Notes.app syncs iCloud notes, so
  // while it is closed the store stays as of then.
  lastWrite(): Date {
    return appDatabase.lastWrite(this.#path);
  }
}
