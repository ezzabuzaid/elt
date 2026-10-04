import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

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

// SQLite's CANTOPEN and AUTH: a missing file or a Full Disk Access denial.
const unavailableCodes = new Set([14, 23]);

const open = (path: string) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new MessagesUnavailableError(path, cause);
    throw cause;
  }
};

// Messages commits through a WAL it keeps open, and FSEvents reports a write
// only when the file closes. SQLite's data_version changes on every commit by
// another connection, so polling it sees each one within the interval.
export class ChatDatabaseVersion implements Disposable {
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(path: string) {
    this.#database = open(path);
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  get current(): number {
    return Number(this.#version.get()?.data_version);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// A read-only view of Messages' chat.db pinned to one moment: chat.db runs in
// WAL mode, so a read transaction sees one snapshot however Messages writes.
// Hold it only while reading; an open read stops Messages checkpointing its WAL.
export class ChatDatabase implements AsyncDisposable {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static async open(
    path = join(messagesDirectory, 'chat.db'),
  ): Promise<ChatDatabase> {
    const database = open(path);
    try {
      database.exec('BEGIN');
      database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      return new ChatDatabase(database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  all(sql: string): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}
