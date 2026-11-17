import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import {
  DataVersion,
  UnavailableError as VersionUnavailableError,
} from '@zukhruf/sqlite-data-version';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import {
  MissingColumnsError,
  UnavailableError as SnapshotUnavailableError,
} from '@zukhruf/sqlite-snapshot';

import {
  AppDatabase,
  AppDatabaseVersion,
  Store,
  StoreUnavailableError,
} from './index.ts';

// No test in this file installs a program, so a denial names the program
// generically, as it does for a plain script that uses an SDK.
const store = new Store('The store', {
  missing: 'Open the app once.',
  grant: 'full-disk-access',
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
        message: `The store at ${path} cannot be read. Turn on the program that runs this process in System Settings › Privacy & Security › Full Disk Access.`,
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
        message: `The store at ${path} cannot be read. Turn on the program that runs this process in System Settings › Privacy & Security › Full Disk Access.`,
      });
    } finally {
      await chmod(folder, 0o755);
    }
  },
);

test('a store that is there says that it is not there when the file that failed inside it is not there', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
  const file = join(dir.path, 'store.sqlite');
  // An SDK names the folder of its store while the file that failed is inside
  // it, as Mail names its root for its version file and its index.
  const failures = [
    () => open(file, { readOnly: true }).close(),
    () => readFileSync(file),
  ].map((read) => {
    try {
      read();
    } catch (error) {
      return error;
    }
    return undefined;
  });

  for (const cause of failures) {
    assert.ok(Error.isError(cause));
    assert.equal(
      new StoreUnavailableError(store, dir.path, cause).message,
      `The store at ${dir.path} is not there. Open the app once.`,
    );
  }
});

test('a store error says that the store is missing, so a caller need not read its cause', async () => {
  await using dir = await new TemporaryFiles().directory('app-database-');
  const path = join(dir.path, 'store.sqlite');
  // A path through a file, not a folder, is missing too (ENOTDIR).
  const file = join(dir.path, 'file');
  writeFileSync(file, '');
  let throughFile: unknown;
  try {
    readFileSync(join(file, 'store.sqlite'));
  } catch (error) {
    throughFile = error;
  }

  assert.throws(
    () => database().snapshot(path),
    (error: unknown) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.missing, true);
      return true;
    },
  );
  assert.equal(
    new StoreUnavailableError(store, dir.path, throughFile).missing,
    true,
  );
});

test(
  'a store error of a denial says that the store is not missing',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('app-database-');
    const path = join(dir.path, 'store.sqlite');
    created(path);
    await chmod(path, 0o000);

    try {
      assert.throws(
        () => database().snapshot(path),
        (error: unknown) => {
          assert.ok(error instanceof StoreUnavailableError);
          assert.equal(error.missing, false);
          return true;
        },
      );
    } finally {
      await chmod(path, 0o644);
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
