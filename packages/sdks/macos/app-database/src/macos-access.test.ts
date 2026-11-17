import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';

import { AppDatabase, Store, macOSAccess } from './index.ts';

// Declared when the module loads, as every SDK declares its store, before any
// host's entry point has installed its program.
const notificationCenter = new Store('The Notification Center store', {
  missing:
    'The notification service of macOS (usernoted) makes it when it starts: log out and log in again.',
  grant: 'full-disk-access',
});

// chmod denies nothing on Windows, and nothing to root.
const denies = process.platform !== 'win32' && process.getuid?.() !== 0;

// The message a real denied open of a store gives: a store file with mode
// 000 stands in for a privacy denial of macOS, since SQLite reports CANTOPEN
// for both and the file is there in both.
async function deniedMessage(store: Store): Promise<string> {
  await using dir = await new TemporaryFiles().directory('macos-access-');
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
  'a store declared before the host installs its program names the program installed when it fails',
  { skip: !denies },
  async () => {
    macOSAccess.install({ program: 'ChatGPT' });
    assert.match(await deniedMessage(notificationCenter), /Turn on ChatGPT /);

    macOSAccess.install({ program: '/opt/homebrew/bin/node' });
    assert.match(
      await deniedMessage(notificationCenter),
      /Turn on \/opt\/homebrew\/bin\/node /,
    );
  },
);

test(
  'a store that the system keeps from this process names the store and gives the one grant, for the installed program',
  { skip: !denies },
  async () => {
    macOSAccess.install({ program: 'ChatGPT' });

    assert.equal(
      await deniedMessage(notificationCenter),
      'The Notification Center store at <path> cannot be read. Turn on ChatGPT in System Settings › Privacy & Security › Full Disk Access.',
    );
  },
);

test(
  'a store that no grant opens says only that it cannot be read',
  { skip: !denies },
  async () => {
    macOSAccess.install({ program: 'ChatGPT' });

    assert.equal(
      await deniedMessage(new Store('The history', { missing: '' })),
      'The history at <path> cannot be read.',
    );
  },
);

test('a store that is not there gives what makes its app create it, not its grant', async () => {
  macOSAccess.install({ program: 'ChatGPT' });
  await using dir = await new TemporaryFiles().directory('macos-access-');
  const path = join(dir.path, 'store.sqlite');

  assert.throws(() => new AppDatabase(notificationCenter).snapshot(path), {
    message: `The Notification Center store at ${path} is not there. The notification service of macOS (usernoted) makes it when it starts: log out and log in again.`,
  });
});

test(
  'a store behind the Contacts grant names both grants that open it',
  { skip: !denies },
  async () => {
    macOSAccess.install({ program: 'ChatGPT' });

    assert.equal(
      await deniedMessage(
        new Store('The Contacts store', { missing: '', grant: 'contacts' }),
      ),
      'The Contacts store at <path> cannot be read. Turn on ChatGPT in System Settings › Privacy & Security › Contacts or › Full Disk Access.',
    );
  },
);

test('the remedy of a framework grant names the installed program and its pane', () => {
  macOSAccess.install({ program: 'ChatGPT' });

  assert.equal(
    macOSAccess.remedy('calendars'),
    'Turn on ChatGPT in System Settings › Privacy & Security › Calendars.',
  );
  assert.equal(
    macOSAccess.remedy('reminders'),
    'Turn on ChatGPT in System Settings › Privacy & Security › Reminders.',
  );
});

test('a store carries no sentence of its own for a denial', () => {
  // The grant is the only remedy a store gives for a denial, so a store
  // cannot add a second one beside it.
  // @ts-expect-error -- `denied` is not a field of a store.
  new Store('The store', { missing: '', denied: 'Grant access.' });
});
