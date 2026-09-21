import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  AppleNotesSource,
  Copy,
  type CopyConfiguration,
  Pipeline,
  SQLiteDestination,
} from './index.ts';

test('the package API copies source records into SQLite', async () => {
  class Notes extends AppleNotesSource {
    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'account-1', name: 'Test account', upgraded: true },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-test-'));
  const source = new Notes();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const copy = new Copy(source.accounts, destination.table('accounts'));
  const results = await new Pipeline({
    source,
    destination,
    steps: [copy],
  }).run();

  assert.deepEqual(results, [{ copy, count: 1 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const row = database.prepare('SELECT id, name FROM accounts').get();
  assert.ok(row);
  assert.deepEqual({ ...row }, { id: 'account-1', name: 'Test account' });
});
