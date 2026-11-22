import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type DestinationSyncMode,
  type FieldSchema,
  Pipeline,
  PipelineError,
  Source,
  Stream,
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

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

// Measures keyed by id, with the fields that a run declares.
function measures(properties: Record<string, FieldSchema>) {
  const fields: Record<string, FieldSchema> = {
    id: { type: 'string' },
    ...properties,
  };
  return new Stream({
    name: 'measures',
    jsonSchema: {
      type: 'object',
      description: 'Measures.',
      properties: Object.fromEntries(
        Object.entries(fields).map(([name, schema]) => [
          name,
          { ...schema, description: `The ${name} of the measure.` },
        ]),
      ),
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
}

// Reads the records of a run, then a checkpoint of its run number, and keeps
// each state that the engine gave it.
class Measured extends Source {
  readonly identity = 'measured';
  protected readonly catalog: Catalog;
  readonly #records: readonly object[];
  readonly #run: number;
  readonly #states: unknown[];

  constructor(
    stream: Stream,
    records: readonly object[],
    run: number,
    states: unknown[],
  ) {
    super();
    this.catalog = new Catalog([stream]);
    this.#records = records;
    this.#run = run;
    this.#states = states;
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

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ) {
    this.#states.push(state);
    const stream = configuration.stream.name;
    for (const data of this.#records) yield { stream, data };
    yield { type: 'STATE' as const, stream, state: { run: this.#run } };
  }
}

// One run of the measures copy, with the fields that the run declares.
function run(
  login: SqlServerLogin,
  {
    properties,
    records,
    number,
    states = [],
    mode = 'append_dedup',
  }: {
    properties: Record<string, FieldSchema>;
    records: readonly object[];
    number: number;
    states?: unknown[];
    mode?: DestinationSyncMode;
  },
) {
  const stream = measures(properties);
  const destination = new SqlServerDestination({ login });
  const overwrites = mode === 'overwrite' || mode === 'overwrite_dedup';
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'raw',
        source: new Measured(stream, records, number, states),
        destination,
        checkpoints: new SqlServerCheckpointStore({ login }),
        steps: [
          new Copy(stream, destination.table('measures'), {
            id: 'measures',
            syncMode: overwrites ? 'full_refresh' : 'incremental',
            destinationSyncMode: mode,
          }),
        ],
      }),
    ],
  }).run();
}

async function positionsOf(login: SqlServerLogin) {
  const positions = await new SqlServerDestination({ login }).positions();
  assert.ok(Array.isArray(positions), 'the database has positions');
  return positions;
}

async function newest(login: SqlServerLogin) {
  return String((await positionsOf(login)).at(-1));
}

// The rows that a session reads of a relation as of a position.
async function asOf(login: SqlServerLogin, position: string, query: string) {
  await using reader = await new SqlServerDatabase(login).connect(globalThis);
  // A session context value is a sql_variant, which holds no nvarchar(max).
  await reader.query(
    `DECLARE @position bigint = CAST(@number AS bigint); EXEC sp_set_session_context @key = N'elt.position', @value = @position, @read_only = 1`,
    { number: String(position.split(':')[1]) },
  );
  return await reader.query(query);
}

// The type of a column of the raw table, as sys.columns names it.
async function typeOf(
  connection: Awaited<ReturnType<typeof scratch>>['admin'],
  column: string,
) {
  const [row] = await connection.query(
    `SELECT TYPE_NAME(user_type_id) AS [type] FROM sys.columns WHERE object_id = OBJECT_ID(N'_warehouse.raw_measures') AND name = @column`,
    { column },
  );
  return row?.type;
}

// The message of the first error of a failed run.
async function failure(running: Promise<unknown>): Promise<string> {
  try {
    await running;
  } catch (error) {
    assert.ok(error instanceof PipelineError, 'the run fails');
    return String(error.errors[0]);
  }
  assert.fail('the run fails');
}

test('a number field that becomes an integer fails its copy, naming the column, while a stored value has a fraction, and the row and checkpoint stay as they were', async () => {
  await using database = await scratch();
  const states: unknown[] = [];
  await run(database.login, {
    properties: { amount: { type: 'number' } },
    records: [{ id: 'a', amount: 1.5 }],
    number: 1,
    states,
  });

  const message = await failure(
    run(database.login, {
      properties: { amount: { type: 'integer' } },
      records: [],
      number: 2,
      states,
    }),
  );

  assert.match(message, /\[amount\]/);
  assert.match(message, /bigint/);
  assert.deepEqual(
    await database.admin.query('SELECT id, amount FROM marts.measures'),
    [{ id: 'a', amount: 1.5 }],
  );
  await run(database.login, {
    properties: { amount: { type: 'number' } },
    records: [],
    number: 3,
    states,
  });
  assert.deepEqual(states, [null, { run: 1 }]);
});

test('a number field that becomes an integer evolves in place when each stored value is whole, keeping its rows and checkpoint, and expires each position before it, since the history cannot widen it', async () => {
  await using database = await scratch();
  const states: unknown[] = [];
  await run(database.login, {
    properties: { amount: { type: 'number' } },
    records: [{ id: 'a', amount: 2 }],
    number: 1,
    states,
  });
  const before = await newest(database.login);

  await run(database.login, {
    properties: { amount: { type: 'integer' } },
    records: [{ id: 'b', amount: 3 }],
    number: 2,
    states,
  });

  assert.deepEqual(
    {
      type: await typeOf(database.admin, 'amount'),
      rows: await database.admin.query(
        'SELECT id, amount FROM marts.measures ORDER BY id',
      ),
      states,
      listed: (await positionsOf(database.login)).includes(before),
    },
    {
      type: 'bigint',
      rows: [
        { id: 'a', amount: '2' },
        { id: 'b', amount: '3' },
      ],
      states: [null, { run: 1 }],
      listed: false,
    },
  );
});

test('an integer field that becomes a string widens in place and its history widens with it and keeps the rows that the change converts, so a dropped field that a later change adds back reads as it was as of each position before the drop', async () => {
  await using database = await scratch();
  await run(database.login, {
    properties: { amount: { type: 'integer' }, note: { type: 'string' } },
    records: [{ id: 'a', amount: 7, note: 'first' }],
    number: 1,
  });
  await run(database.login, {
    properties: { amount: { type: 'integer' }, note: { type: 'string' } },
    records: [{ id: 'a', amount: 8, note: 'second' }],
    number: 2,
  });
  const [first, second] = (await positionsOf(database.login)).map(String);
  assert.ok(first !== undefined && second !== undefined);

  await run(database.login, {
    properties: { amount: { type: 'string' } },
    records: [{ id: 'b', amount: 'x' }],
    number: 3,
  });
  await run(database.login, {
    properties: { amount: { type: 'string' }, note: { type: 'string' } },
    records: [],
    number: 4,
  });

  const read = (position: string) =>
    asOf(
      database.login,
      position,
      'SELECT id, amount, note FROM marts.measures ORDER BY id',
    );
  assert.deepEqual(
    {
      type: await typeOf(database.admin, 'amount'),
      listed: (await positionsOf(database.login)).includes(first),
      first: await read(first),
      second: await read(second),
      now: await database.admin.query(
        'SELECT id, amount, note FROM marts.measures ORDER BY id',
      ),
    },
    {
      type: 'nvarchar',
      listed: true,
      first: [{ id: 'a', amount: '7', note: 'first' }],
      second: [{ id: 'a', amount: '8', note: 'second' }],
      now: [
        { id: 'a', amount: '8', note: null },
        { id: 'b', amount: 'x', note: null },
      ],
    },
  );
});

test('a field that the stream adds enters the stored table, null in the stored rows, and an array field that it drops goes, keeping the rows, the checkpoint and the positions', async () => {
  await using database = await scratch();
  const states: unknown[] = [];
  await run(database.login, {
    properties: { tags: { type: 'array', items: { type: 'string' } } },
    records: [{ id: 'a', tags: ['x'] }],
    number: 1,
    states,
  });
  const before = await newest(database.login);

  await run(database.login, {
    properties: { size: { type: 'integer' } },
    records: [{ id: 'b', size: 4 }],
    number: 2,
    states,
  });

  assert.deepEqual(
    {
      tags: await typeOf(database.admin, 'tags'),
      rows: await database.admin.query(
        'SELECT id, size FROM marts.measures ORDER BY id',
      ),
      states,
      before: await asOf(
        database.login,
        before,
        'SELECT id, size FROM marts.measures ORDER BY id',
      ),
    },
    {
      tags: undefined,
      rows: [
        { id: 'a', size: null },
        { id: 'b', size: '4' },
      ],
      states: [null, { run: 1 }],
      before: [{ id: 'a', size: null }],
    },
  );
});

test('an overwrite whose field widens swaps its table in, and its history widens with it, so the position before the swap reads the old rows', async () => {
  await using database = await scratch();
  await run(database.login, {
    properties: { amount: { type: 'integer' } },
    records: [{ id: 'a', amount: 7 }],
    number: 1,
    mode: 'overwrite',
  });
  const before = await newest(database.login);

  await run(database.login, {
    properties: { amount: { type: 'string' } },
    records: [{ id: 'b', amount: 'x' }],
    number: 2,
    mode: 'overwrite',
  });

  assert.deepEqual(
    {
      listed: (await positionsOf(database.login)).includes(before),
      before: await asOf(
        database.login,
        before,
        'SELECT id, amount FROM marts.measures ORDER BY id',
      ),
      now: await database.admin.query(
        'SELECT id, amount FROM marts.measures ORDER BY id',
      ),
    },
    {
      listed: true,
      before: [{ id: 'a', amount: '7' }],
      now: [{ id: 'b', amount: 'x' }],
    },
  );
});

test('a reader that holds the table delays its change: the copy fails after the lock timeout with the table as it was, and the next run evolves it', async () => {
  await using database = await scratch();
  const states: unknown[] = [];
  await run(database.login, {
    properties: { amount: { type: 'integer' } },
    records: [{ id: 'a', amount: 7 }],
    number: 1,
    states,
  });
  const reshaped = {
    properties: { amount: { type: 'string' } },
    records: [],
    states,
  } as const;
  {
    await using reader = await new SqlServerDatabase(database.login).connect(
      globalThis,
    );
    await reader.query('BEGIN TRANSACTION');
    await reader.query(
      'SELECT COUNT(*) AS [rows] FROM _warehouse.raw_measures WITH (TABLOCK, HOLDLOCK)',
    );

    const message = await failure(
      run(database.login, { ...reshaped, number: 2 }),
    );

    assert.match(message, /lock/i);
    assert.equal(await typeOf(database.admin, 'amount'), 'bigint');
    await reader.query('ROLLBACK');
  }

  await run(database.login, { ...reshaped, number: 3 });

  assert.deepEqual(
    {
      type: await typeOf(database.admin, 'amount'),
      rows: await database.admin.query('SELECT id, amount FROM marts.measures'),
      states,
    },
    {
      type: 'nvarchar',
      rows: [{ id: 'a', amount: '7' }],
      states: [null, { run: 1 }],
    },
  );
});

test('a key field that changes its type fails the copy, since the stored key hashes are of the old values, and the table stays as it was', async () => {
  await using database = await scratch();
  const keyed = (id: FieldSchema) =>
    new Stream({
      name: 'measures',
      jsonSchema: {
        type: 'object',
        description: 'Measures.',
        properties: {
          id: { ...id, description: 'The id of the measure.' },
        },
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['incremental'],
      sourceDefinedCursor: true,
    });
  const once = (stream: Stream, records: readonly object[]) => {
    const destination = new SqlServerDestination({ login: database.login });
    return new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login: database.login }),
      connections: [
        new Connection({
          name: 'raw',
          source: new Measured(stream, records, 1, []),
          destination,
          checkpoints: new SqlServerCheckpointStore({ login: database.login }),
          steps: [
            new Copy(stream, destination.table('measures'), {
              id: 'measures',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    }).run();
  };
  await once(keyed({ type: 'integer' }), [{ id: 1 }]);

  const message = await failure(once(keyed({ type: 'string' }), [{ id: '1' }]));

  assert.match(message, /clear the copy/);
  assert.equal(await typeOf(database.admin, 'id'), 'bigint');
});

test('a view WITH SCHEMABINDING that reads a column the stream converts stops the evolve with an error that names it, and the table stays as it was', async () => {
  await using database = await scratch();
  await run(database.login, {
    properties: { amount: { type: 'integer' } },
    records: [{ id: 'a', amount: 7 }],
    number: 1,
  });
  await database.admin.query(
    'CREATE VIEW dbo.bound WITH SCHEMABINDING AS SELECT id, amount FROM _warehouse.raw_measures',
  );

  const message = await failure(
    run(database.login, {
      properties: { amount: { type: 'string' } },
      records: [],
      number: 2,
    }),
  );

  assert.match(message, /\[dbo\]\.\[bound\] WITH SCHEMABINDING/);
  assert.equal(await typeOf(database.admin, 'amount'), 'bigint');
});
