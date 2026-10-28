import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { chmod, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { UnavailableError as VersionUnavailableError } from '@zukhruf/sqlite-data-version';
import {
  MissingColumnsError,
  UnavailableError as SnapshotUnavailableError,
} from '@zukhruf/sqlite-snapshot';

import { AppDatabase } from './index.ts';

class StoreUnavailableError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`The store at ${path} cannot be read.`, { cause });
    this.path = path;
  }
}

function database(): AppDatabase {
  return new AppDatabase({ unavailable: StoreUnavailableError });
}

function created(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT)');
  db.close();
}

test('a snapshot of a store that is not there is the SDK unavailable error, caused by the package one', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');

  assert.throws(
    () => database().snapshot(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.path, path);
      assert.ok(error.cause instanceof SnapshotUnavailableError);
      return true;
    },
  );
});

test('a store that lacks a column the reader reads is the package missing-columns error, naming the column', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');
  created(path);

  assert.throws(
    () => database().snapshot(path, { item: ['id', 'author'] }),
    (error: unknown) => {
      assert.ok(error instanceof MissingColumnsError);
      assert.equal(error.path, path);
      assert.deepEqual(error.missing, ['item.author']);
      return true;
    },
  );
});

test('the version of a store that is not there is the SDK unavailable error', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');

  assert.throws(
    () => database().version(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.ok(error.cause instanceof VersionUnavailableError);
      return true;
    },
  );
});

test(
  'the version of a store the owner replaced with a file this process cannot open is the SDK unavailable error',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
    const path = join(dir.path, 'store.sqlite');
    created(path);
    using version = database().version(path);
    const replacement = join(dir.path, 'replacement.sqlite');
    created(replacement);
    await chmod(replacement, 0o000);

    renameSync(replacement, path);

    assert.throws(
      () => version.current,
      (error: unknown) => {
        assert.ok(error instanceof StoreUnavailableError);
        assert.equal(error.path, path);
        assert.ok(error.cause instanceof VersionUnavailableError);
        return true;
      },
    );
  },
);

test('the last write of a store that is not there is the SDK unavailable error', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'app-database-'));
  const path = join(dir.path, 'store.sqlite');

  assert.throws(
    () => database().lastWrite(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.path, path);
      assert.ok(error.cause instanceof VersionUnavailableError);
      return true;
    },
  );
});
