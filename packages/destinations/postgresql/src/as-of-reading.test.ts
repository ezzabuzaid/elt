import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  type FieldSchema,
  Gauge,
  type Partition,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
  publishPostgresViews,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a test source's read: a message, or a wait the test ends.
type Step = SourceMessage | (() => Promise<void>);

// Reads the steps a test scripts for each stream, keyed by the stream's name,
// or by `name:value` for each partition of a partitioned stream.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #steps: Readonly<Record<string, readonly Step[]>>;
  readonly #partitions: readonly Partition[];

  constructor(
    streams: readonly Stream[],
    steps: Readonly<Record<string, readonly Step[]>>,
    partitions: readonly Partition[] = [],
  ) {
    super();
    this.catalog = new Catalog(streams);
    this.#steps = steps;
    this.#partitions = partitions;
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

  protected override partitions(): readonly Partition[] {
    return this.#partitions;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
    partition: Partition | null,
  ) {
    const { name } = configuration.stream;
    const key =
      partition === null ? name : `${name}:${Object.values(partition).join()}`;
    for (const step of this.#steps[key] ?? [])
      if (typeof step === 'function') await step();
      else yield step;
  }
}

// Notes keyed by id; a newer copy of a note has a greater version.
const notes = (name = 'notes') =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type: 'integer', description: 'Version of the note.' },
        body: { type: 'string', description: 'Text of the note.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });

const note = (stream: string, id: string, version: number, body = id) => ({
  stream,
  data: { id, version, body },
});
const checkpoint = (stream: string, read: number) => ({
  type: 'STATE' as const,
  stream,
  state: { read },
});

// Readings with no key, as an upstream that replaces its table whole sends
// them: two readings can be the same.
const readings = () =>
  new Stream({
    name: 'readings',
    jsonSchema: {
      type: 'object',
      description: 'A reading.',
      properties: {
        id: { type: 'string', description: 'Sensor id.' },
        value: { type: 'integer', description: 'Value read.' },
      },
      required: ['id', 'value'],
    },
    supportedSyncModes: ['full_refresh'],
  });
const sample = (id: string, value: number) => ({
  stream: 'readings',
  data: { id, value },
});

// The target of a stream in schema raw, which readers read as marts.<name>.
const target = (destination: PostgresDestination, name: string) =>
  destination
    .table(name)
    .withReaderView('marts', `${destination.schema}_${name}`);

// An incremental copy that keeps the newest version of each note.
const incremental = (stream: Stream, destination: PostgresDestination) =>
  new Copy(stream, target(destination, stream.name), {
    id: stream.name,
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });

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

// A client of the test's own, ended with the test.
function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

// A schema of the database, its checkpoints, and a pass of one copy of the
// stream with the steps a test scripts for it.
function warehouse(url: string, stream = notes(), schema = 'raw') {
  const destination = new PostgresDestination({ url, schema });
  const checkpoints = new PostgresCheckpointStore({ url, schema });
  const connection = (
    steps: Readonly<Record<string, readonly Step[]>>,
    copy: Copy<PostgresTable> = incremental(stream, destination),
    partitions: readonly Partition[] = [],
  ) =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: schema,
          source: new Scripted([copy.from], steps, partitions),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    });
  return { destination, stream, connection };
}

// The newest position of the database.
async function newest(destination: PostgresDestination): Promise<string> {
  const positions = await destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// The newest commit of the database, and when its load began.
async function lastCommit(sql: postgres.Sql) {
  const [last] = await sql<
    { number: number; committed_at: Date; opened_at: Date }[]
  >`SELECT c.number, c.committed_at, l.opened_at FROM _warehouse._elt_commits AS c JOIN _warehouse._elt_loads AS l ON l.id = c.load ORDER BY c.number DESC LIMIT 1`;
  if (last === undefined) assert.fail('the database has no commit yet');
  return last;
}

// The rows that commits replaced or removed from the one target of schema,
// as its history keeps them.
async function replaced(sql: postgres.Sql, schema = 'raw') {
  const histories = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = to_regnamespace(${schema}) AND relkind = 'r' AND relname LIKE '\_elt\_history\_%'`;
  assert.equal(histories.length, 1, `${schema} has one history`);
  return (
    await sql.unsafe(
      `SELECT * FROM "${schema}"."${histories[0]?.name}" ORDER BY 1`,
    )
  ).map((row) => ({ ...row }));
}

// The rows a query reads as of a position, or as of the newest one.
async function asOf(
  destination: PostgresDestination,
  query: string,
  position?: string,
) {
  const reading = await destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  return (await reading.sql.unsafe(query)).map((row) => ({ ...row }));
}

test('a reading of a commit inside a pass is refused, as it would show half of that pass, and the commit that ends the pass reads', async () => {
  await using database = await databases.database();
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = await newest(destination);
  await connection({
    notes: [
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
      note('notes', 'n3', 1),
      checkpoint('notes', 3),
    ],
  }).run();
  const end = await newest(destination);
  const [written] = await asOf(
    destination,
    "SELECT committed_in FROM marts.raw_notes WHERE id = 'n2'",
  );
  const inside = `${before.split(':')[0]}:${written?.committed_in}`;

  assert.notEqual(inside, end);
  await assert.rejects(destination.reading(inside), TypeError);
  await assert.rejects(destination.reading('not a position'), TypeError);
  assert.deepEqual(
    await asOf(destination, 'SELECT id FROM marts.raw_notes ORDER BY id', end),
    [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
  );
});

test('a reading with no position while a pass waits after its first commit reads the newest position before that pass, not its half', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(destination, 'SELECT * FROM marts.raw_notes');
  const wait = latch();
  const second = connection({
    notes: [
      note('notes', 'n1', 2, 'changed'),
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
      wait.step,
    ],
  }).run();
  await wait.reached;
  try {
    const half = await sql`SELECT id, body FROM marts.raw_notes ORDER BY id`;
    const reading = await destination.reading();
    if ('expired' in reading) assert.fail(reading.expired);
    await using _reading = reading;

    const during = await reading.sql`SELECT * FROM marts.raw_notes ORDER BY id`;

    assert.deepEqual(
      half.map((row) => ({ ...row })),
      [
        { id: 'n1', body: 'changed' },
        { id: 'n2', body: 'n2' },
      ],
    );
    assert.equal(reading.position, before);
    assert.deepEqual(
      during.map((row) => ({ ...row })),
      rows,
    );
  } finally {
    wait.release();
    await second;
  }
});

test('a reading sees none of the commits made after it opened, and disposing it ends its session', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const reading = await destination.reading();
  if ('expired' in reading) assert.fail(reading.expired);
  const opened = reading.position;
  const sessions = () =>
    sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'elt-reading'`;

  let read;
  try {
    await connection({
      notes: [note('notes', 'n1', 2, 'changed'), note('notes', 'n2', 1)],
    }).run();
    read = await reading.sql`SELECT id, body FROM marts.raw_notes`;
    assert.equal((await sessions()).length, 1);
  } finally {
    await reading[Symbol.asyncDispose]();
  }

  assert.notEqual(await newest(destination), opened);
  assert.deepEqual(
    read.map((row) => ({ ...row })),
    [{ id: 'n1', body: 'n1' }],
  );
  assert.equal((await sessions()).length, 0);
});

test('a session that sets no position reads the reader view as it is now, with none of the replaced rows', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  await connection({
    notes: [
      note('notes', 'n1', 2, 'changed'),
      { type: 'DELETE', stream: 'notes', key: { id: 'n2' } },
      checkpoint('notes', 2),
    ],
  }).run();

  const plain = await sql`SELECT id, body FROM marts.raw_notes ORDER BY id`;

  assert.equal((await replaced(sql)).length, 2);
  assert.deepEqual(
    plain.map((row) => ({ ...row })),
    [{ id: 'n1', body: 'changed' }],
  );
  assert.deepEqual(
    await asOf(destination, 'SELECT id, body FROM marts.raw_notes'),
    [{ id: 'n1', body: 'changed' }],
  );
});

test('a reading of a position of an earlier numbering, or past the newest commit, is expired', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, connection } = warehouse(
    database.connectionString,
  );
  const run = () =>
    connection(
      { notes: [note('notes', 'n1', 1)] },
      new Copy(stream, target(destination, 'notes')),
    ).run();
  await run();
  const old = await newest(destination);
  const [epoch, number] = old.split(':');
  const past = await destination.reading(`${epoch}:${Number(number) + 1}`);
  await sql`DROP SCHEMA raw, marts, _warehouse CASCADE`;
  await run();

  const remade = await destination.reading(old);

  assert.ok('expired' in past, JSON.stringify(past));
  assert.match(past.expired, /past the newest commit/);
  assert.ok('expired' in remade, JSON.stringify(remade));
  assert.match(remade.expired, /earlier numbering/);
});

test('a reading below the newest commit fails each read of the sync history views, with a message that they cannot be read as of a position, and a reading at the newest commit reads them', async () => {
  await using database = await databases.database();
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = await newest(destination);
  await connection({
    notes: [note('notes', 'n2', 1), checkpoint('notes', 2)],
  }).run();

  for (const view of [
    'sync_attempts',
    'extraction_coverage',
    'sync_status',
    'stream_status',
  ]) {
    await assert.rejects(
      asOf(destination, `SELECT * FROM marts.${view}`, before),
      /The sync history cannot be read as of a position/,
      view,
    );
    assert.ok(
      (await asOf(destination, `SELECT * FROM marts.${view}`)).length > 0,
      view,
    );
  }
});

test('a deduplicated row whose values changed reads as it was at the position, from a reading that names it and its commit time, and as changed at the newest one, with the commit and the load that changed it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1, 'first'),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  const first = await lastCommit(sql);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  await delay(5);
  await connection({
    notes: [note('notes', 'n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  const second = await lastCommit(sql);
  const reading = await destination.reading(before);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;

  const read = await reading.sql`SELECT * FROM marts.raw_notes ORDER BY id`;

  assert.equal(reading.position, before);
  assert.ok(
    reading.at.equals(
      Temporal.Instant.fromEpochMilliseconds(first.committed_at.getTime()),
    ),
    `${reading.at} is not ${first.committed_at.toISOString()}`,
  );
  assert.deepEqual(
    read.map((row) => ({ ...row })),
    rows,
  );
  assert.deepEqual(
    await asOf(
      destination,
      "SELECT body, committed_in, loaded_at FROM marts.raw_notes WHERE id = 'n1'",
    ),
    [
      {
        body: 'second',
        committed_in: second.number,
        loaded_at: second.opened_at,
      },
    ],
  );
});

test('a deduplicated row that a later pass loads with the same values keeps its commit and its loaded_at, and its history keeps no row of it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, connection } = warehouse(
    database.connectionString,
  );
  // The replace policy has no cursor guard to refuse a record with the
  // cursor of the stored row, so only the values tell the rows apart.
  const replacing = new Copy(stream, target(destination, 'notes'), {
    id: 'notes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
    dedupPolicy: 'replace',
  });
  await connection(
    {
      notes: [
        note('notes', 'n1', 1),
        note('notes', 'n2', 1),
        checkpoint('notes', 1),
      ],
    },
    replacing,
  ).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  await delay(5);

  await connection(
    {
      notes: [
        note('notes', 'n1', 1),
        note('notes', 'n2', 1, 'changed'),
        checkpoint('notes', 2),
      ],
    },
    replacing,
  ).run();

  assert.deepEqual(
    await asOf(destination, "SELECT * FROM marts.raw_notes WHERE id = 'n1'"),
    rows.filter(({ id }) => id === 'n1'),
  );
  assert.deepEqual(
    (await replaced(sql)).map(({ id, body }) => ({ id, body })),
    [{ id: 'n2', body: 'n2' }],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('a record that the cursor guard refuses leaves no history and changes nothing as of the position', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 2, 'newer'), checkpoint('notes', 1)],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );

  await connection({
    notes: [
      note('notes', 'n1', 1, 'older'),
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(await replaced(sql), []);
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
  assert.deepEqual(
    await asOf(destination, "SELECT * FROM marts.raw_notes WHERE id = 'n1'"),
    rows,
  );
});

test('a row that a later pass deletes reads as of the position before it', async () => {
  await using database = await databases.database();
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );

  await connection({
    notes: [
      { type: 'DELETE', stream: 'notes', key: { id: 'n1' } },
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(await asOf(destination, 'SELECT id FROM marts.raw_notes'), [
    { id: 'n2' },
  ]);
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('the rows of a partition that a later pass resets read as of the position before it', async () => {
  await using database = await databases.database();
  const owned = new Stream({
    name: 'owned',
    jsonSchema: {
      type: 'object',
      description: 'Notes of an owner.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        owner: { type: 'string', description: 'Owner of the note.' },
        version: { type: 'integer', description: 'Version of the note.' },
      },
      required: ['id', 'owner', 'version'],
    },
    primaryKey: ['owner', 'id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
    partitionKey: ['owner'],
  });
  const { destination, connection } = warehouse(
    database.connectionString,
    owned,
  );
  const row = (id: string, owner: string) => ({
    stream: 'owned',
    data: { id, owner, version: 1 },
  });
  const pass = (steps: Readonly<Record<string, readonly Step[]>>) =>
    connection(steps, incremental(owned, destination), [
      { owner: 'ann' },
      { owner: 'bob' },
    ]).run();
  await pass({
    'owned:ann': [row('a1', 'ann'), checkpoint('owned', 1)],
    'owned:bob': [row('b1', 'bob'), checkpoint('owned', 1)],
  });
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_owned ORDER BY id',
  );

  await pass({
    'owned:ann': [
      { type: 'RESET', stream: 'owned' },
      row('a2', 'ann'),
      checkpoint('owned', 2),
    ],
    'owned:bob': [checkpoint('owned', 2)],
  });

  assert.deepEqual(
    await asOf(destination, 'SELECT id FROM marts.raw_owned ORDER BY id'),
    [{ id: 'a2' }, { id: 'b1' }],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_owned ORDER BY id',
      before,
    ),
    rows,
  );
});

test('a clear empties the target at a position of its own, and the rows it cleared read as of the position before it', async () => {
  await using database = await databases.database();
  const { destination, connection } = warehouse(database.connectionString);
  const pipeline = connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  });
  await pipeline.run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );

  await pipeline.clear();
  const cleared = await destination.reading();
  if ('expired' in cleared) assert.fail(cleared.expired);
  await using _cleared = cleared;

  assert.notEqual(cleared.position, before);
  assert.deepEqual([...(await cleared.sql`SELECT * FROM marts.raw_notes`)], []);
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('the rows that a later overwrite replaced read as of the position before it', async () => {
  await using database = await databases.database();
  const { destination, stream, connection } = warehouse(
    database.connectionString,
  );
  const overwrite = new Copy(stream, target(destination, 'notes'));
  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
    overwrite,
  ).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );

  await connection({ notes: [note('notes', 'n3', 1)] }, overwrite).run();

  assert.deepEqual(await asOf(destination, 'SELECT id FROM marts.raw_notes'), [
    { id: 'n3' },
  ]);
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('an overwrite that brings the same rows again keeps no history and leaves each row with its commit and its loaded_at', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, connection } = warehouse(
    database.connectionString,
  );
  const overwrite = new Copy(stream, target(destination, 'notes'));
  const pass = () =>
    connection(
      { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
      overwrite,
    ).run();
  await pass();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  await delay(5);

  await pass();

  assert.notEqual(await newest(destination), before);
  assert.deepEqual(await replaced(sql), []);
  assert.deepEqual(
    await asOf(destination, 'SELECT * FROM marts.raw_notes ORDER BY id'),
    rows,
  );
});

test('a keyless overwrite that sends one of two identical rows again keeps only the copy that left in the history, and the copy that stays keeps its commit', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, connection } = warehouse(
    database.connectionString,
    readings(),
  );
  const overwrite = new Copy(stream, target(destination, 'readings'));
  await connection(
    { readings: [sample('r1', 1), sample('r1', 1), sample('r2', 2)] },
    overwrite,
  ).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_readings ORDER BY id',
  );
  await delay(5);

  await connection(
    { readings: [sample('r1', 1), sample('r2', 2)] },
    overwrite,
  ).run();

  assert.deepEqual(
    (await replaced(sql)).map(({ id, value }) => ({ id, value })),
    [{ id: 'r1', value: '1' }],
  );
  assert.deepEqual(
    await asOf(destination, 'SELECT * FROM marts.raw_readings ORDER BY id'),
    rows.slice(1),
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_readings ORDER BY id',
      before,
    ),
    rows,
  );
});

test('an overwrite_dedup that changes one row of two keeps only its old values in the history, and the other row keeps its commit and its loaded_at', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, stream, connection } = warehouse(
    database.connectionString,
  );
  const overwrite = new Copy(stream, target(destination, 'notes'), {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite_dedup',
    cursorField: 'version',
  });
  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
    overwrite,
  ).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  await delay(5);

  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 2, 'changed')] },
    overwrite,
  ).run();

  assert.deepEqual(
    (await replaced(sql)).map(({ id, body }) => ({ id, body })),
    [{ id: 'n2', body: 'n2' }],
  );
  assert.deepEqual(
    await asOf(destination, "SELECT * FROM marts.raw_notes WHERE id = 'n1'"),
    rows.slice(0, 1),
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('the rows that a later reload swapped out read as of the position before it, and the rows the reload changed in its hidden table before then leave no history', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n3', 1),
      checkpoint('notes', 2),
      note('notes', 'n3', 2, 'changed'),
      { type: 'DELETE', stream: 'notes', key: { id: 'n3' } },
      note('notes', 'n4', 1),
      checkpoint('notes', 3),
    ],
  }).run();

  assert.deepEqual(await asOf(destination, 'SELECT id FROM marts.raw_notes'), [
    { id: 'n4' },
  ]);
  assert.deepEqual(
    (await replaced(sql)).map(({ id }) => id),
    ['n1', 'n2'],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('a reload that sends a row again with the same values leaves it in the target with its commit and its loaded_at, and the history keeps only the rows that left', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  const [first] = await sql<{ committed_in: number; loaded_at: Date }[]>`
    SELECT committed_in, loaded_at FROM raw.notes WHERE id = 'n1'`;

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n1', 1),
      note('notes', 'n3', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  const reload = await lastCommit(sql);
  assert.deepEqual(
    (
      await sql`SELECT id, committed_in, loaded_at FROM raw.notes ORDER BY id`
    ).map((row) => ({ ...row })),
    [
      { id: 'n1', ...first },
      { id: 'n3', committed_in: reload.number, loaded_at: reload.opened_at },
    ],
  );
  assert.deepEqual(
    (await replaced(sql)).map(({ id }) => id),
    ['n2'],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows,
  );
});

test('a reload of a table that keeps its shape changes it in place, so an index and a view of its own that depend on it stay and read the reloaded rows', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  await sql`CREATE INDEX notes_by_body ON raw.notes (body)`;
  await sql`CREATE SCHEMA mine`;
  await sql`CREATE VIEW mine.bodies AS SELECT id, body FROM raw.notes`;

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n1', 1),
      note('notes', 'n3', 1, 'new'),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(
    (
      await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'raw' AND indexname = 'notes_by_body'`
    ).map((row) => ({ ...row })),
    [{ indexname: 'notes_by_body' }],
  );
  assert.deepEqual(
    (await sql`SELECT * FROM mine.bodies ORDER BY id`).map((row) => ({
      ...row,
    })),
    [
      { id: 'n1', body: 'n1' },
      { id: 'n3', body: 'new' },
    ],
  );
  assert.deepEqual(
    await asOf(destination, 'SELECT id FROM marts.raw_notes ORDER BY id'),
    [{ id: 'n1' }, { id: 'n3' }],
  );
});

test('a stream whose field changes type, or that drops a field, evolves the table in a commit of its own, and the rows it changed read as they were as of the position before it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  const { destination, connection } = warehouse(url);
  await connection({
    notes: [
      note('notes', 'n1', 1, 'kept'),
      { stream: 'notes', data: { id: 'n2', version: 1 } },
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  const rows = await asOf(
    destination,
    'SELECT * FROM marts.raw_notes ORDER BY id',
  );
  // The version is now text, and the body is gone.
  const evolved = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type: 'string', description: 'Version of the note.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });
  const next = warehouse(url, evolved);

  await next
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n3', version: 'v1' } },
        checkpoint('notes', 2),
      ],
    })
    .run();
  const changed = await sql`
    SELECT id, committed_in FROM raw.notes ORDER BY id`;

  assert.equal(
    changed[0]?.committed_in,
    changed[1]?.committed_in,
    'one commit changed both rows',
  );
  assert.ok(
    Number(changed[0]?.committed_in) < Number(changed[2]?.committed_in),
    'the evolve commits before the merge',
  );
  assert.deepEqual(
    (await replaced(sql)).map(({ id, body }) => ({ id, body })),
    [
      { id: 'n1', body: 'kept' },
      { id: 'n2', body: null },
    ],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT id, version FROM marts.raw_notes ORDER BY id',
    ),
    [
      { id: 'n1', version: '1' },
      { id: 'n2', version: '1' },
      { id: 'n3', version: 'v1' },
    ],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT id, version, committed_in, loaded_at FROM marts.raw_notes ORDER BY id',
      before,
    ),
    rows.map(({ id, version, committed_in, loaded_at }) => ({
      id,
      version: String(version),
      committed_in,
      loaded_at,
    })),
  );
});

test('a view over the reader view, and a published view of marts that names it with its schema, read as of the position', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, connection } = warehouse(database.connectionString);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  await sql.begin((transaction) =>
    publishPostgresViews(transaction, {
      schema: 'marts',
      views: [
        {
          name: 'note_bodies',
          description: 'Bodies of notes.',
          columns: { id: 'Note id.', body: 'Text of the note.' },
          query: 'SELECT id, body FROM marts.raw_notes',
        },
      ],
    }),
  );
  await sql`CREATE SCHEMA reports`;
  await sql`CREATE VIEW reports.long_notes AS SELECT id FROM marts.note_bodies WHERE length(body) > 1`;
  const before = await newest(destination);

  await connection({
    notes: [
      note('notes', 'n1', 2, 'changed'),
      note('notes', 'n2', 1, 'new note'),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM marts.note_bodies ORDER BY id',
      before,
    ),
    [{ id: 'n1', body: 'n1' }],
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT * FROM reports.long_notes ORDER BY id',
      before,
    ),
    [{ id: 'n1' }],
  );
  assert.deepEqual(
    await asOf(destination, 'SELECT * FROM reports.long_notes ORDER BY id'),
    [{ id: 'n1' }, { id: 'n2' }],
  );
});

test('one table name in two schemas keeps a history of its own in each, and each reads as of the position', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  const a = warehouse(url, notes(), 'a');
  const b = warehouse(url, notes(), 'b');
  await a
    .connection({ notes: [note('notes', 'a1', 1), checkpoint('notes', 1)] })
    .run();
  await b
    .connection({ notes: [note('notes', 'b1', 1), checkpoint('notes', 1)] })
    .run();
  const before = await newest(a.destination);

  await a
    .connection({
      notes: [note('notes', 'a1', 2, 'changed a'), checkpoint('notes', 2)],
    })
    .run();
  await b
    .connection({
      notes: [note('notes', 'b1', 2, 'changed b'), checkpoint('notes', 2)],
    })
    .run();

  assert.deepEqual(
    (await replaced(sql, 'a')).map(({ id }) => id),
    ['a1'],
  );
  assert.deepEqual(
    (await replaced(sql, 'b')).map(({ id }) => id),
    ['b1'],
  );
  assert.deepEqual(
    await asOf(
      b.destination,
      'SELECT id, body FROM marts.a_notes UNION ALL SELECT id, body FROM marts.b_notes ORDER BY id',
      before,
    ),
    [
      { id: 'a1', body: 'a1' },
      { id: 'b1', body: 'b1' },
    ],
  );
});

test('the file of a document that a later pass deletes reads with its own bytes as of the position before it, and a document sent again with the same file keeps its commit', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const url = database.connectionString;
  const documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document.',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        version: { type: 'integer', description: 'Version of the document.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
    emitsDeletes: true,
  });
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const table = destination
    .table('documents', (c) => [
      c.text('id'),
      c.integer('version'),
      c.blob('bytes').from(documents.file),
    ])
    .withReaderView('marts', 'raw_documents');
  const { connection } = warehouse(url, documents);
  const copy = new Copy(documents, table, {
    id: 'documents',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
    dedupPolicy: 'replace',
  });
  const document = async (id: string, text: string) => {
    const path = join(scratch.path, `${id}-${text}.txt`);
    await writeFile(path, text);
    return { stream: 'documents', data: { id, version: 1 }, file: path };
  };
  await connection(
    {
      documents: [
        await document('d1', 'first'),
        await document('d2', 'kept'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = await newest(destination);
  const stored = await asOf(
    destination,
    'SELECT id, committed_in, bytes FROM marts.raw_documents ORDER BY id',
  );

  await connection(
    {
      documents: [
        { type: 'DELETE', stream: 'documents', key: { id: 'd1' } },
        await document('d2', 'kept'),
        await document('d3', 'new'),
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();
  const chunks = await asOf(
    destination,
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'raw'::regnamespace AND c.relname LIKE '\\_elt\\_files\\_%' AND c.relkind = 'r'`,
  );
  assert.equal(chunks.length, 1);
  const bytes = (position?: string) =>
    asOf(
      destination,
      `SELECT d.id, convert_from(string_agg(f.bytes, ''::bytea ORDER BY f.n), 'UTF8') AS text
       FROM marts.raw_documents d JOIN raw."${chunks[0]?.name}" f ON f.file = d.bytes
       GROUP BY d.id ORDER BY d.id`,
      position,
    );

  assert.deepEqual(await bytes(before), [
    { id: 'd1', text: 'first' },
    { id: 'd2', text: 'kept' },
  ]);
  assert.deepEqual(await bytes(), [
    { id: 'd2', text: 'kept' },
    { id: 'd3', text: 'new' },
  ]);
  assert.deepEqual(
    await asOf(
      destination,
      "SELECT id, committed_in, bytes FROM marts.raw_documents WHERE id = 'd2'",
    ),
    stored.filter(({ id }) => id === 'd2'),
  );
});

test('a field that a change of shape drops, and a later one adds back, takes its value again from the next record that brings it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  // The replace policy has no cursor guard to refuse a record with the
  // cursor of the stored row, so only the row hash tells the rows apart.
  const pass = (stream: Stream, steps: readonly Step[]) => {
    const { destination, connection } = warehouse(url, stream);
    return connection(
      { notes: steps },
      new Copy(stream, target(destination, 'notes'), {
        id: 'notes',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
        dedupPolicy: 'replace',
      }),
    ).run();
  };
  const bodiless = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type: 'integer', description: 'Version of the note.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });
  await pass(notes(), [note('notes', 'n1', 1, 'kept'), checkpoint('notes', 1)]);
  await pass(bodiless, [
    { stream: 'notes', data: { id: 'n2', version: 1 } },
    checkpoint('notes', 2),
  ]);

  await pass(notes(), [note('notes', 'n1', 1, 'kept'), checkpoint('notes', 3)]);

  assert.deepEqual(
    [...(await sql`SELECT id, body FROM marts.raw_notes ORDER BY id`)],
    [
      { id: 'n1', body: 'kept' },
      { id: 'n2', body: null },
    ],
  );
});

test('the file of a row that a later reload swapped out reads with its own bytes as of the position before it', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const url = database.connectionString;
  const documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document.',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        version: { type: 'integer', description: 'Version of the document.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
    emitsDeletes: true,
  });
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const table = destination
    .table('documents', (c) => [
      c.text('id'),
      c.integer('version'),
      c.blob('bytes').from(documents.file),
    ])
    .withReaderView('marts', 'raw_documents');
  const { connection } = warehouse(url, documents);
  const copy = new Copy(documents, table, {
    id: 'documents',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });
  const document = async (id: string, text: string) => {
    const path = join(scratch.path, `${id}-${text}.txt`);
    await writeFile(path, text);
    return { stream: 'documents', data: { id, version: 1 }, file: path };
  };
  await connection(
    {
      documents: [
        await document('d1', 'first'),
        await document('d2', 'kept'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = await newest(destination);

  await connection(
    {
      documents: [
        { type: 'RESET', stream: 'documents' },
        await document('d2', 'kept'),
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();
  const [chunks] = await asOf(
    destination,
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'raw'::regnamespace AND c.relname LIKE '\\_elt\\_files\\_%' AND c.relkind = 'r'`,
  );
  const bytes = (position?: string) =>
    asOf(
      destination,
      `SELECT d.id, convert_from(string_agg(f.bytes, ''::bytea ORDER BY f.n), 'UTF8') AS text
       FROM marts.raw_documents d JOIN raw."${chunks?.name}" f ON f.file = d.bytes
       GROUP BY d.id ORDER BY d.id`,
      position,
    );

  assert.deepEqual(await bytes(), [{ id: 'd2', text: 'kept' }]);
  assert.deepEqual(await bytes(before), [
    { id: 'd1', text: 'first' },
    { id: 'd2', text: 'kept' },
  ]);
});

// Notes with one more field, size, of the schema a test gives it, or with no
// size.
const sized = (size?: FieldSchema) =>
  new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type: 'integer', description: 'Version of the note.' },
        ...(size && { size }),
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });

// What a reading of the position gives when the position is expired.
async function expiredReading(
  destination: PostgresDestination,
  position: string,
): Promise<string> {
  const reading = await destination.reading(position);
  if (!('expired' in reading)) {
    await reading[Symbol.asyncDispose]();
    assert.fail(`${position} reads`);
  }
  return reading.expired;
}

const typeChange = /changed the type of a column/;

test('a field that moves from string to integer, which does not keep each old value, expires each position before the change: the history drops the rows only they read, and each position from the change on reads exactly', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  const { destination, connection } = warehouse(
    url,
    sized({ type: 'string', description: 'Size of the note.' }),
  );
  await connection({
    notes: [
      { stream: 'notes', data: { id: 'n1', version: 1, size: 'L' } },
      { stream: 'notes', data: { id: 'n2', version: 1, size: '3' } },
      checkpoint('notes', 1),
    ],
  }).run();
  const first = await newest(destination);
  await connection({
    notes: [
      { type: 'DELETE', stream: 'notes', key: { id: 'n1' } },
      checkpoint('notes', 2),
    ],
  }).run();
  const deleted = await newest(destination);
  const integer = warehouse(
    url,
    sized({ type: 'integer', description: 'Size of the note.' }),
  );

  // Only the history keeps 'L', which no integer holds.
  await integer
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n3', version: 1, size: 4 } },
        checkpoint('notes', 3),
      ],
    })
    .run();
  const changed = await newest(destination);
  await integer
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n2', version: 2, size: 5 } },
        checkpoint('notes', 4),
      ],
    })
    .run();

  assert.match(await expiredReading(destination, first), typeChange);
  assert.match(await expiredReading(destination, deleted), typeChange);
  const after = await destination.positions(deleted);
  assert.ok('expired' in after);
  assert.match(after.expired, typeChange);
  const listed = await destination.positions();
  assert.ok(!('expired' in listed));
  assert.deepEqual(listed, [changed, await newest(destination)]);
  assert.deepEqual(
    (await replaced(sql)).map(({ id, size }) => ({ id, size })),
    [{ id: 'n2', size: '3' }],
    'only the row that the later pass replaced',
  );
  assert.deepEqual(
    await asOf(
      destination,
      'SELECT id, size FROM marts.raw_notes ORDER BY id',
      changed,
    ),
    [
      { id: 'n2', size: '3' },
      { id: 'n3', size: '4' },
    ],
  );
  assert.deepEqual(
    await asOf(destination, 'SELECT id, size FROM marts.raw_notes ORDER BY id'),
    [
      { id: 'n2', size: '5' },
      { id: 'n3', size: '4' },
    ],
  );
});

test('a change of type that expires the positions before it drops the stored file of each row that only the history kept for them', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  const documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document.',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        version: { type: 'integer', description: 'Version of the document.' },
        size: { type: 'integer', description: 'Size of the document.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
    emitsDeletes: true,
  });
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const copy = (size: 'integer' | 'real') =>
    new Copy(
      documents,
      destination
        .table('documents', (c) => [
          c.text('id'),
          c.integer('version'),
          c[size]('size'),
          c.blob('bytes').from(documents.file),
        ])
        .withReaderView('marts', 'raw_documents'),
      {
        id: 'documents',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
      },
    );
  const { connection } = warehouse(url, documents);
  const document = async (id: string, text: string) => {
    const path = join(scratch.path, `${id}-${text}.txt`);
    await writeFile(path, text);
    return {
      stream: 'documents',
      data: { id, version: 1, size: 1 },
      file: path,
    };
  };
  await connection(
    {
      documents: [
        await document('d1', 'gone'),
        await document('d2', 'kept'),
        checkpoint('documents', 1),
      ],
    },
    copy('integer'),
  ).run();
  await connection(
    {
      documents: [
        { type: 'DELETE', stream: 'documents', key: { id: 'd1' } },
        checkpoint('documents', 2),
      ],
    },
    copy('integer'),
  ).run();
  const [chunks] = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'raw'::regnamespace AND relkind = 'r' AND relname LIKE '\_elt\_files\_%'`;
  const files = async () =>
    [
      ...(await sql.unsafe(
        `SELECT convert_from(string_agg(bytes, ''::bytea ORDER BY n), 'UTF8') AS text FROM raw."${chunks?.name}" GROUP BY file ORDER BY 1`,
      )),
    ].map(({ text }) => text);
  assert.deepEqual(await files(), ['gone', 'kept']);

  await connection({ documents: [] }, copy('real')).run();

  assert.deepEqual(await files(), ['kept']);
});

test('a field that moves from number to integer, which does not keep each old value, expires each position before the change', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const { destination, connection } = warehouse(
    url,
    sized({ type: 'number', description: 'Size of the note.' }),
  );
  // A whole number casts exactly; the type is still no widening.
  await connection({
    notes: [
      { stream: 'notes', data: { id: 'n1', version: 1, size: 2 } },
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);

  await warehouse(
    url,
    sized({ type: 'integer', description: 'Size of the note.' }),
  )
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n2', version: 1, size: 3 } },
        checkpoint('notes', 2),
      ],
    })
    .run();

  assert.match(await expiredReading(destination, before), typeChange);
  assert.deepEqual(
    await asOf(destination, 'SELECT id, size FROM marts.raw_notes ORDER BY id'),
    [
      { id: 'n1', size: '2' },
      { id: 'n2', size: '3' },
    ],
  );
});

test('a field that a change of shape drops, and a later one adds back with a type that does not keep each old value, expires each position before it comes back', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const { destination, connection } = warehouse(
    url,
    sized({ type: 'number', description: 'Size of the note.' }),
  );
  await connection({
    notes: [
      { stream: 'notes', data: { id: 'n1', version: 1, size: 1.5 } },
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  await warehouse(url, sized())
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n2', version: 1 } },
        checkpoint('notes', 2),
      ],
    })
    .run();
  const dropped = await newest(destination);

  await warehouse(
    url,
    sized({ type: 'integer', description: 'Size of the note.' }),
  )
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n3', version: 1, size: 4 } },
        checkpoint('notes', 3),
      ],
    })
    .run();

  assert.match(await expiredReading(destination, before), typeChange);
  assert.match(await expiredReading(destination, dropped), typeChange);
  assert.deepEqual(
    await asOf(destination, 'SELECT id, size FROM marts.raw_notes ORDER BY id'),
    [
      { id: 'n1', size: null },
      { id: 'n2', size: null },
      { id: 'n3', size: '4' },
    ],
  );
});

test('a field that a change of shape drops, and a later one adds back as a string, which keeps each old value, reads as of the position before the drop', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const { destination, connection } = warehouse(
    url,
    sized({ type: 'number', description: 'Size of the note.' }),
  );
  await connection({
    notes: [
      { stream: 'notes', data: { id: 'n1', version: 1, size: 1.5 } },
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  await warehouse(url, sized())
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n2', version: 1 } },
        checkpoint('notes', 2),
      ],
    })
    .run();

  await warehouse(
    url,
    sized({ type: 'string', description: 'Size of the note.' }),
  )
    .connection({
      notes: [
        { stream: 'notes', data: { id: 'n3', version: 1, size: 'L' } },
        checkpoint('notes', 3),
      ],
    })
    .run();

  assert.deepEqual(
    await asOf(
      destination,
      'SELECT id, size FROM marts.raw_notes ORDER BY id',
      before,
    ),
    [{ id: 'n1', size: '1.5' }],
  );
});

test('an overwrite whose field moves from string to integer reloads the table, and the swap expires each position before it', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const { destination, stream, connection } = warehouse(
    url,
    sized({ type: 'string', description: 'Size of the note.' }),
  );
  const overwrite = (stream: Stream) =>
    new Copy(stream, target(destination, 'notes'));
  await connection(
    { notes: [{ stream: 'notes', data: { id: 'n1', version: 1, size: 'L' } }] },
    overwrite(stream),
  ).run();
  const first = await newest(destination);
  await connection(
    { notes: [{ stream: 'notes', data: { id: 'n2', version: 1, size: 'M' } }] },
    overwrite(stream),
  ).run();
  const second = await newest(destination);
  const integer = warehouse(
    url,
    sized({ type: 'integer', description: 'Size of the note.' }),
  );

  await integer
    .connection(
      { notes: [{ stream: 'notes', data: { id: 'n3', version: 1, size: 4 } }] },
      overwrite(integer.stream),
    )
    .run();

  assert.match(await expiredReading(destination, first), typeChange);
  assert.match(await expiredReading(destination, second), typeChange);
  assert.deepEqual(
    await asOf(destination, 'SELECT id, size FROM marts.raw_notes'),
    [{ id: 'n3', size: '4' }],
  );
});

test('a timestamp that the history keeps reads as of the position as the same instant, whatever DateStyle the writer and the reader use', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const url = database.connectionString;
  // Platform setup: each session of the writer takes the database's
  // DateStyle, which no operation of the destination sets.
  await sql.unsafe(
    `ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET DateStyle = 'SQL, MDY'`,
  );
  const stream = sized({
    type: 'string',
    format: 'date-time',
    description: 'Size of the note.',
  });
  const { destination, connection } = warehouse(url, stream);
  await connection({
    notes: [
      {
        stream: 'notes',
        data: { id: 'n1', version: 1, size: '2026-03-04T05:06:07.123Z' },
      },
      checkpoint('notes', 1),
    ],
  }).run();
  const before = await newest(destination);
  await connection({
    notes: [
      {
        stream: 'notes',
        data: { id: 'n1', version: 2, size: '2026-05-06T00:00:00.000Z' },
      },
      checkpoint('notes', 2),
    ],
  }).run();

  const reading = await destination.reading(before);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  await reading.sql.unsafe(`SET DateStyle = 'SQL, DMY'`);
  assert.deepEqual(
    [
      ...(await reading.sql.unsafe(
        'SELECT id, extract(epoch FROM size)::text AS size FROM marts.raw_notes',
      )),
    ],
    [
      {
        id: 'n1',
        size: `${Date.parse('2026-03-04T05:06:07Z') / 1000}.123000`,
      },
    ],
  );
});
