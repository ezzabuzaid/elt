import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BiomeSchemaError,
  BiomeStore,
  BiomeUnavailableError,
} from './index.ts';

test('a Biome whose streams folder is missing or denied fails with BiomeUnavailableError naming Full Disk Access', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'biome-'));
  const restricted = join(scratch.path, 'Biome/streams/restricted');
  await mkdir(restricted, { recursive: true });
  await chmod(restricted, 0o000);
  try {
    const missing = await new BiomeStore(join(scratch.path, 'none'))
      .streams()
      .then(
        () => null,
        (error: unknown) => error,
      );
    const denied = await new BiomeStore(join(scratch.path, 'Biome'))
      .streams()
      .then(
        () => null,
        (error: unknown) => error,
      );

    assert.ok(missing instanceof BiomeUnavailableError);
    assert.match(
      missing.message,
      /none\/streams\/restricted cannot be read\. .*Full Disk Access/,
    );
    assert.ok(denied instanceof BiomeUnavailableError);
    assert.match(denied.message, /Biome\/streams\/restricted cannot be read/);
  } finally {
    await chmod(restricted, 0o755);
  }
});

test('a device list without a column the reader needs fails with BiomeSchemaError naming each missing column', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'biome-'));
  await mkdir(join(scratch.path, 'sync'));
  {
    using sync = new DatabaseSync(join(scratch.path, 'sync/sync.db'));
    sync.exec(
      'CREATE TABLE DevicePeer (device_identifier STRING NOT NULL, me BOOLEAN, name STRING, model STRING)',
    );
  }

  assert.throws(
    () => new BiomeStore(scratch.path).sync(),
    (error: unknown) =>
      error instanceof BiomeSchemaError &&
      /missing DevicePeer\.platform, DevicePeer\.last_sync_date\)/.test(
        error.message,
      ),
  );
});
