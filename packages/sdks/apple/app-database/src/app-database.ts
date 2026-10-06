import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';

// The error a store's SDK throws when its file is missing or macOS denies
// access, naming the grant that store needs.
export type UnavailableError = new (path: string, cause: unknown) => Error;

// The error a store's SDK throws when the file lacks columns it reads: the
// app changed its layout, and reading on would misplace fields.
export type SchemaError = new (
  path: string,
  missing: readonly string[],
) => Error;

// The columns a reader depends on, by table.
export type AppDatabaseColumns = Readonly<Record<string, readonly string[]>>;

// SQLite's CANTOPEN and AUTH: a missing file, or a privacy denial such as no
// Full Disk Access. Any other failure is not the user's to grant.
const unavailableCodes = new Set([14, 23]);

function open(path: string, unavailable: UnavailableError): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new unavailable(path, cause);
    throw cause;
  }
}

// A SQLite database another macOS app owns and writes while it runs, read
// read-only and pinned to one moment by a read transaction, so its tables
// agree. Never opened immutable: these apps keep a persistent WAL, where the
// newest rows live. Hold it only while reading: an open read stops the app
// checkpointing its WAL.
export class AppDatabase implements Disposable {
  readonly path: string;
  readonly #database: DatabaseSync;

  constructor(path: string, unavailable: UnavailableError) {
    this.path = path;
    this.#database = open(path, unavailable);
    try {
      // The first read pins the snapshot, so it is taken now rather than at
      // the caller's first query; a file that is no database fails here.
      this.#database.exec('BEGIN');
      this.#database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    } catch (cause) {
      this.#database.close();
      throw cause;
    }
  }

  // Refuses a layout without these columns, and closes the database: the
  // check a reader makes while it opens the snapshot.
  requireColumns(columns: AppDatabaseColumns, schema: SchemaError): void {
    const missing = this.missingColumns(columns);
    if (missing.length === 0) return;
    this[Symbol.dispose]();
    throw new schema(this.path, missing);
  }

  // The columns, as table.column, that this layout lacks. A reader whose
  // reads use different tables checks each read with it and keeps the
  // snapshot open for the others.
  missingColumns(columns: AppDatabaseColumns): string[] {
    return Object.entries(columns).flatMap(([table, names]) => {
      const present = new Set(
        this.all('SELECT name FROM pragma_table_info(?)', table).map(
          (column) => column.name,
        ),
      );
      return names
        .filter((name) => !present.has(name))
        .map((name) => `${table}.${name}`);
    });
  }

  all(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Record<string, SQLOutputValue>[] {
    return this.#database.prepare(sql).all(...parameters);
  }

  [Symbol.dispose](): void {
    if (!this.#database.isOpen) return;
    if (this.#database.isTransaction) this.#database.exec('COMMIT');
    this.#database.close();
  }
}

// These apps commit through a WAL they keep open, and FSEvents reports a
// write only when the file closes. SQLite's data_version changes on every
// commit by another connection, so polling current sees each one.
export class AppDatabaseVersion implements Disposable {
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(path: string, unavailable: UnavailableError) {
    this.#database = open(path, unavailable);
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  get current(): number {
    return Number(this.#version.get()?.data_version);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
