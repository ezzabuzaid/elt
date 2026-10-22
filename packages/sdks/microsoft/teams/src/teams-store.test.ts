import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TeamsStore, TeamsUnavailableError } from './index.ts';

const indexedDB = 'IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb';

// A reader reads the files after the web client writes them, so each file's
// access time is later than the time it was written.
const readLater = 100_000;

test('the store was last written when a file of its database was, though the database folder kept its time', async () => {
  await using profile = await mkdtempDisposable(join(tmpdir(), 'teams-'));
  const database = join(profile.path, indexedDB);
  await mkdir(database, { recursive: true });
  await writeFile(join(database, 'CURRENT'), 'MANIFEST-000001\n');
  await writeFile(join(database, 'MANIFEST-000001'), '');
  await writeFile(join(database, '000003.log'), 'saved');
  const written = (path: string, time: number) =>
    utimes(path, time + readLater, time);
  for (const file of ['CURRENT', 'MANIFEST-000001'])
    await written(join(database, file), 1_800_000_000);
  await written(join(database, '000003.log'), 1_800_000_300);
  await written(database, 1_800_000_000);

  const last = new TeamsStore(profile.path).lastWrite();

  assert.equal(last.getTime(), 1_800_000_300_000);
});

test('a store that is not there is unavailable, not a time', async () => {
  await using profile = await mkdtempDisposable(join(tmpdir(), 'teams-'));

  assert.throws(
    () => new TeamsStore(join(profile.path, 'missing')).lastWrite(),
    TeamsUnavailableError,
  );
});
