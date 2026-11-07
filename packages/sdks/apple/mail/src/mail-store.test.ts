import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { ChangeWatcher } from '@zukhruf/async';
import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { MissingColumnsError } from '@zukhruf/sqlite-snapshot';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { MailStore, StoreUnavailableError } from './index.ts';

const execFileAsync = promisify(execFile);

test('the store was last written when the index of its current version folder was, not an older folder', async () => {
  await using dir = await new TemporaryFiles().directory('mail-store-');
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );
  for (const [version, written] of [
    ['V9', 1_800_000_900],
    ['V10', 1_800_000_300],
  ] as const) {
    await mkdir(join(dir.path, version, 'MailData'), { recursive: true });
    const index = join(dir.path, version, 'MailData/Envelope Index');
    open(index, { journal: new RollbackJournal() }).close();
    // Mail and its daemon write the index; a reader only reads it later.
    await utimes(index, written + 100_000, written);
  }

  const written = await new MailStore(dir.path).lastWrite();

  assert.equal(written.getTime(), 1_800_000_300_000);
});

test('a store whose index is missing is unavailable, not a time', async () => {
  await using dir = await new TemporaryFiles().directory('mail-store-');
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );

  await assert.rejects(
    new MailStore(dir.path).lastWrite(),
    StoreUnavailableError,
  );
});

test('a version that its watch stops during its first read leaves no watch of the store open', async () => {
  await using dir = await new TemporaryFiles().directory('mail-store-');
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );
  await mkdir(join(dir.path, 'V10/MailData'), { recursive: true });
  open(join(dir.path, 'V10/MailData/Envelope Index'), {
    journal: new RollbackJournal(),
  }).close();

  // The first check reads the version file, and the watch stops meanwhile:
  // it abandons the read and disposes the version, as a pipeline does. The
  // process ends by itself only when no watch of the store stays open.
  const script = `
    const { ChangeWatcher } = await import(${JSON.stringify(import.meta.resolve('@zukhruf/async'))});
    const { MailStore } = await import(${JSON.stringify(import.meta.resolve('./index.ts'))});
    const version = new MailStore(${JSON.stringify(dir.path)}).version();
    const controller = new AbortController();
    const first = new ChangeWatcher([version], {
      interval: 1000,
      timeout: 1000,
      clock: globalThis,
    }).watch(controller.signal).next();
    controller.abort();
    version[Symbol.dispose]();
    await first;
  `;
  await execFileAsync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '--eval', script],
    { timeout: 5000 },
  );
});

test('a version whose watch of the store fails rejects the next read with the error, and the read after it watches the store again', async () => {
  await using dir = await new TemporaryFiles().directory('mail-store-');
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );
  await mkdir(join(dir.path, 'V10/MailData'), { recursive: true });
  open(join(dir.path, 'V10/MailData/Envelope Index'), {
    journal: new RollbackJournal(),
  }).close();
  await mkdir(join(dir.path, 'crowd'));
  using version = new MailStore(dir.path).version();
  const controller = new AbortController();
  const checks = new ChangeWatcher([version], {
    interval: 50,
    timeout: 1000,
    clock: globalThis,
  }).watch(controller.signal);
  try {
    const outcome = async () => {
      const { value } = await checks.next();
      assert.ok(value);
      return value.get(version);
    };
    assert.deepEqual(await outcome(), { state: 'changed' });

    // libuv watches every folder of a process through one FSEvents stream,
    // and FSEventStreamStart refuses a stream of more than 4096 paths: the
    // 4097th watch fails every running watch with EMFILE, the store's too.
    // Node closes each failed watch itself, so the crowd leaves nothing open;
    // each close restarts the stream, so the closes take one to two minutes.
    const crowd = Array.from({ length: 4096 }, () =>
      watch(join(dir.path, 'crowd'), { recursive: true }),
    );
    await Promise.all(crowd.map((watcher) => once(watcher, 'error')));

    const failed = await outcome();
    assert.ok(failed?.state === 'failed');
    assert.ok(failed.error instanceof Error);
    assert.equal(failed.error.message, 'EMFILE: too many open files, watch');
    assert.notEqual((await outcome())?.state, 'failed');
    await writeFile(join(dir.path, 'V10/MailData/attachment'), 'downloaded');
    let later = await outcome();
    for (let tries = 0; later?.state === 'unchanged' && tries < 50; tries += 1)
      later = await outcome();
    assert.deepEqual(later, { state: 'changed' });
  } finally {
    controller.abort();
    await checks.return();
  }
});

test('an index without a column the reader needs fails with MissingColumnsError naming each missing table.column', async () => {
  await using dir = await new TemporaryFiles().directory('mail-store-');
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );
  await mkdir(join(dir.path, 'V10/MailData'), { recursive: true });
  const index = join(dir.path, 'V10/MailData/Envelope Index');
  // An index from a Mail whose messages table lacks columns this reader
  // loads and whose other tables are missing entirely.
  using app = open(index, { journal: new RollbackJournal() });
  app.exec(
    'CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, message_id INTEGER, subject INTEGER)',
  );

  await assert.rejects(new MailStore(dir.path).open(), (error: unknown) => {
    assert.ok(error instanceof MissingColumnsError);
    assert.equal(error.name, 'MissingColumnsError');
    assert.equal(error.path, index);
    assert.ok(
      error.message.startsWith(
        `The database at ${JSON.stringify(index)} lacks the columns messages.global_message_id, messages.remote_id, `,
      ),
    );
    assert.match(error.message, /\bmailboxes\.url\b/);
    assert.match(error.message, /\bserver_labels\.label\b/);
    assert.match(error.message, /\bevents\.is_response_requested: /);
    assert.doesNotMatch(
      error.message,
      /[ (]messages\.(ROWID|message_id|subject)\b/,
    );
    return true;
  });
});
