import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ApplePlugin } from './plugin/apple-plugin.ts';

function importedNotes(directory: string) {
  mkdirSync(join(directory, 'notes'), { recursive: true });
  using database = new DatabaseSync(join(directory, 'notes/data.sqlite'));
  database.exec("CREATE TABLE notes(id TEXT); INSERT INTO notes VALUES('n1');");
}

test('Apple setup rejects invalid choices and fills the Calendar default range', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  assert.equal(plugin.status().configured, false);
  for (const [apps, message] of [
    [
      [{ app: 'contacts', scope: { startAt: '2025-01-01T00:00:00.000Z' } }],
      /date filtering/,
    ],
    [[{ app: 'messages', scope: { accountIds: ['a'] } }], /account IDs/],
    [[{ app: 'notes', scope: { collectionIds: [] } }], /too small/i],
    [[{ app: 'notes' }, { app: 'notes' }], /once/],
    [[{ app: 'safari' }], /app/],
  ] as const)
    assert.throws(() => plugin.configure({ apps }), message);
  assert.equal(plugin.status().configured, false);
  const [calendar] = plugin.configure({ apps: [{ app: 'calendar' }] }).apps;
  assert.ok(calendar?.scope.startAt);
  assert.ok(calendar.scope.endAt);
  assert.ok(calendar.scope.startAt < calendar.scope.endAt);
});

test('Apple setup keeps an unchanged app, discards a changed or disconnected one, and refuses a concurrent operation', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  const notes = { app: 'notes', scope: { collectionIds: ['folder-1'] } };
  assert.equal(plugin.configure({ apps: [notes] }).apps[0]?.database, null);
  importedNotes(scratch.path);
  const database = join(scratch.path, 'notes/data.sqlite');
  assert.equal(
    new ApplePlugin(scratch.path).status().apps[0]?.database,
    database,
  );
  {
    using lock = new DatabaseSync(join(scratch.path, 'operation.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    assert.throws(() => plugin.configure({ apps: [] }), /another Codex chat/);
    await assert.rejects(plugin.sync(), /another Codex chat/);
  }
  plugin.configure({ apps: [notes] });
  assert.equal(existsSync(database), true);
  plugin.configure({
    apps: [{ app: 'notes', scope: { collectionIds: ['folder-2'] } }],
  });
  assert.equal(existsSync(join(scratch.path, 'notes')), false);
  importedNotes(scratch.path);
  plugin.configure({ apps: [] });
  assert.equal(existsSync(join(scratch.path, 'notes')), false);
  await assert.rejects(plugin.sync(['notes']), /selected during setup/);
});
