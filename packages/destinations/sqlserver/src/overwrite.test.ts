import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  type DestinationSyncMode,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
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
  const admin = await new SqlServerDatabase(login).connect(globalThis);
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

// Plays the messages a test gives each stream, then a checkpoint, or fails
// after them when the test sets failure.
class Scripted extends Source {
  readonly identity: string = 'scripted';
  protected readonly catalog: Catalog;
  messages: Record<string, readonly SourceMessage[]> = {};
  failure: Error | null = null;

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

  protected override async *extract(
    configuration: CopyConfiguration,
  ): AsyncIterable<SourceMessage> {
    const { name } = configuration.stream;
    yield* this.messages[name] ?? [];
    if (this.failure !== null) throw this.failure;
    yield { type: 'STATE', stream: name, state: {} };
  }
}

// A note: its id, its version, and what it says; keyed by id when keyed.
const notes = (name: string, { keyed }: { keyed: boolean }) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Which note.' },
        version: { type: 'integer', description: 'Its version.' },
        body: { type: 'string', description: 'What it says.' },
      },
      required: ['id', 'version', 'body'],
    },
    primaryKey: keyed ? ['id'] : [],
    supportedSyncModes: ['full_refresh'],
  });

const note = (stream: string, id: string, version: number, body = id) => ({
  stream,
  data: { id, version, body },
});

// A pipeline of one connection that copies the stream into the reader view
// of its name in the mode the test gives, deduplicating by its version.
function overwriting(
  login: SqlServerLogin,
  stream: Stream,
  destinationSyncMode: DestinationSyncMode,
) {
  const warehouse = new SqlServerDestination({ login });
  const source = new Scripted([stream]);
  return {
    warehouse,
    source,
    pipeline: new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination: warehouse,
          checkpoints: new SqlServerCheckpointStore({ login }),
          steps: [
            new Copy(stream, warehouse.table(stream.name), {
              id: `notes:${stream.name}`,
              syncMode: 'full_refresh',
              destinationSyncMode,
              ...(destinationSyncMode === 'overwrite_dedup'
                ? { cursorField: 'version' }
                : {}),
            }),
          ],
        }),
      ],
    }),
  };
}

// Each row of a reader view as `id:version:body`, in order.
async function notesOf(connection: SqlServerConnection) {
  const rows = await connection.query(
    'SELECT id, version, body FROM marts.notes ORDER BY id, version, body',
  );
  return rows.map(
    ({ id, version, body }) =>
      `${String(id)}:${String(version)}:${String(body)}`,
  );
}

// The rows that a session reads as of a position, as a reading sets it.
async function asOf(login: SqlServerLogin, position: string) {
  await using reader = await new SqlServerDatabase(login).connect(globalThis);
  // A session context value is a sql_variant, which holds no nvarchar(max).
  await reader.query(
    `DECLARE @position bigint = CAST(@number AS bigint); EXEC sp_set_session_context @key = N'elt.position', @value = @position, @read_only = 1`,
    { number: numberOf(position) },
  );
  return await notesOf(reader);
}

async function positionsOf(warehouse: SqlServerDestination) {
  const positions = await warehouse.positions();
  assert.ok(Array.isArray(positions), 'the database has positions');
  return positions;
}

// The number of the commit that a position names.
const numberOf = (position: string | undefined) =>
  String(position?.split(':')[1]);

// Each row of the raw table: its values, its commit and when it loaded.
function rawOf(admin: SqlServerConnection) {
  return admin.query(
    'SELECT id, version, body, CONVERT(nvarchar(20), committed_in) AS committed_in, CONVERT(nvarchar(40), loaded_at, 127) AS loaded_at FROM _warehouse.raw_notes ORDER BY id, version, body',
  );
}

// The rows that the history of the raw table kept, oldest first.
async function historyOf(admin: SqlServerConnection) {
  const [table] = await admin.query(
    `SELECT name FROM sys.tables WHERE SCHEMA_NAME(schema_id) = N'_warehouse' AND name LIKE N'[_]elt[_]history[_]%'`,
  );
  return admin.query(
    `SELECT id, version, body, CONVERT(nvarchar(20), committed_in) AS committed_in, CONVERT(nvarchar(20), replaced_in) AS replaced_in FROM _warehouse.[${String(table?.name)}] ORDER BY replaced_in, id`,
  );
}

test('an overwrite whose source fails after its records leaves the table and its history as they were, and the next run replaces them', async () => {
  await using database = await scratch();
  const { source, pipeline } = overwriting(
    database.login,
    notes('notes', { keyed: false }),
    'overwrite',
  );
  source.messages = { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] };
  await pipeline.run();
  const raw = await rawOf(database.admin);

  source.messages = { notes: [note('notes', 'n3', 1)] };
  source.failure = new Error('the source stopped');
  await assert.rejects(pipeline.run(), /the source stopped/);

  assert.deepEqual(await rawOf(database.admin), raw);
  assert.deepEqual(await historyOf(database.admin), []);
  source.messages = { notes: [note('notes', 'n2', 1)] };
  source.failure = null;
  await pipeline.run();
  assert.deepEqual(await notesOf(database.admin), ['n2:1:n2']);
});

test('an overwrite replaces the rows of the table with the records of its run, the history keeps each row that left with the commit that replaced it, and the position before reads as it was', async () => {
  await using database = await scratch();
  const { warehouse, source, pipeline } = overwriting(
    database.login,
    notes('notes', { keyed: false }),
    'overwrite',
  );
  source.messages = { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] };
  await pipeline.run();
  const [before] = await positionsOf(warehouse);

  source.messages = { notes: [note('notes', 'n3', 1)] };
  await pipeline.run();
  const [, after] = await positionsOf(warehouse);

  assert.deepEqual(await notesOf(database.admin), ['n3:1:n3']);
  assert.deepEqual(await historyOf(database.admin), [
    {
      id: 'n1',
      version: '1',
      body: 'n1',
      committed_in: numberOf(before),
      replaced_in: numberOf(after),
    },
    {
      id: 'n2',
      version: '1',
      body: 'n2',
      committed_in: numberOf(before),
      replaced_in: numberOf(after),
    },
  ]);
  assert.deepEqual(await asOf(database.login, String(before)), [
    'n1:1:n1',
    'n2:1:n2',
  ]);
});

test('an overwrite that brings the same rows again keeps no history, leaves each row with its commit and its loaded_at, and takes no position', async () => {
  await using database = await scratch();
  const { warehouse, source, pipeline } = overwriting(
    database.login,
    notes('notes', { keyed: false }),
    'overwrite',
  );
  source.messages = { notes: [note('notes', 'n1', 1), note('notes', 'n2', 1)] };
  await pipeline.run();
  const raw = await rawOf(database.admin);
  const positions = await positionsOf(warehouse);

  await pipeline.run();

  assert.deepEqual(await rawOf(database.admin), raw);
  assert.deepEqual(await historyOf(database.admin), []);
  assert.deepEqual(await positionsOf(warehouse), positions);
});

test('a keyless overwrite that sends one of two identical rows again keeps only the copy that left in the history, and the copy that stays keeps its commit', async () => {
  await using database = await scratch();
  const { warehouse, source, pipeline } = overwriting(
    database.login,
    notes('notes', { keyed: false }),
    'overwrite',
  );
  source.messages = {
    notes: [
      note('notes', 'r1', 1),
      note('notes', 'r1', 1),
      note('notes', 'r2', 2),
    ],
  };
  await pipeline.run();
  const [before] = await positionsOf(warehouse);

  source.messages = { notes: [note('notes', 'r1', 1), note('notes', 'r2', 2)] };
  await pipeline.run();
  const [, after] = await positionsOf(warehouse);

  assert.deepEqual(
    (await rawOf(database.admin)).map(({ id, committed_in }) => ({
      id,
      committed_in,
    })),
    [
      { id: 'r1', committed_in: numberOf(before) },
      { id: 'r2', committed_in: numberOf(before) },
    ],
  );
  assert.deepEqual(await historyOf(database.admin), [
    {
      id: 'r1',
      version: '1',
      body: 'r1',
      committed_in: numberOf(before),
      replaced_in: numberOf(after),
    },
  ]);
  assert.deepEqual(await asOf(database.login, String(before)), [
    'r1:1:r1',
    'r1:1:r1',
    'r2:2:r2',
  ]);
});

test('an overwrite_dedup keeps the newest record of each key of its run, replaces only the row whose values changed, and the history keeps only its old values', async () => {
  await using database = await scratch();
  const { warehouse, source, pipeline } = overwriting(
    database.login,
    notes('notes', { keyed: true }),
    'overwrite_dedup',
  );
  source.messages = {
    notes: [
      note('notes', 'n1', 1),
      note('notes', 'n2', 1),
      note('notes', 'n3', 1),
    ],
  };
  await pipeline.run();
  const [before] = await positionsOf(warehouse);

  source.messages = {
    notes: [
      note('notes', 'n2', 3, 'newest'),
      note('notes', 'n1', 1),
      note('notes', 'n2', 2, 'older'),
    ],
  };
  await pipeline.run();
  const [, after] = await positionsOf(warehouse);

  assert.deepEqual(
    (await rawOf(database.admin)).map(({ id, version, committed_in }) => ({
      id,
      version,
      committed_in,
    })),
    [
      { id: 'n1', version: '1', committed_in: numberOf(before) },
      { id: 'n2', version: '3', committed_in: numberOf(after) },
    ],
  );
  assert.deepEqual(await historyOf(database.admin), [
    {
      id: 'n2',
      version: '1',
      body: 'n2',
      committed_in: numberOf(before),
      replaced_in: numberOf(after),
    },
    {
      id: 'n3',
      version: '1',
      body: 'n3',
      committed_in: numberOf(before),
      replaced_in: numberOf(after),
    },
  ]);
});
