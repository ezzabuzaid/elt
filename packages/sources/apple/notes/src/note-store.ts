import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AppDatabase,
  type AppDatabaseColumns,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

export const notesContainer = join(
  homedir(),
  'Library/Group Containers/group.com.apple.notes',
);

export class NotesUnavailableError extends Error {
  override name = 'NotesUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The Notes store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Notes.app does not need to be open.`,
      { cause },
    );
  }
}

// The store's layout changes between macOS releases; reading one we have not
// verified would silently misplace fields.
export class NotesSchemaError extends Error {
  override name = 'NotesSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The Notes store at ${path} has a layout this connector does not read (missing ${missing.join(', ')}).`,
    );
  }
}

// Notes keeps NoteStore.sqlite and its WAL open while it runs; this probe
// changes with each commit Notes makes.
export class NoteStoreVersion extends AppDatabaseVersion {
  constructor(path: string) {
    super(path, NotesUnavailableError);
  }
}

// A read-only view of NoteStore.sqlite pinned to one moment, so notes, their
// attachments and folders agree.
export class NoteStore extends AppDatabase {
  constructor(path: string, columns: AppDatabaseColumns) {
    super(path, NotesUnavailableError);
    this.requireColumns(columns, NotesSchemaError);
  }
}
