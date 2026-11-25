import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { Client, Contacts, FullDiskAccess } from '@zukhruf/tcc';

import { AppDatabase, Store } from './index.ts';

const notificationCenter = new Store('The Notification Center store', {
  missing:
    'The notification service of macOS (usernoted) makes it when it starts: log out and log in again.',
  service: new FullDiskAccess(),
});

// The client that macOS charges this test process to, as @zukhruf/tcc finds it.
const client = Client.responsibleFor(process.pid);

// chmod denies nothing on Windows, and nothing to root.
const denies = process.platform !== 'win32' && process.getuid?.() !== 0;

// The message a real denied open of a store gives: a store file with mode
// 000 stands in for a privacy denial of macOS, since SQLite reports CANTOPEN
// for both and the file is there in both.
async function deniedMessage(store: Store): Promise<string> {
  await using dir = await new TemporaryFiles().directory('store-remedy-');
  const path = join(dir.path, 'store.sqlite');
  {
    using db = open(path, { journal: new RollbackJournal() });
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY)');
  }
  await chmod(path, 0o000);
  try {
    new AppDatabase(store).snapshot(path);
  } catch (error) {
    assert.ok(Error.isError(error));
    return error.message.replace(path, '<path>');
  } finally {
    await chmod(path, 0o644);
  }
  return assert.fail('a store with mode 000 was read');
}

test(
  'a store that the system keeps from this process names the store and the remedy of its service for this client',
  { skip: !denies },
  async () => {
    assert.equal(
      await deniedMessage(notificationCenter),
      `The Notification Center store at <path> cannot be read. ${new FullDiskAccess().remedy(client)}`,
    );
  },
);

test(
  'a store that no service opens says only that it cannot be read',
  { skip: !denies },
  async () => {
    assert.equal(
      await deniedMessage(new Store('The history', { missing: '' })),
      'The history at <path> cannot be read.',
    );
  },
);

test('a store that is not there gives what makes its app create it, not its service', async () => {
  await using dir = await new TemporaryFiles().directory('store-remedy-');
  const path = join(dir.path, 'store.sqlite');

  assert.throws(() => new AppDatabase(notificationCenter).snapshot(path), {
    message: `The Notification Center store at ${path} is not there. The notification service of macOS (usernoted) makes it when it starts: log out and log in again.`,
  });
});

test(
  'a store behind the Contacts service names the Contacts pane',
  { skip: !denies },
  async () => {
    assert.equal(
      await deniedMessage(
        new Store('The Contacts store', {
          missing: '',
          service: new Contacts(),
        }),
      ),
      `The Contacts store at <path> cannot be read. ${new Contacts().remedy(client)}`,
    );
  },
);

test('a store carries no sentence of its own for a denial', () => {
  // The service is the only remedy a store gives for a denial, so a store
  // cannot add a second one beside it.
  // @ts-expect-error -- `denied` is not a field of a store.
  new Store('The store', { missing: '', denied: 'Grant access.' });
});
