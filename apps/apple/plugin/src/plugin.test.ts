import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { chmod, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { Connectors } from '@workspace/connector-apple-manifest/connectors';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { type Selection, importDirectory } from '@workspace/settings';

import { ApplePlugin } from './apple-plugin.ts';
import { chatStatus } from './chat-status.ts';
import { connectorRows, updateConnector } from './connector-page.ts';

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

// The plugin over the built-in connectors and the fixture Photos connector,
// whose pass reads $HOME/Pictures/photos.json.
async function photosPlugin(directory: string) {
  const plugin = new ApplePlugin(
    new Connectors([
      builtInConnectors,
      resolve('packages/connectors/apple/manifest/dist/fixtures'),
    ]),
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
// data.sqlite as a server's history records them: each pass declares every
// copy of the connection, and one that finishes loads them all.
async function passes(plugin: ApplePlugin, item: Selection) {
  const { connection, destination } = await plugin
    .connector(item.connector)
    .connection(importDirectory(plugin.directory, item), item);
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const copies = connection.steps.map((copy) => ({
    copy,
    coverage: connection.source.coverage(copy.from),
  }));
  return async () => {
    const pass = await history.begin(connection, copies);
    return {
      finish: () =>
        pass.finish(
          copies.map(({ copy }) => ({
            copy,
            count: 0,
            deleted: 0,
            failures: [],
            cancelled: false,
          })),
        ),
      fail: pass.fail,
    };
  };
}

test('Apple setup rejects invalid choices and fills the Calendar default range', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  assert.deepEqual(plugin.status().connectors, []);
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
  assert.deepEqual(plugin.status().connectors, []);
  const [calendar] = await plugin.configure({
    connectors: [
      { connector: 'calendar', scope: {}, includeAttachments: true },
    ],
  });
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

test('Apple setup imports only what a change adds or changes, keeps an unchanged import and removes a changed or disconnected one', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const notes = {
    connector: 'notes' as const,
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: true,
  };
  assert.deepEqual(await plugin.configure({ connectors: [notes] }), [notes]);
  assert.equal(plugin.status().connectors[0]?.database, null);
  const database = imported(scratch.path, notes);
  assert.equal(
    (await applePlugin(install, scratch.path)).status().connectors[0]?.database,
    database,
  );
  const books = { connector: 'books', scope: {}, includeAttachments: true };
  assert.deepEqual(await plugin.configure({ connectors: [notes, books] }), [
    books,
  ]);
  assert.equal(existsSync(database), true);

  const changed = { ...notes, scope: { collectionIds: ['folder-2'] } };
  assert.deepEqual(await plugin.configure({ connectors: [changed] }), [
    changed,
  ]);
  assert.equal(existsSync(database), false);
  const [current] = plugin.status().connectors;
  assert.equal(current?.database, null);
  assert.equal(current?.sync, null);
  imported(scratch.path, changed);
  assert.deepEqual(await plugin.configure({ connectors: [] }), []);
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('importing settles when the settings cannot be read, so the server keeps serving its tools', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A directory where the settings file belongs fails every read of them.
  mkdirSync(join(scratch.path, 'settings.sqlite'));
  const plugin = await applePlugin(install, scratch.path);

  await assert.doesNotReject(
    plugin.import([
      { connector: 'notes', scope: {}, includeAttachments: true },
    ]),
  );
});

test('an import that fails before its pass begins shows the failure on the page and in chat, not that it waits to import', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await photosPlugin(join(scratch.path, 'store'));
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  const imports = await plugin.configure({ connectors: [photos] });
  // A database the import cannot write stands in for one a reader keeps
  // busy past the timeout, or a full disk: the import's sync history cannot
  // install itself, so no pass begins to record why.
  const directory = importDirectory(plugin.directory, photos);
  mkdirSync(directory, { recursive: true });
  await writeFile(join(directory, 'data.sqlite'), '');
  await chmod(join(directory, 'data.sqlite'), 0o444);

  await plugin.import(imports);

  const row = connectorRows(plugin).find(({ name }) => name === 'photos');
  assert.equal(row?.status.state, 'failed');
  assert.equal(
    row?.status.text,
    'Last sync failed: attempt to write a readonly database',
  );
  assert.match(
    chatStatus(plugin).text,
    /^- Photos: last sync failed at .*: attempt to write a readonly database/m,
  );
});

test('an import that synced before and now fails before its pass begins shows the failure, not its last sync', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const home = join(scratch.path, 'home');
  mkdirSync(join(home, 'Pictures'), { recursive: true });
  await writeFile(
    join(home, 'Pictures/photos.json'),
    JSON.stringify([{ id: 'p1', title: 'Beach' }]),
  );
  const plugin = await photosPlugin(join(scratch.path, 'store'));
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  const imports = await plugin.configure({ connectors: [photos] });
  const statusOf = () =>
    connectorRows(plugin).find(({ name }) => name === 'photos')?.status;
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await plugin.import(imports);
    const synced = statusOf();
    // The import can no longer write its database, as when a reader keeps it
    // busy past the timeout or the disk is full.
    await chmod(
      join(importDirectory(plugin.directory, photos), 'data.sqlite'),
      0o444,
    );

    await plugin.import(imports);

    assert.equal(synced?.state, 'succeeded');
    assert.equal(statusOf()?.state, 'failed');
    assert.equal(
      statusOf()?.text,
      'Last sync failed: attempt to write a readonly database',
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test('once an import that failed before its pass can write again, its next pass syncs and the failure is gone', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const home = join(scratch.path, 'home');
  mkdirSync(join(home, 'Pictures'), { recursive: true });
  await writeFile(
    join(home, 'Pictures/photos.json'),
    JSON.stringify([{ id: 'p1', title: 'Beach' }]),
  );
  const plugin = await photosPlugin(join(scratch.path, 'store'));
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  const imports = await plugin.configure({ connectors: [photos] });
  const directory = importDirectory(plugin.directory, photos);
  const database = join(directory, 'data.sqlite');
  mkdirSync(directory, { recursive: true });
  await writeFile(database, '');
  await chmod(database, 0o444);
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await plugin.import(imports);
    const failed = connectorRows(plugin).find(
      ({ name }) => name === 'photos',
    )?.status;
    await chmod(database, 0o644);

    await plugin.import(imports);

    const row = connectorRows(plugin).find(({ name }) => name === 'photos');
    assert.equal(failed?.state, 'failed');
    assert.equal(row?.status.state, 'succeeded');
    assert.match(String(row?.status.text), /^Synced just now/);
    assert.doesNotMatch(chatStatus(plugin).text, /last sync failed/);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test('two servers importing one selection at once load it in one pass, the second waiting for the first', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A pipe the test writes once the pass runs: the Photos read waits on it,
  // so the second import asks while the first one's pass still runs.
  const home = join(scratch.path, 'home');
  mkdirSync(join(home, 'Pictures'), { recursive: true });
  spawnSync('/usr/bin/mkfifo', [join(home, 'Pictures/photos.json')]);
  const plugin = await photosPlugin(join(scratch.path, 'store'));
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  const imports = await plugin.configure({ connectors: [photos] });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const both = Promise.all([plugin.import(imports), plugin.import(imports)]);
    const deadline = Date.now() + 30_000;
    while (plugin.status().connectors[0]?.sync?.state !== 'running') {
      if (Date.now() > deadline) assert.fail('no import started its pass');
      await sleep(50);
    }

    await writeFile(
      join(home, 'Pictures/photos.json'),
      JSON.stringify([{ id: 'p1', title: 'Beach' }]),
    );
    const settled = await Promise.race([both, sleep(30_000).then(() => null)]);

    if (settled === null) assert.fail('an import never settled');
    using data = new DatabaseSync(
      join(importDirectory(plugin.directory, photos), 'data.sqlite'),
      { readOnly: true },
    );
    assert.deepEqual(
      data
        .prepare('SELECT status FROM sync_attempts')
        .all()
        .map((row) => ({ ...row })),
      [{ status: 'succeeded' }],
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test('a connector switched off while its pass runs loses its import once the pass ends', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  // A pipe the test writes once the connector is switched off: the Photos
  // read waits on it, so the pass is still running when the switch happens.
  const home = join(scratch.path, 'home');
  mkdirSync(join(home, 'Pictures'), { recursive: true });
  spawnSync('/usr/bin/mkfifo', [join(home, 'Pictures/photos.json')]);
  const plugin = await photosPlugin(join(scratch.path, 'store'));
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  const imports = await plugin.configure({ connectors: [photos] });
  const directory = importDirectory(plugin.directory, photos);
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const importing = plugin.import(imports);
    const deadline = Date.now() + 30_000;
    while (plugin.status().connectors[0]?.sync?.state !== 'running') {
      if (Date.now() > deadline) assert.fail('no import started its pass');
      await sleep(50);
    }

    await plugin.configure({ connectors: [] });
    const keptWhileRunning = existsSync(directory);
    await writeFile(
      join(home, 'Pictures/photos.json'),
      JSON.stringify([{ id: 'p1', title: 'Beach' }]),
    );
    const settled = await Promise.race([
      importing.then(() => true),
      sleep(30_000).then(() => false),
    ]);

    assert.equal(settled, true, 'the pass never ended');
    assert.equal(keptWhileRunning, true);
    assert.equal(existsSync(directory), false);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
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
  await (await begin()).finish();
  const synced = chatStatus(plugin);
  assert.match(synced.text, /^- Notes: synced at /m);
  assert.notEqual(synced.state, importing.state);

  // Passes over data already imported change its times, not the state.
  const again = await begin();
  assert.equal(chatStatus(plugin).state, synced.state);
  await again.finish();
  assert.equal(chatStatus(plugin).state, synced.state);

  await (await begin()).fail(new Error('Notes could not be opened.'), 'config');
  const failed = chatStatus(plugin);
  await (await begin()).fail(new Error('Notes crashed.'), 'system');
  const crashed = chatStatus(plugin);
  assert.ok(
    failed.text.includes(
      `: Notes could not be opened. ${plugin.connector('notes').guidance()}; data as of `,
    ),
    failed.text,
  );
  assert.notEqual(failed.state, synced.state);
  assert.match(
    crashed.text,
    /^- Notes: last sync failed at .*: Notes crashed\.; data as of /m,
  );
});

test('a selected connector that is no longer loaded is reported, keeps its import through other changes, and can be disconnected', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const withPhotos = await photosPlugin(scratch.path);
  const photos = { connector: 'photos', scope: {}, includeAttachments: true };
  await withPhotos.configure({ connectors: [photos] });
  const plugin = await applePlugin(install, scratch.path);

  const [reported] = plugin.status().connectors;
  const context = chatStatus(plugin).text;
  const imports = await plugin.configure({
    connectors: [
      photos,
      { connector: 'notes', scope: {}, includeAttachments: true },
    ],
  });
  const kept = plugin.status().connectors;
  const changed = () =>
    plugin.configure({
      connectors: [{ ...photos, includeAttachments: false }],
    });
  const listed = connectorRows(plugin).find(({ name }) => name === 'photos');
  const { connectors: rows } = await updateConnector(plugin, 'photos', null);

  assert.equal(reported?.title, 'photos');
  assert.match(
    String(reported?.permissions),
    /No connector named photos is loaded/,
  );
  assert.match(context, /^- photos: No connector named photos is loaded/m);
  assert.deepEqual(
    kept.map(({ connector }) => connector),
    ['photos', 'notes'],
  );
  assert.deepEqual(
    imports.map(({ connector }) => connector),
    ['notes'],
  );
  await assert.rejects(
    changed,
    /No connector named photos is loaded, so its selection cannot change/,
  );
  assert.deepEqual(
    {
      title: listed?.title,
      loaded: listed?.loaded,
      selected: listed?.selection !== null,
    },
    { title: 'photos', loaded: false, selected: true },
  );
  assert.match(
    String(listed?.status.text),
    /No connector named photos is loaded/,
  );
  assert.equal(
    rows.some(({ name }) => name === 'photos'),
    false,
  );
  assert.deepEqual(
    plugin.status().connectors.map(({ connector }) => connector),
    ['notes'],
  );
});

test('the sidebar page describes each connector’s import and switches one connector without touching the others or moving its row', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const statusOf = (name: string) =>
    connectorRows(plugin).find((row) => row.name === name)?.status;
  const described = (name: string) => statusOf(name)?.text;
  const order = connectorRows(plugin).map(({ name }) => name);
  assert.equal(described('notes'), 'Not connected.');

  const notes = {
    connector: 'notes' as const,
    scope: { collectionIds: ['FOLDER-NOTES'] },
    includeAttachments: true,
  };
  await updateConnector(plugin, 'notes', {
    scope: notes.scope,
    includeAttachments: true,
  });
  assert.equal(described('notes'), 'Waiting to import.');
  const begin = await passes(plugin, notes);
  await (await begin()).finish();
  assert.equal(described('notes'), 'Synced just now · 1 folder.');
  // The page adds the connector's permissions guidance to the error once,
  // and offers to open Full Disk Access, since granting it is the fix.
  await (await begin()).fail(new Error('Notes could not be opened.'), 'config');
  assert.deepEqual(statusOf('notes'), {
    state: 'failed',
    text: `Last sync failed: Notes could not be opened. ${plugin.connector('notes').guidance()}`,
    fullDiskAccess: true,
  });
  // A failure granting access cannot fix shows only what went wrong.
  await (await begin()).fail(new Error('Notes crashed.'), 'system');
  assert.deepEqual(statusOf('notes'), {
    state: 'failed',
    text: 'Last sync failed: Notes crashed.',
    fullDiskAccess: false,
  });
  await begin();
  assert.match(String(described('notes')), /^Importing since /);
  // Contacts needs no Full Disk Access, so its access failure does not offer
  // to open it.
  const contacts = {
    connector: 'contacts' as const,
    scope: {},
    includeAttachments: true,
  };
  await updateConnector(plugin, 'contacts', {
    scope: {},
    includeAttachments: true,
  });
  await (
    await (
      await passes(plugin, contacts)
    )()
  ).fail(new Error('Contacts could not be opened.'), 'config');
  assert.deepEqual(statusOf('contacts'), {
    state: 'failed',
    text: `Last sync failed: Contacts could not be opened. ${plugin.connector('contacts').guidance()}`,
    fullDiskAccess: false,
  });
  await updateConnector(plugin, 'contacts', null);

  // Switching Mail on keeps Notes as it was chosen; switching Notes off
  // disconnects it and removes its import. No row moves.
  imported(scratch.path, notes);
  const { connectors: rows } = await updateConnector(plugin, 'mail', {
    scope: {},
    includeAttachments: true,
  });
  assert.deepEqual(
    Object.fromEntries(
      rows.map(({ name, selection }) => [name, selection !== null]),
    ),
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
      clock: false,
      'notification-center': false,
      slack: false,
      teams: false,
      wallet: false,
      whatsapp: false,
    },
  );
  assert.deepEqual(
    rows.map(({ name }) => name),
    order,
  );
  const [kept, mail] = plugin.status().connectors;
  assert.deepEqual(kept?.scope, notes.scope);
  assert.deepEqual(mail?.scope, {});
  assert.equal(mail?.includeAttachments, true);
  assert.equal(described('mail'), 'Waiting to import.');
  await updateConnector(plugin, 'notes', null);
  assert.deepEqual(
    plugin.status().connectors.map(({ connector }) => connector),
    ['mail'],
  );
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('the sidebar page narrows a connector by date, says which connectors it can date, and widens a narrowed one back to everything', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'apple-plugin-'),
  );
  const plugin = await applePlugin(install, scratch.path);
  const dates = {
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: '2026-02-01T00:00:00.000Z',
  };

  await updateConnector(plugin, 'calendar', {
    scope: dates,
    includeAttachments: true,
  });
  await updateConnector(plugin, 'notes', {
    scope: { collectionIds: ['FOLDER-NOTES'] },
    includeAttachments: false,
  });
  const { connectors: rows } = await updateConnector(plugin, 'notes', {
    scope: {},
    includeAttachments: true,
  });

  const row = (name: string) => rows.find((item) => item.name === name);
  assert.deepEqual(row('calendar')?.selection, {
    scope: dates,
    includeAttachments: true,
  });
  assert.equal(typeof row('calendar')?.datedBy, 'string');
  assert.equal(row('contacts')?.datedBy, null);
  assert.deepEqual(row('notes')?.selection, {
    scope: {},
    includeAttachments: true,
  });
  assert.deepEqual(
    plugin.status().connectors.map(({ connector, scope }) => ({
      connector,
      scope,
    })),
    [
      { connector: 'calendar', scope: dates },
      { connector: 'notes', scope: {} },
    ],
  );
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
    () =>
      updateConnector(plugin, 'mail', { scope: {}, includeAttachments: true }),
    /open a new chat/,
  );

  await plugin.import([notes]);

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

  await plugin.import([notes]);

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
  assert.deepEqual(plugin.status().connectors, []);
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
    ).length,
    1,
  );
});
