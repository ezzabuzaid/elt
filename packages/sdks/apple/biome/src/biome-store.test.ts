import assert from 'node:assert/strict';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { MissingColumnsError } from '@zukhruf/sqlite-snapshot';

import { AppInFocus, BiomeStore, StoreUnavailableError } from './index.ts';

test('a Biome whose streams folder is not there fails with StoreUnavailableError saying so, and does not name Full Disk Access', async () => {
  await using scratch = await new TemporaryFiles().directory('biome-');

  const missing = await new BiomeStore(join(scratch.path, 'none'))
    .streams()
    .then(
      () => null,
      (error: unknown) => error,
    );

  assert.ok(missing instanceof StoreUnavailableError);
  assert.match(missing.message, /none\/streams\/restricted is not there\.$/);
  assert.doesNotMatch(missing.message, /Full Disk Access/);
});

test(
  'a Biome whose streams folder is denied fails with StoreUnavailableError naming Full Disk Access',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using scratch = await new TemporaryFiles().directory('biome-');
    const restricted = join(scratch.path, 'Biome/streams/restricted');
    await mkdir(restricted, { recursive: true });
    // chmod stands in for macOS withholding Full Disk Access: the folder is
    // there and the process may not list it.
    await chmod(restricted, 0o000);
    try {
      const denied = await new BiomeStore(join(scratch.path, 'Biome'))
        .streams()
        .then(
          () => null,
          (error: unknown) => error,
        );

      assert.ok(denied instanceof StoreUnavailableError);
      assert.match(
        denied.message,
        /Biome\/streams\/restricted cannot be read\. .*Full Disk Access/,
      );
    } finally {
      await chmod(restricted, 0o755);
    }
  },
);

test('a Biome whose streams folder fails for a reason other than access fails with the file system error itself', async () => {
  await using scratch = await new TemporaryFiles().directory('biome-');
  await mkdir(join(scratch.path, 'Biome/streams'), { recursive: true });
  // A link to itself: listing it fails with ELOOP, which neither a missing
  // nor a denied folder gives.
  await symlink('restricted', join(scratch.path, 'Biome/streams/restricted'));

  const failure = await new BiomeStore(join(scratch.path, 'Biome'))
    .streams()
    .then(
      () => null,
      (error: unknown) => error,
    );

  assert.ok(Error.isError(failure));
  assert.ok(!(failure instanceof StoreUnavailableError));
  assert.equal('code' in failure && failure.code, 'ELOOP');
});

test('a stream whose segment folder fails for a reason other than access fails with the file system error itself, and one with no folder has no segments', async () => {
  await using scratch = await new TemporaryFiles().directory('biome-');
  const stream = join(scratch.path, 'Biome/streams/restricted/App.InFocus');
  await mkdir(stream, { recursive: true });
  const streams = await new BiomeStore(join(scratch.path, 'Biome')).streams();
  const started = await streams.segments(new AppInFocus());
  await symlink('local', join(stream, 'local'));

  const failure = await streams.segments(new AppInFocus()).then(
    () => null,
    (error: unknown) => error,
  );

  assert.deepEqual(started, []);
  assert.ok(Error.isError(failure));
  assert.ok(!(failure instanceof StoreUnavailableError));
  assert.equal('code' in failure && failure.code, 'ELOOP');
});

test('a device list without a column the reader needs fails with MissingColumnsError naming each missing column', async () => {
  await using scratch = await new TemporaryFiles().directory('biome-');
  await mkdir(join(scratch.path, 'sync'));
  {
    using sync = open(join(scratch.path, 'sync/sync.db'), {
      journal: new RollbackJournal(),
    });
    sync.exec(
      'CREATE TABLE DevicePeer (device_identifier STRING NOT NULL, me BOOLEAN, name STRING, model STRING)',
    );
  }

  assert.throws(
    () => new BiomeStore(scratch.path).sync(),
    (error: unknown) =>
      error instanceof MissingColumnsError &&
      /lacks the columns DevicePeer\.platform, DevicePeer\.last_sync_date: /.test(
        error.message,
      ),
  );
});
