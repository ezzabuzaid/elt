import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const entry = join(import.meta.dirname, 'main.js');

for (const absolute of [false, true])
  test(`--directory uses an ${absolute ? 'absolute' : 'explicit relative'} store for setup, status and query`, async () => {
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'cli-directory-'),
    );
    const directory = absolute
      ? join(scratch.path, 'Apple Store')
      : 'Apple Store';
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [entry, '--directory', directory, ...args], {
        cwd: scratch.path,
        env: { ...process.env, HOME: scratch.path },
        encoding: 'utf8',
        timeout: 10_000,
      });

    const setup = cli('setup', '--connector', 'notes', '--no-attachments');
    assert.equal(setup.status, 0, setup.stderr);
    const status = cli('status');
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(
      JSON.parse(status.stdout)
        .filter(({ enabled }: { enabled: boolean }) => enabled)
        .map(({ connector }: { connector: string }) => connector),
      ['notes'],
    );

    const root = resolve(realpathSync(scratch.path), directory);
    // Seed a real import to exercise the reader without needing the Mac's
    // private Notes store; the connector's tests cover producing its records.
    {
      using settings = new DatabaseSync(join(root, 'settings.sqlite'), {
        readOnly: true,
      });
      const database = settings
        .prepare('SELECT database FROM selected_connectors WHERE connector = ?')
        .get('notes')?.database;
      assert.ok(typeof database === 'string');
      assert.match(database, /^notes\/[0-9a-f]{16}\/data\.sqlite$/);
      const path = join(root, database);
      mkdirSync(dirname(path), { recursive: true });
      using imported = new DatabaseSync(path);
      imported.exec(
        "CREATE TABLE notes (title TEXT); INSERT INTO notes VALUES ('Chosen store')",
      );
    }
    const query = cli('query', 'notes', 'SELECT title FROM notes');
    assert.equal(query.status, 0, query.stderr);
    assert.deepEqual(JSON.parse(query.stdout), [{ title: 'Chosen store' }]);
    const watch = cli('sync', 'watch', '--help');
    assert.equal(watch.status, 0, watch.stderr);
    assert.match(watch.stdout, /--connector/);
    assert.equal(existsSync(join(scratch.path, 'outputs')), false);
  });

test('--directory requires a path before any store is opened', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'cli-directory-'),
  );
  const result = spawnSync(process.execPath, [entry, '--directory'], {
    cwd: scratch.path,
    env: { ...process.env, HOME: scratch.path },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--directory <path>.*argument missing/);
  assert.equal(existsSync(join(scratch.path, 'outputs')), false);
});
