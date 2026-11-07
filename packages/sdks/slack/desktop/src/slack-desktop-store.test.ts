import assert from 'node:assert/strict';
import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  SlackDesktopStore,
  SlackDesktopUnavailableError,
  slackDesktopDirectory,
} from './index.ts';

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

for (const [build, location] of Object.entries(locations)) {
  test(`the store in a home folder reads Slack's ${build} installation`, async () => {
    await using home = await new TemporaryFiles().directory('slack-location-');
    const directory = join(home.path, location);
    await save(directory, 'F1');

    const result = await read(home.path);

    assert.deepEqual(result.clients, []);
    assert.equal(result.downloads[0]?.fileId, 'F1');
  });
}

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

test('an inaccessible leftover folder does not hide a readable installation', async () => {
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
});

test('a missing store asks for saved Slack data without requiring the App Store', async () => {
  await using home = await new TemporaryFiles().directory('slack-location-');
  await assert.rejects(read(home.path), (error) => {
    assert.ok(error instanceof SlackDesktopUnavailableError);
    assert.match(error.message, /Open Slack, sign in/);
    assert.doesNotMatch(error.message, /Install Slack from the Mac App Store/);
    return true;
  });
});

for (const [saved, location] of Object.entries(locations)) {
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
  });
}

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

test('a store that is not there is unavailable, not a time', async () => {
  await using dir = await new TemporaryFiles().directory('slack-written-');

  assert.throws(
    () => new SlackDesktopStore(join(dir.path, 'Slack')).lastWrite(),
    SlackDesktopUnavailableError,
  );
});
