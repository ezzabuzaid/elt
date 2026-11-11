import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { open } from '@zukhruf/sqlite-open';
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
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
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
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
  });

const note = (stream: string, id: string, version = 1) => ({
  stream,
  data: { id, version },
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

// The commit numbers of the positions after `after`, which must not be
// expired, and each in the one epoch of the file.
function walkable(destination: SQLiteDestination, after?: string): number[] {
  const positions = destination.positions(after);
  if ('expired' in positions) assert.fail(positions.expired);
  const epochs = new Set(positions.map((position) => position.split(':')[0]));
  assert.ok(epochs.size <= 1, `positions of two epochs: ${positions}`);
  return positions.map((position) => Number(position.split(':')[1]));
}

// The position that names commit number in the file's epoch.
function position(destination: SQLiteDestination, number: number): string {
  const positions = destination.positions();
  if ('expired' in positions || positions[0] === undefined)
    assert.fail('the file has no position yet');
  return `${positions[0].split(':')[0]}:${number}`;
}

// Each row's id with the commit that wrote it.
const committed = (destination: SQLiteDestination, table: string) =>
  storedRows(
    destination.path,
    `SELECT id, committed_in FROM ${table} ORDER BY id`,
  );

const run = (connection: Connection<SQLiteTable>) =>
  new Pipeline({
    clock: globalThis,
    connections: [connection],
    history: new SQLiteSyncHistory(),
  }).run();

// Connection a commits once, then waits while connection b runs a whole pass
// into the same file, then commits again and ends.
async function interleaved(directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const a = notes('a');
  const b = notes('b');
  const wait = latch();
  const connection = (stream: Stream, steps: readonly Step[]) =>
    new Connection({
      name: stream.name,
      source: new Scripted([stream], { [stream.name]: steps }),
      destination,
      checkpoints,
      steps: [incremental(stream, destination)],
    });
  const first = run(
    connection(a, [
      note('a', 'a1'),
      checkpoint('a', 1),
      wait.step,
      note('a', 'a2'),
      checkpoint('a', 2),
    ]),
  );
  await wait.reached;
  await run(connection(b, [note('b', 'b1'), checkpoint('b', 1)]));
  const during = walkable(destination);
  wait.release();
  await first;
  return { destination, during };
}

test('commit numbers rise in the order of the commits across two connections that write one file', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const { destination } = await interleaved(scratch.path);

  const [a1, a2] = committed(destination, 'a');
  const [b1] = committed(destination, 'b');

  assert.ok(
    Number(a1?.committed_in) < Number(b1?.committed_in) &&
      Number(b1?.committed_in) < Number(a2?.committed_in),
    JSON.stringify({ a1, b1, a2 }),
  );
});

test('no position falls inside two loads that overlap, and the end of the later one is a position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const { destination, during } = await interleaved(scratch.path);

  const [, a2] = committed(destination, 'a');

  assert.deepEqual(during, []);
  assert.deepEqual(walkable(destination), [Number(a2?.committed_in)]);
});

test('a pass that waits after its first commit shows no position of its load until it ends', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const stream = notes('notes');
  const wait = latch();
  const connection = (steps: readonly Step[]) =>
    new Connection({
      name: 'notes',
      source: new Scripted([stream], { notes: steps }),
      destination,
      checkpoints,
      steps: [incremental(stream, destination)],
    });
  await run(connection([note('notes', 'n1'), checkpoint('notes', 1)]));
  const [ended] = walkable(destination);
  const second = run(
    connection([note('notes', 'n2'), checkpoint('notes', 2), wait.step]),
  );
  await wait.reached;

  const during = walkable(destination);
  // Not expired, so the waiting pass has committed once.
  const duringPastItsCommit = walkable(
    destination,
    position(destination, Number(ended) + 1),
  );
  wait.release();
  await second;
  const [, n2] = committed(destination, 'notes');

  assert.deepEqual(during, [ended]);
  assert.deepEqual(duringPastItsCommit, []);
  assert.deepEqual(walkable(destination), [ended, Number(n2?.committed_in)]);
  assert.deepEqual(
    walkable(destination, position(destination, Number(ended))),
    [Number(n2?.committed_in)],
  );
});

test('a load that a killed process left open hides every later position, until the next load of its connection closes it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const path = join(scratch.path, 'data.sqlite');
  const state = join(scratch.path, 'state.sqlite');
  // A process that commits once in a pass of notes, then is killed while it
  // reads.
  const pass = `
    import { Catalog, Connection, Copy, Gauge, Pipeline, Source, Stream } from '@eltjs/elt';
    import { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
    class Hanging extends Source {
      identity = 'scripted';
      notes = new Stream({
        name: 'notes',
        jsonSchema: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } }, required: ['id', 'version'] },
        primaryKey: ['id'],
        supportedSyncModes: ['full_refresh', 'incremental'],
        emitsDeletes: true,
      });
      catalog = new Catalog([this.notes]);
      coverage() { return { description: 'test', selection: {} }; }
      async currentAsOf() { return null; }
      async open() { return new AsyncDisposableStack(); }
      changeSignals(streams) { return [{ gauge: new (class extends Gauge { async read() { return 0; } })(), streams, interval: 1000, timeout: 1000 }]; }
      async *extract() {
        yield { stream: 'notes', data: { id: 'n1', version: 1 } };
        yield { type: 'STATE', stream: 'notes', state: { read: 1 } };
        process.stdout.write('committed\\n');
        await new Promise(() => setInterval(() => {}, 1 << 30));
      }
    }
    const source = new Hanging();
    const destination = new SQLiteDestination({ path: process.env.DATABASE });
    await new Pipeline({ clock: globalThis,
      connections: [new Connection({ name: 'notes', source, destination,
        checkpoints: new SQLiteCheckpointStore({ path: process.env.STATE }),
        steps: [new Copy(source.notes, destination.table('notes'), { id: 'notes', syncMode: 'incremental', destinationSyncMode: 'append_dedup', cursorField: 'version' })] })],
      history: new SQLiteSyncHistory(),
    }).run();
  `;
  const killed = spawn(process.execPath, ['--input-type=module', '-e', pass], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATABASE: path, STATE: state },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(killed, 'exit');
  await Promise.race([
    once(killed.stdout, 'data'),
    exited.then(() => assert.fail('the process ended before its commit')),
  ]);
  killed.kill('SIGKILL');
  await exited;
  const destination = new SQLiteDestination({ path });
  const stream = notes('notes');

  const left = walkable(destination);
  await run(
    new Connection({
      name: 'notes',
      source: new Scripted([stream], {
        notes: [note('notes', 'n2'), checkpoint('notes', 2)],
      }),
      destination,
      checkpoints: new SQLiteCheckpointStore({ path: state }),
      steps: [incremental(stream, destination)],
    }),
  );
  const [n1, n2] = committed(destination, 'notes');

  assert.deepEqual(left, []);
  assert.deepEqual(walkable(destination), [
    Number(n1?.committed_in),
    Number(n2?.committed_in),
  ]);
});

test('a load that a later load of its connection closed cannot commit, so the positions already listed stay', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const early = notes('early');
  const late = notes('late');
  const wait = latch();
  const connection = (lateSteps: readonly Step[]) =>
    new Connection({
      name: 'notes',
      source: new Scripted([early, late], {
        early: [note('early', 'e1')],
        late: lateSteps,
      }),
      destination,
      steps: [
        new Copy(early, destination.table('early')),
        new Copy(late, destination.table('late')),
      ],
    });
  const overtaken = run(connection([wait.step, note('late', 'l1')])).then(
    () => assert.fail('the overtaken pass must not commit'),
    (error: unknown) => error,
  );
  await wait.reached;
  await run(connection([note('late', 'l2')]));
  const listed = walkable(destination);

  wait.release();
  const failure = await overtaken;

  assert.ok(failure instanceof PipelineError, String(failure));
  assert.match(
    String(failure.errors[0]),
    /A later load of connection notes closed this load/,
  );
  assert.equal(listed.length, 2);
  assert.deepEqual(walkable(destination), listed);
  assert.deepEqual(
    committed(destination, 'late').map(({ id }) => id),
    ['l2'],
  );
});

test('a position of a file that was made again is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const stream = notes('notes');
  const connection = new Connection({
    name: 'notes',
    source: new Scripted([stream], { notes: [note('notes', 'n1')] }),
    destination,
    steps: [new Copy(stream, destination.table('notes'))],
  });
  await run(connection);
  const listed = destination.positions();
  if ('expired' in listed || listed[0] === undefined)
    assert.fail('the first pass listed no position');
  const [old] = listed;
  for (const suffix of ['', '-wal', '-shm'])
    await rm(`${destination.path}${suffix}`, { force: true });
  await run(connection);

  const after = destination.positions(old);

  assert.ok('expired' in after, JSON.stringify(after));
  assert.equal(walkable(destination).length, 1);
});

test('a file that is not there, or that no load numbered, has no positions, and a position of it is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const missing = new SQLiteDestination({
    path: join(scratch.path, 'missing.sqlite'),
  });
  const unnumbered = new SQLiteDestination({
    path: join(scratch.path, 'other.sqlite'),
  });
  {
    using database = open(unnumbered.path);
    database.exec('CREATE TABLE other (id TEXT)');
  }

  const positions = [missing, unnumbered].map((destination) => [
    destination.positions(),
    'expired' in Object(destination.positions('epoch:1')),
  ]);

  assert.deepEqual(positions, [
    [[], true],
    [[], true],
  ]);
});

test('a string that is not a position is refused', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const stream = notes('notes');
  await run(
    new Connection({
      name: 'notes',
      source: new Scripted([stream], { notes: [note('notes', 'n1')] }),
      destination,
      steps: [new Copy(stream, destination.table('notes'))],
    }),
  );

  assert.throws(() => destination.positions('notes'), TypeError);
  assert.throws(
    () => destination.positions(position(destination, 1).replace(/\d+$/, 'x')),
    TypeError,
  );
});

test('a position past the newest commit of the file is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const stream = notes('notes');
  await run(
    new Connection({
      name: 'notes',
      source: new Scripted([stream], { notes: [note('notes', 'n1')] }),
      destination,
      steps: [new Copy(stream, destination.table('notes'))],
    }),
  );
  const [newest] = walkable(destination);

  const past = destination.positions(position(destination, Number(newest) + 1));
  const at = destination.positions(position(destination, Number(newest)));

  assert.ok('expired' in past, JSON.stringify(past));
  assert.deepEqual(at, []);
});

test('each row of an append, an overwrite, a deduplicated copy and a reset partition names a commit of the load that last wrote it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const appended = notes('appended');
  const replaced = notes('replaced');
  const deduplicated = notes('deduplicated');
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
  const owner = (id: string, name: string) => ({
    stream: 'owned',
    data: { id, owner: name, version: 1 },
  });
  const pass = (steps: Readonly<Record<string, readonly Step[]>>) =>
    run(
      new Connection({
        name: 'notes',
        source: new Scripted([appended, replaced, deduplicated, owned], steps, [
          { owner: 'ann' },
          { owner: 'bob' },
        ]),
        destination,
        checkpoints,
        steps: [
          new Copy(appended, destination.table('appended'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
          new Copy(replaced, destination.table('replaced')),
          incremental(deduplicated, destination),
          incremental(owned, destination),
        ],
      }),
    );
  await pass({
    appended: [note('appended', 'p1')],
    replaced: [note('replaced', 'p1')],
    deduplicated: [
      note('deduplicated', 'kept'),
      note('deduplicated', 'updated'),
      checkpoint('deduplicated', 1),
    ],
    'owned:ann': [owner('a1', 'ann'), checkpoint('owned', 1)],
    'owned:bob': [owner('b1', 'bob'), checkpoint('owned', 1)],
  });
  await pass({
    appended: [note('appended', 'p2')],
    replaced: [note('replaced', 'p2')],
    deduplicated: [
      note('deduplicated', 'updated', 2),
      note('deduplicated', 'added'),
      checkpoint('deduplicated', 2),
    ],
    'owned:ann': [
      { type: 'RESET', stream: 'owned' },
      owner('a2', 'ann'),
      checkpoint('owned', 2),
    ],
    'owned:bob': [checkpoint('owned', 2)],
  });
  const [first, second] = storedRows(
    destination.path,
    'SELECT id FROM _elt_loads ORDER BY id',
  ).map(({ id }) => id);
  const loads = (table: string) =>
    storedRows(
      destination.path,
      `SELECT t.id, c.load FROM ${table} AS t LEFT JOIN _elt_commits AS c ON c.number = t.committed_in ORDER BY t.id`,
    );

  assert.deepEqual(loads('appended'), [
    { id: 'p1', load: first },
    { id: 'p2', load: second },
  ]);
  assert.deepEqual(loads('replaced'), [{ id: 'p2', load: second }]);
  assert.deepEqual(loads('deduplicated'), [
    { id: 'added', load: second },
    { id: 'kept', load: first },
    { id: 'updated', load: second },
  ]);
  assert.deepEqual(loads('owned'), [
    { id: 'a2', load: second },
    { id: 'b1', load: first },
  ]);
});

test('a deduplicated update moves the row to the commit that made it, and a row the cursor kept stays with its own', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const stream = notes('notes');

  await run(
    new Connection({
      name: 'notes',
      source: new Scripted([stream], {
        notes: [
          note('notes', 'newer'),
          note('notes', 'older', 2),
          checkpoint('notes', 1),
          note('notes', 'newer', 2),
          note('notes', 'older', 1),
          checkpoint('notes', 2),
        ],
      }),
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(scratch.path, 'state.sqlite'),
      }),
      steps: [incremental(stream, destination)],
    }),
  );
  const commits = storedRows(
    destination.path,
    'SELECT number FROM _elt_commits ORDER BY number',
  ).map(({ number }) => number);

  assert.deepEqual(committed(destination, 'notes'), [
    { id: 'newer', committed_in: commits[1] },
    { id: 'older', committed_in: commits[0] },
  ]);
});

test("a reload's rows name the commit that swapped them in, not the commits that staged them", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-commits-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const stream = notes('notes');
  const pass = (steps: readonly Step[]) =>
    run(
      new Connection({
        name: 'notes',
        source: new Scripted([stream], { notes: steps }),
        destination,
        checkpoints,
        steps: [incremental(stream, destination)],
      }),
    );
  await pass([note('notes', 'gone'), checkpoint('notes', 1)]);

  await pass([
    { type: 'RESET', stream: 'notes' },
    note('notes', 'n1'),
    checkpoint('notes', 2),
    note('notes', 'n2'),
    checkpoint('notes', 3),
  ]);
  const reload = storedRows(
    destination.path,
    'SELECT number FROM _elt_commits WHERE load = (SELECT max(id) FROM _elt_loads) ORDER BY number',
  ).map(({ number }) => number);

  assert.equal(reload.length, 3);
  assert.deepEqual(committed(destination, 'notes'), [
    { id: 'n1', committed_in: reload[2] },
    { id: 'n2', committed_in: reload[2] },
  ]);
});
