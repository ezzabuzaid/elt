import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

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
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
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

// Notes that only ever arrive, never removed, which a copy appends.
const entries = (name: string) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
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
const incremental = (stream: Stream, destination: PostgresDestination) =>
  new Copy(stream, destination.table(stream.name), {
    id: stream.name,
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });

// An incremental copy that appends each note it reads.
const appending = (stream: Stream, destination: PostgresDestination) =>
  new Copy(stream, destination.table(stream.name), {
    id: stream.name,
    syncMode: 'incremental',
    destinationSyncMode: 'append',
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
// expired, and each in the one epoch of the database.
async function walkable(
  destination: PostgresDestination,
  after?: string,
): Promise<number[]> {
  const positions = await destination.positions(after);
  if ('expired' in positions) assert.fail(positions.expired);
  const epochs = new Set(positions.map((position) => position.split(':')[0]));
  assert.ok(epochs.size <= 1, `positions of two epochs: ${positions}`);
  return positions.map((position) => Number(position.split(':')[1]));
}

// The position that names commit number in the database's epoch.
async function position(
  destination: PostgresDestination,
  number: number,
): Promise<string> {
  const positions = await destination.positions();
  if ('expired' in positions || positions[0] === undefined)
    assert.fail('the database has no position yet');
  return `${positions[0].split(':')[0]}:${number}`;
}

// A client of the test's own, ended with the test.
function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

const run = (url: string, connection: Connection<PostgresTable>) =>
  new Pipeline({
    clock: globalThis,
    connections: [connection],
    history: new PostgresSyncHistory({ url }),
  }).run();

// One connection of a schema, named as the schema, that copies its steps.
function connector(
  url: string,
  schema: string,
  streams: readonly Stream[],
  steps: Readonly<Record<string, readonly Step[]>>,
  copy: (
    stream: Stream,
    destination: PostgresDestination,
  ) => Copy<PostgresTable> = incremental,
) {
  const destination = new PostgresDestination({ url, schema });
  return {
    destination,
    connection: new Connection({
      name: schema,
      source: new Scripted(streams, steps),
      destination,
      checkpoints: new PostgresCheckpointStore({ url, schema }),
      steps: streams.map((stream) => copy(stream, destination)),
    }),
  };
}

test('commit numbers rise in the order of the commits across two connections that load two schemas of one database', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const wait = latch();
  const a = connector(url, 'a', [notes('notes')], {
    notes: [
      note('notes', 'a1'),
      checkpoint('notes', 1),
      wait.step,
      note('notes', 'a2'),
      checkpoint('notes', 2),
    ],
  });
  const b = connector(url, 'b', [notes('notes')], {
    notes: [note('notes', 'b1'), checkpoint('notes', 1)],
  });
  const first = run(url, a.connection);
  await wait.reached;
  await run(url, b.connection);
  const during = await walkable(a.destination);
  wait.release();
  await first;

  const [a1, a2] = await sql`SELECT committed_in FROM a.notes ORDER BY id`;
  const [b1] = await sql`SELECT committed_in FROM b.notes`;

  assert.ok(
    Number(a1?.committed_in) < Number(b1?.committed_in) &&
      Number(b1?.committed_in) < Number(a2?.committed_in),
    JSON.stringify({ a1, b1, a2 }),
  );
  assert.deepEqual(during, []);
  assert.deepEqual(await walkable(a.destination), [Number(a2?.committed_in)]);
  assert.deepEqual(await walkable(b.destination), [Number(a2?.committed_in)]);
});

test('a pass that waits after its first commit shows no position of its load until it ends', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const stream = notes('notes');
  const wait = latch();
  const pass = (steps: readonly Step[]) =>
    run(url, connector(url, 'raw', [stream], { notes: steps }).connection);
  const { destination } = connector(url, 'raw', [stream], {});
  await pass([note('notes', 'n1'), checkpoint('notes', 1)]);
  const [ended] = await walkable(destination);
  const second = pass([note('notes', 'n2'), checkpoint('notes', 2), wait.step]);
  await wait.reached;

  const during = await walkable(destination);
  // Not expired, so the waiting pass has committed once.
  const duringPastItsCommit = await walkable(
    destination,
    await position(destination, Number(ended) + 1),
  );
  wait.release();
  await second;
  const [, n2] = await sql`SELECT committed_in FROM raw.notes ORDER BY id`;

  assert.deepEqual(during, [ended]);
  assert.deepEqual(duringPastItsCommit, []);
  assert.deepEqual(await walkable(destination), [
    ended,
    Number(n2?.committed_in),
  ]);
  assert.deepEqual(
    await walkable(destination, await position(destination, Number(ended))),
    [Number(n2?.committed_in)],
  );
});

test('a load that a killed process left open hides every later position, until the next load of its connection closes it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  // A process that commits once in a pass of notes, then is killed while it
  // reads.
  const pass = `
    import { Catalog, Connection, Copy, Gauge, Pipeline, Source, Stream } from '@eltjs/elt';
    import { PostgresCheckpointStore, PostgresDestination, PostgresSyncHistory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
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
    const url = process.env.DATABASE;
    const source = new Hanging();
    const destination = new PostgresDestination({ url, schema: 'raw' });
    await new Pipeline({ clock: globalThis,
      connections: [new Connection({ name: 'raw', source, destination,
        checkpoints: new PostgresCheckpointStore({ url, schema: 'raw' }),
        steps: [new Copy(source.notes, destination.table('notes'), { id: 'notes', syncMode: 'incremental', destinationSyncMode: 'append_dedup', cursorField: 'version' })] })],
      history: new PostgresSyncHistory({ url }),
    }).run();
  `;
  const killed = spawn(process.execPath, ['--input-type=module', '-e', pass], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATABASE: url },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(killed, 'exit');
  await Promise.race([
    once(killed.stdout, 'data'),
    exited.then(() => assert.fail('the process ended before its commit')),
  ]);
  killed.kill('SIGKILL');
  await exited;
  const stream = notes('notes');
  const next = connector(url, 'raw', [stream], {
    notes: [note('notes', 'n2'), checkpoint('notes', 2)],
  });

  const left = await walkable(next.destination);
  await run(url, next.connection);
  const [n1, n2] = await sql`SELECT committed_in FROM raw.notes ORDER BY id`;

  assert.deepEqual(left, []);
  assert.deepEqual(await walkable(next.destination), [
    Number(n1?.committed_in),
    Number(n2?.committed_in),
  ]);
});

test('a load that a later load of its connection closed cannot commit, so the positions already listed stay', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const early = notes('early');
  const late = notes('late');
  const wait = latch();
  const destination = new PostgresDestination({ url, schema: 'raw' });
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
  const overtaken = run(url, connection([wait.step, note('late', 'l1')])).then(
    () => assert.fail('the overtaken pass must not commit'),
    (error: unknown) => error,
  );
  await wait.reached;
  await run(url, connection([note('late', 'l2')]));
  const listed = await walkable(destination);

  wait.release();
  const failure = await overtaken;

  assert.ok(failure instanceof PipelineError, String(failure));
  assert.match(
    String(failure.errors[0]),
    /A later load of connection notes closed this load/,
  );
  assert.equal(listed.length, 2);
  assert.deepEqual(await walkable(destination), listed);
  assert.deepEqual(
    (await sql`SELECT id FROM raw.late`).map(({ id }) => id),
    ['l2'],
  );
});

test('a commit still in flight keeps every later commit of the database from being a position, and one that rolls back holds nothing back', async (t) => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const locker = client(url, clients);
  const watcher = client(url, clients);
  const a = (id: string) =>
    connector(
      url,
      'a',
      [entries('notes')],
      { notes: [note('notes', id), checkpoint('notes', 1)] },
      appending,
    );
  const b = connector(url, 'b', [notes('notes')], {
    notes: [note('notes', 'b1'), checkpoint('notes', 1)],
  });
  await run(url, a('a1').connection);
  const before = await walkable(b.destination);
  // A commit takes its number, then waits for the table that the test
  // holds, so it stays in flight while b commits.
  const stalled = await locker.reserve();
  clients.defer(() => stalled.release());
  await stalled`BEGIN`;
  await stalled`LOCK TABLE a.notes IN ACCESS EXCLUSIVE MODE`;
  const second = run(url, a('a2').connection).then(
    () => 'committed',
    () => 'failed',
  );
  const pid = await t.waitFor(
    async () => {
      const [blocked] = await watcher<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE NOT granted AND relation = to_regclass('a.notes')`;
      assert.ok(blocked, 'no commit waits for a.notes yet');
      return blocked.pid;
    },
    { interval: 10, timeout: 10_000 },
  );
  await run(url, b.connection);

  const during = await walkable(b.destination);
  await watcher`SELECT pg_terminate_backend(${pid})`;
  const outcome = await second;
  await stalled`ROLLBACK`;
  const [b1] = await watcher`SELECT committed_in FROM b.notes`;
  const after = await walkable(b.destination);

  assert.deepEqual(during, before);
  assert.equal(outcome, 'failed');
  assert.deepEqual(after, [...before, Number(b1?.committed_in)]);
});

test('two connections that commit many times at once lose no commit: each listed position stays listed, with the same commits at or below it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const passes = 15;
  const loader = async (schema: string) => {
    for (let pass = 0; pass < passes; pass++)
      await run(
        url,
        connector(
          url,
          schema,
          [entries('notes')],
          {
            notes: [1, 2, 3].flatMap((step) => [
              note('notes', `${schema}${pass}.${step}`),
              checkpoint('notes', step),
            ]),
          },
          appending,
        ).connection,
      );
  };
  const { destination } = connector(url, 'a', [], {});
  const commitsUpTo = async (number: number) =>
    (
      await sql<
        { number: number }[]
      >`SELECT number FROM _warehouse._elt_commits WHERE number <= ${number} ORDER BY number`
    ).map((row) => row.number);
  let done = false;
  const loading = Promise.all([loader('a'), loader('b')]).finally(() => {
    done = true;
  });
  const seen = new Map<number, number[]>();
  while (!done) {
    const listed = await walkable(destination);
    const newest = listed.at(-1);
    if (newest !== undefined && !seen.has(newest))
      seen.set(newest, await commitsUpTo(newest));
  }
  await loading;

  const final = await walkable(destination);
  const changed = [];
  for (const [number, commits] of seen)
    if (
      !final.includes(number) ||
      (await commitsUpTo(number)).join() !== commits.join()
    )
      changed.push(number);

  assert.ok(seen.size > 1, `the reader saw ${seen.size} positions`);
  assert.deepEqual(changed, []);
  assert.equal((await commitsUpTo(2 ** 31 - 1)).length, passes * 2 * 3);
});

test('first loads into many schemas of a new database can all open at once', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const schemas = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  await using loads = new AsyncDisposableStack();

  // No sync history makes _warehouse first: each load makes the numbering.
  const outcomes = await Promise.allSettled(
    schemas.map(async (schema) =>
      loads.use(
        await new PostgresDestination({ url, schema }).load({
          clock: globalThis,
          connection: schema,
        }),
      ),
    ),
  );

  assert.deepEqual(
    outcomes.map((outcome) =>
      outcome.status === 'rejected' ? String(outcome.reason) : 'opened',
    ),
    schemas.map(() => 'opened'),
  );
});

test('a position of another database is expired in a fresh one, which numbers its commits anew', async () => {
  await using first = await databases.database();
  await using fresh = await databases.database();
  const pass = (url: string) =>
    connector(url, 'raw', [notes('notes')], {
      notes: [note('notes', 'n1'), checkpoint('notes', 1)],
    });
  const old = pass(first.connectionString);
  await run(first.connectionString, old.connection);
  const listed = await old.destination.positions();
  if ('expired' in listed || listed[0] === undefined)
    assert.fail('the first database listed no position');
  const again = pass(fresh.connectionString);
  await run(fresh.connectionString, again.connection);

  const after = await again.destination.positions(listed[0]);
  const positions = await again.destination.positions();

  assert.ok('expired' in after, JSON.stringify(after));
  assert.ok(!('expired' in positions) && positions.length === 1);
  assert.notEqual(positions[0], listed[0]);
  assert.equal(positions[0]?.split(':')[1], listed[0].split(':')[1]);
});

test('a database that no load numbered has no positions, and a position of it is expired', async () => {
  await using database = await databases.database();
  const destination = new PostgresDestination({
    url: database.connectionString,
    schema: 'raw',
  });

  const positions = await destination.positions();
  const after = await destination.positions('epoch:1');

  assert.deepEqual(positions, []);
  assert.ok('expired' in after, JSON.stringify(after));
});

test('a position past the newest commit is expired, and a string that is not a position is refused', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const { destination, connection } = connector(url, 'raw', [notes('notes')], {
    notes: [note('notes', 'n1'), checkpoint('notes', 1)],
  });
  await run(url, connection);
  const [newest] = await walkable(destination);

  const past = await destination.positions(
    await position(destination, Number(newest) + 1),
  );
  const at = await destination.positions(
    await position(destination, Number(newest)),
  );

  assert.ok('expired' in past, JSON.stringify(past));
  assert.deepEqual(at, []);
  await assert.rejects(destination.positions('notes'), TypeError);
  await assert.rejects(
    destination.positions(
      (await position(destination, 1)).replace(/\d+$/, 'x'),
    ),
    TypeError,
  );
});

test('each row of an append, an overwrite, a deduplicated copy and a reset partition names a commit of the load that last wrote it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
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
      url,
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
  const [first, second] = (
    await sql`SELECT id FROM _warehouse._elt_loads ORDER BY id`
  ).map(({ id }) => Number(id));
  const loads = async (table: string) =>
    (
      await sql.unsafe(
        `SELECT t.id, c.load FROM raw.${table} AS t LEFT JOIN _warehouse._elt_commits AS c ON c.number = t.committed_in ORDER BY t.id`,
      )
    ).map(({ id, load }) => ({ id, load: Number(load) }));

  assert.deepEqual(await loads('appended'), [
    { id: 'p1', load: first },
    { id: 'p2', load: second },
  ]);
  assert.deepEqual(await loads('replaced'), [{ id: 'p2', load: second }]);
  assert.deepEqual(await loads('deduplicated'), [
    { id: 'added', load: second },
    { id: 'kept', load: first },
    { id: 'updated', load: second },
  ]);
  assert.deepEqual(await loads('owned'), [
    { id: 'a2', load: second },
    { id: 'b1', load: first },
  ]);
});

test('a deduplicated update moves the row to the commit that made it, and a row the cursor kept stays with its own', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const { connection } = connector(url, 'raw', [notes('notes')], {
    notes: [
      note('notes', 'newer'),
      note('notes', 'older', 2),
      checkpoint('notes', 1),
      note('notes', 'newer', 2),
      note('notes', 'older', 1),
      checkpoint('notes', 2),
    ],
  });

  await run(url, connection);
  const commits = (
    await sql`SELECT number FROM _warehouse._elt_commits ORDER BY number`
  ).map(({ number }) => number);

  assert.deepEqual(
    [...(await sql`SELECT id, committed_in FROM raw.notes ORDER BY id`)],
    [
      { id: 'newer', committed_in: commits[1] },
      { id: 'older', committed_in: commits[0] },
    ],
  );
});

test("a reload's rows name the commit that swapped them in, not the commits that staged them", async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const pass = (steps: readonly Step[]) =>
    run(
      url,
      connector(url, 'raw', [notes('notes')], { notes: steps }).connection,
    );
  await pass([note('notes', 'gone'), checkpoint('notes', 1)]);

  await pass([
    { type: 'RESET', stream: 'notes' },
    note('notes', 'n1'),
    checkpoint('notes', 2),
    note('notes', 'n2'),
    checkpoint('notes', 3),
  ]);
  const reload = (
    await sql`SELECT number FROM _warehouse._elt_commits WHERE load = (SELECT max(id) FROM _warehouse._elt_loads) ORDER BY number`
  ).map(({ number }) => number);

  assert.equal(reload.length, 3);
  assert.deepEqual(
    [...(await sql`SELECT id, committed_in FROM raw.notes ORDER BY id`)],
    [
      { id: 'n1', committed_in: reload[2] },
      { id: 'n2', committed_in: reload[2] },
    ],
  );
});

test('a clear is a commit of its connection, and its number is a position', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const { destination, connection } = connector(url, 'raw', [notes('notes')], {
    notes: [note('notes', 'n1'), checkpoint('notes', 1)],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    connections: [connection],
    history: new PostgresSyncHistory({ url }),
  });
  await pipeline.run();
  const [loaded] = await walkable(destination);

  await pipeline.clear();
  const [clear] = await sql`
    SELECT c.number, l.connector FROM _warehouse._elt_commits AS c
    JOIN _warehouse._elt_loads AS l ON l.id = c.load
    WHERE c.number > ${Number(loaded)}`;

  assert.equal(clear?.connector, 'raw');
  assert.deepEqual(await walkable(destination), [
    Number(loaded),
    Number(clear?.number),
  ]);
});
