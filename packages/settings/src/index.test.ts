import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  type ConnectorFacts,
  ConnectorRemovedError,
  NewerLayoutError,
  type Selection,
  Settings,
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
    using store = new Settings(scratch.path);
    store.select(
      [notes, { connector: 'books', scope: {}, includeAttachments: true }],
      options,
    );
    store.saveConnectionFailure(notes, 'Notes could not be opened.', 'config');
  }

  const { rows, stderr } = shell(
    join(scratch.path, 'settings.sqlite'),
    'SELECT connector, scope, include_attachments, database, connection_error, connection_failure_type, permissions FROM selected_connectors',
  );

  assert.equal(stderr, '');
  using store = new Settings(scratch.path);
  assert.deepEqual(rows, [
    {
      connector: 'notes',
      scope: '{"collectionIds":["folder-1"]}',
      include_attachments: 0,
      database: store.database(notes),
      connection_error: 'Notes could not be opened.',
      connection_failure_type: 'config',
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
      connection_failure_type: null,
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

test('a changed selection leaves its previous import stale, and a selection with problems changes nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  using store = new Settings(scratch.path);
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
  assert.deepEqual(store.staleImports(), []);

  const metadata = { ...everything, includeAttachments: false };
  store.select([metadata], options);
  mkdirSync(store.directory(metadata), { recursive: true });
  assert.deepEqual(store.selections(), [metadata]);
  assert.deepEqual(store.staleImports(), [store.directory(everything)]);
  store.select([], options);
  assert.deepEqual(
    store.staleImports().sort(),
    [store.directory(everything), store.directory(metadata)].sort(),
  );
});

test('a store refuses a settings file a newer layout wrote, and empties one an older layout wrote', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  {
    using store = new Settings(scratch.path);
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
  assert.throws(() => new Settings(scratch.path), NewerLayoutError);

  stamp((layout) => layout - 2);
  using store = new Settings(scratch.path);
  assert.deepEqual(store.selections(), []);
});

test('removing a connector stops its running import', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  using store = new Settings(scratch.path);
  store.select([notes], options);
  using removal = store.removal(notes);
  const removed = Promise.withResolvers<unknown>();
  removal.signal.addEventListener(
    'abort',
    () => removed.resolve(removal.signal.reason),
    { once: true },
  );

  // Another setup removes Notes while its import runs.
  {
    using other = new Settings(scratch.path);
    other.select([], options);
  }
  const reason = await removed.promise;

  assert.ok(reason instanceof ConnectorRemovedError);
  assert.equal(reason.message, 'notes was removed from the selection');
});

test('a selection that keeps a connector never stops its import', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'store-'));
  const notes = { connector: 'notes', scope: {}, includeAttachments: true };
  const books = { connector: 'books', scope: {}, includeAttachments: true };
  using store = new Settings(scratch.path);
  store.select([notes], options);
  using removal = store.removal(notes);

  store.select([notes, books], options);
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  assert.equal(removal.signal.aborted, false);
});
