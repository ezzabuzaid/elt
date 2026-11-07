import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ChangeWatcher, type Outcome } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AppFilesVersion } from './index.ts';

// The outcome of each check of version, after the step for that check: a
// Check cannot be built outside a watch, so the version is read through one.
async function checked(
  version: AppFilesVersion,
  steps: readonly (() => Promise<void>)[],
): Promise<Outcome[]> {
  const stop = new AbortController();
  const checks = new ChangeWatcher([version], {
    interval: 5,
    timeout: 1000,
    clock: globalThis,
  }).watch(stop.signal);
  try {
    const outcomes: Outcome[] = [];
    for (const step of steps) {
      await step();
      const { value } = await checks.next();
      const outcome = value?.get(version);
      assert.ok(outcome !== undefined);
      outcomes.push(outcome);
    }
    return outcomes;
  } finally {
    stop.abort();
    await checks.return();
  }
}

test(
  'a store in a folder this process may not read is a change that does not fail the watch, and a grant of access is a change again',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('app-files-');
    const folder = join(dir.path, 'Container');
    await mkdir(folder);
    const path = join(folder, 'store.plist');
    await writeFile(path, 'store');
    await chmod(folder, 0o000);
    try {
      const outcomes = await checked(new AppFilesVersion(() => [path]), [
        async () => {},
        () => chmod(folder, 0o700),
        async () => {},
      ]);

      assert.deepEqual(outcomes, [
        { state: 'changed' },
        { state: 'changed' },
        { state: 'unchanged' },
      ]);
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

test('a store whose folder is not there is a change that does not fail the watch, and the folder the app makes is a change again', async () => {
  await using dir = await new TemporaryFiles().directory('app-files-');
  const folder = join(dir.path, 'Store');
  const files = () => readdirSync(folder).map((name) => join(folder, name));

  const outcomes = await checked(new AppFilesVersion(files), [
    async () => {},
    async () => {
      await mkdir(folder);
      await writeFile(join(folder, 'CURRENT'), 'MANIFEST-000001\n');
    },
    async () => {},
  ]);

  assert.deepEqual(outcomes, [
    { state: 'changed' },
    { state: 'changed' },
    { state: 'unchanged' },
  ]);
});

test('a store file that the file system cannot stat for another reason fails the read', async () => {
  await using dir = await new TemporaryFiles().directory('app-files-');
  // A link to itself: stat fails with ELOOP.
  const path = join(dir.path, 'store.plist');
  await symlink(path, path);

  const [outcome] = await checked(new AppFilesVersion(() => [path]), [
    async () => {},
  ]);

  assert.ok(outcome?.state === 'failed');
  assert.match(String(outcome.error), /^Error: ELOOP: /);
});
