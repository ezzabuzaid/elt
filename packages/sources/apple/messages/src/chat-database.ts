import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AppDatabase,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

export const messagesDirectory = join(homedir(), 'Library/Messages');

export class MessagesUnavailableError extends Error {
  override name = 'MessagesUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Messages history at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Messages.app does not need to be open.`,
      { cause },
    );
  }
}

// Messages commits through a WAL it keeps open; this probe changes with each
// commit Messages makes.
export class ChatDatabaseVersion extends AppDatabaseVersion {
  constructor(path: string) {
    super(path, MessagesUnavailableError);
  }
}

// A read-only view of Messages' chat.db pinned to one moment, and the read
// context of a Messages extraction. Its columns are not checked: a renamed
// column fails the stream that reads it with SQLite's own error.
export class ChatDatabase extends AppDatabase implements AsyncDisposable {
  constructor(path: string) {
    super(path, MessagesUnavailableError);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }
}
