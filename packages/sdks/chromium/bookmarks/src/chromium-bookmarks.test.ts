import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { ChromiumBookmarks, StoreUnavailableError } from './index.ts';

test('a missing Bookmarks file says it is not there and what makes the browser write it', async () => {
  await using dir = await new TemporaryFiles().directory('bookmarks-');
  const path = join(dir.path, 'Bookmarks');

  assert.throws(
    () => ChromiumBookmarks.read(path),
    (error: unknown) =>
      error instanceof StoreUnavailableError &&
      error.missing &&
      error.message ===
        `The bookmarks at ${path} is not there. Bookmark a page in the browser so it saves its bookmarks.`,
  );
});

test('a Bookmarks file that the system denies says it cannot be read', async (t) => {
  if (process.platform === 'win32')
    return t.skip('chmod denies nothing on Windows');
  if (process.getuid?.() === 0) return t.skip('chmod denies nothing to root');
  await using dir = await new TemporaryFiles().directory('bookmarks-');
  const path = join(dir.path, 'Bookmarks');
  await writeFile(path, '{"roots":{}}');
  await chmod(path, 0o000);

  assert.throws(
    () => ChromiumBookmarks.read(path),
    (error: unknown) =>
      error instanceof StoreUnavailableError &&
      !error.missing &&
      error.message === `The bookmarks at ${path} cannot be read.`,
  );
});

test('a Bookmarks path that the file system cannot read as a file gives the file system’s own error', async () => {
  await using dir = await new TemporaryFiles().directory('bookmarks-');
  const path = join(dir.path, 'Bookmarks');
  await mkdir(path);

  assert.throws(
    () => ChromiumBookmarks.read(path),
    (error: unknown) =>
      !(error instanceof StoreUnavailableError) &&
      Error.isError(error) &&
      'code' in error &&
      error.code === 'EISDIR',
  );
});
