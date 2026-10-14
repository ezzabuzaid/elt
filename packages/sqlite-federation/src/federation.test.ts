import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Federation, TooManyDatabasesError } from './index.ts';

// A database the host keeps: one table t with the values given.
function writeDatabase(path: string, values: readonly number[]): void {
  using database = new DatabaseSync(path);
  database.exec('CREATE TABLE t (x INTEGER)');
  const insert = database.prepare('INSERT INTO t (x) VALUES (?)');
  for (const value of values) insert.run(value);
}

// The schemas the handle has open between statements, as a condition can
// read them.
function attachedNames(federation: Federation): unknown[] {
  return federation.sql.all`SELECT name FROM pragma_database_list`.map(
    ({ name }) => name,
  );
}

test('a statement that names more than 10 databases fails with TooManyDatabasesError and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map<string, string>();
  for (let index = 0; index <= 10; index++) {
    const path = join(scratch.path, `d${index}.sqlite`);
    writeDatabase(path, [index]);
    paths.set(`d${index}`, path);
  }
  using federation = new Federation({ locate: (name) => paths.get(name) });

  assert.throws(
    () =>
      federation.sql.all`
        SELECT x FROM d0.t UNION ALL SELECT x FROM d1.t UNION ALL
        SELECT x FROM d2.t UNION ALL SELECT x FROM d3.t UNION ALL
        SELECT x FROM d4.t UNION ALL SELECT x FROM d5.t UNION ALL
        SELECT x FROM d6.t UNION ALL SELECT x FROM d7.t UNION ALL
        SELECT x FROM d8.t UNION ALL SELECT x FROM d9.t UNION ALL
        SELECT x FROM d10.t`,
    (error) => {
      assert.ok(error instanceof TooManyDatabasesError);
      assert.deepEqual([...error.names].sort(), [...paths.keys()].sort());
      assert.match(error.message, /split/i);
      return true;
    },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a name the host cannot locate fails with SQLite’s own error', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });

  // Every database has sqlite_schema, so a database attached in place of the
  // unknown name would answer.
  assert.throws(
    () => federation.sql.all`SELECT name FROM elsewhere.sqlite_schema`,
    { message: 'no such table: elsewhere.sqlite_schema' },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a table its database lacks fails with SQLite’s own error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });

  assert.throws(() => federation.sql.all`SELECT x FROM d.missing`, {
    message: 'no such table: d.missing',
  });
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a path to a file that does not exist fails with SQLite’s own error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  writeDatabase(first, [1]);
  const paths = new Map([
    ['first', first],
    ['absent', join(scratch.path, 'absent.sqlite')],
  ]);
  using federation = new Federation({ locate: (name) => paths.get(name) });

  // SQLite resolves a FROM list from left to right, so first is attached
  // before absent fails.
  assert.throws(
    () => federation.sql.all`SELECT a.x FROM first.t a, absent.t b`,
    { message: /unable to open database/ },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a locate that throws fails the statement with its error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  writeDatabase(first, [1]);
  const unreadable = new Error('the host cannot read its settings');
  using federation = new Federation({
    locate: (name) => {
      if (name === 'first') return first;
      throw unreadable;
    },
  });

  assert.throws(
    () => federation.sql.all`SELECT a.x FROM first.t a, second.t b`,
    (error) => error === unreadable,
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a statement cannot change a database it reads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });

  assert.throws(
    () => federation.sql.all`INSERT INTO d.t (x) VALUES (2) RETURNING x`,
    { message: /readonly database/ },
  );
  using database = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT x FROM t')
      .all()
      .map(({ x }) => x),
    [1],
  );
});

test('a writer commits between two statements', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });
  assert.deepEqual(
    federation.sql.all`SELECT x FROM d.t`.map(({ x }) => x),
    [1],
  );

  using writer = new DatabaseSync(path, { timeout: 0 });
  writer.exec('INSERT INTO t (x) VALUES (2)');

  assert.deepEqual(
    federation.sql.all`SELECT x FROM d.t ORDER BY x`.map(({ x }) => x),
    [1, 2],
  );
});

test('a database that moves between statements is read from its new path', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const before = join(scratch.path, 'before.sqlite');
  const after = join(scratch.path, 'after.sqlite');
  writeDatabase(before, [1]);
  writeDatabase(after, [2]);
  let path = before;
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });
  // One cached statement runs again after its database was detached.
  const read = () => federation.sql.all`SELECT x FROM d.t`.map(({ x }) => x);
  assert.deepEqual(read(), [1]);

  path = after;

  assert.deepEqual(read(), [2]);
});

test('a statement reads a database that it names by schema', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1, 2]);
  using federation = new Federation({
    locate: (name) => (name === 'd' ? path : undefined),
  });

  const all = federation.sql.all`SELECT x FROM d.t ORDER BY x`;
  const afterAll = attachedNames(federation);
  const one = federation.sql.get`SELECT count(*) AS n FROM d.t`;
  const afterGet = attachedNames(federation);

  assert.deepEqual(
    all.map(({ x }) => x),
    [1, 2],
  );
  assert.equal(one?.n, 2);
  assert.deepEqual(afterAll, ['main']);
  assert.deepEqual(afterGet, ['main']);
});

test('one statement joins two databases', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map([
    ['left', join(scratch.path, 'left.sqlite')],
    ['right', join(scratch.path, 'right.sqlite')],
  ]);
  writeDatabase(join(scratch.path, 'left.sqlite'), [1, 2, 3]);
  writeDatabase(join(scratch.path, 'right.sqlite'), [2, 3, 4]);
  using federation = new Federation({ locate: (name) => paths.get(name) });

  const rows = federation.sql.all`
    SELECT l.x FROM left.t l JOIN right.t r ON r.x = l.x ORDER BY l.x`;

  assert.deepEqual(
    rows.map(({ x }) => x),
    [2, 3],
  );
});

test('one statement reads 10 databases', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map<string, string>();
  for (let index = 0; index < 10; index++) {
    const path = join(scratch.path, `d${index}.sqlite`);
    writeDatabase(path, [index]);
    paths.set(`d${index}`, path);
  }
  using federation = new Federation({ locate: (name) => paths.get(name) });

  const rows = federation.sql.all`
    SELECT x FROM d0.t UNION ALL SELECT x FROM d1.t UNION ALL
    SELECT x FROM d2.t UNION ALL SELECT x FROM d3.t UNION ALL
    SELECT x FROM d4.t UNION ALL SELECT x FROM d5.t UNION ALL
    SELECT x FROM d6.t UNION ALL SELECT x FROM d7.t UNION ALL
    SELECT x FROM d8.t UNION ALL SELECT x FROM d9.t
    ORDER BY x`;

  assert.deepEqual(
    rows.map(({ x }) => x),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});
