import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

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
  SQLiteSyncHistory,
  readPassStatus,
  readSQLite,
} from './index.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

// The sqlite3 shell agents read with, which refuses writes.
function shell(database: string, sql: string) {
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database, sql],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr };
}

test('a pass and each of its streams read running while it runs and cancelled once it is stopped', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  const reading = Promise.withResolvers<void>();
  // Emits one record, then waits for its run to stop.
  class Waiting extends LiveSource {
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
  const connection = new Connection({
    name: 'waiting',
    source,
    destination,
    steps: [new Copy(source.records, destination.table('records'))],
  });
  const controller = new AbortController();
  const reason = new Error('stopped by the test');

  const running = new Pipeline({ connections: [connection], history }).run({
    signal: controller.signal,
  });
  await reading.promise;
  const during = readPassStatus(destination.path);
  controller.abort(reason);
  const stopped = await running.then(
    () => assert.fail('a stopped pass must reject'),
    (error: unknown) => error,
  );
  const after = readPassStatus(destination.path);

  assert.equal(during.pass?.state, 'running');
  assert.deepEqual(
    during.streams.map(({ stream, state }) => [stream, state]),
    [['records', 'running']],
  );
  assert.equal(stopped, reason);
  assert.equal(after.pass?.state, 'cancelled');
  assert.match(after.pass?.error ?? '', /stopped by the test/);
  assert.deepEqual(
    after.streams.map(({ stream, state }) => [stream, state]),
    [['records', 'cancelled']],
  );
});

test('a read rolls back the hot journal a pass killed mid-commit left, so the sqlite3 shell can open the file again', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
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

test("a pass that did not load says whether its failures are the user's to fix, as the source classifies them", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  // What an SDK throws when macOS denies its store.
  class StoreDeniedError extends Error {}
  class Guarded extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'guarded';
    readonly guarded = stream('guarded');
    readonly broken = stream('broken');
    protected readonly catalog = new Catalog([this.guarded, this.broken]);
    failures: Record<string, Error> = {};
    opening: Error | null = null;

    override failureType(error: unknown) {
      return error instanceof StoreDeniedError ? 'config' : 'system';
    }

    protected override async open() {
      if (this.opening !== null) throw this.opening;
      return new AsyncDisposableStack();
    }

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      const failure = this.failures[configuration.stream.name];
      if (failure !== undefined) throw failure;
      yield { stream: configuration.stream.name, data: { id: 'kept' } };
    }
  }
  const source = new Guarded();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'guarded',
        source,
        destination,
        steps: [
          new Copy(source.guarded, destination.table('guarded')),
          new Copy(source.broken, destination.table('broken')),
        ],
      }),
    ],
    history,
  });
  const pass = async () => {
    await pipeline.run().catch(() => {});
    return readPassStatus(destination.path).pass;
  };

  source.failures = {
    guarded: new StoreDeniedError('The store is behind Full Disk Access.'),
    broken: new Error('The store is corrupt.'),
  };
  const both = await pass();
  const coverage = shell(
    destination.path,
    "SELECT stream, json_extract(value, '$.failure_type') AS failure_type FROM extraction_coverage, json_each(failures) WHERE attempt_id = (SELECT latest_attempt_id FROM sync_status) ORDER BY stream",
  ).rows;
  source.failures = { broken: new Error('The store is corrupt.') };
  const systemOnly = await pass();
  source.failures = {};
  source.opening = new StoreDeniedError(
    'The store is behind Full Disk Access.',
  );
  const unopened = await pass();
  source.opening = null;
  const loaded = await pass();

  assert.deepEqual([both?.state, both?.failureType], ['failed', 'config']);
  assert.deepEqual(coverage, [
    { stream: 'broken', failure_type: 'system' },
    { stream: 'guarded', failure_type: 'config' },
  ]);
  assert.deepEqual(
    [systemOnly?.state, systemOnly?.failureType],
    ['partial', 'system'],
  );
  assert.deepEqual(
    [unopened?.state, unopened?.failureType],
    ['failed', 'config'],
  );
  assert.deepEqual([loaded?.state, loaded?.failureType], ['succeeded', null]);
  assert.deepEqual(
    shell(
      destination.path,
      'SELECT status, failure_type FROM sync_attempts ORDER BY attempt_id',
    ).rows,
    [
      { status: 'failed', failure_type: 'config' },
      { status: 'partial', failure_type: 'system' },
      { status: 'failed', failure_type: 'config' },
      { status: 'succeeded', failure_type: null },
    ],
  );
});

test('each recorded failure keeps the causes its error chains, such as why a connection failed', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  // A real fetch to a port nobody listens on: undici's "fetch failed",
  // whose cause says the connection was refused.
  await using server = await new HttpServer().start(() => {});
  await server.cleanup();
  const refused = await fetch(`${server.origin}/`).then(
    () => assert.fail('a closed port answered'),
    (error: unknown) => error,
  );
  assert.ok(refused instanceof Error, String(refused));
  class Fetching extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'fetching';
    readonly files = stream('files');
    protected readonly catalog = new Catalog([this.files]);
    failing: Error | null = null;
    opening: Error | null = null;

    protected override async open() {
      if (this.opening !== null) throw this.opening;
      return new AsyncDisposableStack();
    }

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      if (this.failing !== null) throw this.failing;
      yield { stream: configuration.stream.name, data: { id: 'kept' } };
    }
  }
  const source = new Fetching();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'fetching',
        source,
        destination,
        steps: [new Copy(source.files, destination.table('files'))],
      }),
    ],
    history,
  });
  const failures = async () => {
    await pipeline.run().catch(() => {});
    return shell(
      destination.path,
      "SELECT json_extract(value, '$.error') AS error, json_extract(value, '$.stacktrace') AS stacktrace FROM extraction_coverage, json_each(failures) WHERE attempt_id = (SELECT latest_attempt_id FROM sync_status)",
    ).rows;
  };

  source.failing = refused;
  const streamFailed = await failures();
  source.failing = null;
  source.opening = refused;
  const openFailed = await failures();

  for (const recorded of [streamFailed, openFailed]) {
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].error, 'fetch failed');
    assert.match(
      recorded[0].stacktrace,
      /\[cause\]: Error: connect ECONNREFUSED 127\.0\.0\.1:\d+/,
    );
    assert.match(recorded[0].stacktrace, /code: 'ECONNREFUSED'/);
  }
});

function stream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
}

test('a pass a killed process left running stays running, until a history that is the sole writer of its connection starts the next run', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  const path = join(scratch.path, 'data.sqlite');
  // A process that begins a pass of notes, then is killed while it reads.
  const pass = `
    import { Catalog, Connection, Copy, Pipeline, Source, Stream } from '@workspace/elt';
    import { SQLiteDestination, SQLiteSyncHistory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
    class Hanging extends Source {
      identity = 'hanging';
      notes = new Stream({
        name: 'notes',
        jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
        supportedSyncModes: ['full_refresh'],
      });
      catalog = new Catalog([this.notes]);
      coverage() { return { description: 'test', selection: {} }; }
      async currentAsOf() { return null; }
      async open() { return new AsyncDisposableStack(); }
      async *observe({ streams }) { yield streams; }
      async *extract() {
        yield { stream: 'notes', data: { id: 'n1' } };
        process.stdout.write('reading\\n');
        await new Promise(() => setInterval(() => {}, 1 << 30));
      }
    }
    const source = new Hanging();
    const destination = new SQLiteDestination({ path: process.env.DATABASE });
    await new Pipeline({
      connections: [new Connection({ name: 'notes', source, destination, steps: [new Copy(source.notes, destination.table('notes'))] })],
      history: new SQLiteSyncHistory(),
    }).run();
  `;
  const killed = spawn(process.execPath, ['--input-type=module', '-e', pass], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATABASE: path },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(killed, 'exit');
  await Promise.race([
    once(killed.stdout, 'data'),
    exited.then(() => assert.fail('the process ended before its pass read')),
  ]);
  killed.kill('SIGKILL');
  await exited;
  const source = new Finishing();
  const destination = new SQLiteDestination({ path });
  const connection = new Connection({
    name: 'notes',
    source,
    destination,
    steps: [new Copy(source.notes, destination.table('notes'))],
  });
  const attempts = () => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database
      .prepare(
        'SELECT status, error, failure_type FROM sync_attempts ORDER BY attempt_id',
      )
      .all()
      .map((row) => ({ ...row }));
  };

  await new Pipeline({
    connections: [connection],
    history: new SQLiteSyncHistory(),
  }).run();
  const shared = attempts();
  await new Pipeline({
    connections: [connection],
    history: new SQLiteSyncHistory({ soleWriter: true }),
  }).run();
  const sole = attempts();

  const succeeded = { status: 'succeeded', error: null, failure_type: null };
  assert.deepEqual(shared, [
    { status: 'running', error: null, failure_type: null },
    succeeded,
  ]);
  assert.deepEqual(sole, [
    {
      status: 'failed',
      error: 'The process running this pass ended before the pass did',
      failure_type: 'system',
    },
    succeeded,
    succeeded,
  ]);
});

// A source of notes that loads one note and ends.
class Finishing extends LiveSource {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  readonly identity = 'finishing';
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.notes]);

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(configuration: CopyConfiguration) {
    yield { stream: configuration.stream.name, data: { id: 'n1' } };
  }
}
