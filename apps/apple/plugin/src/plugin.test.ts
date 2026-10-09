import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
} from '@openai/mcp-extensions/server';

import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { Connectors } from '@workspace/connector-apple-manifest/connectors';
import { SQLitePasses, SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { type Selection, importDirectory } from '@workspace/settings';

import { ApplePlugin } from './apple-plugin.ts';
import { chatStatus } from './chat-status.ts';
import { importPending } from './importing.ts';
import { settingsRead, settingsUpdate } from './native-settings.ts';

// The committed plugin, as Codex installs it.
const install = resolve('plugins/apple');

// The host the plugin's server passes its connectors, with the helper this
// workspace compiled instead of the bundled copy.
const host = {
  grantee: 'ChatGPT',
  eventKitHelper: fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/sdk-apple-eventkit'),
    ),
  ),
};

// The plugin as its server creates it, over the built-in connectors.
async function applePlugin(install: string, directory: string) {
  const plugin = new ApplePlugin(
    new Connectors([builtInConnectors]),
    host,
    install,
    directory,
  );
  await plugin.refresh();
  return plugin;
}

// Stands in for a server's import of one connector selection.
function imported(directory: string, item: Selection) {
  const path = importDirectory(directory, item);
  mkdirSync(path, { recursive: true });
  using database = new DatabaseSync(join(path, 'data.sqlite'));
  database.exec("CREATE TABLE notes(id TEXT); INSERT INTO notes VALUES('n1');");
  return join(path, 'data.sqlite');
}

// Begins passes of one connector selection's import, recorded in its
// data.sqlite as a server's history records them.
async function passes(plugin: ApplePlugin, item: Selection) {
  const { connection, destination } = await plugin
    .connector(item.connector)
    .connection(importDirectory(plugin.directory, item), item);
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return () => history.begin(connection, []);
}

test('Apple setup rejects invalid choices and fills the Calendar default range', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  assert.deepEqual((await plugin.status()).connectors, []);
  for (const [selection, message] of [
    [
      [
        {
          connector: 'contacts',
          scope: { startAt: '2025-01-01T00:00:00.000Z' },
          includeAttachments: true,
        },
      ],
      /date filtering/,
    ],
    [
      [
        {
          connector: 'messages',
          scope: { accountIds: ['a'] },
          includeAttachments: true,
        },
      ],
      /account IDs/,
    ],
    [
      [
        {
          connector: 'notes',
          scope: { collectionIds: [] },
          includeAttachments: true,
        },
      ],
      /at least one collection/,
    ],
    [
      [
        { connector: 'notes', scope: {}, includeAttachments: true },
        { connector: 'notes', scope: {}, includeAttachments: true },
      ],
      /once/,
    ],
  ] as const)
    await assert.rejects(
      () => plugin.configure({ connectors: selection }),
      message,
    );
  assert.deepEqual((await plugin.status()).connectors, []);
  const [calendar] = (
    await plugin.configure({
      connectors: [
        { connector: 'calendar', scope: {}, includeAttachments: true },
      ],
    })
  ).connectors;
  assert.ok(calendar?.scope.startAt);
  assert.ok(calendar.scope.endAt);
  assert.ok(calendar.scope.startAt < calendar.scope.endAt);
});

test('agents read the selected connectors, where each import lives and what macOS access it needs from the settings file with the sqlite3 shell', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const notes = {
    connector: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: false,
  };
  await plugin.configure({
    connectors: [
      notes,
      { connector: 'mail', scope: {}, includeAttachments: true },
    ],
  });
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      join(scratch.path, 'settings.sqlite'),
      'SELECT connector, scope, include_attachments, database, connection_error, permissions FROM selected_connectors',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), [
    {
      connector: 'notes',
      scope: JSON.stringify(notes.scope),
      include_attachments: 0,
      database: join(importDirectory(scratch.path, notes), 'data.sqlite'),
      connection_error: null,
      permissions: plugin.connector('notes').guidance(),
    },
    {
      connector: 'mail',
      scope: '{}',
      include_attachments: 1,
      database: join(
        importDirectory(scratch.path, {
          connector: 'mail',
          scope: {},
          includeAttachments: true,
        }),
        'data.sqlite',
      ),
      connection_error: null,
      permissions: plugin.connector('mail').guidance(),
    },
  ]);
});

test('Apple setup keeps an unchanged import, removes a changed or disconnected one, and reports a pass no server finishes as interrupted', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const notes = {
    connector: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: true,
  };
  assert.equal(
    (await plugin.configure({ connectors: [notes] })).connectors[0]?.database,
    null,
  );
  const database = imported(scratch.path, notes);
  assert.equal(
    (await (await applePlugin(install, scratch.path)).status()).connectors[0]
      ?.database,
    database,
  );
  await plugin.configure({ connectors: [notes] });
  assert.equal(existsSync(database), true);

  // A pass left running by a server that exited is reported as interrupted.
  const begin = await passes(plugin, notes);
  await begin();
  assert.equal(
    (await plugin.status()).connectors[0]?.sync?.state,
    'interrupted',
  );
  // A server importing it runs the import's pass.
  await new SQLitePasses(database).run(async () =>
    assert.equal((await plugin.status()).connectors[0]?.sync?.state, 'running'),
  );

  const changed = { ...notes, scope: { collectionIds: ['folder-2'] } };
  await plugin.configure({ connectors: [changed] });
  assert.equal(existsSync(database), false);
  const [current] = (await plugin.status()).connectors;
  assert.equal(current?.database, null);
  assert.equal(current?.sync, null);
  imported(scratch.path, changed);
  await plugin.configure({ connectors: [] });
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('importing settles when the settings cannot be read, so the server keeps serving its tools', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A directory where the settings file belongs fails every read of them.
  mkdirSync(join(scratch.path, 'settings.sqlite'));
  const plugin = await applePlugin(install, scratch.path);

  await assert.doesNotReject(importPending(plugin));
});

test('a chat hears of a pass only when it changes what a reader can do with the connector', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const notes = {
    connector: 'notes' as const,
    scope: {},
    includeAttachments: true,
  };
  await plugin.configure({ connectors: [notes] });
  // The importing server runs the import's pass while it records passes.
  await new SQLitePasses(
    join(importDirectory(scratch.path, notes), 'data.sqlite'),
  ).run(async () => {
    const waiting = await chatStatus(plugin);
    assert.match(
      waiting.text,
      /^- Notes: waiting for its first import\. No database yet\.$/m,
    );
    const begin = await passes(plugin, notes);
    await begin();
    const importing = await chatStatus(plugin);
    assert.match(
      importing.text,
      /^- Notes: importing since .*; no data yet\. Database: notes\//m,
    );
    assert.notEqual(importing.state, waiting.state);
    await (await begin()).finish([]);
    const synced = await chatStatus(plugin);
    assert.match(synced.text, /^- Notes: synced at /m);
    assert.notEqual(synced.state, importing.state);

    // Passes over data already imported change its times, not the state.
    const again = await begin();
    assert.equal((await chatStatus(plugin)).state, synced.state);
    await again.finish([]);
    assert.equal((await chatStatus(plugin)).state, synced.state);

    await (await begin()).fail(new Error('Notes could not be opened.'));
    const failed = await chatStatus(plugin);
    assert.match(
      failed.text,
      /^- Notes: last sync failed at .*: Notes could not be opened\. .*; data as of /m,
    );
    assert.notEqual(failed.state, synced.state);
  });
});

test('a selected connector that is no longer loaded is reported, keeps its import through other changes, and can be disconnected', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const withPhotos = new ApplePlugin(
    new Connectors([
      builtInConnectors,
      resolve('packages/connectors/apple/manifest/dist/fixtures'),
    ]),
    host,
    install,
    scratch.path,
  );
  await withPhotos.refresh();
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  await withPhotos.configure({ connectors: [photos] });
  const plugin = await applePlugin(install, scratch.path);

  const [reported] = (await plugin.status()).connectors;
  const context = (await chatStatus(plugin)).text;
  const kept = await plugin.configure({
    connectors: [
      photos,
      { connector: 'notes', scope: {}, includeAttachments: true },
    ],
  });
  const changed = () =>
    plugin.configure({
      connectors: [{ ...photos, includeAttachments: false }],
    });
  const switches = (await settingsRead(plugin)).values;
  const { values } = await settingsUpdate(plugin, { photos: false });

  assert.equal(reported?.title, 'photos');
  assert.match(
    String(reported?.permissions),
    /No connector named photos is loaded/,
  );
  assert.match(context, /^- photos: No connector named photos is loaded/m);
  assert.deepEqual(
    kept.connectors.map(({ connector }) => connector),
    ['photos', 'notes'],
  );
  await assert.rejects(
    changed,
    /No connector named photos is loaded, so its selection cannot change/,
  );
  assert.equal(switches.photos, true);
  assert.equal(values.photos, undefined);
  assert.deepEqual(
    (await plugin.status()).connectors.map(({ connector }) => connector),
    ['notes'],
  );
});

test('the Settings page switches connectors on and off and describes each import as OpenAI’s settings schema requires', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const described = async () => {
    const result = await settingsRead(plugin);
    OpenAISettingsReadResultSchema.parse(result);
    return Object.fromEntries(
      Object.entries(result.schema.properties).map(([name, field]) => [
        name,
        field.description,
      ]),
    );
  };
  assert.equal((await described()).notes, 'Not connected.');

  const notes = {
    connector: 'notes' as const,
    scope: { collectionIds: ['FOLDER-NOTES'] },
    includeAttachments: true,
  };
  await plugin.configure({ connectors: [notes] });
  assert.equal((await described()).notes, 'Waiting to import.');
  const begin = await passes(plugin, notes);
  await (await begin()).finish([]);
  assert.equal((await described()).notes, 'Synced just now · 1 folder.');
  // The page adds the connector's permissions guidance to the error once.
  await (await begin()).fail(new Error('Notes could not be opened.'));
  assert.equal(
    (await described()).notes,
    `Last sync failed: Notes could not be opened. ${plugin.connector('notes').guidance()}`,
  );
  await begin();
  assert.equal(
    (await described()).notes,
    'Paused: resumes the next time Codex runs the Apple plugin.',
  );
  await new SQLitePasses(
    join(importDirectory(scratch.path, notes), 'data.sqlite'),
  ).run(async () =>
    assert.match((await described()).notes ?? '', /^Importing since /),
  );

  // Switching Mail on keeps Notes as it was chosen; switching Notes off
  // disconnects it and removes its import.
  imported(scratch.path, notes);
  assert.deepEqual(
    OpenAISettingsUpdateResultSchema.parse(
      await settingsUpdate(plugin, { mail: true }),
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
      activity: false,
      accounts: false,
      'call-history': false,
      'notification-center': false,
      slack: false,
    },
  );
  const [kept, mail] = (await plugin.status()).connectors;
  assert.deepEqual(kept?.scope, notes.scope);
  assert.deepEqual(mail?.scope, {});
  assert.equal(mail?.includeAttachments, true);
  assert.equal((await described()).mail, 'Waiting to import.');
  await settingsUpdate(plugin, { notes: false });
  assert.deepEqual(
    (await plugin.status()).connectors.map(({ connector }) => connector),
    ['mail'],
  );
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('once another plugin version replaces this one, its server refuses to change connectors and imports nothing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // Installing another version deletes this version's folder.
  const replaced = join(scratch.path, 'install');
  cpSync(join(install, '.codex-plugin'), join(replaced, '.codex-plugin'), {
    recursive: true,
  });
  const store = join(scratch.path, 'store');
  const plugin = await applePlugin(replaced, store);
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  await plugin.configure({ connectors: [notes] });
  // An import the newer version's selection no longer names.
  const unselected = imported(store, { ...notes, includeAttachments: false });
  assert.equal(plugin.updated(), false);
  rmSync(replaced, { recursive: true });
  assert.equal(plugin.updated(), true);
  await assert.rejects(
    () =>
      plugin.configure({
        connectors: [
          { connector: 'mail', scope: {}, includeAttachments: true },
        ],
      }),
    /open a new chat/,
  );
  await assert.rejects(
    () => settingsUpdate(plugin, { mail: true }),
    /open a new chat/,
  );

  await importPending(plugin);

  // Old code neither removes imports nor starts one.
  assert.equal(existsSync(unselected), true);
  assert.equal(existsSync(importDirectory(store, notes)), false);
});

test('a server whose code predates the settings file refuses to change connectors and imports nothing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  await plugin.configure({ connectors: [notes] });
  const unselected = imported(scratch.path, {
    ...notes,
    includeAttachments: false,
  });
  // A newer plugin rewrote the settings file in a layout this code predates.
  {
    using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'));
    const layout = Number(
      database.prepare('PRAGMA user_version').get()?.user_version,
    );
    database.exec(`PRAGMA user_version = ${layout + 1}`);
  }
  await assert.rejects(
    () =>
      plugin.configure({
        connectors: [
          { connector: 'mail', scope: {}, includeAttachments: true },
        ],
      }),
    /open a new chat/,
  );

  await importPending(plugin);

  assert.equal(existsSync(unselected), true);
  assert.equal(existsSync(importDirectory(scratch.path, notes)), false);
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
  const plugin = await applePlugin(install, scratch.path);
  assert.deepEqual((await plugin.status()).connectors, []);
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
    (
      await plugin.configure({
        connectors: [
          { connector: 'notes', scope: {}, includeAttachments: true },
        ],
      })
    ).connectors.length,
    1,
  );
});
