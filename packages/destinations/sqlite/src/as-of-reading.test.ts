import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
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
  return { destination, stream, connection };
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
