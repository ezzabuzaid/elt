import assert from 'node:assert/strict';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { MissingColumnsError } from '@zukhruf/sqlite-snapshot';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { BiomeStore, StoreUnavailableError } from './index.ts';

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
