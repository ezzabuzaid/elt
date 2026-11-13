import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DataVersion,
  UnavailableError as VersionUnavailableError,
} from '@zukhruf/sqlite-data-version';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import {
  MissingColumnsError,
  UnavailableError as SnapshotUnavailableError,
} from '@zukhruf/sqlite-snapshot';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  AppDatabase,
  AppDatabaseVersion,
  Store,
  StoreUnavailableError,
} from './index.ts';

const store = new Store('The store', {
  missing: 'Open the app once.',
  denied: 'Grant access.',
});

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

test('a store that is not there says so and gives what makes its app create it, not the grant', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
  const path = join(dir.path, 'store.sqlite');

  assert.throws(() => database().snapshot(path), {
    message: `The store at ${path} is not there. Open the app once.`,
  });
  assert.throws(() => database().lastWrite(path), {
    message: `The store at ${path} is not there. Open the app once.`,
  });
});

test(
  'a store that the system keeps from this process says that it cannot be read and gives the grant',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('app-database-');
    const path = join(dir.path, 'store.sqlite');
    created(path);
    // chmod stands in for a privacy denial of macOS: SQLite reports CANTOPEN
    // (14) for both, and the file is there in both.
    await chmod(path, 0o000);

    try {
      assert.throws(() => database().snapshot(path), {
        message: `The store at ${path} cannot be read. Grant access.`,
      });
    } finally {
      await chmod(path, 0o644);
    }
  },
);

test(
  'a store in a folder that the system keeps from this process says that it cannot be read and gives the grant',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('app-database-');
    const folder = join(dir.path, 'container');
    await mkdir(folder);
    const path = join(folder, 'store.sqlite');
    created(path);
    // macOS refuses even a look into a folder behind a privacy grant, as a
    // launchd job without the grant found for the folder of Notification
    // Center. The store can be there, so the message keeps the grant.
    await chmod(folder, 0o000);

    try {
      assert.throws(() => database().snapshot(path), {
        message: `The store at ${path} cannot be read. Grant access.`,
      });
    } finally {
      await chmod(folder, 0o755);
    }
  },
);

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

test('the version of a store that is not there reads as unavailable, and as a version once the owner creates the store', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
  const path = join(dir.path, 'store.sqlite');
  using version = database().version(path);

  const before = version.current;
  created(path);
  const after = version.current;

  assert.equal(before, 'unavailable');
  assert.equal(typeof after, 'number');
});

test(
  'the version of a store the owner replaced with a file this process cannot open reads as unavailable, and as a version again once a readable store is back',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('app-database-');
    const path = join(dir.path, 'store.sqlite');
    created(path);
    using version = database().version(path);
    const opened = version.current;
    const denied = join(dir.path, 'denied.sqlite');
    created(denied);
    await chmod(denied, 0o000);
    const readable = join(dir.path, 'readable.sqlite');
    created(readable);

    renameSync(denied, path);
    const replaced = version.current;
    renameSync(readable, path);
    const back = version.current;

    assert.equal(typeof opened, 'number');
    assert.equal(replaced, 'unavailable');
    assert.equal(typeof back, 'number');
  },
);

test('a version whose first read of an opened store fails closes that store, and the next read opens it again', () => {
  // SQLite gives no way to fail data_version just after an open, so each open
  // reads a database that DataVersion takes in place of a file. The first
  // fails its second observation, the read of the version.
  let opened = 0;
  let closed = 0;
  const open = () => {
    opened += 1;
    let observations = 0;
    return new DataVersion('store.sqlite', {
      observe: () => {
        observations += 1;
        if (opened === 1 && observations === 2)
          throw new Error('disk I/O error');
        return 'observed';
      },
      [Symbol.dispose]: () => {
        closed += 1;
      },
    });
  };
  const version = new AppDatabaseVersion(open);

  assert.throws(() => version.current, { message: 'disk I/O error' });
  const closedAfterFailure = closed;
  const next = version.current;
  version[Symbol.dispose]();

  assert.equal(closedAfterFailure, 1);
  assert.equal(next, 0);
  assert.deepEqual({ opened, closed }, { opened: 2, closed: 2 });
});

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
