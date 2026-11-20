import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

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
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
  type SqlServerTable,
  readPassStatus,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

// A database of its own for one test, which keeps row versions for readers
// unless the test says otherwise.
async function scratch({ rowVersions = true } = {}) {
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
  if (rowVersions)
    await admin.query(
      `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
    );
  return {
    login,
    admin,
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

// A step of a read: a message, or a wait or a failure the test sets.
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
    jsonSchema: {
      type: 'object',
      description: 'Records.',
      properties: { id: { type: 'string', description: 'Record id.' } },
    },
    supportedSyncModes: ['full_refresh'],
  });

const record = (stream: string, id: string) => ({ stream, data: { id } });

// One connection that copies each stream into a table of its name.
function connection(
  login: SqlServerLogin,
  name: string,
  steps: Readonly<Record<string, readonly Step[]>>,
) {
  const streams = Object.keys(steps).map(records);
  const destination = new SqlServerDestination({ login });
  return new Connection({
    name,
    source: new Scripted(streams, steps),
    destination,
    steps: streams.map(
      (stream) => new Copy(stream, destination.table(stream.name)),
    ),
  });
}

const run = (
  login: SqlServerLogin,
  ...connections: Connection<SqlServerTable>[]
) =>
  new Pipeline({
    clock: globalThis,
    connections,
    history: new SqlServerSyncHistory({ login }),
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

const broken = (message: string) => async () => {
  throw new Error(message);
};

test('readPassStatus of a database that no history recorded reads no pass and no streams', async () => {
  await using database = await scratch();

  const status = await readPassStatus(database.login);

  assert.deepEqual(status, { pass: null, streams: [] });
});

test('readPassStatus reads a running pass as running, and its streams as running', async () => {
  await using database = await scratch();
  const { login } = database;
  const wait = latch();
  const passing = run(
    login,
    connection(login, 'notes', { notes: [wait.step, record('notes', 'n1')] }),
  );
  await wait.reached;

  let during;
  try {
    during = await readPassStatus(login);
  } finally {
    wait.release();
    await passing;
  }

  assert.equal(during.pass?.state, 'running');
  assert.equal(during.pass?.completedAt, null);
  assert.deepEqual(
    during.streams.map(({ stream, state, error }) => [stream, state, error]),
    [['notes', 'running', null]],
  );
});

test('readPassStatus reads the latest passes of several connections as one pass, and each stream with the errors of its latest attempt, which a later attempt that loads it clears', async () => {
  await using database = await scratch();
  const { login, admin } = database;
  const notes = connection(login, 'notes', { notes: [record('notes', 'n1')] });
  await assert.rejects(
    run(
      login,
      notes,
      connection(login, 'mail', {
        inbox: [broken('The inbox broke')],
        sent: [record('sent', 's1')],
      }),
    ),
    PipelineError,
  );

  const failed = await readPassStatus(login);
  const [times] = await admin.query(
    'SELECT MIN([started_at]) AS [started], MAX([completed_at]) AS [completed] FROM marts.sync_attempts',
  );
  await run(
    login,
    connection(login, 'mail', {
      inbox: [record('inbox', 'i1')],
      sent: [record('sent', 's1')],
    }),
  );
  const loaded = await readPassStatus(login);

  assert.ok(times?.started instanceof Date && times.completed instanceof Date);
  assert.deepEqual(
    { ...failed.pass, currentAsOf: undefined },
    {
      state: 'partial',
      startedAt: times.started.toISOString(),
      completedAt: times.completed.toISOString(),
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

test('readPassStatus of a database that keeps no row versions reads the failed pass that its history recorded, with the failure type config', async () => {
  await using database = await scratch({ rowVersions: false });
  const { login } = database;
  await assert.rejects(
    run(login, connection(login, 'notes', { notes: [record('notes', 'n1')] })),
    PipelineError,
  );

  const status = await readPassStatus(login);

  assert.equal(status.pass?.state, 'failed');
  assert.equal(status.pass?.failureType, 'config');
  assert.match(String(status.pass?.error), /keeps no row versions/);
});
