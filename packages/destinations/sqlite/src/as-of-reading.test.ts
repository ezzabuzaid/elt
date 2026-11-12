import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  LocalFiles,
  type Partition,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  View,
  openDestination,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

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
const notes = (name: string) =>
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
// Readings with no key, as an upstream that replaces its table whole sends
// them: two readings can be the same.
const readings = () =>
  new Stream({
    name: 'readings',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, value: { type: 'integer' } },
      required: ['id', 'value'],
    },
    supportedSyncModes: ['full_refresh'],
  });

const sample = (id: string, value: number) => ({
  stream: 'readings',
  data: { id, value },
});
const checkpoint = (stream: string, read: number) => ({
  type: 'STATE' as const,
  stream,
  state: { read },
});

// An incremental copy that keeps the newest version of each note.
const incremental = (stream: Stream, destination: SQLiteDestination) =>
  new Copy(stream, destination.table(stream.name), {
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

const pipeline = (
  connection: Connection<SQLiteTable>,
  derived: readonly View[] = [],
) =>
  new Pipeline({
    clock: globalThis,
    connections: [connection],
    history: new SQLiteSyncHistory(),
    derived,
  });

// A file, its checkpoints, and a pass of one copy of the stream with the
// steps a test scripts for it.
function notesFile(directory: string, stream = notes('notes')) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const connection = (
    steps: Readonly<Record<string, readonly Step[]>>,
    copy: Copy<SQLiteTable> = incremental(stream, destination),
    derived: readonly View[] = [],
  ) =>
    pipeline(
      new Connection({
        name: 'notes',
        source: new Scripted([copy.from], steps),
        destination,
        checkpoints,
        steps: [copy],
      }),
      derived,
    );
  return { destination, checkpoints, stream, connection };
}

// The newest position of the file.
function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

// The newest commit of the file, and when its load began.
function lastCommit(destination: SQLiteDestination) {
  const [last] = storedRows(
    destination.path,
    'SELECT c.number, c.committed_at, l.opened_at FROM _elt_commits AS c JOIN _elt_loads AS l ON l.id = c.load ORDER BY c.number DESC LIMIT 1',
  );
  if (last === undefined) assert.fail('the file has no commit yet');
  return last;
}

// The rows that commits replaced or removed from a target, as its history
// keeps them.
function replaced(destination: SQLiteDestination, target: string) {
  const [recorded] = storedRows(
    destination.path,
    `SELECT history FROM _elt_histories WHERE target = '${target}'`,
  );
  if (recorded === undefined) assert.fail(`${target} has no history`);
  return storedRows(
    destination.path,
    `SELECT * FROM "${String(recorded.history)}" ORDER BY id`,
  );
}

// The rows a query reads as of a position, or as of the newest one.
function asOf(destination: SQLiteDestination, sql: string, position?: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

test('a reading with no position while a pass waits after its first commit reads the newest position before that pass, not its half', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
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
    const half = storedRows(
      destination.path,
      'SELECT id, body FROM notes ORDER BY id',
    );
    const reading = destination.reading();
    if ('expired' in reading) assert.fail(reading.expired);
    using _reading = reading;

    const during = reading.sql
      .prepare('SELECT * FROM notes ORDER BY id')
      .all()
      .map((row) => ({ ...row }));

    assert.deepEqual(half, [
      { id: 'n1', body: 'changed' },
      { id: 'n2', body: 'n2' },
    ]);
    assert.equal(reading.position, before);
    assert.deepEqual(during, rows);
  } finally {
    wait.release();
    await second;
  }
});

test('a reading of a commit inside a pass is refused, as it would show half of that pass, and the commit that ends the pass reads', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = newest(destination);
  await connection({
    notes: [
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
      note('notes', 'n3', 1),
      checkpoint('notes', 3),
    ],
  }).run();
  const end = newest(destination);
  // A reader that names the commit of a row it read, here the first
  // checkpoint of the second pass, which is not a position.
  const [written] = asOf(
    destination,
    "SELECT committed_in FROM notes WHERE id = 'n2'",
  );
  const inside = `${before.split(':')[0]}:${written?.committed_in}`;

  assert.notEqual(inside, end);
  assert.deepEqual(destination.positions(before), [end]);
  assert.throws(() => destination.reading(inside), TypeError);
  assert.deepEqual(asOf(destination, 'SELECT id FROM notes ORDER BY id', end), [
    { id: 'n1' },
    { id: 'n2' },
    { id: 'n3' },
  ]);
});

test('a reading of a position of a file made again, or past the newest commit, is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const run = () =>
    connection(
      { notes: [note('notes', 'n1', 1)] },
      new Copy(stream, destination.table('notes')),
    ).run();
  await run();
  const old = newest(destination);
  const [epoch, number] = old.split(':');
  const past = destination.reading(`${epoch}:${Number(number) + 1}`);
  for (const suffix of ['', '-wal', '-shm'])
    await rm(`${destination.path}${suffix}`, { force: true });
  await run();

  const remade = destination.reading(old);

  assert.ok('expired' in past, JSON.stringify(past));
  assert.match(past.expired, /past the newest commit/);
  assert.ok('expired' in remade, JSON.stringify(remade));
  assert.match(remade.expired, /earlier numbering/);
  assert.deepEqual(asOf(destination, 'SELECT id FROM notes'), [{ id: 'n1' }]);
});

test('a reading as of a position refuses a stored view that reads a target as main."target", and the reading at the newest commit reads it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const qualified = new View({
    into: destination,
    name: 'qualified_notes',
    description: 'Notes, named with main.',
    columns: { id: 'Note id.' },
    sql: 'SELECT id FROM main.notes',
  });
  const pass = (steps: readonly Step[]) =>
    connection({ notes: steps }, incremental(stream, destination), [
      qualified,
    ]).run();
  await pass([note('notes', 'n1', 1), checkpoint('notes', 1)]);
  const before = newest(destination);
  await pass([note('notes', 'n2', 1), checkpoint('notes', 2)]);

  assert.throws(
    () => destination.reading(before),
    (error) =>
      error instanceof TypeError &&
      /"qualified_notes" reads "notes" as main\."notes"/.test(error.message),
  );
  assert.deepEqual(
    asOf(destination, 'SELECT id FROM qualified_notes ORDER BY id'),
    [{ id: 'n1' }, { id: 'n2' }],
  );
});

test('a reading as of a position fails each read of the sync history, its tables and its views, with a message that it cannot be read as of a position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const before = newest(destination);
  await connection({
    notes: [note('notes', 'n2', 1), checkpoint('notes', 2)],
  }).run();
  const reading = destination.reading(before);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;

  for (const sql of [
    'SELECT * FROM sync_attempts',
    'SELECT count(*) FROM _elt_sync_attempts',
    'SELECT * FROM stream_status',
    'SELECT * FROM _elt_stream_checks',
    'SELECT * FROM extraction_coverage',
    'SELECT count(*) FROM _elt_extraction_coverage',
  ])
    assert.throws(
      () => reading.sql.prepare(sql).all(),
      /The sync history cannot be read as of a position/,
      sql,
    );
});

test('a deduplicated row whose values changed reads as it was at the position, from a reading that names it and its commit time, and as changed at the newest one, with the commit and the load that changed it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [
      note('notes', 'n1', 1, 'first'),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = newest(destination);
  const first = lastCommit(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
  await delay(5);
  await connection({
    notes: [note('notes', 'n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  const second = lastCommit(destination);
  const reading = destination.reading(before);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;

  const read = reading.sql
    .prepare('SELECT * FROM notes ORDER BY id')
    .all()
    .map((row) => ({ ...row }));

  assert.equal(reading.position, before);
  assert.ok(
    reading.at.equals(Temporal.Instant.from(String(first.committed_at))),
    `${reading.at} is not ${first.committed_at}`,
  );
  assert.deepEqual(read, rows);
  assert.deepEqual(
    asOf(
      destination,
      "SELECT body, committed_in, loaded_at FROM notes WHERE id = 'n1'",
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
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  // The replace policy has no cursor guard to refuse a record with the
  // cursor of the stored row, so only the values tell the rows apart.
  const replacing = new Copy(stream, destination.table('notes'), {
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
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
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
    asOf(destination, "SELECT * FROM notes WHERE id = 'n1'"),
    rows.filter(({ id }) => id === 'n1'),
  );
  assert.deepEqual(
    replaced(destination, 'notes').map(({ id, body }) => ({ id, body })),
    [{ id: 'n2', body: 'n2' }],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('a record that the cursor guard refuses leaves no history and changes nothing as of the position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 2, 'newer'), checkpoint('notes', 1)],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection({
    notes: [
      note('notes', 'n1', 1, 'older'),
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(replaced(destination, 'notes'), []);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
  assert.deepEqual(
    asOf(destination, "SELECT * FROM notes WHERE id = 'n1'"),
    rows,
  );
});

test('a row that a later pass deletes reads as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection({
    notes: [
      { type: 'DELETE', stream: 'notes', key: { id: 'n1' } },
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(asOf(destination, 'SELECT id FROM notes'), [{ id: 'n2' }]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('the rows of a partition that a later pass resets read as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const owned = new Stream({
    name: 'owned',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        owner: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['id', 'owner', 'version'],
    },
    primaryKey: ['owner', 'id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
    partitionKey: ['owner'],
  });
  const row = (id: string, owner: string) => ({
    stream: 'owned',
    data: { id, owner, version: 1 },
  });
  const pass = (steps: Readonly<Record<string, readonly Step[]>>) =>
    pipeline(
      new Connection({
        name: 'owned',
        source: new Scripted([owned], steps, [
          { owner: 'ann' },
          { owner: 'bob' },
        ]),
        destination,
        checkpoints,
        steps: [incremental(owned, destination)],
      }),
    ).run();
  await pass({
    'owned:ann': [row('a1', 'ann'), checkpoint('owned', 1)],
    'owned:bob': [row('b1', 'bob'), checkpoint('owned', 1)],
  });
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM owned ORDER BY id');

  await pass({
    'owned:ann': [
      { type: 'RESET', stream: 'owned' },
      row('a2', 'ann'),
      checkpoint('owned', 2),
    ],
    'owned:bob': [checkpoint('owned', 2)],
  });

  assert.deepEqual(asOf(destination, 'SELECT id FROM owned ORDER BY id'), [
    { id: 'a2' },
    { id: 'b1' },
  ]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM owned ORDER BY id', before),
    rows,
  );
});

test('a clear empties the target at a position of its own, and the rows it cleared read as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  const notesPipeline = connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  });
  await notesPipeline.run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await notesPipeline.clear();
  const cleared = destination.reading();
  if ('expired' in cleared) assert.fail(cleared.expired);
  using _cleared = cleared;

  assert.notEqual(cleared.position, before);
  assert.deepEqual(cleared.sql.prepare('SELECT * FROM notes').all(), []);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('the rows that a later overwrite replaced read as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const overwrite = new Copy(stream, destination.table('notes'));
  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
    overwrite,
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection({ notes: [note('notes', 'n3', 1)] }, overwrite).run();

  assert.deepEqual(asOf(destination, 'SELECT id FROM notes'), [{ id: 'n3' }]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('the rows that a later reload swapped out read as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n3', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(asOf(destination, 'SELECT id FROM notes'), [{ id: 'n3' }]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('a keyless overwrite that sends one of two identical rows again keeps only the copy that left in the history, and the copy that stays keeps its commit', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(
    scratch.path,
    readings(),
  );
  const overwrite = new Copy(stream, destination.table('readings'));
  await connection(
    { readings: [sample('r1', 1), sample('r1', 1), sample('r2', 2)] },
    overwrite,
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM readings ORDER BY id');
  await delay(5);

  await connection(
    { readings: [sample('r1', 1), sample('r2', 2)] },
    overwrite,
  ).run();

  assert.deepEqual(
    replaced(destination, 'readings').map(({ id, value }) => ({ id, value })),
    [{ id: 'r1', value: 1 }],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM readings ORDER BY id'),
    rows.slice(1),
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM readings ORDER BY id', before),
    rows,
  );
});

test('a keyless overwrite that sends one more copy of a stored row inserts only that copy, with its own commit, and the stored copy keeps its commit and its loaded_at', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(
    scratch.path,
    readings(),
  );
  const overwrite = new Copy(stream, destination.table('readings'));
  await connection({ readings: [sample('r1', 1)] }, overwrite).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM readings');
  await delay(5);

  await connection(
    { readings: [sample('r1', 1), sample('r1', 1)] },
    overwrite,
  ).run();
  const last = lastCommit(destination);

  assert.deepEqual(replaced(destination, 'readings'), []);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM readings ORDER BY committed_in'),
    [
      ...rows,
      ...rows.map((row) => ({
        ...row,
        committed_in: last.number,
        loaded_at: last.opened_at,
      })),
    ],
  );
  assert.deepEqual(asOf(destination, 'SELECT * FROM readings', before), rows);
});

test('an overwrite that brings the same rows again keeps no history and leaves each row with its commit and its loaded_at', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const overwrite = new Copy(stream, destination.table('notes'));
  const pass = () =>
    connection(
      { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
      overwrite,
    ).run();
  await pass();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
  await delay(5);

  await pass();

  assert.notEqual(newest(destination), before);
  assert.deepEqual(replaced(destination, 'notes'), []);
  assert.deepEqual(asOf(destination, 'SELECT * FROM notes ORDER BY id'), rows);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('an overwrite_dedup that changes one row of two keeps only its old values in the history, and the other row keeps its commit and its loaded_at', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const overwrite = new Copy(stream, destination.table('notes'), {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite_dedup',
    cursorField: 'version',
  });
  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
    overwrite,
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
  await delay(5);

  await connection(
    {
      notes: [
        note('notes', 'n1', 1),
        note('notes', 'n2', 2, 'changed'),
        note('notes', 'n2', 1),
      ],
    },
    overwrite,
  ).run();

  assert.deepEqual(
    replaced(destination, 'notes').map(({ id, body }) => ({ id, body })),
    [{ id: 'n2', body: 'n2' }],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT id, body FROM notes ORDER BY id'),
    [
      { id: 'n1', body: 'n1' },
      { id: 'n2', body: 'changed' },
    ],
  );
  assert.deepEqual(
    asOf(destination, "SELECT * FROM notes WHERE id = 'n1'"),
    rows.filter(({ id }) => id === 'n1'),
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('a reload that keeps the shape of the table keeps only the row that left in the history, and a row it loads again keeps its commit and its loaded_at', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
  await delay(5);

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n1', 1),
      checkpoint('notes', 2),
      note('notes', 'n3', 1),
      checkpoint('notes', 3),
    ],
  }).run();
  const last = lastCommit(destination);

  assert.deepEqual(
    replaced(destination, 'notes').map(({ id }) => id),
    ['n2'],
  );
  assert.deepEqual(
    storedRows(
      destination.path,
      String.raw`SELECT name FROM sqlite_schema WHERE name LIKE '\_elt\_next\_%' ESCAPE '\'`,
    ),
    [],
  );
  assert.deepEqual(
    asOf(
      destination,
      'SELECT id, committed_in, loaded_at FROM notes ORDER BY id',
    ),
    [
      ...rows
        .filter(({ id }) => id === 'n1')
        .map(({ id, committed_in, loaded_at }) => ({
          id,
          committed_in,
          loaded_at,
        })),
      { id: 'n3', committed_in: last.number, loaded_at: last.opened_at },
    ],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('a reload that opens the first pass under a new key loads in place rows that repeat the old key', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  // The stream keyed by id, then by title, as a stream that changes its key.
  const items = (primaryKey: string[]) =>
    new Stream({
      name: 'items',
      jsonSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          version: { type: 'integer' },
        },
        required: ['id', 'title', 'version'],
      },
      primaryKey,
      supportedSyncModes: ['incremental'],
      emitsDeletes: true,
    });
  const item = (id: string, title: string) => ({
    stream: 'items',
    data: { id, title, version: 1 },
  });
  const pass = (primaryKey: string[], steps: readonly Step[]) => {
    const stream = items(primaryKey);
    return pipeline(
      new Connection({
        name: 'items',
        source: new Scripted([stream], { items: steps }),
        destination,
        checkpoints,
        steps: [incremental(stream, destination)],
      }),
    ).run();
  };
  await pass(['id'], [item('a', 'A'), item('b', 'B'), checkpoint('items', 1)]);
  await checkpoints.reset('items');

  await pass(
    ['title'],
    [
      { type: 'RESET', stream: 'items' },
      item('b', 'B'),
      item('b', 'Z'),
      checkpoint('items', 2),
    ],
  );

  assert.deepEqual(
    asOf(destination, 'SELECT id, title FROM items ORDER BY title'),
    [
      { id: 'b', title: 'B' },
      { id: 'b', title: 'Z' },
    ],
  );
  assert.deepEqual(
    replaced(destination, 'items').map(({ id }) => id),
    ['a'],
  );
});

test('an index and a trigger that a host made on the table stay after a reload that keeps the shape of the table', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  {
    // A host's own index and trigger: no operation of elt makes them.
    using database = openDestination(destination.path);
    database.exec('CREATE INDEX "notes_by_body" ON "notes" ("body")');
    database.exec(
      'CREATE TRIGGER "notes_seen" AFTER INSERT ON "notes" BEGIN SELECT 1; END',
    );
  }

  await connection({
    notes: [
      { type: 'RESET', stream: 'notes' },
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(asOf(destination, 'SELECT id FROM notes'), [{ id: 'n2' }]);
  assert.deepEqual(
    storedRows(
      destination.path,
      "SELECT name, tbl_name FROM sqlite_schema WHERE name IN ('notes_by_body', 'notes_seen') ORDER BY name",
    ),
    [
      { name: 'notes_by_body', tbl_name: 'notes' },
      { name: 'notes_seen', tbl_name: 'notes' },
    ],
  );
});

test('a keyless overwrite of a stream with fields named rowid and _rowid_ keeps only the row that left in the history', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  // Two rows with one value of each field. SQLite reads a column of such a
  // name in place of the row's own id.
  const stream = new Stream({
    name: 'messages',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        rowid: { type: 'integer' },
        _rowid_: { type: 'integer' },
      },
      required: ['id', 'rowid', '_rowid_'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const message = (id: string) => ({
    stream: 'messages',
    data: { id, rowid: 1, _rowid_: 1 },
  });
  const { destination, connection } = notesFile(scratch.path, stream);
  const overwrite = new Copy(stream, destination.table('messages'));
  await connection(
    { messages: [message('m1'), message('m2')] },
    overwrite,
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM messages ORDER BY id');

  await connection({ messages: [message('m2')] }, overwrite).run();

  assert.deepEqual(
    replaced(destination, 'messages').map(({ id }) => id),
    ['m1'],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM messages'),
    rows.filter(({ id }) => id === 'm2'),
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM messages ORDER BY id', before),
    rows,
  );
});

test('a column that a later pass adds reads NULL as of the position before it, in the rows that pass changed and in the rows it left', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  const base = notes('notes');
  const wider = new Stream({
    ...base,
    jsonSchema: {
      ...base.jsonSchema,
      properties: {
        ...base.jsonSchema.properties,
        extra: { type: ['string', 'null'], description: 'Added later.' },
      },
    },
  });
  await connection({
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      checkpoint('notes', 1),
    ],
  }).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection(
    {
      notes: [
        {
          stream: 'notes',
          data: { id: 'n1', version: 2, body: 'n1', extra: 'x' },
        },
        checkpoint('notes', 2),
      ],
    },
    incremental(wider, destination),
  ).run();

  assert.deepEqual(
    asOf(destination, 'SELECT id, extra FROM notes ORDER BY id'),
    [
      { id: 'n1', extra: 'x' },
      { id: 'n2', extra: null },
    ],
  );
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows.map((row) => ({ ...row, extra: null })),
  );
});

test('a column that an overwrite adds while it replaces the table reads NULL as of the position before it, in the rows the history kept without it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  const base = notes('notes');
  const wider = new Stream({
    ...base,
    jsonSchema: {
      ...base.jsonSchema,
      properties: {
        ...base.jsonSchema.properties,
        extra: { type: ['string', 'null'], description: 'Added later.' },
      },
    },
  });
  await connection(
    { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] },
    new Copy(base, destination.table('notes')),
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  // An overwrite reloads a table of another shape into a hidden table, and
  // its history keeps the old rows with the old columns.
  await connection(
    {
      notes: [
        {
          stream: 'notes',
          data: { id: 'n3', version: 1, body: 'n3', extra: 'x' },
        },
      ],
    },
    new Copy(wider, destination.table('notes')),
  ).run();

  assert.deepEqual(asOf(destination, 'SELECT id, extra FROM notes'), [
    { id: 'n3', extra: 'x' },
  ]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows.map((row) => ({ ...row, extra: null })),
  );
});

test('a view over a view reads as of the position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const derived = [
    new View({
      into: destination,
      name: 'bodies',
      description: 'The body of each note.',
      columns: { id: 'Note id.', body: 'Text of the note.' },
      sql: 'SELECT id, body FROM notes',
    }),
    new View({
      into: destination,
      name: 'body_list',
      description: 'Every body, in order of id.',
      columns: { bodies: 'The bodies, joined.' },
      sql: "SELECT group_concat(body, ',' ORDER BY id) AS bodies FROM bodies",
    }),
  ];
  const pass = (steps: readonly Step[]) =>
    connection(
      { notes: steps },
      incremental(stream, destination),
      derived,
    ).run();
  await pass([
    note('notes', 'n1', 1, 'a'),
    note('notes', 'n2', 1, 'b'),
    checkpoint('notes', 1),
  ]);
  const before = newest(destination);

  await pass([
    note('notes', 'n1', 2, 'c'),
    { type: 'DELETE', stream: 'notes', key: { id: 'n2' } },
    note('notes', 'n3', 1, 'd'),
    checkpoint('notes', 2),
  ]);

  assert.deepEqual(asOf(destination, 'SELECT bodies FROM body_list'), [
    { bodies: 'c,d' },
  ]);
  assert.deepEqual(asOf(destination, 'SELECT bodies FROM body_list', before), [
    { bodies: 'a,b' },
  ]);
});

test('a reader view reads as of the position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  const copy = new Copy(
    stream,
    destination.table('raw_notes').withReaderView('notes'),
    {
      id: 'notes',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    },
  );
  await connection(
    {
      notes: [
        note('notes', 'n1', 1),
        note('notes', 'n2', 1),
        checkpoint('notes', 1),
      ],
    },
    copy,
  ).run();
  const before = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');

  await connection(
    {
      notes: [
        note('notes', 'n1', 2, 'changed'),
        { type: 'DELETE', stream: 'notes', key: { id: 'n2' } },
        checkpoint('notes', 2),
      ],
    },
    copy,
  ).run();

  assert.deepEqual(asOf(destination, 'SELECT id, body FROM notes'), [
    { id: 'n1', body: 'changed' },
  ]);
  assert.deepEqual(
    asOf(destination, 'SELECT * FROM notes ORDER BY id', before),
    rows,
  );
});

test('a reading sees none of the commits made after it opened', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const rows = asOf(destination, 'SELECT * FROM notes ORDER BY id');
  const reading = destination.reading();
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;

  await connection({
    notes: [
      note('notes', 'n1', 2, 'changed'),
      note('notes', 'n2', 1),
      checkpoint('notes', 2),
    ],
  }).run();

  assert.deepEqual(
    reading.sql
      .prepare('SELECT * FROM notes ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    rows,
  );
  assert.deepEqual(
    asOf(destination, 'SELECT id, body FROM notes ORDER BY id'),
    [
      { id: 'n1', body: 'changed' },
      { id: 'n2', body: 'n2' },
    ],
  );
});

test('a reading at the newest commit reads the tables as they are, the sync history too, at the time of that commit, and disposing it closes it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, connection } = notesFile(scratch.path);
  await connection({
    notes: [note('notes', 'n1', 1), checkpoint('notes', 1)],
  }).run();
  const last = lastCommit(destination);
  const reading = destination.reading(newest(destination));
  if ('expired' in reading) assert.fail(reading.expired);

  const temporary = reading.sql
    .prepare('SELECT name FROM temp.sqlite_schema')
    .all();
  const attempts = reading.sql
    .prepare('SELECT status FROM sync_attempts')
    .all()
    .map((row) => ({ ...row }));
  reading[Symbol.dispose]();

  assert.deepEqual(temporary, []);
  assert.deepEqual(attempts, [{ status: 'succeeded' }]);
  assert.ok(
    reading.at.equals(Temporal.Instant.from(String(last.committed_at))),
    `${reading.at} is not ${last.committed_at}`,
  );
  assert.equal(reading.sql.isOpen, false);
});

// Documents keyed by id, each with the bytes of one file.
const documents = () =>
  new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
    supportsFileTransfer: true,
  });

// A table that keeps the bytes of each document's file in the SQLite file.
const documentTable = (stream: Stream, destination: SQLiteDestination) =>
  destination.table('documents', (c) => [
    c.text('id'),
    c.integer('version'),
    c.blob('bytes').from(stream.file),
  ]);

// A deduplicating copy of the documents, in which the newest record of a key
// replaces the stored row.
const deduplicated = (stream: Stream, destination: SQLiteDestination) =>
  new Copy(stream, documentTable(stream, destination), {
    id: 'documents',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
    dedupPolicy: 'replace',
  });

// A document whose file holds the text, written where the source reads it.
async function document(
  directory: string,
  id: string,
  version: number,
  text: string,
): Promise<SourceMessage> {
  const file = join(directory, `${id}-${version}-${text}.txt`);
  await writeFile(file, text);
  return { stream: 'documents', data: { id, version }, file };
}

// The chunk table of the bytes of the documents, by the documented rule:
// _elt_files_ and the first 40 hex digits of the SHA-256 of the JSON of
// [table, column].
const chunks = `"_elt_files_${hash('sha256', JSON.stringify(['documents', 'bytes'])).slice(0, 40)}"`;

// The text of each document's file, as a reading as of the position, or as
// of the newest one, puts its chunks together; null when no chunk is left.
function texts(destination: SQLiteDestination, position?: string) {
  const rows = asOf(
    destination,
    `SELECT d.id, c.bytes FROM documents AS d LEFT JOIN ${chunks} AS c ON c.file = d.bytes ORDER BY d.id, c.n`,
    position,
  );
  return Object.fromEntries(
    [...Map.groupBy(rows, ({ id }) => String(id))].map(([id, parts]) => {
      const bytes = parts.flatMap(({ bytes }) =>
        bytes instanceof Uint8Array ? [bytes] : [],
      );
      return [id, bytes.length === 0 ? null : Buffer.concat(bytes).toString()];
    }),
  );
}

// The number of stored files that no row of the documents or of their
// history refers to.
function orphans(destination: SQLiteDestination) {
  const [recorded] = storedRows(
    destination.path,
    "SELECT history FROM _elt_histories WHERE target = 'documents'",
  );
  if (recorded === undefined) assert.fail('documents has no history');
  const [counted] = storedRows(
    destination.path,
    `SELECT count(DISTINCT file) AS n FROM ${chunks} WHERE file NOT IN (SELECT bytes FROM documents WHERE bytes IS NOT NULL UNION ALL SELECT bytes FROM "${String(recorded.history)}" WHERE bytes IS NOT NULL)`,
  );
  return counted?.n;
}

test('the file of a document that a later pass deletes reads with its own bytes as of the position before it, though that pass saved a new file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  const copy = deduplicated(stream, destination);
  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        await document(scratch.path, 'd2', 1, 'second'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = newest(destination);

  await connection(
    {
      documents: [
        { type: 'DELETE', stream: 'documents', key: { id: 'd2' } },
        await document(scratch.path, 'd3', 1, 'third'),
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();

  assert.deepEqual(texts(destination), { d1: 'first', d3: 'third' });
  assert.deepEqual(texts(destination, before), { d1: 'first', d2: 'second' });
  assert.equal(orphans(destination), 0);
});

test('a document whose file changed, or whose fields changed beside the same file, is a new version, and its old row reads its own bytes as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  const copy = deduplicated(stream, destination);
  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        await document(scratch.path, 'd2', 1, 'same'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = newest(destination);

  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'changed'),
        await document(scratch.path, 'd2', 2, 'same'),
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();
  const last = lastCommit(destination);

  assert.deepEqual(
    asOf(destination, 'SELECT id, committed_in FROM documents ORDER BY id'),
    [
      { id: 'd1', committed_in: last.number },
      { id: 'd2', committed_in: last.number },
    ],
  );
  assert.deepEqual(
    replaced(destination, 'documents').map(({ id, version }) => ({
      id,
      version,
    })),
    [
      { id: 'd1', version: 1 },
      { id: 'd2', version: 1 },
    ],
  );
  assert.deepEqual(texts(destination), { d1: 'changed', d2: 'same' });
  assert.deepEqual(texts(destination, before), { d1: 'first', d2: 'same' });
  assert.equal(orphans(destination), 0);
});

test('an overwrite, a deduplicating load and a reload that bring the same files again leave each row with its file, its commit and its loaded_at, keep no history, and keep no second copy of a file', async () => {
  for (const mode of ['overwrite', 'append_dedup', 'reload'] as const) {
    await using scratch = await new TemporaryFiles().directory('elt-as-of-');
    const stream = documents();
    const { destination, connection } = notesFile(scratch.path, stream);
    const copy =
      mode === 'overwrite'
        ? new Copy(stream, documentTable(stream, destination))
        : deduplicated(stream, destination);
    const pass = async (read: number) =>
      connection(
        {
          documents: [
            ...(mode === 'reload' && read > 1
              ? [{ type: 'RESET' as const, stream: 'documents' }]
              : []),
            await document(scratch.path, 'd1', 1, 'first'),
            await document(scratch.path, 'd2', 1, 'second'),
            checkpoint('documents', read),
          ],
        },
        copy,
      ).run();
    await pass(1);
    const before = newest(destination);
    const rows = asOf(destination, 'SELECT * FROM documents ORDER BY id');
    await delay(5);

    await pass(2);

    assert.notEqual(newest(destination), before, mode);
    assert.deepEqual(
      asOf(destination, 'SELECT * FROM documents ORDER BY id'),
      rows,
      mode,
    );
    assert.deepEqual(replaced(destination, 'documents'), [], mode);
    assert.deepEqual(texts(destination), { d1: 'first', d2: 'second' }, mode);
    assert.deepEqual(
      storedRows(
        destination.path,
        `SELECT count(DISTINCT file) AS files FROM ${chunks}`,
      ),
      [{ files: 2 }],
      mode,
    );
  }
});

test('the file of a document that a later overwrite leaves out reads with its own bytes as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  const overwrite = new Copy(stream, documentTable(stream, destination));
  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        await document(scratch.path, 'd2', 1, 'second'),
      ],
    },
    overwrite,
  ).run();
  const before = newest(destination);

  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        await document(scratch.path, 'd3', 1, 'third'),
      ],
    },
    overwrite,
  ).run();

  assert.deepEqual(texts(destination), { d1: 'first', d3: 'third' });
  assert.deepEqual(texts(destination, before), { d1: 'first', d2: 'second' });
  assert.equal(orphans(destination), 0);
});

test('the files of the documents that a reload of another shape swapped out read with their own bytes as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  await connection(
    { documents: [await document(scratch.path, 'd1', 1, 'first')] },
    new Copy(stream, documentTable(stream, destination)),
  ).run();
  const before = newest(destination);

  // A table without version has another shape, which an overwrite reloads
  // into a hidden table that takes the table's place.
  await connection(
    { documents: [await document(scratch.path, 'd2', 1, 'second')] },
    new Copy(
      stream,
      destination.table('documents', (c) => [
        c.text('id'),
        c.blob('bytes').from(stream.file),
      ]),
    ),
  ).run();

  assert.deepEqual(texts(destination), { d2: 'second' });
  assert.deepEqual(texts(destination, before), { d1: 'first' });
  assert.equal(orphans(destination), 0);
});

test('the files of the documents that a clear removed read with their own bytes as of the position before it, also after a later pass saved a new file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  const copy = deduplicated(stream, destination);
  const loaded = connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        await document(scratch.path, 'd2', 1, 'second'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  );
  await loaded.run();
  const before = newest(destination);

  await loaded.clear();
  await connection(
    {
      documents: [
        await document(scratch.path, 'd3', 1, 'third'),
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();

  assert.deepEqual(texts(destination), { d3: 'third' });
  assert.deepEqual(texts(destination, before), { d1: 'first', d2: 'second' });
  assert.equal(orphans(destination), 0);
});

test('the files of the documents of a partition that a later pass resets read with their own bytes as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const owned = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        owner: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['id', 'owner', 'version'],
    },
    primaryKey: ['owner', 'id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
    partitionKey: ['owner'],
    supportsFileTransfer: true,
  });
  const owners = [{ owner: 'ann' }, { owner: 'bob' }];
  const ownedDocument = async (id: string, owner: string, text: string) => ({
    ...(await document(scratch.path, id, 1, text)),
    data: { id, owner, version: 1 },
  });
  const pass = (steps: Readonly<Record<string, readonly Step[]>>) =>
    pipeline(
      new Connection({
        name: 'documents',
        source: new Scripted([owned], steps, owners),
        destination,
        checkpoints,
        steps: [
          new Copy(
            owned,
            destination.table('documents', (c) => [
              c.text('id'),
              c.text('owner'),
              c.integer('version'),
              c.blob('bytes').from(owned.file),
            ]),
            {
              id: 'documents',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ).run();
  await pass({
    'documents:ann': [
      await ownedDocument('a1', 'ann', 'ann first'),
      checkpoint('documents', 1),
    ],
    'documents:bob': [
      await ownedDocument('b1', 'bob', 'bob first'),
      checkpoint('documents', 1),
    ],
  });
  const before = newest(destination);

  await pass({
    'documents:ann': [
      { type: 'RESET', stream: 'documents' },
      await ownedDocument('a2', 'ann', 'ann second'),
      checkpoint('documents', 2),
    ],
    'documents:bob': [checkpoint('documents', 2)],
  });

  assert.deepEqual(texts(destination), { a2: 'ann second', b1: 'bob first' });
  assert.deepEqual(texts(destination, before), {
    a1: 'ann first',
    b1: 'bob first',
  });
  assert.equal(orphans(destination), 0);
});

test('a file column that a pass drops and a later pass adds again gives each new file an id that no row had, so a reading as of a position before the drop shows the bytes of no other file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, checkpoints, connection } = notesFile(
    scratch.path,
    stream,
  );
  const withoutBytes = new Copy(
    stream,
    destination.table('documents', (c) => [c.text('id'), c.integer('version')]),
    {
      id: 'documents',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    },
  );
  const copy = deduplicated(stream, destination);
  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = newest(destination);
  await connection(
    {
      documents: [
        { type: 'DELETE', stream: 'documents', key: { id: 'd1' } },
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();
  // Whether a copy reads files is part of its checkpoint binding, so the host
  // resets the checkpoint at each change; the table keeps its rows.
  await checkpoints.reset('documents');
  await connection(
    {
      documents: [
        { stream: 'documents', data: { id: 'd0', version: 1 } },
        checkpoint('documents', 3),
      ],
    },
    withoutBytes,
  ).run();
  await checkpoints.reset('documents');

  await connection(
    {
      documents: [
        await document(scratch.path, 'd2', 1, 'second'),
        checkpoint('documents', 4),
      ],
    },
    copy,
  ).run();

  const [old] = asOf(
    destination,
    "SELECT bytes FROM documents WHERE id = 'd1'",
    before,
  );
  const [saved] = asOf(
    destination,
    "SELECT bytes FROM documents WHERE id = 'd2'",
  );
  assert.ok(Number(saved?.bytes) > Number(old?.bytes), `${saved?.bytes}`);
  // The dropped column took the chunks of d1's file with it.
  assert.deepEqual(texts(destination, before), { d1: null });
  assert.deepEqual(texts(destination), { d0: null, d2: 'second' });
});

test('an overwrite that adds a file column to a stored table keeps the files of the rows it loads, though the table it replaces and its history do not have the column', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  // No column of a chunk table has this name, so SQL that reads it from a
  // table without it fails instead of reading the chunk table's own column.
  const attachments = `"_elt_files_${hash('sha256', JSON.stringify(['documents', 'attachment'])).slice(0, 40)}"`;
  const read = (position?: string) =>
    asOf(
      destination,
      `SELECT d.id, CAST(c.bytes AS TEXT) AS text FROM documents AS d LEFT JOIN ${attachments} AS c ON c.file = d.attachment ORDER BY d.id`,
      position,
    );
  await connection(
    { documents: [{ stream: 'documents', data: { id: 'd1', version: 1 } }] },
    new Copy(
      stream,
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
      ]),
    ),
  ).run();
  const before = newest(destination);

  // The table gains a column, so the overwrite reloads it into a hidden
  // table, whose commits keep no row in the history.
  await connection(
    { documents: [await document(scratch.path, 'd2', 1, 'second')] },
    new Copy(
      stream,
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.blob('attachment').from(stream.file),
      ]),
    ),
  ).run();

  assert.deepEqual(read(), [{ id: 'd2', text: 'second' }]);
  assert.deepEqual(read(before), [{ id: 'd1', text: null }]);
});

test('the file in a file storage of a document that a later pass deletes reads with its own bytes as of the position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const stream = documents();
  const { destination, connection } = notesFile(scratch.path, stream);
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const copy = new Copy(
    stream,
    destination.table('documents', (c) => [
      c.text('id'),
      c.integer('version'),
      c.text('ref').from(stream.file.store(files)),
    ]),
    {
      id: 'documents',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    },
  );
  await connection(
    {
      documents: [
        await document(scratch.path, 'd1', 1, 'first'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  const before = newest(destination);

  await connection(
    {
      documents: [
        { type: 'DELETE', stream: 'documents', key: { id: 'd1' } },
        checkpoint('documents', 2),
      ],
    },
    copy,
  ).run();

  assert.deepEqual(asOf(destination, 'SELECT id FROM documents'), []);
  const [kept] = asOf(destination, 'SELECT ref FROM documents', before);
  assert.equal(
    await readFile(join(files.directory, String(kept?.ref)), 'utf8'),
    'first',
  );
});

test('a row that a later pass sends again after its table dropped a column and took it back has the value again, and reads as it was at each position before', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, stream, connection } = notesFile(scratch.path);
  // The replace policy has no cursor guard to refuse a record with the
  // cursor of the stored row, so only the values tell the rows apart.
  const copy = (withBody: boolean) =>
    new Copy(
      stream,
      withBody
        ? destination.table('notes')
        : destination.table('notes', (c) => [
            c.text('id'),
            c.integer('version'),
          ]),
      {
        id: 'notes',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
        dedupPolicy: 'replace',
      },
    );
  await connection(
    { notes: [note('notes', 'n1', 1, 'kept'), checkpoint('notes', 1)] },
    copy(true),
  ).run();
  const first = newest(destination);
  const rows = asOf(destination, 'SELECT * FROM notes');
  await connection({ notes: [checkpoint('notes', 2)] }, copy(false)).run();
  const dropped = newest(destination);

  await connection(
    { notes: [note('notes', 'n1', 1, 'kept'), checkpoint('notes', 3)] },
    copy(true),
  ).run();

  assert.deepEqual(asOf(destination, 'SELECT id, body FROM notes'), [
    { id: 'n1', body: 'kept' },
  ]);
  assert.deepEqual(asOf(destination, 'SELECT id, body FROM notes', dropped), [
    { id: 'n1', body: null },
  ]);
  assert.deepEqual(asOf(destination, 'SELECT * FROM notes', first), rows);
});
