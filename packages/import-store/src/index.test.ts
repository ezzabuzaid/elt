import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  type ConnectorFacts,
  ImportStore,
  NewerLayoutError,
  type Selection,
  lease,
  leaseHeld,
  selectionProblems,
} from './index.ts';

// Notes narrows by account and folder and is dated; Contacts narrows by
// container only and has no dates; Books cannot be narrowed.
const facts = (connector: string): ConnectorFacts => ({
  narrowsBy: (kind) =>
    connector === 'notes' ||
    (connector === 'contacts' && kind === 'collectionIds'),
  datedBy: connector === 'notes' ? 'last modified' : null,
});
const options = {
  facts,
  permissions: ({ connector }: Selection) => `Allow ${connector}.`,
};

// The sqlite3 shell agents read with, refused writes and untrusted schemas.
function shell(database: string, sql: string) {
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database, sql],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr };
}

test('a selection is checked against what each connector can be narrowed by', () => {
  assert.deepEqual(
    selectionProblems(
      [
        { connector: 'notes', scope: {}, includeAttachments: true },
        { connector: 'notes', scope: {}, includeAttachments: false },
        {
          connector: 'contacts',
          scope: {
            accountIds: ['a'],
            collectionIds: ['c', 'c'],
            startAt: '2025-01-01T00:00:00.000Z',
          },
          includeAttachments: true,
        },
        {
          connector: 'books',
          scope: { collectionIds: [] },
          includeAttachments: true,
        },
        {
          connector: 'notes',
          scope: {
            startAt: '2025-02-01T00:00:00.000Z',
            endAt: '2025-01-01T00:00:00.000Z',
          },
          includeAttachments: true,
        },
      ],
      facts,
    ),
    [
      'notes: choose each connector once',
      'contacts: cannot be narrowed by account IDs',
      'contacts: choose each collection once',
      'contacts: date filtering is unavailable',
      'books: cannot be narrowed by collection IDs',
      'books: choose at least one collection',
      'notes: choose each connector once',
      'notes: start must precede end',
    ],
  );
  assert.deepEqual(
    selectionProblems(
      [
        {
          connector: 'notes',
          scope: { accountIds: ['a'], startAt: '2025-01-01T00:00:00.000Z' },
          includeAttachments: true,
        },
      ],
      facts,
    ),
    [],
  );
});

test('readers find each selected import, where it lives and what access it needs in selected_connectors with the sqlite3 shell', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = {
    connector: 'notes',
    scope: { collectionIds: ['folder-1'] },
    includeAttachments: false,
  };
  {
    using store = new ImportStore(scratch.path);
    store.select(
      [notes, { connector: 'books', scope: {}, includeAttachments: true }],
      options,
    );
    store.saveConnectionFailure(notes, 'Notes could not be opened.');
  }

  const { rows, stderr } = shell(
    join(scratch.path, 'settings.sqlite'),
    'SELECT connector, scope, include_attachments, database, connection_error, permissions FROM selected_connectors',
  );

  assert.equal(stderr, '');
  using store = new ImportStore(scratch.path);
  assert.deepEqual(rows, [
    {
      connector: 'notes',
      scope: '{"collectionIds":["folder-1"]}',
      include_attachments: 0,
      database: store.database(notes),
      connection_error: 'Notes could not be opened.',
      permissions: 'Allow notes.',
    },
    {
      connector: 'books',
      scope: '{}',
      include_attachments: 1,
      database: store.database({
        connector: 'books',
        scope: {},
        includeAttachments: true,
      }),
      connection_error: null,
      permissions: 'Allow books.',
    },
  ]);
  assert.deepEqual(
    shell(
      join(scratch.path, 'settings.sqlite'),
      "SELECT name FROM catalog WHERE name = 'selected_connectors.database'",
    ).rows,
    [{ name: 'selected_connectors.database' }],
  );
});

test('a changed selection replaces its import, and a selection with problems changes nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  using store = new ImportStore(scratch.path);
  const everything = {
    connector: 'notes',
    scope: {},
    includeAttachments: true,
  };
  store.select([everything], options);
  mkdirSync(store.directory(everything), { recursive: true });

  assert.throws(
    () =>
      store.select(
        [
          {
            connector: 'books',
            scope: { accountIds: ['a'] },
            includeAttachments: true,
          },
        ],
        options,
      ),
    /books: cannot be narrowed by account IDs/,
  );
  assert.deepEqual(store.selections(), [everything]);
  assert.equal(existsSync(store.directory(everything)), true);

  const metadata = { ...everything, includeAttachments: false };
  store.select([metadata], options);
  assert.deepEqual(store.selections(), [metadata]);
  assert.equal(existsSync(store.directory(everything)), false);
  store.select([], options);
  assert.deepEqual(readdirSync(join(scratch.path, 'notes')), []);
});

test('a store refuses a settings file a newer layout wrote, and empties one an older layout wrote', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  {
    using store = new ImportStore(scratch.path);
    store.select([notes], options);
  }
  const stamp = (change: (layout: number) => number) => {
    using database = new DatabaseSync(join(scratch.path, 'settings.sqlite'));
    const layout = Number(
      database.prepare('PRAGMA user_version').get()?.user_version,
    );
    database.exec(`PRAGMA user_version = ${change(layout)}`);
  };

  stamp((layout) => layout + 1);
  assert.throws(() => new ImportStore(scratch.path), NewerLayoutError);

  stamp((layout) => layout - 2);
  using store = new ImportStore(scratch.path);
  assert.deepEqual(store.selections(), []);
});

test('one process at a time holds a store lease', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  assert.equal(leaseHeld(scratch.path), false);
  {
    using held = lease(scratch.path);
    assert.ok(held);
    assert.equal(lease(scratch.path), null);
    assert.equal(leaseHeld(scratch.path), true);
  }
  assert.equal(leaseHeld(scratch.path), false);
});

test('a read rolls back the hot journal a pass killed mid-commit left, so the sqlite3 shell can open the import again', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  using store = new ImportStore(scratch.path);
  store.select([notes], options);
  mkdirSync(store.directory(notes), { recursive: true });
  const database = store.database(notes);
  {
    using data = new DatabaseSync(database);
    data.exec("CREATE TABLE notes(id TEXT); INSERT INTO notes VALUES('kept');");
  }
  // A pass that dies inside its transaction, after SQLite spilled the change
  // to the file, leaves the rollback journal behind.
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const data = new DatabaseSync(${JSON.stringify(database)});
       data.exec('PRAGMA cache_size = 1; BEGIN');
       data.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO notes SELECT 'lost-' || i FROM n");
       process.kill(process.pid, 'SIGKILL');`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(existsSync(`${database}-journal`), true);
  assert.match(
    shell(database, 'SELECT count(*) AS n FROM notes').stderr,
    /readonly/,
  );

  {
    using data = store.read(notes);
    assert.deepEqual(
      { ...data.prepare('SELECT count(*) AS n FROM notes').get() },
      { n: 1 },
    );
  }

  assert.deepEqual(shell(database, 'SELECT count(*) AS n FROM notes').rows, [
    { n: 1 },
  ]);
});
