import assert from 'node:assert/strict';
import { mkdtempDisposable, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { NotesStore, NotesUnavailableError } from './index.ts';

test('the store was last written when Notes last wrote NoteStore.sqlite', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'notes-'));
  const path = join(dir.path, 'NoteStore.sqlite');
  new DatabaseSync(path).close();
  // Notes writes the store; a reader only reads it later.
  await utimes(path, 1_800_100_000, 1_800_000_000);

  const written = new NotesStore(path).lastWrite();

  assert.equal(written.getTime(), 1_800_000_000_000);
});

test('a store that is not there is unavailable, not a time', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'notes-'));

  assert.throws(
    () => new NotesStore(join(dir.path, 'NoteStore.sqlite')).lastWrite(),
    NotesUnavailableError,
  );
});
