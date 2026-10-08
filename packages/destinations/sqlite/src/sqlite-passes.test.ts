import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  SQLiteDestination,
  SQLitePasses,
  SQLiteSyncHistory,
  readSQLite,
} from './index.ts';

// The sqlite3 shell agents read with, which refuses writes.
function shell(database: string, sql: string) {
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database, sql],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr };
}

test('a destination runs one pass at a time; its status names a stopped pass cancelled and a running one no process runs interrupted', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-passes-'));
  const reading = Promise.withResolvers<void>();
  // Emits one record, then waits for its run to stop.
  class Waiting extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'waiting';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      supportedSyncModes: ['full_refresh'],
    });
    protected readonly catalog = new Catalog([this.records]);

    protected override async open() {
      return new AsyncDisposableStack();
    }

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      _partition: null,
      _context: AsyncDisposable,
      signal?: AbortSignal,
    ) {
      yield { stream: configuration.stream.name, data: { id: 'staged' } };
      reading.resolve();
      await new Promise((resolve) =>
        signal?.addEventListener('abort', resolve, { once: true }),
      );
    }
  }
  const source = new Waiting();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const connection = new Connection({
    name: 'waiting',
    source,
    destination,
    steps: [new Copy(source.records, destination.table('records'))],
  });
  const passes = new SQLitePasses(destination.path);
  const controller = new AbortController();
  const reason = new Error('stopped by the test');

  const running = passes.run(() =>
    new Pipeline({ connections: [connection], history }).run({
      signal: controller.signal,
    }),
  );
  await reading.promise;
  const during = await passes.status();
  const second = await passes.run(async () => 'ran');
  controller.abort(reason);
  const stopped = await running.then(
    () => assert.fail('a stopped pass must reject'),
    (error: unknown) => error,
  );
  const after = await passes.status();
  // A pass its process left running, as when the process was killed.
  await history.begin(connection, []);
  const left = await passes.status();

  assert.equal(during.pass?.state, 'running');
  assert.deepEqual(
    during.streams.map(({ stream, state }) => [stream, state]),
    [['records', 'running']],
  );
  assert.deepEqual(second, { acquired: false });
  assert.equal(stopped, reason);
  assert.equal(after.pass?.state, 'cancelled');
  assert.match(after.pass?.error ?? '', /stopped by the test/);
  assert.deepEqual(
    after.streams.map(({ stream, state }) => [stream, state]),
    [['records', 'cancelled']],
  );
  assert.equal(left.pass?.state, 'interrupted');
});

test('a read rolls back the hot journal a pass killed mid-commit left, so the sqlite3 shell can open the file again', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-passes-'));
  const database = join(scratch.path, 'data.sqlite');
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
    using data = readSQLite(database);
    assert.deepEqual(
      { ...data.prepare('SELECT count(*) AS n FROM notes').get() },
      { n: 1 },
    );
  }

  assert.deepEqual(shell(database, 'SELECT count(*) AS n FROM notes').rows, [
    { n: 1 },
  ]);
});
