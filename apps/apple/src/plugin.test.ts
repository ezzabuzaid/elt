import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
} from '@openai/mcp-extensions/server';
import { Connection } from 'elt';
import { SQLiteDestination, SQLiteSyncHistory } from 'elt-sqlite';
import { ApplePlugin } from './plugin/apple-plugin.ts';
import { apps } from './plugin/apps.ts';
import { keepFresh, leaderRunning } from './plugin/freshness.ts';
import { settingsRead, settingsUpdate } from './plugin/native-settings.ts';
import { importDirectory } from './plugin/settings.ts';

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

// Begins passes of one app selection's import, recorded in its data.sqlite as
// the leading server's history records them.
async function passes(
  directory: string,
  item: Parameters<typeof importDirectory>[1],
) {
  const path = importDirectory(directory, item);
  mkdirSync(path, { recursive: true });
  const destination = new SQLiteDestination({
    path: join(path, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const connection = new Connection({
    name: item.app,
    source: apps[item.app].source(item.scope),
    destination,
    steps: [],
  });
  return () => history.begin(connection, []);
}

test('Apple setup rejects invalid choices and fills the Calendar default range', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  assert.deepEqual(plugin.status().apps, []);
  for (const [apps, message] of [
    [
      [{ app: 'contacts', scope: { startAt: '2025-01-01T00:00:00.000Z' } }],
      /date filtering/,
    ],
    [[{ app: 'messages', scope: { accountIds: ['a'] } }], /account IDs/],
    [[{ app: 'notes', scope: { collectionIds: [] } }], /too small/i],
    [[{ app: 'notes' }, { app: 'notes' }], /once/],
    [[{ app: 'photos' }], /app/],
  ] as const)
    assert.throws(() => plugin.configure({ apps }), message);
  assert.deepEqual(plugin.status().apps, []);
  const [calendar] = plugin.configure({ apps: [{ app: 'calendar' }] }).apps;
  assert.ok(calendar?.scope.startAt);
  assert.ok(calendar.scope.endAt);
  assert.ok(calendar.scope.startAt < calendar.scope.endAt);
});

test('agents read the selected apps, where each import lives and what macOS access it needs from the settings file with the sqlite3 shell', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  const notes = {
    app: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: false,
  };
  plugin.configure({ apps: [notes, { app: 'mail' }] });
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      join(scratch.path, 'settings.sqlite'),
      'SELECT app, scope, include_attachments, database, connection_error, permissions FROM selected_apps',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), [
    {
      app: 'notes',
      scope: JSON.stringify(notes.scope),
      include_attachments: 0,
      database: join(importDirectory(scratch.path, notes), 'data.sqlite'),
      connection_error: null,
      permissions: apps.notes.permissions,
    },
    {
      app: 'mail',
      scope: '{}',
      include_attachments: 1,
      database: join(
        importDirectory(scratch.path, {
          app: 'mail',
          scope: {},
          includeAttachments: true,
        }),
        'data.sqlite',
      ),
      connection_error: null,
      permissions: apps.mail.permissions,
    },
  ]);
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

  // A pass left running by a server that exited is reported as interrupted.
  const begin = await passes(scratch.path, notes);
  await begin();
  assert.equal(plugin.status().apps[0]?.sync?.state, 'interrupted');
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
});

test('the leading server keeps leading when its settings cannot be read, and lets go once stopped', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A directory where the settings file belongs fails every read of them.
  mkdirSync(join(scratch.path, 'settings.sqlite'));
  const stopping = new AbortController();
  const running = keepFresh(scratch.path, stopping.signal, '0.4.1');
  try {
    await sleep(1_500);
    assert.equal(leaderRunning(scratch.path), true);
  } finally {
    stopping.abort();
  }
  await running;
  assert.equal(leaderRunning(scratch.path), false);
});

test('the Settings page switches apps on and off and describes each import as OpenAI’s settings schema requires', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  const described = () => {
    const result = settingsRead(plugin);
    OpenAISettingsReadResultSchema.parse(result);
    return Object.fromEntries(
      Object.entries(result.schema.properties).map(([app, field]) => [
        app,
        field.description,
      ]),
    );
  };
  assert.equal(described().notes, 'Not connected.');

  const notes = {
    app: 'notes' as const,
    scope: { collectionIds: ['FOLDER-NOTES'] },
    includeAttachments: true,
  };
  plugin.configure({ apps: [notes] });
  assert.equal(described().notes, 'Waiting to import.');
  const begin = await passes(scratch.path, notes);
  await (await begin()).finish([]);
  assert.equal(described().notes, 'Synced just now · 1 folder.');
  // The page adds the app's permissions guidance to the error once.
  await (await begin()).fail(new Error('Notes could not be opened.'));
  assert.equal(
    described().notes,
    `Last sync failed: Notes could not be opened. ${apps.notes.permissions}`,
  );
  await begin();
  assert.equal(
    described().notes,
    'Paused: resumes the next time Codex runs the Apple plugin.',
  );
  {
    using lease = new DatabaseSync(join(scratch.path, 'watch.sqlite'));
    lease.exec('BEGIN IMMEDIATE');
    assert.match(described().notes ?? '', /^Importing since /);
  }

  // Switching Mail on keeps Notes as it was chosen; switching Notes off
  // disconnects it and removes its import.
  imported(scratch.path, notes);
  assert.deepEqual(
    OpenAISettingsUpdateResultSchema.parse(
      settingsUpdate(plugin, { mail: true }),
    ).values,
    {
      mail: true,
      notes: true,
      messages: false,
      contacts: false,
      calendar: false,
      reminders: false,
      safari: false,
    },
  );
  const [kept, mail] = plugin.status().apps;
  assert.deepEqual(kept?.scope, notes.scope);
  assert.deepEqual(mail?.scope, {});
  assert.equal(mail?.includeAttachments, true);
  assert.equal(described().mail, 'Waiting to import.');
  settingsUpdate(plugin, { notes: false });
  assert.deepEqual(
    plugin.status().apps.map(({ app }) => app),
    ['mail'],
  );
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('a server whose code predates the settings file refuses to change apps and never leads', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(scratch.path);
  plugin.configure({ apps: [{ app: 'notes' }] });
  // A newer plugin rewrote the settings file in a layout this code predates.
  {
    using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'));
    const layout = Number(
      database.prepare('PRAGMA user_version').get()?.user_version,
    );
    database.exec(`PRAGMA user_version = ${layout + 1}`);
  }
  assert.throws(
    () => plugin.configure({ apps: [{ app: 'mail' }] }),
    /Start a new chat/,
  );
  assert.throws(
    () => settingsUpdate(plugin, { mail: true }),
    /Start a new chat/,
  );
  const stopping = new AbortController();
  const running = keepFresh(scratch.path, stopping.signal, '99.0.0');
  try {
    await sleep(1_500);
    assert.equal(leaderRunning(scratch.path), false);
  } finally {
    stopping.abort();
  }
  await running;
});

test('settings an older layout wrote are discarded, so the user sets up again', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // Plugin 0.5.0 kept the selection as one JSON value and no layout stamp.
  {
    using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'));
    database.exec(
      `CREATE TABLE configuration (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); INSERT INTO configuration VALUES(1, '{"apps":[{"app":"notes","scope":{},"includeAttachments":true}]}');`,
    );
  }
  const plugin = new ApplePlugin(scratch.path);
  assert.deepEqual(plugin.status().apps, []);
  using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'), {
    readOnly: true,
  });
  assert.equal(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'configuration'")
      .get(),
    undefined,
  );
  assert.equal(plugin.configure({ apps: [{ app: 'notes' }] }).apps.length, 1);
});

test('a newer plugin server takes the lead from an older one, and the older one leads again once the newer one stops', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const older = new AbortController();
  const olderRunning = keepFresh(scratch.path, older.signal, '0.4.1');
  const newer = new AbortController();
  let newerRunning: Promise<void> | undefined;
  const again = new AbortController();
  let againRunning: Promise<void> | undefined;
  try {
    await sleep(500);
    assert.equal(leaderRunning(scratch.path), true);
    newerRunning = keepFresh(scratch.path, newer.signal, '0.10.0');
    // The older leader steps down on its next check; the newer one takes
    // the lease on its next attempt.
    await sleep(4_000);
    older.abort();
    await olderRunning;
    // Had the older server still led, its exit would have left the lease free.
    assert.equal(leaderRunning(scratch.path), true);

    // An older version installed again leads once the newer server stops.
    againRunning = keepFresh(scratch.path, again.signal, '0.4.1');
    await sleep(2_500);
    newer.abort();
    await newerRunning;
    await sleep(2_500);
    assert.equal(leaderRunning(scratch.path), true);
  } finally {
    older.abort();
    newer.abort();
    again.abort();
    await Promise.all([olderRunning, newerRunning, againRunning]);
  }
  assert.equal(leaderRunning(scratch.path), false);
});
