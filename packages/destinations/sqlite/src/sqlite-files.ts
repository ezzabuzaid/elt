import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

import { DatabaseFiles, type FailureType } from '@eltjs/elt';

import { openDestination } from './open-destination.ts';
import { failureType } from './sqlite-failure-type.ts';

const table = '"_elt_files"';

// A rowid table, as SQLite advises for rows as large as a chunk.
const files = new Declaration(
  [
    `CREATE TABLE ${table} ("scope" TEXT NOT NULL, "name" TEXT NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("scope", "name", "n")) STRICT`,
  ],
  { rows: 'replace' },
);

// The files of a copy in the SQLite file of its destination, in the reserved
// table _elt_files.
export class SQLiteFiles extends DatabaseFiles<DatabaseSync> {
  override readonly identity = JSON.stringify({ type: 'sqlite-files' });
  readonly #path: string;

  constructor(path: string) {
    super('_elt_files');
    this.#path = path;
    Object.freeze(this);
  }

  protected override async connect(): Promise<DatabaseSync> {
    const database = openDestination(this.#path);
    try {
      files.apply(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  protected override async write(
    database: DatabaseSync,
    scope: string,
    name: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<void> {
    database
      .prepare(
        `INSERT INTO ${table} ("scope", "name", "n", "bytes") VALUES (?, ?, ?, ?)`,
      )
      .run(scope, name, n, bytes);
  }

  protected override async rename(
    database: DatabaseSync,
    scope: string,
    from: string,
    to: string,
  ): Promise<void> {
    database
      .prepare(
        `UPDATE ${table} SET "name" = ?3 WHERE "scope" = ?1 AND "name" = ?2 AND NOT EXISTS (SELECT 1 FROM ${table} WHERE "scope" = ?1 AND "name" = ?3)`,
      )
      .run(scope, from, to);
  }

  protected override async remove(
    database: DatabaseSync,
    scope: string,
    names: readonly string[],
  ): Promise<void> {
    database
      .prepare(
        `DELETE FROM ${table} WHERE "scope" = ? AND "name" IN (SELECT "value" FROM json_each(?))`,
      )
      .run(scope, JSON.stringify(names));
  }

  protected override async names(
    database: DatabaseSync,
    scope: string,
  ): Promise<readonly string[]> {
    return database
      .prepare(`SELECT "name" FROM ${table} WHERE "scope" = ? AND "n" = 0`)
      .all(scope)
      .map(({ name }) => String(name));
  }

  protected override async read(
    database: DatabaseSync,
    scope: string,
    name: string,
    n: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    // substr gives NULL for an empty BLOB, the one chunk of an empty file.
    const row = database
      .prepare(
        `SELECT coalesce(substr("bytes", 1, ?), x'') AS "bytes" FROM ${table} WHERE "scope" = ? AND "name" = ? AND "n" = ?`,
      )
      .get(length, scope, name, n);
    if (row === undefined) return undefined;
    if (!(row.bytes instanceof Uint8Array))
      throw new TypeError(`Chunk ${n} of stored file ${name} is not a BLOB`);
    return row.bytes;
  }

  override failureType(error: unknown): FailureType {
    return failureType(error);
  }
}
