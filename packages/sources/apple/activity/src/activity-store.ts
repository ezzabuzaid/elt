import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

// Where macOS keeps activity: Biome's streams and its device list, and the
// older knowledgeC store that still records what Biome does not.
export type ActivityLocation = {
  readonly biome: string;
  readonly knowledge: string;
};

export const defaultActivityLocation: ActivityLocation = Object.freeze({
  biome: join(homedir(), 'Library/Biome'),
  knowledge: join(
    homedir(),
    'Library/Application Support/Knowledge/knowledgeC.db',
  ),
});

export const biomeStreams = ({ biome }: ActivityLocation) =>
  join(biome, 'streams/restricted');

export const biomeDevices = ({ biome }: ActivityLocation) =>
  join(biome, 'sync/sync.db');

export class ActivityUnavailableError extends Error {
  override name = 'ActivityUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `Activity data at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`,
      { cause },
    );
  }
}

// macOS changes these private stores between releases; reading one we have
// not verified would silently misplace fields.
class ActivitySchemaError extends Error {
  override name = 'ActivitySchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The activity store at ${path} has a layout this connector does not read (missing ${missing.join(', ')}).`,
    );
  }
}

// SQLite's CANTOPEN and AUTH: a missing file or a Full Disk Access denial.
const unavailableCodes = new Set([14, 23]);

// Read-only, never immutable: knowledgeC and Biome's device list keep a WAL
// whose newest rows an immutable open would miss.
const open = (path: string) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new ActivityUnavailableError(path, cause);
    throw cause;
  }
};

// SQLite's data_version changes on every commit by another connection, so
// polling it sees each one, including commits still in the WAL.
export class ActivityDatabaseVersion implements Disposable {
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

// A read-only view of one database pinned to one moment, so its tables agree.
// Hold it only while reading: an open read stops the writer checkpointing its
// WAL.
export class ActivityDatabase implements AsyncDisposable {
  readonly path: string;
  readonly #database: DatabaseSync;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  static async open(
    path: string,
    required: Readonly<Record<string, readonly string[]>>,
  ): Promise<ActivityDatabase> {
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
      if (missing.length > 0) throw new ActivitySchemaError(path, missing);
      return new ActivityDatabase(path, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  all(
    sql: string,
    ...parameters: (string | number)[]
  ): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all(...parameters);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}
