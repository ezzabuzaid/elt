import assert from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { NotesStore, StoreUnavailableError } from './index.ts';

test('the store was last written when Notes last wrote NoteStore.sqlite', async () => {
  await using dir = await new TemporaryFiles().directory('notes-');
  const path = join(dir.path, 'NoteStore.sqlite');
  open(path, { journal: new RollbackJournal() }).close();
  // Notes writes the store; a reader only reads it later.
  await utimes(path, 1_800_100_000, 1_800_000_000);

  const written = new NotesStore(path).lastWrite();

  assert.equal(written.getTime(), 1_800_000_000_000);
});

test('a store that is not there is unavailable, not a time', async () => {
  await using dir = await new TemporaryFiles().directory('notes-');

  assert.throws(
    () => new NotesStore(join(dir.path, 'NoteStore.sqlite')).lastWrite(),
    StoreUnavailableError,
  );
});
