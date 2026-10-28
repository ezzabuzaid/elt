import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  rename,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { WhatsApp, WhatsAppUnavailableError } from './index.ts';

// A store as WhatsApp leaves it, last written at a time in seconds since the
// epoch; a reader reads it later.
async function writtenAt(path: string, time: number) {
  await mkdir(dirname(path), { recursive: true });
  new DatabaseSync(path).close();
  await utimes(path, time + 100_000, time);
}

test('each store was last written when WhatsApp last wrote that store, whatever it wrote to the others', async () => {
  await using container = await mkdtempDisposable(join(tmpdir(), 'whatsapp-'));
  await writtenAt(join(container.path, 'ChatStorage.sqlite'), 1_800_000_000);
  await writtenAt(
    join(container.path, 'statusDB/Status.sqlite'),
    1_800_000_060,
  );
  // The notification extension writes this store while the app is closed.
  await writtenAt(join(container.path, 'LocalKeyValue.sqlite'), 1_800_000_900);
  const whatsapp = new WhatsApp(container.path);

  const written = {
    chats: whatsapp.lastWrite('chatStorage').getTime(),
    statuses: whatsapp.lastWrite('statuses').getTime(),
    settings: whatsapp.lastWrite('localKeyValue').getTime(),
  };

  assert.deepEqual(written, {
    chats: 1_800_000_000_000,
    statuses: 1_800_000_060_000,
    settings: 1_800_000_900_000,
  });
});

test('a store WhatsApp has not created is unavailable, not a time', async () => {
  await using container = await mkdtempDisposable(join(tmpdir(), 'whatsapp-'));

  assert.throws(
    () => new WhatsApp(container.path).lastWrite('chatStorage'),
    WhatsAppUnavailableError,
  );
});

test(
  'a store WhatsApp replaced with one this process cannot open reads as missing, and as a version again once a readable store is back',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using container = await mkdtempDisposable(
      join(tmpdir(), 'whatsapp-'),
    );
    const path = join(container.path, 'ChatStorage.sqlite');
    await writtenAt(path, 1_800_000_000);
    using version = new WhatsApp(container.path).version('chatStorage');
    const opened = version.current;
    const denied = join(container.path, 'denied.sqlite');
    await writtenAt(denied, 1_800_000_060);
    await chmod(denied, 0o000);
    const readable = join(container.path, 'readable.sqlite');
    await writtenAt(readable, 1_800_000_120);

    await rename(denied, path);
    const replaced = version.current;
    await rename(readable, path);
    const back = version.current;

    assert.match(opened, /^\d+$/);
    assert.equal(replaced, 'missing');
    assert.match(back, /^\d+$/);
  },
);
