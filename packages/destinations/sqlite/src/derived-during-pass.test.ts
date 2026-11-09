import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';

import { Latch } from '@zukhruf/async';
import { open } from '@zukhruf/sqlite-open';
import { timebox } from '@zukhruf/testing/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DerivedDataset,
  DerivedDatasetError,
  Gauge,
  type LoadedRow,
  Pipeline,
  Rule,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// The upstream of a test source, which the test fills before it reads: a
// watch finds it changed at its first check and unchanged after.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A long pass: the notes of first and a checkpoint, then those of second
// and a checkpoint once rest opens, as a crawl that commits its first pages
// long before its last. Each run waits on the latch rest is then.
class Notes extends Source {
  readonly identity = 'notes';
  rest = new Latch();
  first: readonly string[] = ['n1'];
  second: readonly string[] = ['n2'];
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
  });
  protected readonly catalog = new Catalog([this.notes]);

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]) {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    const stream = configuration.stream.name;
    const { rest, first, second } = this;
    for (const id of first) yield { stream, data: { id } };
    yield { type: 'STATE' as const, stream, state: { read: 1 } };
    await rest.wait();
    for (const id of second) yield { stream, data: { id } };
    yield { type: 'STATE' as const, stream, state: { read: 2 } };
  }
}

// Each note's id in capitals; it fails on the ids in failing, as a model
// that refuses, holds an id until its latch in holding opens, and records
// each id it is called with; a call whose signal aborted while it held
// throws, as a model call that the stop ended.
class Shout extends Rule<string, string> {
  readonly failing = new Set<string>();
  readonly holding = new Map<string, Latch>();
  readonly calls: string[] = [];
  readonly key = { name: 'id', description: 'Note id.' };
  readonly output = {
    loud: { description: 'The id in capitals.', type: 'text' as const },
  };
  readonly batch = 1;
  readonly concurrency = 1;

  read(row: LoadedRow) {
    return { key: String(row.id), input: String(row.id) };
  }

  async identity() {
    return 'shout-v1';
  }

  async compute(inputs: readonly string[], signal?: AbortSignal) {
    this.calls.push(...inputs);
    for (const input of inputs) await this.holding.get(input)?.wait();
    signal?.throwIfAborted();
    return inputs.map((input) =>
      this.failing.has(input)
        ? { error: 'the model refused' }
        : { value: { loud: input.toUpperCase() } },
    );
  }
}

function notesPipeline(directory: string) {
  const source = new Notes();
  const shout = new Shout();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('raw_notes').withReaderView('notes');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'checkpoints.sqlite'),
        }),
        steps: [
          new Copy(source.notes, target, {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'shouts',
        description: 'Each note id in capitals.',
        from: [target],
        compute: shout,
      }),
    ],
  });
  // What the sqlite3 shell that agents read with finds in shouts.
  const shouts = () => {
    const { stdout } = spawnSync(
      '/usr/bin/sqlite3',
      [
        '-readonly',
        '-json',
        destination.path,
        'SELECT id, status, loud FROM shouts ORDER BY id',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout || '[]');
  };
  // How the history recorded each pass.
  const passes = () => {
    const { stdout } = spawnSync(
      '/usr/bin/sqlite3',
      [
        '-readonly',
        '-json',
        destination.path,
        'SELECT status FROM sync_attempts',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout || '[]');
  };
  return { source, shout, pipeline, shouts, passes };
}

const untilShown = {
  minTimeout: 10,
  maxRetryTime: 5_000,
  shouldRetry: ({ error }: { error: unknown }) =>
    error instanceof assert.AssertionError,
};

test('during a long run, a computed dataset holds the outputs of the rows the first checkpoint committed before the pass ends', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const { source, pipeline, shouts } = notesPipeline(scratch.path);

  const run = pipeline.run();
  try {
    await timebox(() => {
      assert.deepEqual(shouts(), [
        { id: 'n1', status: 'computed', loud: 'N1' },
      ]);
    }, untilShown);
  } finally {
    source.rest.open();
    await run;
  }

  assert.deepEqual(shouts(), [
    { id: 'n1', status: 'computed', loud: 'N1' },
    { id: 'n2', status: 'computed', loud: 'N2' },
  ]);
});

test('under a watch, a consumer reads the outputs of the rows the first checkpoint committed before the watch yields the pass', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const { source, pipeline, shouts } = notesPipeline(scratch.path);
  const controller = new AbortController();
  const watching = pipeline.watch({ signal: controller.signal });

  const first = watching.next();
  try {
    await timebox(() => {
      assert.deepEqual(shouts(), [
        { id: 'n1', status: 'computed', loud: 'N1' },
      ]);
    }, untilShown);
  } finally {
    source.rest.open();
    await first;
    controller.abort();
    await watching.return(undefined);
  }

  assert.deepEqual(shouts(), [
    { id: 'n1', status: 'computed', loud: 'N1' },
    { id: 'n2', status: 'computed', loud: 'N2' },
  ]);
});

test('a row that fails during a pass is tried again only by the refresh after the next pass, as each pass tries it once', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const { source, shout, pipeline, shouts } = notesPipeline(scratch.path);
  shout.failing.add('n1');
  const first = pipeline.run();
  try {
    await timebox(() => {
      assert.deepEqual(shouts(), [{ id: 'n1', status: 'failed', loud: null }]);
    }, untilShown);
  } finally {
    source.rest.open();
    await first;
  }
  const triedInFirst = shout.calls.filter((id) => id === 'n1').length;
  const failedAfterFirst = shouts()[0];
  shout.failing.clear();
  source.rest = new Latch();
  source.first = ['n1', 'n3'];

  const second = pipeline.run();
  try {
    // n3 is new, so a refresh during the pass makes it; n1 waits.
    await timebox(() => {
      assert.deepEqual(
        shouts().map(({ id, status }: { id: string; status: string }) => [
          id,
          status,
        ]),
        [
          ['n1', 'failed'],
          ['n2', 'computed'],
          ['n3', 'computed'],
        ],
      );
    }, untilShown);
  } finally {
    source.rest.open();
    await second;
  }

  assert.equal(triedInFirst, 1);
  assert.deepEqual(failedAfterFirst, {
    id: 'n1',
    status: 'failed',
    loud: null,
  });
  assert.deepEqual(shouts(), [
    { id: 'n1', status: 'computed', loud: 'N1' },
    { id: 'n2', status: 'computed', loud: 'N2' },
    { id: 'n3', status: 'computed', loud: 'N3' },
  ]);
  assert.deepEqual(
    shout.calls.filter((id) => id === 'n1'),
    ['n1', 'n1'],
  );
});

test('a run that its signal stops after its pass, while a refresh reads, resolves as its pass did and keeps what it committed', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const { source, shout, pipeline, shouts, passes } = notesPipeline(
    scratch.path,
  );
  const held = new Latch();
  shout.holding.set('n1', held);
  source.rest.open();
  const stop = new AbortController();

  const run = pipeline.run({ signal: stop.signal });
  try {
    await timebox(() => {
      assert.deepEqual(passes(), [{ status: 'succeeded' }]);
      assert.deepEqual(shout.calls, ['n1']);
    }, untilShown);
  } finally {
    stop.abort();
    held.open();
  }
  const results = await run;

  assert.deepEqual(
    results.map(({ count }) => count),
    [2],
  );
  // The read that the stop ended kept nothing; the next run reads it.
  assert.deepEqual(shouts(), []);
});

test('a row that a refresh during a stopped pass failed is tried again by the refresh after the pass of a restarted pipeline, once', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const before = notesPipeline(scratch.path);
  before.shout.failing.add('n1');
  const stop = new AbortController();
  const stopped = before.pipeline.run({ signal: stop.signal }).then(
    () => 'resolved',
    (error: unknown) => error,
  );
  try {
    await timebox(() => {
      assert.deepEqual(before.shouts(), [
        { id: 'n1', status: 'failed', loud: null },
      ]);
    }, untilShown);
  } finally {
    stop.abort();
    before.source.rest.open();
  }
  const outcome = await stopped;
  // A new process: a new pipeline over the same files.
  const after = notesPipeline(scratch.path);
  after.source.rest.open();

  await after.pipeline.run();

  assert.equal(outcome, stop.signal.reason);
  assert.deepEqual(before.shout.calls, ['n1']);
  assert.deepEqual(
    after.shout.calls.filter((id) => id === 'n1'),
    ['n1'],
  );
  assert.deepEqual(after.shouts(), [
    { id: 'n1', status: 'computed', loud: 'N1' },
    { id: 'n2', status: 'computed', loud: 'N2' },
  ]);
});

test('a dataset that fails during a watch names itself, and the sync history does not blame the copy that it stopped', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const source = new Notes();
  const path = join(scratch.path, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  class Refused extends DerivedDataset<ReturnType<typeof destination.table>> {
    readonly name = 'refused_dataset';
    override async refresh(): Promise<void> {
      // The pass is still running; its source can end once the stop comes.
      source.rest.open();
      throw new Error('no such column: nope');
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.notes, destination.table('raw_notes'), {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
    derived: [new Refused()],
  });

  const failure = await Array.fromAsync(
    pipeline.watch({ signal: new AbortController().signal }),
  ).then(
    () => assert.fail('the failed dataset should stop the watch'),
    (error: unknown) => error,
  );

  using database = open(path, { readOnly: true });
  const attempts = database
    .prepare('SELECT status, error FROM sync_attempts')
    .all();
  assert.ok(failure instanceof DerivedDatasetError, String(failure));
  assert.equal(failure.dataset, 'refused_dataset');
  assert.match(failure.message, /refused_dataset.*no such column: nope/);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, 'cancelled');
  assert.doesNotMatch(String(attempts[0]?.error), /no such column/);
});

// A gauge that a test moves, as an upstream that changed.
class Dial extends Gauge<number> {
  turns = 0;
  protected async read(): Promise<number> {
    return this.turns;
  }
}

// One table of rows, read whole, which a test changes.
class Rows extends Source {
  readonly identity: string;
  readonly dial = new Dial();
  rows: readonly string[];
  readonly table: Stream;
  protected readonly catalog: Catalog;

  constructor(name: string, rows: readonly string[]) {
    super();
    this.identity = name;
    this.rows = rows;
    this.table = new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description: 'A row.',
        properties: { id: { type: 'string', description: 'Row id.' } },
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
    this.catalog = new Catalog([this.table]);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]) {
    return [{ gauge: this.dial, streams, interval: 100, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const id of this.rows)
      yield { stream: configuration.stream.name, data: { id } };
  }
}

test('a target dropped by hand does not stop a watch: its dataset waits with its rows, and once the copy loads the target again it asks the rule for nothing', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-derived-');
  const path = join(scratch.path, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const dropped = new Rows('dropped', ['a1']);
  const other = new Rows('other', ['b1']);
  const shout = new Shout();
  // Runs after the computed dataset, and only when it did not fail, so a test
  // can wait for the refresh that it means.
  class Refreshes extends DerivedDataset<ReturnType<typeof destination.table>> {
    readonly name = 'refreshes';
    count = 0;
    override async refresh(): Promise<void> {
      this.count += 1;
    }
  }
  const refreshes = new Refreshes();
  const target = destination
    .table('raw_dropped')
    .withReaderView('dropped_rows');
  const connection = (source: Rows, to: ReturnType<typeof destination.table>) =>
    new Connection({
      name: source.identity,
      source,
      destination,
      steps: [new Copy(source.table, to)],
    });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      connection(dropped, target),
      connection(other, destination.table('raw_other')),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'shouts',
        description: 'Each id in capitals.',
        from: [target],
        compute: shout,
      }),
      refreshes,
    ],
  });
  // What a reader finds; a table the pipeline has not made yet holds nothing.
  const read = (sql: string) => {
    using database = open(path, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } catch {
      return [];
    }
  };
  const controller = new AbortController();
  const watch = pipeline.watch({ signal: controller.signal });
  const passes = (async () => {
    for await (const _ of watch);
  })();
  try {
    await timebox(() => {
      assert.deepEqual(
        read('SELECT id, status FROM shouts').map(({ id, status }) => [
          id,
          status,
        ]),
        [['a1', 'computed']],
      );
    }, untilShown);

    {
      // A person's hand: no operation of a pipeline drops a target.
      using database = open(path);
      database.exec('DROP TABLE raw_dropped');
    }
    const beforeOther = refreshes.count;
    // A commit of the other connection asks for a refresh over the view of the
    // table that is gone.
    other.rows = ['b1', 'b2'];
    other.dial.turns += 1;
    await timebox(() => {
      assert.ok(refreshes.count > beforeOther);
      assert.equal(read('SELECT id FROM raw_other').length, 2);
    }, untilShown);
    const during = read('SELECT id FROM shouts').map(({ id }) => id);
    const beforeReload = refreshes.count;
    dropped.dial.turns += 1;
    await timebox(() => {
      assert.ok(refreshes.count > beforeReload);
      assert.equal(read('SELECT id FROM raw_dropped').length, 1);
    }, untilShown);
    await timebox(() => {
      assert.deepEqual(
        read('SELECT id, status FROM shouts').map(({ id, status }) => [
          id,
          status,
        ]),
        [['a1', 'computed']],
      );
    }, untilShown);

    assert.deepEqual(during, ['a1']);
    assert.deepEqual(shout.calls, ['a1']);
  } finally {
    controller.abort();
    await passes.catch(() => {});
  }
});

// A process of a host: it reloads one table of 1000 rows into a file, each row
// marked with its load. With DIE set it says so in the middle of the rows and
// waits for the test to kill it. It is a real process because only the death of
// a process proves what its unfinished writes leave behind.
const loadingProcess = `
  const { Catalog, Connection, Copy, Pipeline, Source, Stream } = await import('@eltjs/elt');
  const { SQLiteDestination, SQLiteSyncHistory } = await import(process.env.ELT_SQLITE);
  const { LOAD, DIE, DATA } = process.env;
  class Bookings extends Source {
    identity = 'bookings';
    bookings = new Stream({
      name: 'bookings',
      jsonSchema: {
        type: 'object',
        description: 'A booking.',
        properties: {
          id: { type: 'string', description: 'Booking id.' },
          load: { type: 'string', description: 'The load that wrote it.' },
        },
        required: ['id', 'load'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
    catalog = new Catalog([this.bookings]);
    coverage() { return { description: 'test', selection: {} }; }
    async currentAsOf() { return null; }
    async open() { return new AsyncDisposableStack(); }
    async *extract({ stream }) {
      for (let id = 0; id < 1000; id += 1) {
        if (id === 500 && DIE !== undefined) {
          process.stdout.write('loading');
          await new Promise(() => setInterval(() => {}, 1000));
        }
        yield { stream: stream.name, data: { id: String(id), load: LOAD } };
      }
    }
  }
  const source = new Bookings();
  const destination = new SQLiteDestination({ path: DATA });
  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory({ soleWriter: true }),
    connections: [new Connection({
      name: 'bookings',
      source,
      destination,
      steps: [new Copy(source.bookings, destination.table('bookings'))],
    })],
  }).run();
`;

test(
  'a process killed in the middle of a reload leaves readers the whole table of the load before, and the next process on the same file replaces it and records the dead pass as failed',
  { timeout: 120_000 },
  async () => {
    await using scratch = await new TemporaryFiles().directory('elt-killed-');
    const data = join(scratch.path, 'data.sqlite');
    const load = (extra: Record<string, string>) =>
      spawn(process.execPath, ['--input-type=module', '-e', loadingProcess], {
        env: {
          ...process.env,
          ELT_SQLITE: import.meta.resolve('./index.ts'),
          DATA: data,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    const exited = (child: ReturnType<typeof load>) =>
      new Promise<number | null>((resolve) =>
        child.once('exit', (code) => resolve(code)),
      );
    const seen = () => {
      using database = open(data, { readOnly: true });
      return {
        integrity: database.prepare('PRAGMA integrity_check').get()
          ?.integrity_check,
        loads: database
          .prepare(
            'SELECT load, COUNT(*) AS bookings, COUNT(DISTINCT id) AS ids FROM bookings GROUP BY load',
          )
          .all()
          .map((row) => ({ ...row })),
        errors: database
          .prepare('SELECT error FROM sync_attempts ORDER BY attempt_id')
          .all()
          .map(({ error }) => error),
      };
    };
    assert.equal(await exited(load({ LOAD: 'first' })), 0);

    const killed = load({ LOAD: 'killed', DIE: '1' });
    const gone = exited(killed);
    await once(killed.stdout, 'data');
    killed.kill('SIGKILL');
    await gone;
    const afterKill = seen();
    assert.equal(await exited(load({ LOAD: 'next' })), 0);
    const afterNext = seen();

    assert.deepEqual(afterKill.integrity, 'ok');
    assert.deepEqual(afterKill.loads, [
      { load: 'first', bookings: 1000, ids: 1000 },
    ]);
    assert.deepEqual(afterNext.integrity, 'ok');
    assert.deepEqual(afterNext.loads, [
      { load: 'next', bookings: 1000, ids: 1000 },
    ]);
    assert.deepEqual(afterNext.errors, [
      null,
      'The process running this pass ended before the pass did',
      null,
    ]);
  },
);
