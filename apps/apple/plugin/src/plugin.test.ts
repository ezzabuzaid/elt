import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
} from '@openai/mcp-extensions/server';

import BooksApp from '@workspace/apple/apps/books/books-app';
import CalendarApp from '@workspace/apple/apps/calendar/calendar-app';
import ContactsApp from '@workspace/apple/apps/contacts/contacts-app';
import MailApp from '@workspace/apple/apps/mail/mail-app';
import MessagesApp from '@workspace/apple/apps/messages/messages-app';
import NotesApp from '@workspace/apple/apps/notes/notes-app';
import RemindersApp from '@workspace/apple/apps/reminders/reminders-app';
import SafariApp from '@workspace/apple/apps/safari/safari-app';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import {
  type Selection,
  importDirectory,
  leaseHeld,
} from '@workspace/import-store';

import { ApplePlugin } from './apple-plugin.ts';
import { chatStatus } from './chat-status.ts';
import { keepFresh } from './freshness.ts';
import { settingsRead, settingsUpdate } from './native-settings.ts';

// The committed plugin, as Codex installs it.
const install = resolve('plugins/apple');

// The apps the plugin's server creates.
const host = { grantee: 'ChatGPT' };
const apps = [
  new MailApp(host),
  new NotesApp(host),
  new MessagesApp(host),
  new ContactsApp(host),
  new CalendarApp(host),
  new RemindersApp(host),
  new SafariApp(host),
  new BooksApp(host),
];

// Stands in for the leading server's import of one app selection.
function imported(directory: string, item: Selection) {
  const path = importDirectory(directory, item);
  mkdirSync(path, { recursive: true });
  using database = new DatabaseSync(join(path, 'data.sqlite'));
  database.exec("CREATE TABLE notes(id TEXT); INSERT INTO notes VALUES('n1');");
  return join(path, 'data.sqlite');
}

// Begins passes of one app selection's import, recorded in its data.sqlite as
// the leading server's history records them.
async function passes(plugin: ApplePlugin, item: Selection) {
  const { connection, destination } = await plugin
    .app(item.app)
    .connection(importDirectory(plugin.directory, item), item);
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return () => history.begin(connection, []);
}

test('Apple setup rejects invalid choices and fills the Calendar default range', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
  assert.deepEqual(plugin.status().apps, []);
  for (const [selection, message] of [
    [
      [
        {
          app: 'contacts',
          scope: { startAt: '2025-01-01T00:00:00.000Z' },
          includeAttachments: true,
        },
      ],
      /date filtering/,
    ],
    [
      [
        {
          app: 'messages',
          scope: { accountIds: ['a'] },
          includeAttachments: true,
        },
      ],
      /account IDs/,
    ],
    [
      [
        {
          app: 'notes',
          scope: { collectionIds: [] },
          includeAttachments: true,
        },
      ],
      /at least one collection/,
    ],
    [
      [
        { app: 'notes', scope: {}, includeAttachments: true },
        { app: 'notes', scope: {}, includeAttachments: true },
      ],
      /once/,
    ],
  ] as const)
    assert.throws(() => plugin.configure({ apps: selection }), message);
  assert.deepEqual(plugin.status().apps, []);
  const [calendar] = plugin.configure({
    apps: [{ app: 'calendar', scope: {}, includeAttachments: true }],
  }).apps;
  assert.ok(calendar?.scope.startAt);
  assert.ok(calendar.scope.endAt);
  assert.ok(calendar.scope.startAt < calendar.scope.endAt);
});

test('agents read the selected apps, where each import lives and what macOS access it needs from the settings file with the sqlite3 shell', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
  const notes = {
    app: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: false,
  };
  plugin.configure({
    apps: [notes, { app: 'mail', scope: {}, includeAttachments: true }],
  });
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
      permissions: plugin.app('notes').guidance(),
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
      permissions: plugin.app('mail').guidance(),
    },
  ]);
});

test('Apple setup keeps an unchanged import, removes a changed or disconnected one, and reports a pass no server finishes as interrupted', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
  const notes = {
    app: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: true,
  };
  assert.equal(plugin.configure({ apps: [notes] }).apps[0]?.database, null);
  const database = imported(scratch.path, notes);
  assert.equal(
    new ApplePlugin(apps, install, scratch.path).status().apps[0]?.database,
    database,
  );
  plugin.configure({ apps: [notes] });
  assert.equal(existsSync(database), true);

  // A pass left running by a server that exited is reported as interrupted.
  const begin = await passes(plugin, notes);
  await begin();
  assert.equal(plugin.status().apps[0]?.sync?.state, 'interrupted');
  {
    using lease = new DatabaseSync(join(scratch.path, 'lease.sqlite'));
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
  const running = keepFresh(
    new ApplePlugin(apps, install, scratch.path),
    stopping.signal,
  );
  try {
    await sleep(1_500);
    assert.equal(leaseHeld(scratch.path), true);
  } finally {
    stopping.abort();
  }
  await running;
  assert.equal(leaseHeld(scratch.path), false);
});

test('a chat hears of a pass only when it changes what a reader can do with the app', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
  const notes = {
    app: 'notes' as const,
    scope: {},
    includeAttachments: true,
  };
  plugin.configure({ apps: [notes] });
  // The leading server holds the lease while its passes run.
  using lease = new DatabaseSync(join(scratch.path, 'lease.sqlite'));
  lease.exec('BEGIN IMMEDIATE');
  const waiting = chatStatus(plugin);
  assert.match(
    waiting.text,
    /^- Notes: waiting for its first import\. No database yet\.$/m,
  );
  const begin = await passes(plugin, notes);
  await begin();
  const importing = chatStatus(plugin);
  assert.match(
    importing.text,
    /^- Notes: importing since .*; no data yet\. Database: notes\//m,
  );
  assert.notEqual(importing.state, waiting.state);
  await (await begin()).finish([]);
  const synced = chatStatus(plugin);
  assert.match(synced.text, /^- Notes: synced at /m);
  assert.notEqual(synced.state, importing.state);

  // Passes over data already imported change its times, not the state.
  const again = await begin();
  assert.equal(chatStatus(plugin).state, synced.state);
  await again.finish([]);
  assert.equal(chatStatus(plugin).state, synced.state);

  await (await begin()).fail(new Error('Notes could not be opened.'));
  const failed = chatStatus(plugin);
  assert.match(
    failed.text,
    /^- Notes: last sync failed at .*: Notes could not be opened\. .*; data as of /m,
  );
  assert.notEqual(failed.state, synced.state);
});

test('the Settings page switches apps on and off and describes each import as OpenAI’s settings schema requires', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
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
  const begin = await passes(plugin, notes);
  await (await begin()).finish([]);
  assert.equal(described().notes, 'Synced just now · 1 folder.');
  // The page adds the app's permissions guidance to the error once.
  await (await begin()).fail(new Error('Notes could not be opened.'));
  assert.equal(
    described().notes,
    `Last sync failed: Notes could not be opened. ${plugin.app('notes').guidance()}`,
  );
  await begin();
  assert.equal(
    described().notes,
    'Paused: resumes the next time Codex runs the Apple plugin.',
  );
  {
    using lease = new DatabaseSync(join(scratch.path, 'lease.sqlite'));
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
      books: false,
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

test('once another plugin version replaces this one, its server refuses to change apps and never leads', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // Installing another version deletes this version's folder.
  const replaced = join(scratch.path, 'install');
  cpSync(join(install, '.codex-plugin'), join(replaced, '.codex-plugin'), {
    recursive: true,
  });
  const store = join(scratch.path, 'store');
  const plugin = new ApplePlugin(apps, replaced, store);
  plugin.configure({
    apps: [{ app: 'notes', scope: {}, includeAttachments: true }],
  });
  assert.equal(plugin.updated(), false);
  rmSync(replaced, { recursive: true });
  assert.equal(plugin.updated(), true);
  assert.throws(
    () =>
      plugin.configure({
        apps: [{ app: 'mail', scope: {}, includeAttachments: true }],
      }),
    /open a new chat/,
  );
  assert.throws(
    () => settingsUpdate(plugin, { mail: true }),
    /open a new chat/,
  );
  const stopping = new AbortController();
  const running = keepFresh(plugin, stopping.signal);
  try {
    await sleep(1_500);
    assert.equal(leaseHeld(store), false);
  } finally {
    stopping.abort();
  }
  await running;
});

test('a server whose code predates the settings file refuses to change apps and never leads', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = new ApplePlugin(apps, install, scratch.path);
  plugin.configure({
    apps: [{ app: 'notes', scope: {}, includeAttachments: true }],
  });
  // A newer plugin rewrote the settings file in a layout this code predates.
  {
    using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'));
    const layout = Number(
      database.prepare('PRAGMA user_version').get()?.user_version,
    );
    database.exec(`PRAGMA user_version = ${layout + 1}`);
  }
  assert.throws(
    () =>
      plugin.configure({
        apps: [{ app: 'mail', scope: {}, includeAttachments: true }],
      }),
    /open a new chat/,
  );
  const stopping = new AbortController();
  const running = keepFresh(plugin, stopping.signal);
  try {
    await sleep(1_500);
    assert.equal(leaseHeld(scratch.path), false);
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
  const plugin = new ApplePlugin(apps, install, scratch.path);
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
  assert.equal(
    plugin.configure({
      apps: [{ app: 'notes', scope: {}, includeAttachments: true }],
    }).apps.length,
    1,
  );
});
