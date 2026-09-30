import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApplePlugin } from './plugin/apple-plugin.ts';
import { keepFresh, leaderRunning } from './plugin/freshness.ts';
import { importDirectory, Settings } from './plugin/settings.ts';

// Stands in for the leading server's import of one app selection.
function imported(
  directory: string,
  item: Parameters<typeof importDirectory>[1],
) {
  const path = importDirectory(directory, item);
  mkdirSync(path, { recursive: true });
  using database = new DatabaseSync(join(path, 'data.sqlite'));
  database.exec("CREATE TABLE notes(id TEXT); INSERT INTO notes VALUES('n1');");
  return join(path, 'data.sqlite');
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

test('Apple setup keeps an unchanged import, removes a changed or disconnected one, and reports a pass no server finishes as interrupted', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  const notes = {
    app: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: true,
  };
  assert.equal(plugin.configure({ apps: [notes] }).apps[0]?.database, null);
  const database = imported(scratch.path, notes);
  assert.equal(
    new ApplePlugin(scratch.path).status().apps[0]?.database,
    database,
  );
  plugin.configure({ apps: [notes] });
  assert.equal(existsSync(database), true);

  // A pass left running by a server that exited is not waited for.
  {
    using settings = new Settings(scratch.path);
    settings.saveSyncResult(importDirectory(scratch.path, notes), {
      state: 'running',
      startedAt: new Date().toISOString(),
    });
  }
  assert.equal(plugin.status().apps[0]?.sync?.state, 'interrupted');
  assert.equal((await plugin.sync())?.apps[0]?.sync?.state, 'interrupted');
  {
    using lease = new DatabaseSync(join(scratch.path, 'watch.sqlite'));
    lease.exec('BEGIN IMMEDIATE');
    assert.equal(plugin.status().apps[0]?.sync?.state, 'running');
  }

  const changed = { ...notes, scope: { collectionIds: ['folder-2'] } };
  plugin.configure({ apps: [changed] });
  assert.equal(existsSync(database), false);
  const [current] = plugin.status().apps;
  assert.equal(current?.database, null);
  assert.equal(current?.sync, null);
  imported(scratch.path, changed);
  plugin.configure({ apps: [] });
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
  await assert.rejects(plugin.sync(['notes']), /selected during setup/);
});

test('the leading server keeps leading when its settings cannot be read, and lets go once stopped', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A directory where the settings file belongs fails every read of them.
  mkdirSync(join(scratch.path, 'settings.sqlite'));
  const stopping = new AbortController();
  const running = keepFresh(scratch.path, stopping.signal);
  try {
    await sleep(1_500);
    assert.equal(leaderRunning(scratch.path), true);
  } finally {
    stopping.abort();
  }
  await running;
  assert.equal(leaderRunning(scratch.path), false);
});
