import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { Latch } from '@zukhruf/async';
import { timebox } from '@zukhruf/testing/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type LoadedRow,
  Pipeline,
  Rule,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

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

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
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
