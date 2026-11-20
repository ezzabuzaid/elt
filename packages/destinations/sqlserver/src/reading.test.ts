import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitFor } from '@zukhruf/testing/async';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';
import {
  SqlServerDatabase,
  SqlServerUnavailableError,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

// A database of its own for one test, which keeps row versions for readers.
async function scratch() {
  const database = await sqlServer.database();
  const login: SqlServerLogin = {
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    trustServerCertificate: true,
  };
  const admin = await new SqlServerDatabase(login).connect();
  await admin.query(
    `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
  );
  return {
    login,
    admin,
    name: database.database,
    async [Symbol.asyncDispose]() {
      await admin[Symbol.asyncDispose]();
      await database[Symbol.asyncDispose]();
    },
  };
}

class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a read: a message, or a wait the test ends.
type Step = SourceMessage | (() => Promise<void>);

// Reads the steps that a test sets for each stream, by the stream's name.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  steps: Readonly<Record<string, readonly Step[]>> = {};

  constructor(streams: readonly Stream[]) {
    super();
    this.catalog = new Catalog(streams);
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
    for (const step of this.steps[configuration.stream.name] ?? [])
      if (typeof step === 'function') await step();
      else yield step;
  }
}

// Notes by id; a newer copy of a note has a greater version.
const notes = new Stream({
  name: 'notes',
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
  supportedSyncModes: ['incremental'],
  emitsDeletes: true,
});

const note = (id: string, version: number, body = id): SourceMessage => ({
  stream: 'notes',
  data: { id, version, body },
});
const checkpoint = (read: number): SourceMessage => ({
  type: 'STATE',
  stream: 'notes',
  state: { read },
});
const removal = (id: string): SourceMessage => ({
  type: 'DELETE',
  stream: 'notes',
  key: { id },
});

// A pipeline that keeps the newest version of each note in marts.notes.
function warehouse(login: SqlServerLogin) {
  const destination = new SqlServerDestination({ login });
  const source = new Scripted([notes]);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login }),
        steps: [
          new Copy(notes, destination.table('notes'), {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
          }),
        ],
      }),
    ],
  });
  const run = (steps: readonly Step[]) => {
    source.steps = { notes: steps };
    return pipeline.run();
  };
  return { destination, pipeline, run };
}

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

async function newest(destination: SqlServerDestination): Promise<string> {
  const positions = await destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// The rows that a query reads as of a position, or as of the newest one.
async function asOf(
  destination: SqlServerDestination,
  query: string,
  position?: string,
) {
  const reading = await destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  return (await reading.sql.query(query)).map((row) => ({ ...row }));
}

const ordered = 'SELECT [id], [body] FROM marts.notes ORDER BY [id]';

test('a reading of an earlier position reads each row as it was then, also one that a later pass changed or deleted, and a view over the reader view reads as of it too, while a reading with no position reads the rows as they are now', async () => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1, 'first'), note('n2', 1), checkpoint(1)]);
  const before = await newest(destination);
  const [commit] = await database.admin.query(
    'SELECT TOP (1) [committed_at] FROM _warehouse._elt_commits ORDER BY [number] DESC',
  );
  await run([note('n1', 2, 'second'), removal('n2'), note('n3', 1)]);
  await database.admin.query(
    'CREATE VIEW marts.bodies AS SELECT [id], UPPER([body]) AS [loud] FROM marts.notes',
  );

  const reading = await destination.reading(before);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  const then = await reading.sql.query(ordered);
  const loud = await reading.sql.query(
    'SELECT [id], [loud] FROM marts.bodies ORDER BY [id]',
  );

  assert.equal(reading.position, before);
  assert.ok(commit?.committed_at instanceof Date);
  assert.equal(reading.at.epochMilliseconds, commit.committed_at.getTime());
  assert.deepEqual(
    then.map((row) => ({ ...row })),
    [
      { id: 'n1', body: 'first' },
      { id: 'n2', body: 'n2' },
    ],
  );
  assert.deepEqual(
    loud.map((row) => ({ ...row })),
    [
      { id: 'n1', loud: 'FIRST' },
      { id: 'n2', loud: 'N2' },
    ],
  );
  assert.deepEqual(await asOf(destination, ordered), [
    { id: 'n1', body: 'second' },
    { id: 'n3', body: 'n3' },
  ]);
});

test('a reading cannot change its position, at an earlier position or at the newest one, as the session context refuses a change of its key', async () => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1, 'first'), checkpoint(1)]);
  const before = await newest(destination);
  await run([note('n1', 2, 'second'), checkpoint(2)]);
  const later = await newest(destination);

  for (const [position, body] of [
    [before, 'first'],
    [undefined, 'second'],
  ] as const) {
    const reading = await destination.reading(position);
    if ('expired' in reading) assert.fail(reading.expired);
    await using _reading = reading;
    const move = (number: string) =>
      reading.sql.query(
        `DECLARE @position bigint = CAST(@number AS bigint); EXEC sp_set_session_context @key = N'elt.position', @value = @position`,
        { number },
      );

    await assert.rejects(move(later.split(':')[1] ?? ''), /read_only/);
    await assert.rejects(move(before.split(':')[1] ?? ''), /read_only/);
    assert.deepEqual(await reading.sql.query(ordered), [{ id: 'n1', body }]);
  }
});

test('a reading sees none of the commits made after it opened, and disposing it ends its session', async (t) => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1), checkpoint(1)]);
  const reading = await destination.reading();
  if ('expired' in reading) assert.fail(reading.expired);
  const opened = reading.position;
  const [session] = await reading.sql.query('SELECT @@SPID AS [id]');
  const sessions = () =>
    database.admin.query(
      'SELECT 1 AS [open] FROM sys.dm_exec_sessions WHERE [session_id] = CAST(@id AS int)',
      { id: String(session?.id) },
    );

  let read;
  try {
    await run([note('n1', 2, 'changed'), note('n2', 1), checkpoint(2)]);
    read = await reading.sql.query(ordered);
    assert.equal((await sessions()).length, 1);
  } finally {
    await reading[Symbol.asyncDispose]();
  }

  assert.notEqual(await newest(destination), opened);
  assert.deepEqual(
    read.map((row) => ({ ...row })),
    [{ id: 'n1', body: 'n1' }],
  );
  await assert.rejects(
    reading.sql.query('SELECT 1'),
    SqlServerUnavailableError,
  );
  // The server lets go of a session after its connection closes.
  await waitFor(async () => assert.equal((await sessions()).length, 0), {
    signal: t.signal,
  });
});

test('a reading with no position while a pass waits after its first commit reads the newest position before that pass, not its half', async () => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1), checkpoint(1)]);
  const before = await newest(destination);
  const wait = latch();
  const second = run([
    note('n1', 2, 'changed'),
    note('n2', 1),
    checkpoint(2),
    wait.step,
  ]);
  await wait.reached;
  try {
    const half = await database.admin.query(ordered);
    const reading = await destination.reading();
    if ('expired' in reading) assert.fail(reading.expired);
    await using _reading = reading;

    const during = await reading.sql.query(ordered);

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
      [{ id: 'n1', body: 'n1' }],
    );
  } finally {
    wait.release();
    await second;
  }
});

test('a reading of a commit inside a pass is refused, as it would show half of that pass, and the commit that ends the pass reads', async () => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1), checkpoint(1)]);
  const before = await newest(destination);
  await run([note('n2', 1), checkpoint(2), note('n3', 1), checkpoint(3)]);
  const end = await newest(destination);
  // The commit is internal, so only the raw table shows it.
  const [written] = await database.admin.query(
    `SELECT CONVERT(nvarchar(20), [committed_in]) AS [committed_in] FROM _warehouse.raw_notes WHERE [id] = N'n2'`,
  );
  const inside = `${before.split(':')[0]}:${String(written?.committed_in)}`;

  assert.notEqual(inside, end);
  await assert.rejects(destination.reading(inside), TypeError);
  await assert.rejects(destination.reading('not a position'), TypeError);
  assert.deepEqual(await asOf(destination, ordered, end), [
    { id: 'n1', body: 'n1' },
    { id: 'n2', body: 'n2' },
    { id: 'n3', body: 'n3' },
  ]);
});

test('a reading of a database with no load, of a position past the newest commit, or before a clear is expired', async () => {
  await using database = await scratch();
  const { destination, pipeline, run } = warehouse(database.login);
  const empty = await destination.reading();
  await run([note('n1', 1), checkpoint(1)]);
  const old = await newest(destination);
  const [epoch, number] = old.split(':');
  const past = await destination.reading(`${epoch}:${Number(number) + 1}`);
  await pipeline.clear();
  const cleared = await destination.reading(old);

  assert.ok('expired' in empty, JSON.stringify(empty));
  assert.ok('expired' in past, JSON.stringify(past));
  assert.match(past.expired, /past the newest commit/);
  assert.ok('expired' in cleared, JSON.stringify(cleared));
  assert.match(cleared.expired, /a clear that forgot the rows of its table/);
});

test('a reading below the newest commit fails each read of the sync history views, with a message that they cannot be read as of a position, and a reading at the newest commit reads them', async () => {
  await using database = await scratch();
  const { destination, run } = warehouse(database.login);
  await run([note('n1', 1), checkpoint(1)]);
  const before = await newest(destination);
  await run([note('n2', 1), checkpoint(2)]);

  for (const view of [
    'sync_attempts',
    'extraction_coverage',
    'sync_status',
    'stream_status',
    'derived_status',
  ]) {
    await assert.rejects(
      asOf(destination, `SELECT * FROM marts.${view}`, before),
      /The sync history cannot be read as of a position/,
      view,
    );
    assert.ok(
      Array.isArray(await asOf(destination, `SELECT * FROM marts.${view}`)),
      view,
    );
  }
  assert.equal(
    (await asOf(destination, 'SELECT * FROM marts.sync_attempts')).length,
    2,
  );
});
