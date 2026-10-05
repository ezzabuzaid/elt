import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { AppDatabase, AppDatabaseVersion } from './index.ts';

// What a store's SDK passes in: its own errors, which name its grant.
class StoreUnavailableError extends Error {
  override name = 'StoreUnavailableError';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`The store at ${path} cannot be read.`, { cause });
    this.path = path;
  }
}

class StoreSchemaError extends Error {
  override name = 'StoreSchemaError';
  readonly missing: readonly string[];

  constructor(path: string, missing: readonly string[]) {
    super(`The store at ${path} lacks ${missing.join(', ')}.`);
    this.missing = missing;
  }
}

test('a read stays on one moment while the app commits, and the version reports each commit', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');
  using app = new DatabaseSync(path);
  app.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  using version = new AppDatabaseVersion(path, StoreUnavailableError);
  const before = version.current;

  {
    using database = new AppDatabase(path, StoreUnavailableError);
    app.exec("INSERT INTO notes (title) VALUES ('second')");

    assert.deepEqual(
      database.all('SELECT title FROM notes ORDER BY id').map((row) => ({
        ...row,
      })),
      [{ title: 'first' }],
    );
    assert.notEqual(version.current, before);
  }
  using next = new AppDatabase(path, StoreUnavailableError);
  assert.equal(next.all('SELECT count(*) AS n FROM notes')[0]?.n, 2);
});

test('a layout without the required columns fails with the store’s schema error, naming each one, and closes', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');
  using app = new DatabaseSync(path);
  app.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  using database = new AppDatabase(path, StoreUnavailableError);

  assert.throws(
    () =>
      database.requireColumns(
        { notes: ['id', 'title'], folders: ['id'] },
        StoreSchemaError,
      ),
    (error: unknown) => {
      assert.ok(error instanceof StoreSchemaError);
      assert.deepEqual(error.missing, ['notes.title', 'folders.id']);
      return true;
    },
  );
  assert.throws(() => database.all('SELECT 1'), /not open/);
});

test('only a missing or denied file is the store’s unavailable error', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const missing = join(dir.path, 'missing', 'store.sqlite');
  const notDatabase = join(dir.path, 'notes.txt');
  await writeFile(notDatabase, 'not a database, but long enough to be read');

  for (const open of [
    () => new AppDatabase(missing, StoreUnavailableError),
    () => new AppDatabaseVersion(missing, StoreUnavailableError),
  ])
    assert.throws(open, (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.path, missing);
      return true;
    });
  assert.throws(
    () => new AppDatabase(notDatabase, StoreUnavailableError),
    (error: unknown) => {
      assert.ok(!(error instanceof StoreUnavailableError));
      assert.match(String(error), /not a database/);
      return true;
    },
  );
});
