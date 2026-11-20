import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { inspect } from 'node:util';

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
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSetupError,
  SqlServerSyncHistory,
} from './index.ts';

// SQL Server 2025, the oldest engine that the destination loads.
const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

// A database of its own for one test, which keeps row versions for readers,
// as the destination needs, unless the test says it does not.
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
    // The same login as an ADO.NET connection string.
    connectionString: database.connectionString,
    name: database.database,
    admin,
    async [Symbol.asyncDispose]() {
      await admin[Symbol.asyncDispose]();
      await database[Symbol.asyncDispose]();
    },
  };
}

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// An incremental source of notes: each read gives the notes after the saved
// state, then the state after the last of them.
class Notes extends Source {
  readonly identity: string = 'notes';
  readonly stream = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        n: { type: 'integer', description: 'The place of the note.' },
        text: { type: 'string', description: 'What the note says.' },
      },
      required: ['n', 'text'],
    },
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
  });
  protected readonly catalog = new Catalog([this.stream]);
  upstream: { n: number; text: string }[] = [];
  readonly states: unknown[] = [];
  // What a read waits for after it reads its state, before its first note.
  waits = async () => {};

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
    state: unknown,
  ): AsyncIterable<SourceMessage> {
    this.states.push(state);
    await this.waits();
    const after = Number(Object(state).after ?? 0);
    const read = this.upstream.filter(({ n }) => n > after);
    for (const note of read)
      yield { stream: configuration.stream.name, data: note };
    yield {
      type: 'STATE',
      stream: configuration.stream.name,
      state: { after: Math.max(after, ...read.map(({ n }) => n)) },
    };
  }
}

const pipeline = (login: SqlServerLogin, source: Notes) => {
  const warehouse = new SqlServerDestination({ login });
  return {
    warehouse,
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
            new Copy(source.stream, warehouse.table('notes'), {
              id: 'notes:notes',
              syncMode: 'incremental',
              destinationSyncMode: 'append',
            }),
          ],
        }),
      ],
    }),
  };
};

test('a pipeline appends each run of a stream to its reader view, resumes from its checkpoint, records each pass, and gives a position for each pass that committed', async () => {
  await using database = await scratch();
  const source = new Notes();
  const { warehouse, pipeline: run } = pipeline(database.login, source);

  source.upstream = [
    { n: 1, text: 'first' },
    { n: 2, text: 'second' },
  ];
  await run.run();
  const afterFirst = await warehouse.positions();
  source.upstream.push({ n: 3, text: 'third ü 😀' });
  await run.run();
  const afterSecond = await warehouse.positions();
  await run.run();
  const afterNothing = await warehouse.positions();

  assert.deepEqual(
    await database.admin.query('SELECT n, text FROM marts.notes ORDER BY n'),
    [
      { n: '1', text: 'first' },
      { n: '2', text: 'second' },
      { n: '3', text: 'third ü 😀' },
    ],
  );
  assert.deepEqual(
    await database.admin.query(
      'SELECT COUNT(DISTINCT loaded_at) AS loads FROM marts.notes',
    ),
    [{ loads: 2 }],
  );
  assert.deepEqual(source.states, [null, { after: 2 }, { after: 3 }]);
  assert.deepEqual(
    await database.admin.query(
      `SELECT a.status, c.target_table, c.written_count FROM marts.sync_attempts AS a JOIN marts.extraction_coverage AS c ON c.attempt_id = a.attempt_id ORDER BY a.attempt_id`,
    ),
    [
      { status: 'succeeded', target_table: 'notes', written_count: '2' },
      { status: 'succeeded', target_table: 'notes', written_count: '1' },
      { status: 'succeeded', target_table: 'notes', written_count: '0' },
    ],
  );
  assert.ok(Array.isArray(afterFirst) && afterFirst.length === 1);
  assert.ok(Array.isArray(afterSecond) && afterSecond.length === 2);
  assert.deepEqual(afterNothing, afterSecond);
  assert.deepEqual(await warehouse.positions(afterFirst[0]), [afterSecond[1]]);
});

test('the position of a pass is the rowversion of its commit row in the epoch of the database, and the reader view shows no internal column', async () => {
  await using database = await scratch();
  const source = new Notes();
  const { warehouse, pipeline: run } = pipeline(database.login, source);
  source.upstream = [{ n: 1, text: 'only' }];

  await run.run();

  const [commit] = await database.admin.query(
    `SELECT CONVERT(nvarchar(20), CAST(c.number AS bigint)) AS number, e.epoch FROM _warehouse._elt_commits AS c CROSS JOIN _warehouse._elt_epoch AS e`,
  );
  assert.deepEqual(await warehouse.positions(), [
    `${String(commit?.epoch)}:${String(commit?.number)}`,
  ]);
  assert.deepEqual(
    (
      await database.admin.query(
        `SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(N'marts.notes') ORDER BY column_id`,
      )
    ).map(({ name }) => name),
    ['n', 'text', 'loaded_at'],
  );
});

test('a transaction of the database that holds a rowversion keeps each later commit from being a position until it ends', async () => {
  await using database = await scratch();
  await database.admin.query(
    'CREATE TABLE dbo.writes (id int IDENTITY PRIMARY KEY, version rowversion)',
  );
  const source = new Notes();
  const { warehouse, pipeline: run } = pipeline(database.login, source);
  source.upstream = [{ n: 1, text: 'after an open write' }];
  await database.admin.query('BEGIN TRANSACTION');
  await database.admin.query('INSERT INTO dbo.writes DEFAULT VALUES');

  await run.run();
  const held = await warehouse.positions();
  await database.admin.query('COMMIT');
  const settled = await warehouse.positions();

  assert.deepEqual(held, []);
  assert.ok(Array.isArray(settled) && settled.length === 1);
});

test('a run of more rows than one batch holds loads each row once, from an ADO.NET connection string', async () => {
  await using database = await scratch();
  const source = new Notes();
  const { pipeline: run } = pipeline(database.connectionString, source);
  source.upstream = Array.from({ length: 2500 }, (_, index) => ({
    n: index + 1,
    text: `note ${index + 1}`,
  }));

  await run.run();

  assert.deepEqual(
    await database.admin.query(
      'SELECT COUNT(*) AS notes, COUNT(DISTINCT n) AS places, MIN(n) AS first, MAX(n) AS last FROM marts.notes',
    ),
    [{ notes: 2500, places: 2500, first: '1', last: '2500' }],
  );
});

test('the first run into a new database makes what its targets share under the lock of _warehouse, so it waits while another session holds that lock', async () => {
  await using database = await scratch();
  const source = new Notes();
  source.upstream = [{ n: 1, text: 'after the lock' }];
  const { pipeline: run } = pipeline(database.login, source);
  await using holder = await new SqlServerDatabase(database.login).connect();
  await holder.query(
    "BEGIN TRANSACTION; DECLARE @result int; EXEC @result = sp_getapplock @Resource = N'elt:_warehouse', @LockMode = N'Exclusive', @LockOwner = N'Transaction';",
  );

  const running = run.run();
  const waiting = async (): Promise<void> => {
    const [waiter] = await database.admin.query(
      `SELECT TOP (1) request_session_id AS id FROM sys.dm_tran_locks WHERE resource_type = N'APPLICATION' AND request_status = N'WAIT' AND resource_database_id = DB_ID()`,
    );
    if (waiter === undefined) {
      await setTimeout(100);
      return waiting();
    }
  };
  await waiting();
  await holder.query('COMMIT');
  await running;

  assert.deepEqual(await database.admin.query('SELECT text FROM marts.notes'), [
    { text: 'after the lock' },
  ]);
});

test('a database that keeps no row versions for readers fails the first load with the statements that turn them on, and nothing is made', async () => {
  await using database = await scratch({ rowVersions: false });
  const warehouse = new SqlServerDestination({ login: database.login });

  const failure = await warehouse
    .load({ clock: globalThis, connection: 'notes' })
    .then(
      () => assert.fail('the load opened'),
      (error: unknown) => error,
    );

  assert.ok(failure instanceof SqlServerSetupError, String(failure));
  assert.equal(
    failure.message,
    `Database ${database.name} keeps no row versions for readers, so they would wait for each load; run ALTER DATABASE [${database.name}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.name}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
  );
  assert.deepEqual(
    await database.admin.query(
      `SELECT IIF(SCHEMA_ID(N'_warehouse') IS NULL, 0, 1) AS made`,
    ),
    [{ made: 0 }],
  );
});

test('a run of a copy that another run holds fails before it reads, and the copy runs again once the other run ends', async () => {
  await using database = await scratch();
  const holding = new Notes();
  holding.upstream = [{ n: 1, text: 'held' }];
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  holding.waits = async () => {
    reading.resolve();
    await release.promise;
  };
  const first = pipeline(database.login, holding).pipeline.run();
  await reading.promise;
  const refused = new Notes();

  const failure = await pipeline(database.login, refused)
    .pipeline.run()
    .then(
      () => assert.fail('the second run read the copy'),
      (error: unknown) => error,
    );
  release.resolve();
  await first;
  const after = new Notes();
  after.upstream = [{ n: 2, text: 'after' }];
  await pipeline(database.login, after).pipeline.run();

  assert.match(
    inspect(failure),
    /Checkpoint notes:notes is in use by another run/,
  );
  assert.deepEqual(refused.states, []);
  assert.deepEqual(after.states, [{ after: 1 }]);
});

test('a clear empties the reader view, forgets each position before it, and the next run loads the copy from its start', async () => {
  await using database = await scratch();
  const source = new Notes();
  source.upstream = [{ n: 1, text: 'kept' }];
  const { warehouse, pipeline: run } = pipeline(database.login, source);
  await run.run();
  const [before] = await positionsOf(warehouse);

  await run.clear();
  const cleared = await database.admin.query('SELECT n FROM marts.notes');
  const expired = await warehouse.positions(before);
  await run.run();

  assert.deepEqual(cleared, []);
  if (!('expired' in expired))
    assert.fail('the position before the clear expired');
  assert.match(expired.expired, /a clear that forgot the rows of its table/);
  assert.deepEqual(source.states, [null, null]);
  assert.deepEqual(await database.admin.query('SELECT n FROM marts.notes'), [
    { n: '1' },
  ]);
});

test('a database restored from a backup gives numbers again, so its next load starts a new epoch and a position from before the restore is expired', async () => {
  await using database = await scratch();
  const source = new Notes();
  source.upstream = [{ n: 1, text: 'before the backup' }];
  const { warehouse, pipeline: run } = pipeline(database.login, source);
  await run.run();
  const backup = `/var/opt/mssql/data/${database.name}.bak`;
  await database.admin.query(
    `BACKUP DATABASE [${database.name}] TO DISK = @backup WITH INIT`,
    { backup },
  );
  source.upstream.push({ n: 2, text: 'after the backup' });
  await run.run();
  const [, lost] = await positionsOf(warehouse);
  await using master = await new SqlServerDatabase({
    ...database.login,
    database: 'master',
  }).connect();
  await master.query(
    `ALTER DATABASE [${database.name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
     RESTORE DATABASE [${database.name}] FROM DISK = N'${backup}' WITH REPLACE;
     ALTER DATABASE [${database.name}] SET MULTI_USER;
     EXEC master.dbo.xp_delete_file 0, N'${backup}';`,
  );
  const restored = new Notes();
  restored.upstream = [{ n: 3, text: 'after the restore' }];

  await pipeline(database.login, restored).pipeline.run();
  const expired = await warehouse.positions(lost);
  const [epoch] = await positionsOf(warehouse);

  if (!('expired' in expired))
    assert.fail('the position after the backup expired');
  assert.match(
    expired.expired,
    /is of an earlier numbering: the commits of this database were numbered again since/,
  );
  assert.notEqual(epoch?.split(':')[0], lost?.split(':')[0]);
});

test('each JSON Schema type loads into its SQL Server type, and reads back as it was', async () => {
  await using database = await scratch();
  const stream = new Stream({
    name: 'things',
    jsonSchema: {
      type: 'object',
      description: 'A thing of each type.',
      properties: {
        text: { type: 'string', description: 'Text.' },
        day: { type: 'string', format: 'date', description: 'A day.' },
        at: {
          type: 'string',
          format: 'date-time',
          precision: 7,
          description: 'An instant.',
        },
        local: {
          type: 'string',
          format: 'date-time-local',
          precision: 7,
          description: 'A wall-clock time.',
        },
        exact: {
          type: 'string',
          format: 'date-time-local',
          precision: 9,
          description: 'A wall-clock time finer than SQL Server keeps.',
        },
        clock: {
          type: 'string',
          format: 'time-local',
          precision: 3,
          description: 'A time of day.',
        },
        big: { type: 'string', format: 'int64', description: 'A big count.' },
        money: {
          type: 'string',
          format: 'decimal',
          precision: 10,
          scale: 2,
          description: 'An amount.',
        },
        bytes: {
          type: 'string',
          contentEncoding: 'base64',
          description: 'Some bytes.',
        },
        count: { type: 'integer', description: 'A count.' },
        ratio: { type: 'number', description: 'A ratio.' },
        flag: { type: 'boolean', description: 'A flag.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags.',
        },
        none: { type: ['string', 'null'], description: 'Nothing.' },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const thing = {
    text: 'ü 😀',
    day: '2026-11-20',
    at: '2026-11-20T10:11:12.1234567Z',
    local: '2026-11-20T10:11:12.1234567',
    exact: '2026-11-20T10:11:12.123456789',
    clock: '10:11:12.123',
    big: '9223372036854775807',
    money: '12345678.90',
    bytes: 'AAEC/w==',
    count: 42,
    ratio: 0.1,
    flag: true,
    tags: ['a', 'b'],
    none: null,
  };
  const warehouse = new SqlServerDestination({ login: database.login });
  const source = new (class extends Notes {
    protected override readonly catalog = new Catalog([stream]);
    protected override async *extract(configuration: CopyConfiguration) {
      yield { stream: configuration.stream.name, data: thing };
    }
  })();

  await new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'things',
        source,
        destination: warehouse,
        steps: [
          new Copy(stream, warehouse.table('things'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  }).run();

  assert.deepEqual(
    await database.admin.query(
      `SELECT name, data_type FROM marts.catalog WHERE kind = N'column' AND name LIKE N'things.%' ORDER BY name`,
    ),
    [
      { name: 'things.at', data_type: 'datetimeoffset(7)' },
      { name: 'things.big', data_type: 'bigint' },
      { name: 'things.bytes', data_type: 'varbinary(max)' },
      { name: 'things.clock', data_type: 'time(3)' },
      { name: 'things.count', data_type: 'bigint' },
      { name: 'things.day', data_type: 'date' },
      { name: 'things.exact', data_type: 'nvarchar(max)' },
      { name: 'things.flag', data_type: 'bit' },
      { name: 'things.loaded_at', data_type: 'datetimeoffset(3)' },
      { name: 'things.local', data_type: 'datetime2(7)' },
      { name: 'things.money', data_type: 'decimal(10,2)' },
      { name: 'things.none', data_type: 'nvarchar(max)' },
      { name: 'things.ratio', data_type: 'float' },
      { name: 'things.tags', data_type: 'json' },
      { name: 'things.text', data_type: 'nvarchar(max)' },
    ],
  );
  assert.deepEqual(
    await database.admin.query(
      `SELECT text, CONVERT(nvarchar(10), day, 23) AS day, CONVERT(nvarchar(40), at, 127) AS at,
         CONVERT(nvarchar(40), local, 126) AS local, exact, CONVERT(nvarchar(20), clock, 114) AS clock,
         CONVERT(nvarchar(20), big) AS big, CONVERT(nvarchar(20), money) AS money,
         BASE64_ENCODE(bytes) AS bytes, count, ratio, flag, CAST(tags AS nvarchar(max)) AS tags, none
       FROM marts.things`,
    ),
    [
      {
        ...thing,
        count: '42',
        tags: '["a","b"]',
      },
    ],
  );
});

test('the destination refuses, with no connection, a declaration that it cannot hold', () => {
  const warehouse = new SqlServerDestination({
    login: {
      server: 'never.invalid',
      database: 'none',
      user: 'nobody',
      password: 'never-sent',
    },
  });
  const notes = new Notes();
  const declared = (description: string) =>
    new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description,
        properties: { n: { type: 'integer', description: 'A place.' } },
      },
      supportedSyncModes: ['full_refresh'],
    });
  const append: {
    readonly syncMode: 'full_refresh';
    readonly destinationSyncMode: 'append';
  } = { syncMode: 'full_refresh', destinationSyncMode: 'append' };
  const check = (copy: Copy<ReturnType<typeof warehouse.table>>) =>
    warehouse.validate(copy.configuration, copy.to);

  assert.throws(() => warehouse.table('catalog'), {
    name: 'TypeError',
    message: 'Reader name catalog is a relation the destination makes',
  });
  assert.throws(
    () =>
      check(
        new Copy(notes.stream, warehouse.table('notes'), {
          id: 'notes',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: ['n'],
        }),
      ),
    /Destination does not support append_dedup/,
  );
  assert.throws(
    () =>
      check(
        new Copy(declared('x'.repeat(3751)), warehouse.table('notes'), append),
      ),
    /a SQL Server extended property holds at most 7500/,
  );
  assert.throws(
    () =>
      check(
        new Copy(
          new Stream({
            name: 'notes',
            jsonSchema: {
              type: 'object',
              properties: { n: { type: 'integer' } },
            },
            supportedSyncModes: ['full_refresh'],
          }),
          warehouse.table('notes'),
          append,
        ),
      ),
    /Reader view marts\.notes needs JSON Schema descriptions for the stream, n of stream notes/,
  );
});

test('a table whose columns declare a key keeps two keys that differ only in case, and a commit that repeats a key fails and leaves the table as it was', async () => {
  await using database = await scratch();
  const stream = new Stream({
    name: 'people',
    jsonSchema: {
      type: 'object',
      description: 'A person.',
      properties: {
        id: { type: 'string', description: 'Who.' },
        name: { type: 'string', description: 'What they are called.' },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  let people = [
    { id: 'A', name: 'upper' },
    { id: 'a', name: 'lower' },
  ];
  const source = new (class extends Notes {
    protected override readonly catalog = new Catalog([stream]);
    protected override async *extract(configuration: CopyConfiguration) {
      for (const person of people)
        yield { stream: configuration.stream.name, data: person };
    }
  })();
  const warehouse = new SqlServerDestination({ login: database.login });
  const run = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'people',
        source,
        destination: warehouse,
        steps: [
          new Copy(
            stream,
            warehouse.table('people', (columns) => [
              columns.text('id').primaryKey(),
              columns.text('name'),
            ]),
            { syncMode: 'full_refresh', destinationSyncMode: 'append' },
          ),
        ],
      }),
    ],
  });

  await run.run();
  people = [
    { id: 'b', name: 'new' },
    { id: 'A', name: 'again' },
  ];
  const repeated = await run.run().then(
    () => assert.fail('a repeated key loaded'),
    (error: unknown) => error,
  );

  assert.match(inspect(repeated), /duplicate key/);
  assert.deepEqual(
    await database.admin.query(
      'SELECT id, name FROM marts.people ORDER BY name',
    ),
    [
      { id: 'a', name: 'lower' },
      { id: 'A', name: 'upper' },
    ],
  );
});

test('the next pass of a connection records as failed a pass of its connection whose session ended, and leaves a pass that still runs and a pass of another connection as they are', async () => {
  await using database = await scratch();
  const source = new Notes();
  const { pipeline: run } = pipeline(database.login, source);
  await run.run();
  const history = new SqlServerSyncHistory({ login: database.login });
  const connection = (name: string) =>
    new Connection({
      name,
      source,
      destination: new SqlServerDestination({ login: database.login }),
      steps: [],
    });
  await using stoppedNotes = await history.begin(
    connection('notes'),
    [],
    new Date(),
  );
  await using stoppedOther = await history.begin(
    connection('other'),
    [],
    new Date(),
  );
  const holders = await database.admin.query(
    `SELECT DISTINCT request_session_id AS id FROM sys.dm_tran_locks WHERE resource_type = N'APPLICATION' AND request_owner_type = N'SESSION' AND resource_database_id = DB_ID()`,
  );
  for (const { id } of holders)
    await database.admin.query(`KILL ${Number(id)}`);
  await using running = await history.begin(
    connection('notes'),
    [],
    new Date(),
  );

  await run.run();

  assert.equal(holders.length, 2);
  assert.deepEqual(
    await database.admin.query(
      'SELECT connector, status, error FROM marts.sync_attempts ORDER BY attempt_id',
    ),
    [
      { connector: 'notes', status: 'succeeded', error: null },
      {
        connector: 'notes',
        status: 'failed',
        error:
          'The session running this pass ended before the pass did: its process stopped, or lost the database',
      },
      { connector: 'other', status: 'running', error: null },
      { connector: 'notes', status: 'running', error: null },
      { connector: 'notes', status: 'succeeded', error: null },
    ],
  );
});

// The positions of the database, which a test expects to be a list.
async function positionsOf(warehouse: SqlServerDestination) {
  const positions = await warehouse.positions();
  assert.ok(Array.isArray(positions), 'the database has positions');
  return positions;
}
