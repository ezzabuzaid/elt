import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  PipelineError,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Measures keyed by id, whose amount has the JSON type the run declares.
const measures = (amount: 'number' | 'integer') =>
  new Stream({
    name: 'measures',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, amount: { type: amount } },
      required: ['id', 'amount'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });

// Reads the records a run gives, then a checkpoint of its own run number,
// and keeps each state the engine gave it.
class Measured extends Source {
  readonly identity = 'measured';
  protected readonly catalog: Catalog;
  readonly #records: readonly object[];
  readonly #run: number;
  readonly #states: unknown[];

  constructor(
    stream: Stream,
    records: readonly object[],
    run: number,
    states: unknown[],
  ) {
    super();
    this.catalog = new Catalog([stream]);
    this.#records = records;
    this.#run = run;
    this.#states = states;
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

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ) {
    this.#states.push(state);
    const stream = configuration.stream.name;
    for (const data of this.#records) yield { stream, data };
    yield { type: 'STATE' as const, stream, state: { run: this.#run } };
  }
}

// One run of the measures copy into data.sqlite in directory, with amount
// typed as the run declares.
const run = (
  directory: string,
  amount: 'number' | 'integer',
  records: readonly object[],
  number: number,
  states: unknown[],
) => {
  const stream = measures(amount);
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  return new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'measured',
        source: new Measured(stream, records, number, states),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'checkpoints.sqlite'),
        }),
        steps: [
          new Copy(stream, destination.table('measures'), {
            id: 'measures',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  }).run();
};

// The id, amount and the storage class of the amount of each stored row.
function stored(directory: string) {
  using database = open(join(directory, 'data.sqlite'));
  return database
    .prepare(
      'SELECT id, amount, typeof(amount) AS type FROM measures ORDER BY id',
    )
    .all()
    .map((row) => ({ ...row }));
}

test('a number field that becomes an integer fails its copy, naming the column, while a stored value has a fraction, and the row and checkpoint stay as they were', async () => {
  await using scratch = await new TemporaryFiles().directory('exact-cast-');
  const states: unknown[] = [];
  await run(scratch.path, 'number', [{ id: 'a', amount: 1.5 }], 1, states);

  await assert.rejects(run(scratch.path, 'integer', [], 2, states), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.match(String(error.errors[0]), /amount/);
    assert.match(String(error.errors[0]), /INTEGER/);
    return true;
  });

  assert.deepEqual(stored(scratch.path), [
    { id: 'a', amount: 1.5, type: 'real' },
  ]);
  await run(scratch.path, 'number', [], 3, states);
  assert.deepEqual(states, [null, { run: 1 }]);
});

test('a number field that becomes an integer evolves in place, keeping its checkpoint, when each stored value is whole', async () => {
  await using scratch = await new TemporaryFiles().directory('exact-cast-');
  const states: unknown[] = [];
  await run(scratch.path, 'number', [{ id: 'a', amount: 2 }], 1, states);

  await run(scratch.path, 'integer', [], 2, states);

  assert.deepEqual(stored(scratch.path), [
    { id: 'a', amount: 2, type: 'integer' },
  ]);
  assert.deepEqual(states, [null, { run: 1 }]);
});

test('an integer field that becomes a number widens in place, keeping each value and the checkpoint', async () => {
  await using scratch = await new TemporaryFiles().directory('exact-cast-');
  const states: unknown[] = [];
  await run(scratch.path, 'integer', [{ id: 'a', amount: 7 }], 1, states);

  await run(scratch.path, 'number', [{ id: 'b', amount: 0.25 }], 2, states);

  assert.deepEqual(stored(scratch.path), [
    { id: 'a', amount: 7, type: 'real' },
    { id: 'b', amount: 0.25, type: 'real' },
  ]);
  assert.deepEqual(states, [null, { run: 1 }]);
});
