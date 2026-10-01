import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, realpathSync, renameSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { noteStoreFixture } from 'apple/fixtures/notes-store';
import { appleSeconds, safariFixture } from 'apple/fixtures/safari-stores';

const entry = join(import.meta.dirname, 'main.js');

// The CLI as a script runs it: no terminal, HOME pointing at a Mac whose
// apps' stores the test wrote, and the working directory holding outputs/.
function cli(mac: string, ...args: string[]) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [entry, ...args],
    { cwd: mac, env: { ...process.env, HOME: mac }, encoding: 'utf8' },
  );
  return { status, stdout, stderr };
}

// The user's Notes, where Notes keeps them under HOME. Only Notes has a store
// here; every other app finds nothing, as on a Mac that denies access.
const withNotes = (mac: string) =>
  noteStoreFixture(join(mac, 'Library/Group Containers/group.com.apple.notes'));

// The CLI in a terminal of its own, typed into as a person would: expect,
// which macOS ships, gives it a 120×40 pseudo-terminal, relays keys and exits
// with the CLI's status.
function terminal(mac: string, ...args: string[]) {
  const child = spawn(
    '/usr/bin/expect',
    [
      '-c',
      `set stty_init {columns 120 rows 40}; spawn -noecho {${process.execPath}} {${entry}} ${args.join(' ')}; interact; lassign [wait] pid spawned failed status; exit $status`,
    ],
    { cwd: mac, env: { ...process.env, HOME: mac } },
  );
  let screen = '';
  child.stdout.on('data', (data) => {
    screen += stripVTControlCharacters(String(data));
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  return {
    child,
    exited,
    get screen() {
      return screen;
    },
    async shows(text: string) {
      for (let tries = 0; !screen.includes(text); tries++) {
        if (tries > 300) assert.fail(`never showed ${text}:\n${screen}`);
        await sleep(100);
      }
    },
    async type(...keys: string[]) {
      for (const key of keys) {
        child.stdin.write(key);
        await sleep(150);
      }
    },
  };
}

const down = '\x1b[B';
const space = ' ';
const enter = '\r';

const lines = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('an app macOS will not open fails alone, named with the access to grant, while the others load', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  assert.equal(
    cli(mac.path, 'setup', '--app', 'notes', '--app', 'messages').status,
    0,
  );

  const synced = cli(mac.path, 'sync');

  assert.equal(synced.status, 1);
  const passes = Object.fromEntries(
    lines(synced.stdout).map((pass) => [pass.app, pass]),
  );
  assert.equal(passes.notes.status, 'succeeded');
  assert.equal(passes.messages.status, 'failed');
  assert.match(passes.messages.error, /Full Disk Access/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ app, state }: { app: string; state: string }) => [
      app,
      state,
    ]),
    [
      ['notes', 'succeeded'],
      ['messages', 'failed'],
    ],
  );
});

test('a second sync is refused while another holds the store, and nothing it imported is touched', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');
  // Stands in for a running sync: a real one would be `sync --watch`, which
  // launches the real Notes app. A sync holds this lock for its whole run.
  mkdirSync(join(mac.path, 'outputs/cli'), { recursive: true });
  using held = new DatabaseSync(join(mac.path, 'outputs/cli/sync.lock'));
  held.exec('BEGIN EXCLUSIVE');

  const second = cli(mac.path, 'sync');
  const rescoped = cli(
    mac.path,
    'setup',
    '--app',
    'notes',
    '--collection',
    'FOLDER-NOTES',
  );

  assert.equal(second.status, 1);
  assert.match(second.stderr, /Another sync is using this store/);
  assert.equal(rescoped.status, 1);
  const notes = cli(
    mac.path,
    'query',
    'notes',
    'SELECT count(*) AS n FROM notes',
    '--json',
  );
  assert.ok(JSON.parse(notes.stdout)[0].n > 0);
});

test('setup, sync, status and query read the Notes this Mac holds through documented views', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);

  const setup = cli(mac.path, 'setup', '--app', 'notes', '--json');
  const synced = cli(mac.path, 'sync');
  const status = cli(mac.path, 'status', '--json');
  const views = cli(mac.path, 'query', 'notes', '--tables', '--json');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes WHERE title IS NOT NULL ORDER BY title',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout), {
    apps: [{ app: 'notes', scope: {}, attachments: true }],
  });
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(lines(synced.stdout)[0].status, 'succeeded');
  const [notes] = JSON.parse(status.stdout);
  assert.equal(notes.state, 'succeeded');
  assert.notEqual(notes.lastSuccessAt, null);
  assert.equal(
    notes.database,
    join(realpathSync(mac.path), 'outputs/cli/notes/data.sqlite'),
  );
  const readable = JSON.parse(views.stdout);
  assert.ok(
    readable.some(
      ({ view, rows }: { view: string; rows: number }) =>
        view === 'notes' && rows > 0,
    ),
    views.stdout,
  );
  assert.ok(
    readable.some(
      ({ view }: { view: string }) => view === 'inline_attachments',
    ),
  );
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Groceries', 'Old', 'Secret'],
  );
});

test('changing what an app imports, down to its attachments, loads the new selection completely on the next sync', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');
  const options = JSON.parse(
    cli(mac.path, 'options', 'notes', '--json').stdout,
  );
  const trash = options
    .flatMap(
      ({ options }: { options: { id: string; label: string }[] }) => options,
    )
    .find(
      ({ label }: { label: string }) => label === 'iCloud / Recently Deleted',
    );

  // Narrowing flags bind to the --app before them, here the second one.
  const rescoped = cli(
    mac.path,
    'setup',
    '--app',
    'messages',
    '--app',
    'notes',
    '--collection',
    trash.id,
    '--no-attachments',
  );
  const synced = cli(mac.path, 'sync');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes',
    '--json',
  );

  assert.equal(rescoped.status, 0, rescoped.stderr);
  const notesPass = lines(synced.stdout).find(({ app }) => app === 'notes');
  assert.equal(notesPass.status, 'succeeded', synced.stdout);
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Old'],
  );
  const fileColumns = cli(
    mac.path,
    'query',
    'notes',
    "SELECT name FROM catalog WHERE name LIKE '%.attachmentRef'",
    '--json',
  );
  assert.deepEqual(JSON.parse(fileColumns.stdout), []);
});

test('a command a script cannot run fails and says why, changing nothing', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');

  const unnamed = cli(mac.path, 'setup');
  const misplaced = cli(
    mac.path,
    'setup',
    '--collection',
    'FOLDER-NOTES',
    '--app',
    'notes',
  );
  const undated = cli(
    mac.path,
    'setup',
    '--app',
    'contacts',
    '--since',
    '2025-01-01',
  );
  const twoStatements = cli(
    mac.path,
    'query',
    'notes',
    'SELECT 1; DELETE FROM notes',
  );
  // Indented further than the second statement is long, the way an editor
  // or an agent might send it.
  const unselected = cli(mac.path, 'sync', '--app', 'calendar');
  const indented = cli(
    mac.path,
    'query',
    'notes',
    `${' '.repeat(12)}SELECT 1; SELECT 2`,
  );

  for (const run of [
    unnamed,
    misplaced,
    undated,
    unselected,
    twoStatements,
    indented,
  ])
    assert.equal(run.status, 1, run.stderr);
  assert.match(unselected.stderr, /calendar is not set up/);
  assert.match(unnamed.stderr, /--app/);
  assert.match(misplaced.stderr, /must follow the --app/);
  assert.match(undated.stderr, /no date/);
  assert.match(twoStatements.stderr, /one SQL statement/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ app }: { app: string }) => app),
    ['notes'],
  );
});

test('the setup wizard saves what the person picks and syncs it when asked', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  const wizard = terminal(mac.path, 'setup');
  try {
    await wizard.shows('Which apps should be imported?');
    await wizard.type(down, space, enter);
    await wizard.shows('Narrow any app?');
    await wizard.type(space, enter);
    await wizard.shows('Notes: accounts');
    await wizard.type(enter);
    await wizard.shows('iCloud / Recently Deleted');
    await wizard.type(down, space, enter);
    await wizard.shows('date last edited since');
    await wizard.type(enter);
    await wizard.shows('date last edited until');
    await wizard.type(enter);
    await wizard.shows('Sync now?');
    await wizard.type(enter);

    assert.equal(await wizard.exited, 0, wizard.screen);
  } finally {
    wizard.child.kill();
  }

  assert.match(wizard.screen, /Notes\s+\d+ rows/);
  const [notes] = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.equal(notes.state, 'succeeded');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes',
    '--json',
  );
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Old'],
  );
});

test('one SQL statement runs however it is spaced or commented', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');

  const commented = cli(
    mac.path,
    'query',
    'notes',
    '\n  -- how many notes\n  SELECT count(*) AS n FROM notes; -- all of them\n',
    '--json',
  );

  assert.equal(commented.status, 0, commented.stderr);
  assert.equal(JSON.parse(commented.stdout)[0].n, 3);
});

test('sync --watch loads each change Safari commits until Ctrl-C stops it, keeping every pass it finished', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  // Safari keeps history under ~/Library/Safari and its tabs in its sandbox
  // container; the fixture writes both, and the container moves where Safari
  // keeps it.
  const library = join(mac.path, 'Library');
  const { directory, container } = await safariFixture(library);
  const sandboxed = join(
    library,
    'Containers/com.apple.Safari/Data/Library/Safari',
  );
  mkdirSync(dirname(sandboxed), { recursive: true });
  renameSync(container, sandboxed);
  cli(mac.path, 'setup', '--app', 'safari');
  const watching = spawn(process.execPath, [entry, 'sync', '--watch'], {
    cwd: mac.path,
    env: { ...process.env, HOME: mac.path },
  });
  try {
    let stdout = '';
    watching.stdout.on('data', (data) => {
      stdout += String(data);
    });
    const passes = () => (stdout.trim() === '' ? [] : lines(stdout));
    const until = async (done: () => boolean) => {
      for (let tries = 0; !done(); tries++) {
        if (tries > 200) assert.fail(`never happened:\n${stdout}`);
        await sleep(100);
      }
    };
    await until(() => passes().length === 1);

    {
      using history = new DatabaseSync(join(directory, 'History.db'));
      history
        .prepare(
          'INSERT INTO history_visits (history_item, visit_time) VALUES (1, ?)',
        )
        .run(appleSeconds('2026-04-01T00:00:00Z'));
    }
    await until(() =>
      passes().some(({ streams }) =>
        streams.some(
          ({ stream, written }: { stream: string; written: number }) =>
            stream === 'historyVisits' && written === 1,
        ),
      ),
    );
    watching.kill('SIGINT');
    const [code] = await once(watching, 'close');

    assert.equal(code, 130);
    assert.ok(
      passes().every(({ status }) => status === 'succeeded'),
      stdout,
    );
    const visits = cli(
      mac.path,
      'query',
      'safari',
      "SELECT count(*) AS n FROM history_visits WHERE visitedAt LIKE '2026-04-01%'",
      '--json',
    );
    assert.equal(JSON.parse(visits.stdout)[0].n, 1, visits.stderr);
  } finally {
    watching.kill();
  }
});
