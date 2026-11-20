import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type FieldSchema,
  type Partition,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
  type StreamSchema,
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
  const admin = await new SqlServerDatabase(login).connect();
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

// Notes whose schema and rows the test sets before each run.
class Notes extends Source {
  readonly identity = 'notes';
  rows: readonly object[] = [];
  #stream: Stream;
  protected catalog: Catalog;

  constructor(jsonSchema: StreamSchema) {
    super();
    this.#stream = Notes.#declare(jsonSchema);
    this.catalog = new Catalog([this.#stream]);
  }

  static #declare(jsonSchema: StreamSchema): Stream {
    return new Stream({
      name: 'notes',
      jsonSchema,
      supportedSyncModes: ['full_refresh'],
    });
  }

  get stream(): Stream {
    return this.#stream;
  }

  reshape(jsonSchema: StreamSchema): void {
    this.#stream = Notes.#declare(jsonSchema);
    this.catalog = new Catalog([this.#stream]);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(_configuration: CopyConfiguration) {
    for (const data of this.rows) yield { stream: 'notes', data };
  }
}

const described = (properties: Record<string, FieldSchema>): StreamSchema => ({
  type: 'object',
  description: 'A note.',
  properties: Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [
      name,
      { ...schema, description: `The ${name} of the note.` },
    ]),
  ),
  required: ['id'],
});

// One run that overwrites marts.notes with the rows of the source, in the
// shape that the source has now.
function overwrite(login: SqlServerLogin, source: Notes) {
  const destination = new SqlServerDestination({ login });
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login }),
        steps: [new Copy(source.stream, destination.table('notes'))],
      }),
    ],
  }).run();
}

async function positionsOf(login: SqlServerLogin) {
  const positions = await new SqlServerDestination({ login }).positions();
  assert.ok(Array.isArray(positions), 'the database has positions');
  return positions;
}

// The rows that a session reads of a relation as of a position.
async function asOf(login: SqlServerLogin, position: string, query: string) {
  await using reader = await new SqlServerDatabase(login).connect();
  // A session context value is a sql_variant, which holds no nvarchar(max).
  await reader.query(
    `DECLARE @position bigint = CAST(@number AS bigint); EXEC sp_set_session_context @key = N'elt.position', @value = @position, @read_only = 1`,
    { number: String(position.split(':')[1]) },
  );
  return await reader.query(query);
}

// Whether a run failed with a TypeError of its copy whose message matches.
const failedWith = (error: unknown, message: RegExp) =>
  error instanceof PipelineError &&
  error.errors[0] instanceof TypeError &&
  message.test(error.errors[0].message);

test('a reload that swaps a table in refreshes the views of others over it, keeps the permissions of the table, and its history keeps the rows it replaced for a position before the swap', async () => {
  await using database = await scratch();
  const source = new Notes(
    described({ id: { type: 'string' }, title: { type: 'string' } }),
  );
  source.rows = [{ id: '1', title: 'a' }];
  await overwrite(database.login, source);
  const [before] = await positionsOf(database.login);
  await database.admin.query(
    `CREATE USER [analyst] WITHOUT LOGIN; GRANT SELECT ON _warehouse.raw_notes TO [analyst];`,
  );
  await database.admin.query('CREATE SCHEMA reports');
  await database.admin.query(
    'CREATE VIEW reports.everything AS SELECT * FROM marts.notes',
  );
  await database.admin.query(
    'CREATE VIEW reports.loud AS SELECT * FROM reports.everything',
  );

  source.reshape(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    }),
  );
  source.rows = [
    { id: '1', title: 'b', body: 'x' },
    { id: '2', title: 'c', body: 'y' },
  ];
  await overwrite(database.login, source);

  assert.deepEqual(
    {
      loud: await database.admin.query(
        'SELECT id, title, body FROM reports.loud ORDER BY id',
      ),
      analyst: await database.admin.query(
        `EXECUTE AS USER = N'analyst'; SELECT COUNT(*) AS [rows] FROM _warehouse.raw_notes; REVERT;`,
      ),
      before: await asOf(
        database.login,
        String(before),
        'SELECT id, title FROM marts.notes ORDER BY id',
      ),
    },
    {
      loud: [
        { id: '1', title: 'b', body: 'x' },
        { id: '2', title: 'c', body: 'y' },
      ],
      analyst: [{ rows: 2 }],
      before: [{ id: '1', title: 'a' }],
    },
  );
});

test('a view WITH SCHEMABINDING over the raw table stops the swap with an error that names it, and the table, its history and the positions stay as they were until the view goes', async () => {
  await using database = await scratch();
  const source = new Notes(
    described({ id: { type: 'string' }, title: { type: 'string' } }),
  );
  source.rows = [{ id: '1', title: 'a' }];
  await overwrite(database.login, source);
  await database.admin.query('CREATE SCHEMA reports');
  await database.admin.query(
    'CREATE VIEW reports.bound WITH SCHEMABINDING AS SELECT id, title FROM _warehouse.raw_notes',
  );
  const positions = await positionsOf(database.login);
  source.reshape(
    described({
      id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    }),
  );
  source.rows = [{ id: '2', title: 'b', body: 'x' }];

  await assert.rejects(overwrite(database.login, source), (error: unknown) =>
    failedWith(
      error,
      /^\[reports\]\.\[bound\] WITH SCHEMABINDING stops the change of \[_warehouse\]\.\[raw_notes\]/,
    ),
  );
  const stopped = {
    notes: await database.admin.query(
      'SELECT id, title FROM marts.notes ORDER BY id',
    ),
    positions: await positionsOf(database.login),
  };
  await database.admin.query('DROP VIEW reports.bound');
  await overwrite(database.login, source);

  assert.deepEqual(
    {
      stopped,
      swapped: await database.admin.query(
        'SELECT id, title, body FROM marts.notes ORDER BY id',
      ),
    },
    {
      stopped: { notes: [{ id: '1', title: 'a' }], positions },
      swapped: [{ id: '2', title: 'b', body: 'x' }],
    },
  );
});

test('a swap that drops a column a view reads fails with an error that names the view, and the table stays as it was', async () => {
  await using database = await scratch();
  const source = new Notes(
    described({ id: { type: 'string' }, title: { type: 'string' } }),
  );
  source.rows = [{ id: '1', title: 'a' }];
  await overwrite(database.login, source);
  await database.admin.query('CREATE SCHEMA reports');
  await database.admin.query(
    'CREATE VIEW reports.titles AS SELECT title FROM marts.notes',
  );
  source.reshape(described({ id: { type: 'string' } }));
  source.rows = [{ id: '2' }];

  await assert.rejects(overwrite(database.login, source), (error: unknown) =>
    failedWith(
      error,
      /^\[reports\]\.\[titles\] reads \[_warehouse\]\.\[raw_notes\] and does not fit its change: Invalid column name 'title'/,
    ),
  );

  assert.deepEqual(
    await database.admin.query('SELECT title FROM reports.titles'),
    [{ title: 'a' }],
  );
});

test('a swap that changes the type of a column expires each position before it, since the history holds one type for each column, and readers see the new rows', async () => {
  await using database = await scratch();
  const source = new Notes(
    described({ id: { type: 'string' }, score: { type: 'integer' } }),
  );
  source.rows = [{ id: '1', score: 2 }];
  await overwrite(database.login, source);
  const [before] = await positionsOf(database.login);

  source.reshape(
    described({ id: { type: 'string' }, score: { type: 'number' } }),
  );
  source.rows = [{ id: '2', score: 2.5 }];
  await overwrite(database.login, source);

  assert.deepEqual(
    {
      listed: (await positionsOf(database.login)).includes(String(before)),
      notes: await database.admin.query(
        'SELECT id, score FROM marts.notes ORDER BY id',
      ),
    },
    { listed: false, notes: [{ id: '2', score: 2.5 }] },
  );
});

// Items of two accounts, keyed by account and id, partitioned by account
// when partitioned.
const accountItems = ({ partitioned }: { partitioned: boolean }) =>
  new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      description: 'Items of accounts.',
      properties: {
        account: { type: 'string', description: 'Account of the item.' },
        id: { type: 'string', description: 'Item id.' },
      },
    },
    primaryKey: ['account', 'id'],
    ...(partitioned ? { partitionKey: ['account'] } : {}),
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });

// Emits, for each partition, or for the whole stream when unpartitioned,
// what the test scripts for the next run.
class Scripted extends Source {
  readonly identity = 'scripted';
  script: Record<string, (SourceMessage | Error)[]> = {};
  readonly stream: Stream;
  protected readonly catalog: Catalog;

  constructor(partitioning: { partitioned: boolean }) {
    super();
    this.stream = accountItems(partitioning);
    this.catalog = new Catalog([this.stream]);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override partitions() {
    return this.stream.partitionKey === undefined
      ? []
      : [{ account: 'a' }, { account: 'b' }];
  }

  protected override async *extract(
    _configuration: CopyConfiguration,
    _state: unknown,
    partition: Partition | null,
  ) {
    for (const message of this.script[String(partition?.account ?? 'all')] ??
      []) {
      if (Error.isError(message)) throw message;
      yield message;
    }
  }
}

function deduplicating(login: SqlServerLogin, source: Scripted) {
  const destination = new SqlServerDestination({ login });
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'accounts',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login }),
        steps: [
          new Copy(source.stream, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
}

const record = (account: string, id: string) => ({
  stream: 'items',
  data: { account, id },
});
const reset = { type: 'RESET' as const, stream: 'items' };
const state = { type: 'STATE' as const, stream: 'items', state: {} };

async function itemsOf(connection: SqlServerConnection) {
  return (
    await connection.query(
      'SELECT account, id FROM marts.items ORDER BY account, id',
    )
  ).map(({ account, id }) => `${String(account)}${String(id)}`);
}

test('a reset of the whole stream reloads it into a hidden table: readers keep the old rows until the stream ends, a failed reload resumes, a new reset starts it over, and the history keeps the rows it replaced', async () => {
  await using database = await scratch();
  const source = new Scripted({ partitioned: false });
  const pipeline = deduplicating(database.login, source);
  source.script = { all: [record('a', '1'), record('a', '2'), state] };
  await pipeline.run();
  const [before] = await positionsOf(database.login);

  source.script = {
    all: [reset, record('b', '1'), state, new Error('gone')],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  const whileReloading = await itemsOf(database.admin);
  source.script = { all: [record('b', '2'), state] };
  await pipeline.run();
  const resumed = await itemsOf(database.admin);
  const beforeRestart = (await positionsOf(database.login)).at(-1);
  source.script = { all: [reset, record('c', '1'), state, new Error('gone')] };
  await assert.rejects(pipeline.run(), PipelineError);
  source.script = { all: [reset, record('d', '1'), state] };
  await pipeline.run();

  assert.deepEqual(
    {
      whileReloading,
      resumed,
      restarted: await itemsOf(database.admin),
      beforeRestart: (
        await asOf(
          database.login,
          String(beforeRestart),
          'SELECT account, id FROM marts.items ORDER BY account, id',
        )
      ).map(({ account, id }) => `${String(account)}${String(id)}`),
      before: (
        await asOf(
          database.login,
          String(before),
          'SELECT account, id FROM marts.items ORDER BY account, id',
        )
      ).map(({ account, id }) => `${String(account)}${String(id)}`),
    },
    {
      whileReloading: ['a1', 'a2'],
      resumed: ['b1', 'b2'],
      restarted: ['d1'],
      beforeRestart: ['b1', 'b2'],
      before: ['a1', 'a2'],
    },
  );
});

test('a reset of a partition reloads it into a hidden table: readers keep its old rows until the stream ends, the other partitions load as before, a failed reload resumes, and a deletion that the reload reads stays deleted', async () => {
  await using database = await scratch();
  const source = new Scripted({ partitioned: true });
  const pipeline = deduplicating(database.login, source);
  source.script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();

  source.script = {
    a: [reset, record('a', '3'), record('a', '4'), state, new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  const whileReloading = await itemsOf(database.admin);
  source.script = {
    a: [
      { type: 'DELETE', stream: 'items', key: { account: 'a', id: '3' } },
      record('a', '5'),
      state,
    ],
    b: [state],
  };
  await pipeline.run();

  assert.deepEqual(
    {
      whileReloading,
      reloaded: await itemsOf(database.admin),
    },
    {
      whileReloading: ['a1', 'a2', 'b1', 'b2'],
      reloaded: ['a4', 'a5', 'b1', 'b2'],
    },
  );
});

test('a reset of a partition that a failure discards before a commit opens no reload, so the next run loads the partition as before', async () => {
  await using database = await scratch();
  const source = new Scripted({ partitioned: true });
  const pipeline = deduplicating(database.login, source);
  source.script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();
  source.script = {
    a: [reset, record('a', '3'), new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);

  source.script = { a: [record('a', '4'), state], b: [state] };
  await pipeline.run();

  assert.deepEqual(await itemsOf(database.admin), [
    'a1',
    'a2',
    'a4',
    'b1',
    'b2',
  ]);
});
