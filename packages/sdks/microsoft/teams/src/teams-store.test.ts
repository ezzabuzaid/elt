import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { Client, FullDiskAccess } from '@zukhruf/tcc';

import { StoreUnavailableError, TeamsStore } from './index.ts';

// The remedy that a denied store gives: the Full Disk Access sentence of
// @zukhruf/tcc for the client that macOS charges this test process to.
const fullDiskAccess = new FullDiskAccess().remedy(
  Client.responsibleFor(process.pid),
);

const indexedDB = 'IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb';

// A reader reads the files after the web client writes them, so each file's
// access time is later than the time it was written.
const readLater = 100_000;

test('the store was last written when a file of its database was, though the database folder kept its time', async () => {
  await using profile = await new TemporaryFiles().directory('teams-');
  const database = join(profile.path, indexedDB);
  await mkdir(database, { recursive: true });
  await writeFile(join(database, 'CURRENT'), 'MANIFEST-000001\n');
  await writeFile(join(database, 'MANIFEST-000001'), '');
  await writeFile(join(database, '000003.log'), 'saved');
  const written = (path: string, time: number) =>
    utimes(path, time + readLater, time);
  for (const file of ['CURRENT', 'MANIFEST-000001'])
    await written(join(database, file), 1_800_000_000);
  await written(join(database, '000003.log'), 1_800_000_300);
  await written(database, 1_800_000_000);

  const last = new TeamsStore(profile.path).lastWrite();

  assert.equal(last.getTime(), 1_800_000_300_000);
});

test('a store that is not there is unavailable, not a time, and says how to make it', async () => {
  await using profile = await new TemporaryFiles().directory('teams-');
  const directory = join(profile.path, 'missing');

  assert.throws(
    () => new TeamsStore(directory).lastWrite(),
    (error) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.equal(error.missing, true);
      assert.equal(
        error.message,
        `The Microsoft Teams app's store at ${directory} is not there. Open Teams, sign in and let it load your chats.`,
      );
      return true;
    },
  );
});

test('a database folder that holds no file is a store that is not there', async () => {
  await using profile = await new TemporaryFiles().directory('teams-');
  await mkdir(join(profile.path, indexedDB), { recursive: true });

  assert.throws(
    () => new TeamsStore(profile.path).lastWrite(),
    (error) => {
      assert.ok(error instanceof StoreUnavailableError);
      assert.match(error.message, /is not there\. Open Teams, sign in/);
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
    await using profile = await new TemporaryFiles().directory('teams-');
    await mkdir(join(profile.path, indexedDB), { recursive: true });
    // chmod stands in for macOS withholding the app's container from a process
    // without Full Disk Access: both fail the read with EACCES or EPERM.
    await chmod(profile.path, 0o000);

    try {
      assert.throws(
        () => new TeamsStore(profile.path).lastWrite(),
        (error) => {
          assert.ok(error instanceof StoreUnavailableError);
          assert.equal(error.missing, false);
          assert.equal(
            error.message,
            `The Microsoft Teams app's store at ${profile.path} cannot be read. ${fullDiskAccess}`,
          );
          return true;
        },
      );
    } finally {
      await chmod(profile.path, 0o700);
    }
  },
);

test('a store that fails to list for another reason fails as that error', async () => {
  await using profile = await new TemporaryFiles().directory('teams-');
  const database = join(profile.path, indexedDB);
  await mkdir(join(database, '..'), { recursive: true });
  // A link to itself: the folder is there and readable, but never resolves.
  await symlink(database, database);

  assert.throws(
    () => new TeamsStore(profile.path).lastWrite(),
    (error) => {
      assert.ok(!(error instanceof StoreUnavailableError));
      assert.equal(Reflect.get(Object(error), 'code'), 'ELOOP');
      return true;
    },
  );
});

test(
  'a database folder that the system keeps from this process fails the read of the accounts as one that cannot be read',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using profile = await new TemporaryFiles().directory('teams-');
    const database = join(profile.path, indexedDB);
    await mkdir(database, { recursive: true });
    await writeFile(join(database, 'CURRENT'), 'MANIFEST-000001\n');
    // chmod stands in for macOS withholding the app's container from a
    // process without Full Disk Access: both fail the read with EACCES or
    // EPERM.
    await chmod(database, 0o000);

    try {
      await assert.rejects(new TeamsStore(profile.path).clients(), (error) => {
        assert.ok(error instanceof StoreUnavailableError);
        assert.equal(error.missing, false);
        assert.equal(
          error.message,
          `The Microsoft Teams app's store at ${profile.path} cannot be read. ${fullDiskAccess}`,
        );
        return true;
      });
    } finally {
      await chmod(database, 0o700);
    }
  },
);

test('a database folder that fails to read for another reason fails the read of the accounts as that error', async () => {
  await using profile = await new TemporaryFiles().directory('teams-');
  const database = join(profile.path, indexedDB);
  await mkdir(join(database, '..'), { recursive: true });
  // A link to itself: the folder is there and readable, but never resolves.
  await symlink(database, database);

  await assert.rejects(new TeamsStore(profile.path).clients(), (error) => {
    assert.ok(!(error instanceof StoreUnavailableError));
    assert.equal(Reflect.get(Object(error), 'code'), 'ELOOP');
    return true;
  });
});
