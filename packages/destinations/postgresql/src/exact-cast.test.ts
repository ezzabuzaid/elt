import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

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
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

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

// One run of the measures copy into schema raw of url, with amount typed as
// the run declares.
const run = (
  url: string,
  amount: 'number' | 'integer',
  records: readonly object[],
  number: number,
  states: unknown[],
) => {
  const stream = measures(amount);
  const destination = new PostgresDestination({ url, schema: 'raw' });
  return new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'raw',
        source: new Measured(stream, records, number, states),
        destination,
        checkpoints: new PostgresCheckpointStore({ url, schema: 'raw' }),
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

// The id, amount and the type of the amount column of each stored row.
const stored = async (sql: postgres.Sql) =>
  (
    await sql`SELECT id, amount::text AS amount, pg_typeof(amount)::text AS type FROM raw.measures ORDER BY id`
  ).map((row) => ({ ...row }));

test('a number field that becomes an integer fails its copy, naming the column, while a stored value has a fraction, and the row and checkpoint stay as they were', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const states: unknown[] = [];
    await run(url, 'number', [{ id: 'a', amount: 1.5 }], 1, states);

    await assert.rejects(run(url, 'integer', [], 2, states), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.match(String(error.errors[0]), /"amount"/);
      assert.match(String(error.errors[0]), /bigint/i);
      return true;
    });

    assert.deepEqual(await stored(sql), [
      { id: 'a', amount: '1.5', type: 'double precision' },
    ]);
    await run(url, 'number', [], 3, states);
    assert.deepEqual(states, [null, { run: 1 }]);
  } finally {
    await sql.end();
  }
});

test('a number field that becomes an integer evolves in place, keeping its checkpoint, when each stored value is whole', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const states: unknown[] = [];
    await run(url, 'number', [{ id: 'a', amount: 2 }], 1, states);

    await run(url, 'integer', [], 2, states);

    assert.deepEqual(await stored(sql), [
      { id: 'a', amount: '2', type: 'bigint' },
    ]);
    assert.deepEqual(states, [null, { run: 1 }]);
  } finally {
    await sql.end();
  }
});

test('an integer field that becomes a number widens in place, keeping each value and the checkpoint', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const states: unknown[] = [];
    await run(url, 'integer', [{ id: 'a', amount: 7 }], 1, states);

    await run(url, 'number', [{ id: 'b', amount: 0.25 }], 2, states);

    assert.deepEqual(await stored(sql), [
      { id: 'a', amount: '7', type: 'double precision' },
      { id: 'b', amount: '0.25', type: 'double precision' },
    ]);
    assert.deepEqual(states, [null, { run: 1 }]);
  } finally {
    await sql.end();
  }
});
