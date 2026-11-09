import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createClock } from '@sinonjs/fake-timers';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  PassFailed,
  PassFinished,
  Pipeline,
  Source,
  Stream,
  passChannels,
} from '@eltjs/elt';

import {
  SQLiteDestination,
  SQLiteSyncHistory,
  readPassStatus,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

// The upstream of a test source, which the test fills before it reads: a
// watch finds it changed at its first check and unchanged after.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// The change signal of streams whose upstream the test filled.
const filled = (streams: readonly Stream[]): ChangeSignal[] => [
  { gauge: new Filled(), streams, interval: 1000, timeout: 1000 },
];

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

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
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

  const running = new Pipeline({
    clock: globalThis,
    connections: [connection],
    history,
  }).run({
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

test('a pass killed in the middle of a commit leaves a file that the sqlite3 shell and readPassStatus read at once, with only the committed rows', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  class Notes extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'notes';
    readonly notes = stream('notes');
    protected readonly catalog = new Catalog([this.notes]);

    protected override async open() {
      return new AsyncDisposableStack();
    }

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
    }

    protected override async *extract() {
      yield { stream: 'notes', data: { id: 'kept' } };
    }
  }
  const source = new Notes();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  await new Pipeline({
    clock: globalThis,
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
    history: new SQLiteSyncHistory(),
  }).run();
  // The connection of a load dies inside its commit, after SQLite spilled
  // the change to the write-ahead log.
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { openDestination } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
       const data = openDestination(process.env.DATABASE);
       data.exec('PRAGMA cache_size = 1; BEGIN IMMEDIATE');
       data.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO notes (id, loaded_at) SELECT 'lost-' || i, loaded_at FROM n, notes");
       process.kill(process.pid, 'SIGKILL');`,
    ],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, DATABASE: destination.path },
      encoding: 'utf8',
    },
  );
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);

  assert.deepEqual(shell(destination.path, 'SELECT id FROM notes'), {
    rows: [{ id: 'kept' }],
    stderr: '',
  });
  assert.equal(readPassStatus(destination.path).pass?.state, 'succeeded');
  // The killed connection had spilled its change, which the reads skipped.
  assert.ok(statSync(`${destination.path}-wal`).size > 0);
});

test('readPassStatus of a path with no file reads no pass and no streams', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');

  assert.deepEqual(readPassStatus(join(scratch.path, 'data.sqlite')), {
    pass: null,
    streams: [],
  });
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

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
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
    clock: globalThis,
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

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
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
    clock: globalThis,
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
    import { Catalog, Connection, Copy, Gauge, Pipeline, Source, Stream } from '@eltjs/elt';
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
      changeSignals(streams) { return [{ gauge: new (class extends Gauge { async read() { return 0; } })(), streams, interval: 1000, timeout: 1000 }]; }
      async *extract() {
        yield { stream: 'notes', data: { id: 'n1' } };
        process.stdout.write('reading\\n');
        await new Promise(() => setInterval(() => {}, 1 << 30));
      }
    }
    const source = new Hanging();
    const destination = new SQLiteDestination({ path: process.env.DATABASE });
    await new Pipeline({ clock: globalThis,
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
  const attempts = () =>
    storedRows(
      path,
      'SELECT status, error, failure_type FROM sync_attempts ORDER BY attempt_id',
    );

  await new Pipeline({
    clock: globalThis,
    connections: [connection],
    history: new SQLiteSyncHistory(),
  }).run();
  const shared = attempts();
  await new Pipeline({
    clock: globalThis,
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

  override changeSignals(streams: readonly Stream[]) {
    return filled(streams);
  }

  protected override async *extract(configuration: CopyConfiguration) {
    yield { stream: configuration.stream.name, data: { id: 'n1' } };
  }
}

test('a sync history dates each pass on the clock of its pipeline, not on the clock of the database', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  const clock = createClock(Date.parse('2001-02-03T04:05:06.000Z'));
  // Each read takes two seconds of the pipeline's clock.
  class Slow extends Finishing {
    protected override async *extract(configuration: CopyConfiguration) {
      clock.tick(2_000);
      yield* super.extract(configuration);
    }
  }
  const source = new Slow();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const connection = new Connection({
    name: 'notes',
    source,
    destination,
    steps: [new Copy(source.notes, destination.table('notes'))],
  });
  const attempts = () =>
    shell(
      destination.path,
      'SELECT connector, started_at, completed_at, status FROM sync_attempts ORDER BY attempt_id',
    ).rows;

  await new Pipeline({
    clock,
    connections: [connection],
    history: new SQLiteSyncHistory(),
  }).run();
  // A process begins a pass and is killed before the pass ends.
  clock.tick(1_000);
  await new SQLiteSyncHistory().begin(
    connection,
    connection.steps.map((copy) => ({ copy, coverage: source.coverage() })),
    new Date(clock.Date.now()),
  );
  clock.tick(1_000);
  await new Pipeline({
    clock,
    connections: [connection],
    history: new SQLiteSyncHistory({ soleWriter: true }),
  }).run();
  // A connection that copies one stream twice fails before it reads.
  clock.tick(1_000);
  await assert.rejects(
    new Pipeline({
      clock,
      connections: [
        new Connection({
          name: 'twice',
          source,
          destination,
          steps: [
            new Copy(source.notes, destination.table('notes'), {
              id: 'twice:notes',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
            new Copy(source.notes, destination.table('notes_again'), {
              id: 'twice:notes-again',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
          ],
        }),
      ],
      history: new SQLiteSyncHistory(),
    }).run(),
    TypeError,
  );

  assert.deepEqual(attempts(), [
    {
      connector: 'notes',
      started_at: '2001-02-03T04:05:06.000Z',
      completed_at: '2001-02-03T04:05:08.000Z',
      status: 'succeeded',
    },
    {
      connector: 'notes',
      started_at: '2001-02-03T04:05:09.000Z',
      completed_at: '2001-02-03T04:05:10.000Z',
      status: 'failed',
    },
    {
      connector: 'notes',
      started_at: '2001-02-03T04:05:10.000Z',
      completed_at: '2001-02-03T04:05:12.000Z',
      status: 'succeeded',
    },
    {
      connector: 'twice',
      started_at: '2001-02-03T04:05:13.000Z',
      completed_at: '2001-02-03T04:05:13.000Z',
      status: 'failed',
    },
  ]);
});

test('a file that several connections load reads as one pass, which is only as good as its worst connection', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  // A source that loads one record, as current as its upstream says, and
  // fails or waits as the test tells it to.
  class Told extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity: string;
    readonly records = stream('records');
    protected readonly catalog = new Catalog([this.records]);
    upstream: Date | null = null;
    failing: Error | null = null;
    // What a read does once it emitted its record.
    afterRead: () => Promise<void> = async () => {};

    constructor(identity: string) {
      super();
      this.identity = identity;
    }

    override async currentAsOf() {
      return this.upstream;
    }

    override failureType(error: unknown) {
      return error instanceof StoreDeniedError ? 'config' : 'system';
    }

    protected override async open() {
      if (this.failing !== null) throw this.failing;
      return new AsyncDisposableStack();
    }

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
    }

    protected override async *extract(configuration: CopyConfiguration) {
      yield { stream: configuration.stream.name, data: { id: 'kept' } };
      await this.afterRead();
    }
  }
  // What an SDK throws when macOS denies its store.
  class StoreDeniedError extends Error {}
  // Named so that the sync_status row of notes comes first.
  const notes = new Told('notes');
  const tasks = new Told('tasks');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    connections: [notes, tasks].map(
      (source) =>
        new Connection({
          name: source.identity,
          source,
          destination,
          steps: [
            new Copy(
              source.records,
              destination.table(`${source.identity}_records`),
            ),
          ],
        }),
    ),
    history: new SQLiteSyncHistory(),
  });
  const pass = async () => {
    await pipeline.run().catch(() => {});
    return readPassStatus(destination.path).pass;
  };
  const attempts = () =>
    shell(
      destination.path,
      'SELECT connector, started_at, completed_at, last_successful_sync_at FROM sync_status ORDER BY connector',
    ).rows;

  tasks.failing = new StoreDeniedError('Tasks are behind Full Disk Access.');
  const denied = await pass();
  const deniedRows = attempts();
  tasks.failing = new Error('The tasks store is corrupt.');
  notes.failing = new Error('The notes store is corrupt.');
  const broken = await pass();
  notes.failing = null;
  tasks.failing = new StoreDeniedError('Tasks are behind Full Disk Access.');
  await pass();
  notes.failing = new Error('The notes store is corrupt.');
  const mixed = await pass();
  tasks.failing = null;
  notes.failing = null;
  notes.upstream = new Date('2026-10-02T00:00:00.000Z');
  tasks.upstream = new Date('2026-10-01T00:00:00.000Z');
  const loaded = await pass();
  const loadedRows = attempts();
  const reading = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  tasks.afterRead = () => {
    reading.resolve();
    return waiting.promise;
  };
  // The pass of notes ends while tasks still reads.
  const notesEnded = Promise.withResolvers<void>();
  const hear = (message: unknown) => {
    if (message instanceof PassFinished && message.connection.source === notes)
      notesEnded.resolve();
  };
  passChannels.finish.subscribe(hear);
  const stop = new AbortController();
  const running = pipeline.run({ signal: stop.signal }).catch(() => {});
  let during;
  try {
    await Promise.all([reading.promise, notesEnded.promise]);
    during = readPassStatus(destination.path).pass;
  } finally {
    passChannels.finish.unsubscribe(hear);
    stop.abort(new Error('stopped by the test'));
    waiting.resolve();
    await running;
  }
  const stopped = readPassStatus(destination.path).pass;

  assert.deepEqual(
    [denied?.state, denied?.failureType, denied?.error],
    [
      'partial',
      'config',
      'The following copies did not load completely: records: Tasks are behind Full Disk Access.',
    ],
  );
  // Tasks never loaded, so it is current as of no time.
  assert.deepEqual(
    [denied?.lastSucceededAt, denied?.currentAsOf],
    [null, null],
  );
  assert.equal(
    denied?.startedAt,
    deniedRows.map((row: { started_at: string }) => row.started_at).sort()[0],
  );
  assert.equal(
    denied?.completedAt,
    deniedRows
      .map((row: { completed_at: string }) => row.completed_at)
      .sort()
      .at(-1),
  );
  assert.deepEqual(
    [broken?.state, broken?.failureType, broken?.error],
    [
      'failed',
      'system',
      'The following copies did not load completely: records: The notes store is corrupt.\nThe following copies did not load completely: records: The tasks store is corrupt.',
    ],
  );
  assert.deepEqual([mixed?.state, mixed?.failureType], ['failed', 'config']);
  assert.deepEqual(
    [loaded?.state, loaded?.failureType, loaded?.error],
    ['succeeded', null, null],
  );
  assert.equal(
    loaded?.lastSucceededAt,
    loadedRows
      .map(
        (row: { last_successful_sync_at: string }) =>
          row.last_successful_sync_at,
      )
      .sort()[0],
  );
  assert.equal(loaded?.currentAsOf, '2026-10-01T00:00:00.000Z');
  assert.equal(during?.state, 'running');
  assert.deepEqual([stopped?.state, stopped?.failureType], ['cancelled', null]);
  assert.match(stopped?.error ?? '', /stopped by the test/);
});

test('a connection that copies one stream twice is recorded as a failed pass and published as one, with the reason that its validation gave', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-passes-');
  class Notes extends LiveSource {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'notes';
    readonly notes = new Stream({
      name: 'notes',
      jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      supportedSyncModes: ['full_refresh'],
    });
    protected readonly catalog = new Catalog([this.notes]);

    protected override async open() {
      return new AsyncDisposableStack();
    }

    override changeSignals(streams: readonly Stream[]) {
      return filled(streams);
    }

    protected override async *extract() {
      yield { stream: 'notes', data: { id: 'never read' } };
    }
  }
  const source = new Notes();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  // A wiring mistake: one stream copied into two tables, which one read
  // cannot do, so the connection never reads.
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'twice',
        source,
        destination,
        steps: [
          new Copy(source.notes, destination.table('notes'), {
            id: 'twice:notes',
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
          new Copy(source.notes, destination.table('notes_again'), {
            id: 'twice:notes-again',
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
        ],
      }),
    ],
  });
  const why = 'Connection twice copies each stream once';
  const failed: unknown[] = [];
  const hear = (message: unknown) => {
    if (message instanceof PassFailed && message.connection.name === 'twice')
      failed.push(message.error);
  };
  passChannels.failure.subscribe(hear);

  try {
    await assert.rejects(pipeline.run(), new TypeError(why));
  } finally {
    passChannels.failure.unsubscribe(hear);
  }

  const { pass } = readPassStatus(destination.path);
  assert.deepEqual([pass?.state, pass?.error], ['failed', why]);
  // The failed attempt covers its stream once, through the first copy of it.
  assert.deepEqual(
    shell(
      destination.path,
      'SELECT stream, target_table, status FROM extraction_coverage WHERE attempt_id = (SELECT latest_attempt_id FROM sync_status)',
    ).rows,
    [{ stream: 'notes', target_table: 'notes', status: 'failed' }],
  );
  assert.deepEqual(failed, [new TypeError(why)]);
});
