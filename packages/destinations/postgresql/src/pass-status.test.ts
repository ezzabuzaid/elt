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
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
  readPassStatus,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a read: a message, a wait the test ends, or a failure.
type Step = SourceMessage | (() => Promise<void>);

// Reads the steps a test scripts for each stream, keyed by the stream's name.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #steps: Readonly<Record<string, readonly Step[]>>;

  constructor(
    streams: readonly Stream[],
    steps: Readonly<Record<string, readonly Step[]>>,
  ) {
    super();
    this.catalog = new Catalog(streams);
    this.#steps = steps;
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

  protected override async *extract(configuration: CopyConfiguration) {
    for (const step of this.#steps[configuration.stream.name] ?? [])
      if (typeof step === 'function') await step();
      else yield step;
  }
}

const records = (name: string) =>
  new Stream({
    name,
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });

const record = (stream: string, id: string) => ({ stream, data: { id } });

// One connection, named as its schema, that copies each stream into a table.
function connection(
  url: string,
  name: string,
  steps: Readonly<Record<string, readonly Step[]>>,
) {
  const streams = Object.keys(steps).map(records);
  const destination = new PostgresDestination({ url, schema: name });
  return new Connection({
    name,
    source: new Scripted(streams, steps),
    destination,
    steps: streams.map(
      (stream) => new Copy(stream, destination.table(stream.name)),
    ),
  });
}

const run = (url: string, ...connections: Connection<PostgresTable>[]) =>
  new Pipeline({
    clock: globalThis,
    connections,
    history: new PostgresSyncHistory({ url }),
  }).run();

// A wait the test ends, and a promise that settles once the read reached it.
function latch() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    step: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

const broken = (message: string) => async () => {
  throw new Error(message);
};

test('readPassStatus of a database that no history recorded reads no pass and no streams', async () => {
  await using database = await databases.database();

  const status = await readPassStatus(database.connectionString);

  assert.deepEqual(status, { pass: null, streams: [] });
});

test('readPassStatus reads a running pass as running, and its streams as running', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const wait = latch();
  const passing = run(
    url,
    connection(url, 'notes', { notes: [wait.step, record('notes', 'n1')] }),
  );
  await wait.reached;

  const during = await readPassStatus(url);
  wait.release();
  await passing;

  assert.equal(during.pass?.state, 'running');
  assert.equal(during.pass?.completedAt, null);
  assert.deepEqual(
    during.streams.map(({ stream, state, error }) => [stream, state, error]),
    [['notes', 'running', null]],
  );
});

test('readPassStatus reads the latest passes of several connections as one pass, and each stream with the errors of its latest attempt, which a later attempt that loads it clears', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const notes = connection(url, 'notes', { notes: [record('notes', 'n1')] });
  await assert.rejects(
    run(
      url,
      notes,
      connection(url, 'mail', {
        inbox: [broken('The inbox broke')],
        sent: [record('sent', 's1')],
      }),
    ),
    PipelineError,
  );

  const failed = await readPassStatus(url);
  const [times] = await sql<{ started: Date; completed: Date }[]>`
    SELECT min(started_at) AS started, max(completed_at) AS completed
    FROM marts.sync_attempts`;
  await run(
    url,
    connection(url, 'mail', {
      inbox: [record('inbox', 'i1')],
      sent: [record('sent', 's1')],
    }),
  );
  const loaded = await readPassStatus(url);

  assert.deepEqual(
    { ...failed.pass, currentAsOf: undefined },
    {
      state: 'partial',
      startedAt: times?.started.toISOString(),
      completedAt: times?.completed.toISOString(),
      lastSucceededAt: null,
      currentAsOf: undefined,
      error:
        'The following copies did not load completely: inbox: The inbox broke',
      failureType: 'system',
    },
  );
  assert.deepEqual(
    failed.streams.map(({ stream, state, error, lastSucceededAt }) => [
      stream,
      state,
      error,
      lastSucceededAt === null,
    ]),
    [
      ['inbox', 'failed', 'The inbox broke', true],
      ['notes', 'succeeded', null, false],
      ['sent', 'succeeded', null, false],
    ],
  );
  assert.equal(loaded.pass?.state, 'succeeded');
  assert.equal(loaded.pass?.error, null);
  assert.deepEqual(
    loaded.streams.map(({ stream, state, error }) => [stream, state, error]),
    [
      ['inbox', 'succeeded', null],
      ['notes', 'succeeded', null],
      ['sent', 'succeeded', null],
    ],
  );
});

test('int64 and localTimestamp columns keep the int64 and date-time-local formats, as an inferred column keeps them', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const bookings = new Stream({
    name: 'bookings',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        start: { type: ['string', 'null'] },
        exact: { type: ['string', 'null'] },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({ url, schema: 'raw' });

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'raw',
        source: new Scripted([bookings], {
          bookings: [
            {
              stream: 'bookings',
              data: {
                id: '9007199254740993',
                start: '2026-10-01T08:30:00.123',
                exact: '2026-10-01T08:30:00.1234567',
              },
            },
            {
              stream: 'bookings',
              data: { id: '-9223372036854775808', start: null, exact: null },
            },
          ],
        }),
        destination,
        steps: [
          new Copy(
            bookings,
            destination.table('bookings', (columns) => [
              columns.int64('id'),
              columns.localTimestamp('start', 3),
              columns.localTimestamp('exact', 7),
            ]),
          ),
        ],
      }),
    ],
  }).run();

  assert.deepEqual(
    [
      ...(await sql`
        SELECT id::text AS id, to_char(start, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS start, exact::text AS exact
        FROM raw.bookings ORDER BY id`),
    ],
    [
      { id: '-9223372036854775808', start: null, exact: null },
      {
        id: '9007199254740993',
        start: '2026-10-01T08:30:00.123',
        exact: '2026-10-01T08:30:00.1234567',
      },
    ],
  );
  assert.deepEqual(
    [
      ...(await sql`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'raw' AND table_name = 'bookings'
          AND column_name IN ('id', 'start', 'exact') ORDER BY column_name`),
    ],
    [
      { column_name: 'exact', data_type: 'text' },
      { column_name: 'id', data_type: 'bigint' },
      { column_name: 'start', data_type: 'timestamp without time zone' },
    ],
  );
});
