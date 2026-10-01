import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

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
      throw new NotesUnavailableError(path, cause);
    throw cause;
  }
};

// Notes keeps NoteStore.sqlite and its WAL open while it runs, and FSEvents
// reports a write only when the file closes. SQLite's data_version changes on
// every commit by another connection, so polling it sees each one.
export class NoteStoreVersion implements Disposable {
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

// A read-only view of NoteStore.sqlite pinned to one moment, so notes, their
// attachments and folders agree. Hold it only while reading: an open read
// stops Notes checkpointing its WAL.
export class NoteStore implements AsyncDisposable {
  readonly #database: DatabaseSync;

  private constructor(
    readonly path: string,
    database: DatabaseSync,
  ) {
    this.#database = database;
  }

  static async open(
    path: string,
    required: Readonly<Record<string, readonly string[]>>,
  ): Promise<NoteStore> {
    const database = open(path);
    try {
      database.exec('BEGIN');
      const missing = Object.entries(required).flatMap(([table, columns]) => {
        const present = new Set(
          database
            .prepare('SELECT name FROM pragma_table_info(?)')
            .all(table)
            .map((column) => column.name),
        );
        return columns
          .filter((column) => !present.has(column))
          .map((column) => `${table}.${column}`);
      });
      if (missing.length > 0) throw new NotesSchemaError(path, missing);
      return new NoteStore(path, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  all(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all(...parameters);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}
