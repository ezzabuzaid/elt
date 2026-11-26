import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { Client, FullDiskAccess } from '@zukhruf/tcc';

import {
  SlackDesktopStore,
  StoreUnavailableError,
  slackDesktopDirectory,
} from './index.ts';

// The remedy that a denied store gives: the Full Disk Access sentence of
// @zukhruf/tcc for the client that macOS charges this test process to.
const fullDiskAccess = new FullDiskAccess().remedy(
  Client.responsibleFor(process.pid),
);

const locations = {
  direct: 'Library/Application Support/Slack',
  appStore:
    'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack',
};
const indexedDB = 'IndexedDB/https_app.slack.com_0.indexeddb.leveldb';

// A real, empty LevelDB plus a download in Slack's main-process state. This
// tests discovery and reading without copying private data or mocking fs.
async function save(directory: string, fileId: string) {
  await mkdir(join(directory, indexedDB), { recursive: true });
  await writeFile(join(directory, indexedDB, 'CURRENT'), 'MANIFEST-000001\n');
  await writeFile(join(directory, indexedDB, 'MANIFEST-000001'), '');
  await mkdir(join(directory, 'storage'), { recursive: true });
  await writeFile(
    join(directory, 'storage/root-state.json'),
    JSON.stringify({ downloads: { T1: { [fileId]: { id: fileId } } } }),
  );
}

// The store a host reads: the folder it names, or the installation that
// slackDesktopDirectory finds in the home folder.
async function read(home: string, directory?: string) {
  const store = new SlackDesktopStore(directory ?? slackDesktopDirectory(home));
  return {
    clients: await store.clients(),
    downloads: await store.downloads(),
  };
}

void test.each(Object.entries(locations), ([build, location]) =>
  test(`the store in a home folder reads Slack's ${build} installation`, async () => {
    await using home = await new TemporaryFiles().directory('slack-location-');
    const directory = join(home.path, location);
    await save(directory, 'F1');

    const result = await read(home.path);

    assert.deepEqual(result.clients, []);
    assert.equal(result.downloads[0]?.fileId, 'F1');
  }),
);

test('an empty App Store folder does not hide the direct-download store', async () => {
  await using home = await new TemporaryFiles().directory('slack-location-');
  await mkdir(join(home.path, locations.appStore), { recursive: true });
  await save(join(home.path, locations.direct), 'F1');

  assert.equal((await read(home.path)).downloads[0]?.fileId, 'F1');
});

test('an explicit directory reads only that store', async () => {
  await using home = await new TemporaryFiles().directory('slack-location-');
  await save(join(home.path, locations.direct), 'F1');
  const directory = join(home.path, 'custom');
  await save(directory, 'F2');

  assert.equal((await read(home.path, directory)).downloads[0]?.fileId, 'F2');
});

test(
  'an inaccessible leftover folder does not hide a readable installation',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using home = await new TemporaryFiles().directory('slack-location-');
    const leftover = join(home.path, locations.appStore);
    await mkdir(leftover, { recursive: true });
    await save(join(home.path, locations.direct), 'F1');
    // A real filesystem denial stands in for macOS withholding an old
    // sandboxed container while the direct-download installation is readable.
    await chmod(leftover, 0o000);
    try {
      assert.equal((await read(home.path)).downloads[0]?.fileId, 'F1');
    } finally {
      await chmod(leftover, 0o700);
    }
  },
);

test('a missing store asks for saved Slack data without requiring the App Store', async () => {
  await using home = await new TemporaryFiles().directory('slack-location-');
  await assert.rejects(read(home.path), (error) => {
    assert.ok(error instanceof StoreUnavailableError);
    assert.match(error.message, /is not there\. Open Slack, sign in/);
    assert.doesNotMatch(error.message, /Install Slack from the Mac App Store/);
    return true;
  });
});

void test.each(Object.entries(locations), ([saved, location]) =>
  test(`when both stores exist, the most recently saved database wins: ${location}`, async () => {
    await using home = await new TemporaryFiles().directory('slack-location-');
    for (const [build, path] of Object.entries(locations)) {
      const directory = join(home.path, path);
      await save(directory, build);
      for (const file of ['CURRENT', 'MANIFEST-000001'])
        await utimes(join(directory, indexedDB, file), 1, 1);
    }
    // Updating an existing log need not change the directory's timestamp.
    const directory = join(home.path, location);
    await writeFile(join(directory, indexedDB, '000002.log'), '');
    await utimes(join(directory, indexedDB), 1, 1);

    assert.equal((await read(home.path)).downloads[0]?.fileId, saved);
  }),
);

// A reader reads the files after the app saves them, so each file's access
// time is later than the time it was saved.
const readLater = 100_000;

// Gives the store's files the times the app saved them, in seconds since the
// epoch; the database folder's own time stays at the first save.
async function savedAt(
  directory: string,
  times: { database: number; log: number; state: number },
) {
  const database = join(directory, indexedDB);
  const saved = (path: string, time: number) =>
    utimes(path, time + readLater, time);
  for (const file of ['CURRENT', 'MANIFEST-000001'])
    await saved(join(database, file), times.database);
  await saved(join(database, '000003.log'), times.log);
  await saved(database, times.database);
  await saved(join(directory, 'storage/root-state.json'), times.state);
}

test('the store was last written when a file of its database was, though the database folder kept its time', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');
  await save(dir.path, 'F1');
  await writeFile(join(dir.path, indexedDB, '000003.log'), 'saved');
  await savedAt(dir.path, {
    database: 1_800_000_000,
    log: 1_800_000_300,
    state: 1_800_000_000,
  });

  const written = new SlackDesktopStore(dir.path).lastWrite();

  assert.equal(written.getTime(), 1_800_000_300_000);
});

test('the store was last written when the app last saved its own state, if that came later', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');
  await save(dir.path, 'F1');
  await writeFile(join(dir.path, indexedDB, '000003.log'), 'first save');
  await savedAt(dir.path, {
    database: 1_800_000_000,
    log: 1_800_000_000,
    state: 1_800_000_600,
  });

  const written = new SlackDesktopStore(dir.path).lastWrite();

  assert.equal(written.getTime(), 1_800_000_600_000);
});

test('a store that is not there is unavailable, not a time, and says how to make it', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');
  const directory = join(dir.path, 'Slack');

  assert.throws(
    () => new SlackDesktopStore(directory).lastWrite(),
    (error) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.missing, true);
      assert.equal(
        error.message,
        `The Slack app's store at ${directory} is not there. Open Slack, sign in and let it save its workspaces.`,
      );
      return true;
    },
  );
});

test('a database folder that holds no file is a store that is not there', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');
  await mkdir(join(dir.path, indexedDB), { recursive: true });

  assert.throws(
    () => new SlackDesktopStore(dir.path).lastWrite(),
    (error) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.match(error.message, /is not there\. Open Slack, sign in/);
      return true;
    },
  );
});

test(
  'a store that the system keeps from this process cannot be read, and names Full Disk Access',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('slack-written-');
    await save(dir.path, 'F1');
    // chmod stands in for macOS withholding the app's container from a process
    // without Full Disk Access: both fail the read with EACCES or EPERM.
    await chmod(dir.path, 0o000);

    try {
      assert.throws(
        () => new SlackDesktopStore(dir.path).lastWrite(),
        (error) => {
          assert.ok(error instanceof StoreUnavailableError);
          assert.equal(error.missing, false);
          assert.equal(
            error.message,
            `The Slack app's store at ${dir.path} cannot be read. ${fullDiskAccess}`,
          );
          return true;
        },
      );
    } finally {
      await chmod(dir.path, 0o700);
    }
  },
);

test('a store that fails to list for another reason fails as that error', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');
  const database = join(dir.path, indexedDB);
  await mkdir(join(database, '..'), { recursive: true });
  // A link to itself: the folder is there and readable, but never resolves.
  await symlink(database, database);

  assert.throws(
    () => new SlackDesktopStore(dir.path).lastWrite(),
    (error) => {
      assert.ok(!(error instanceof StoreUnavailableError));
      assert.equal(Reflect.get(Object(error), 'code'), 'ELOOP');
      return true;
    },
  );
});

test(
  'a database folder that the system keeps from this process fails the read of the workspaces as one that cannot be read',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('slack-read-');
    await save(dir.path, 'F1');
    const database = join(dir.path, indexedDB);
    // chmod stands in for macOS withholding the app's container from a
    // process without Full Disk Access: both fail the read with EACCES or
    // EPERM.
    await chmod(database, 0o000);

    try {
      await assert.rejects(
        new SlackDesktopStore(dir.path).clients(),
        (error) => {
          assert.ok(error instanceof StoreUnavailableError);
          assert.equal(error.missing, false);
          assert.equal(
            error.message,
            `The Slack app's store at ${dir.path} cannot be read. ${fullDiskAccess}`,
          );
          return true;
        },
      );
    } finally {
      await chmod(database, 0o700);
    }
  },
);

test('a database folder that fails to read for another reason fails the read of the workspaces as that error', async () => {
  await using dir = await new TemporaryFiles().directory('slack-read-');
  const database = join(dir.path, indexedDB);
  await mkdir(join(database, '..'), { recursive: true });
  // A link to itself: the folder is there and readable, but never resolves.
  await symlink(database, database);

  await assert.rejects(new SlackDesktopStore(dir.path).clients(), (error) => {
    assert.ok(!(error instanceof StoreUnavailableError));
    assert.equal(Reflect.get(Object(error), 'code'), 'ELOOP');
    return true;
  });
});
