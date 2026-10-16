import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { peopleConnectors } from '@workspace/apple-people/people';
import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { Connectors } from '@workspace/connector-apple-manifest/connectors';
import { Settings } from '@workspace/settings';

import { Imports } from './imports.ts';
import { TerminalHost } from './terminal-host.ts';

const entry = join(import.meta.dirname, 'main.js');

// Real selected imports with the counterparts shape the people model reads.
// Connector tests cover producing these rows from each upstream app's store.
async function importsAt(root: string): Promise<Map<string, string>> {
  const { connectors, broken } = await new Connectors([builtInConnectors]).load(
    new TerminalHost(),
  );
  assert.deepEqual(broken, []);
  const imports = new Imports(connectors);
  using settings = new Settings(join(root, 'outputs/cli'));
  const selections = peopleConnectors.map((connector) => ({
    connector,
    scope: {},
    includeAttachments: false,
  }));
  settings.select(selections, {
    facts: (name) => imports.connector(name),
    permissions: ({ connector }) => imports.connector(connector).guidance(),
  });
  const paths = new Map<string, string>();
  for (const selection of selections) {
    mkdirSync(settings.directory(selection), { recursive: true });
    const path = settings.database(selection);
    paths.set(selection.connector, path);
    using database = new DatabaseSync(path);
    database.exec(`CREATE TABLE counterparts (
      relation, identifier_type, identifier, linked_type, linked_identifier,
      name, first_at, last_at, occurrences, context
    )`);
    if (selection.connector === 'contacts')
      database.exec(`INSERT INTO counterparts VALUES
        ('card', 'app', 'RANA', 'phone', '+962791234567', 'Rana', NULL, NULL, 1, NULL),
        ('card', 'app', 'ME', 'phone', '+962790000000', 'Ezz', NULL, NULL, 1, NULL),
        ('self', 'app', 'ME', 'phone', '+962790000000', 'Ezz', NULL, NULL, 1, NULL)`);
    if (selection.connector === 'messages')
      database.exec(`INSERT INTO counterparts VALUES
        ('received', 'phone', '+962791234567', NULL, NULL, NULL,
         '2026-10-01T09:00:00.000Z', '2026-10-02T09:00:00.000Z', 2, NULL)`);
  }
  return paths;
}

function people(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [entry, 'people', ...args], {
    cwd: root,
    env: { ...process.env, HOME: root },
    encoding: 'utf8',
  });
}

test('people preserves the default list, custom SQL, duplicate columns and empty-result headings', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'people-cli-'));
  await importsAt(scratch.path);

  const listed = people(scratch.path);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), [
    {
      name: 'Rana',
      tags: '["contacts:card","messages:received"]',
      first_at: '2026-10-01T09:00:00.000Z',
      last_at: '2026-10-02T09:00:00.000Z',
    },
  ]);
  const custom = people(
    scratch.path,
    'SELECT name FROM people ORDER BY name',
    '--json',
  );
  assert.equal(custom.status, 0, custom.stderr);
  assert.deepEqual(JSON.parse(custom.stdout), [
    { name: 'Ezz' },
    { name: 'Rana' },
  ]);
  const unqualified = people(
    scratch.path,
    'SELECT count(*) AS n FROM counterparts',
  );
  assert.equal(unqualified.status, 0, unqualified.stderr);
  assert.deepEqual(JSON.parse(unqualified.stdout), [{ n: 3 }]);
  const columns = people(
    scratch.path,
    'PRAGMA contacts.table_info(counterparts)',
  );
  assert.equal(columns.status, 0, columns.stderr);
  assert.equal(JSON.parse(columns.stdout)[0].name, 'relation');

  for (const [sql, expected] of [
    ['SELECT name AS person FROM people WHERE 0', /person\s+0 rows/],
    ['SELECT 1 AS same, 2 AS same', /same\s+same\s+1\s+2\s+1 row/],
  ] as const) {
    const rendered = spawnSync(
      '/usr/bin/expect',
      [
        '-c',
        `spawn -noecho {${process.execPath}} {${entry}} people {${sql}}; expect eof; lassign [wait] pid spawned failed status; exit $status`,
      ],
      {
        cwd: scratch.path,
        env: { ...process.env, HOME: scratch.path },
        encoding: 'utf8',
      },
    );
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(stripVTControlCharacters(rendered.stdout), expected);
  }

  const comments = people(
    scratch.path,
    'SELECT 1 AS n; -- tail\n ; /* done */',
  );
  assert.equal(comments.status, 0, comments.stderr);
  assert.deepEqual(JSON.parse(comments.stdout), [{ n: 1 }]);
  for (const sql of ['SELECT 1; SELECT 2', 'SELECT 1; malformed sql']) {
    const rejected = people(scratch.path, sql);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Run one SQL statement at a time/);
    assert.equal(rejected.stdout, '');
  }
  const write = people(scratch.path, 'DELETE FROM contacts.counterparts');
  assert.equal(write.status, 1);
  assert.match(write.stderr, /readonly/);
});

test('people validates every required import even when the query reads none', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'people-cli-'));
  const paths = await importsAt(scratch.path);
  const path = paths.get('calendar');
  assert.ok(path);
  rmSync(path);

  const result = people(scratch.path, 'SELECT 1');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Calendar has not synced yet; run: sync/);
  assert.equal(result.stdout, '');
});

test('query preserves main, schema PRAGMAs, positional output and statement rejection through the shared executor', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'query-cli-'));
  await importsAt(scratch.path);
  const query = (sql: string) =>
    spawnSync(process.execPath, [entry, 'query', 'contacts', sql], {
      cwd: scratch.path,
      env: { ...process.env, HOME: scratch.path },
      encoding: 'utf8',
    });

  const main = query(
    'SELECT count(*) AS n FROM main.counterparts; -- tail\n ; /* done */',
  );
  assert.equal(main.status, 0, main.stderr);
  assert.deepEqual(JSON.parse(main.stdout), [{ n: 3 }]);
  const schema = query("SELECT name FROM sqlite_schema WHERE type = 'table'");
  assert.equal(schema.status, 0, schema.stderr);
  assert.deepEqual(JSON.parse(schema.stdout), [{ name: 'counterparts' }]);
  const pragma = query('PRAGMA main.table_info(counterparts)');
  assert.equal(pragma.status, 0, pragma.stderr);
  assert.equal(JSON.parse(pragma.stdout)[0].name, 'relation');
  const duplicate = query('SELECT 1 AS same, 2 AS same');
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.deepEqual(JSON.parse(duplicate.stdout), [{ same: 2 }]);

  for (const [sql, expected] of [
    ['SELECT name AS person FROM counterparts WHERE 0', /person\s+0 rows/],
    ['SELECT 1 AS same, 2 AS same', /same\s+same\s+1\s+2\s+1 row/],
  ] as const) {
    const rendered = spawnSync(
      '/usr/bin/expect',
      [
        '-c',
        `spawn -noecho {${process.execPath}} {${entry}} query contacts {${sql}}; expect eof; lassign [wait] pid spawned failed status; exit $status`,
      ],
      {
        cwd: scratch.path,
        env: { ...process.env, HOME: scratch.path },
        encoding: 'utf8',
      },
    );
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(stripVTControlCharacters(rendered.stdout), expected);
  }
  for (const sql of ['SELECT 1; SELECT 2', 'SELECT 1; malformed sql']) {
    const rejected = query(sql);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Run one SQL statement at a time/);
    assert.equal(rejected.stdout, '');
  }
  const write = query('DELETE FROM main.counterparts');
  assert.equal(write.status, 1);
  assert.match(write.stderr, /readonly/);
});

test('query joins main and its preset with another import, locating only the imports it reads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'query-cli-'));
  const paths = await importsAt(scratch.path);
  const messages = paths.get('messages');
  const calendar = paths.get('calendar');
  assert.ok(messages);
  assert.ok(calendar);
  rmSync(calendar);
  {
    using database = new DatabaseSync(messages);
    database.exec(`
      CREATE TABLE messages (guid, date, handle, subject, text, handleService, isFromMe, service);
      INSERT INTO messages VALUES ('m1', '2026-10-01', '+962791234567', NULL, 'Monthly subscription', 'SMS', 0, 'SMS');
      CREATE TABLE message_attachments (messageGuid, attachmentGuid);
      CREATE TABLE attachments (guid, transferName, mimeType, availableLocally);
    `);
  }
  const query = (sql: string) =>
    spawnSync(process.execPath, [entry, 'query', 'messages', sql], {
      cwd: scratch.path,
      env: { ...process.env, HOME: scratch.path },
      encoding: 'utf8',
    });

  const joined = query(`
    SELECT c.name, m.text, p.record_id
    FROM main.messages m
    JOIN message_subscription_evidence p ON p.record_id = m.guid
    JOIN contacts.counterparts c ON c.linked_identifier = m.handle
    WHERE c.relation = 'card'
  `);
  assert.equal(joined.status, 0, joined.stderr);
  assert.deepEqual(JSON.parse(joined.stdout), [
    { name: 'Rana', text: 'Monthly subscription', record_id: 'm1' },
  ]);

  for (const [sql, error] of [
    ['SELECT * FROM main.missing', /no such table: main.missing/],
    [
      'SELECT * FROM unknown.counterparts',
      /no such table: unknown.counterparts/,
    ],
    ['SELECT * FROM contacts.missing', /no such table: contacts.missing/],
    [
      'SELECT * FROM calendar.counterparts',
      /Calendar has not synced yet; run: sync/,
    ],
    ['SELECT * FROM books.counterparts', /Books is not set up; run: setup/],
    ['DELETE FROM contacts.counterparts', /readonly/],
  ] as const) {
    const failed = query(sql);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, error);
    assert.equal(failed.stdout, '');
  }
  assert.equal(existsSync(calendar), false);
});

for (const args of [
  ['people', 'SELECT count(*) AS n FROM contacts.counterparts'],
  ['query', 'contacts', 'SELECT count(*) AS n FROM main.counterparts'],
  [
    'query',
    'messages',
    'SELECT count(*) AS n FROM main.counterparts m CROSS JOIN contacts.counterparts c',
  ],
])
  test(`${args.slice(0, -1).join(' ')} recovers a hot journal before reading its imports`, async () => {
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'people-cli-'),
    );
    const paths = await importsAt(scratch.path);
    const path = paths.get('contacts');
    assert.ok(path);
    const crashed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('PRAGMA cache_size = 1; BEGIN');
    database.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO counterparts (relation, identifier_type, identifier) SELECT 'card', 'app', 'lost-' || i FROM n");
    process.kill(process.pid, 'SIGKILL');
  `,
        path,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(existsSync(`${path}-journal`), true);
    {
      using readonly = new DatabaseSync(path, { readOnly: true });
      assert.throws(
        () => readonly.prepare('SELECT count(*) FROM counterparts').get(),
        /readonly/,
      );
    }

    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: scratch.path,
      env: { ...process.env, HOME: scratch.path },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ n: 3 }]);
    assert.equal(existsSync(`${path}-journal`), false);
  });
