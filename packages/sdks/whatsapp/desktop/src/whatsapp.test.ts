import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, utimes } from 'node:fs/promises';
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
