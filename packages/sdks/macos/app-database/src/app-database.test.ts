import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { UnavailableError as VersionUnavailableError } from '@zukhruf/sqlite-data-version';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import {
  MissingColumnsError,
  UnavailableError as SnapshotUnavailableError,
} from '@zukhruf/sqlite-snapshot';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AppDatabase, Store, StoreUnavailableError } from './index.ts';

const store = new Store('The store', 'Grant access.');

function database(): AppDatabase {
  return new AppDatabase(store);
}

function created(path: string): void {
  using db = open(path, { journal: new RollbackJournal() });
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT)');
}

test('a snapshot of a store that is not there is the SDK unavailable error, caused by the package one', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
  const path = join(dir.path, 'store.sqlite');

  assert.throws(
    () => database().snapshot(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.store, store);
      assert.equal(error.path, path);
      assert.ok(error.cause instanceof SnapshotUnavailableError);
      return true;
    },
  );
});

test('a store that lacks a column the reader reads is the package missing-columns error, naming the column', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
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
  await using dir = await new TemporaryFiles().directory('app-database-');
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
    await using dir = await new TemporaryFiles().directory('app-database-');
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
  await using dir = await new TemporaryFiles().directory('app-database-');
  const path = join(dir.path, 'store.sqlite');

  assert.throws(
    () => database().lastWrite(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.store, store);
      assert.equal(error.path, path);
      assert.ok(error.cause instanceof VersionUnavailableError);
      return true;
    },
  );
});
