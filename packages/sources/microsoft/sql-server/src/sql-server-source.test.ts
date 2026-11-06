import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';
import { Postgres } from '@zukhruf/testing/postgres';
import {
  type Database,
  SQL_SERVER_FULL_IMAGE,
  SqlServer,
} from '@zukhruf/testing/sqlserver';
import sql from 'mssql';
import postgres from 'postgres';

import { Connection, Pipeline, PipelineError } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import {
  SqlServerDatabase,
  SqlServerLoginError,
  SqlServerPermissionError,
} from '@workspace/sdk-microsoft-sql-server';

import { sqlServerCopies } from './sql-server-copies.ts';
import { SqlServerSource } from './sql-server-source.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: SQL_SERVER_FULL_IMAGE,
});
const postgresServer = new Postgres({ environment: process.env });

// A real db_datareader identity, with the additional grants this test needs.
// The database belongs to Zukhruf; this scope owns only the server login.
async function readOnlyLogin(
  database: Database,
  admin: sql.ConnectionPool,
  setup: string,
) {
  await using resources = new AsyncDisposableStack();
  const user = `reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = `Reader-${randomUUID()}`;
  await admin
    .request()
    .batch(
      `CREATE LOGIN [${user}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`,
    );
  // SQL Server refuses to drop a login that is logged in, and a connection
  // closed while it streamed stays logged in for a moment after the client
  // lets go, so the drop waits up to five seconds for its sessions to end.
  resources.defer(async () => {
    await admin.request().batch(`
      DECLARE @waited int = 0;
      WHILE EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE login_name = N'${user}') AND @waited < 100
      BEGIN
        WAITFOR DELAY '00:00:00.050';
        SET @waited += 1;
      END;
      DROP LOGIN [${user}];`);
  });
  await admin
    .request()
    .batch(
      `CREATE USER [${user}] FOR LOGIN [${user}]; ALTER ROLE db_datareader ADD MEMBER [${user}]; ${setup.replaceAll('{user}', `[${user}]`)}`,
    );
  const owned = resources.move();
  return {
    user: `[${user}]`,
    connectionString: `Server=${database.host},${database.port};Database=${database.database};User Id=${user};Password=${password};Encrypt=true;TrustServerCertificate=true`,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/**
 * Loads the SQL Server database into the warehouse's raw schema as a host
 * does: the source is discovered again on every run, each stream lands in a
 * table named after it, and checkpoints stay beside the data.
 */
function syncer(
  connectionString: string,
  url: string,
  history: PostgresSyncHistory,
) {
  const database = new SqlServerDatabase(connectionString);
  const destination = new PostgresDestination({
    url,
    schema: 'raw',
  });
  const checkpoints = new PostgresCheckpointStore({
    url,
    schema: 'raw',
  });
  return async () => {
    const source = await SqlServerSource.discover(database);
    const pipeline = new Pipeline({
      clock: globalThis,
      history,
      connections: [
        new Connection({
          name: 'sql-server',
          source,
          destination,
          checkpoints,
          steps: sqlServerCopies(source, (stream) =>
            destination.table(stream.replace('.', '_')),
          ),
        }),
      ],
    });
    return { source, results: await pipeline.run() };
  };
}

// A watch on a fake clock, because a check waits 30 s and the hourly
// refresh an hour: each check runs when the test moves the clock past the
// wait. A change that wakes nothing makes no yield, so each check a test
// reads must wake a stream.
function watcher(t: TestContext, source: SqlServerSource) {
  // A start in the middle of an hour, so a wake on the hour of the clock
  // differs from a wake an hour after the watch started.
  const clock = createClock(Date.UTC(2026, 10, 6, 7, 12));
  const controller = new AbortController();
  const watch = source.watch({
    clock,
    streams: source.streams,
    signal: controller.signal,
  });
  const names = (result: IteratorResult<readonly { name: string }[]>) =>
    result.done ? [] : result.value.map(({ name }) => name).sort();
  return {
    clock,
    // The first check, which wakes every stream.
    first: async () => names(await watch.next()),
    // The streams the next check wakes.
    woken: async () => {
      const next = watch.next();
      await t.waitFor(() => assert.ok(clock.countTimers() > 0), {
        timeout: 30_000,
      });
      await clock.tickAsync(30_000);
      return names(await next);
    },
    [Symbol.asyncDispose]: async () => {
      controller.abort();
      await watch.return(undefined);
    },
  };
}

// A run expected to fail, with its outcome per copy.
async function failing(run: () => Promise<unknown>) {
  const error = await run().then(
    () => assert.fail('the run should fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof PipelineError, String(error));
  return error;
}

// Each kind of failure a run's copies reported, once.
function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

for (const snapshot of [false, true])
  test(`a Change Tracking table loads every row, then applies what changed, deletions included, and writes nothing when nothing changed${snapshot ? ', in a database that allows snapshot isolation' : ''}`, async () => {
    await using server = await sqlServer.database();
    if (snapshot) {
      await using configuration = new AsyncDisposableStack();
      const master = configuration.adopt(
        new sql.ConnectionPool({
          ...sql.ConnectionPool.parseConnectionString(server.connectionString),
          database: 'master',
        }),
        (pool) => pool.close(),
      );
      await master.connect();
      await master
        .request()
        .batch(
          `ALTER DATABASE [${server.database}] SET ALLOW_SNAPSHOT_ISOLATION ON;`,
        );
    }
    await using warehouse = await postgresServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    const warehouseSql = clients.adopt(
      postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
      (client) => client.end(),
    );
    const history = new PostgresSyncHistory({
      url: warehouse.connectionString,
    });
    await admin.request().batch(`
      ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
      CREATE TABLE dbo.orders (id int PRIMARY KEY, total decimal(9, 2) NOT NULL);
      ALTER TABLE dbo.orders ENABLE CHANGE_TRACKING;
      INSERT dbo.orders VALUES (1, 1.00), (2, 2.00), (3, 3.00);`);
    await using reader = await readOnlyLogin(
      server,
      admin,
      'GRANT VIEW CHANGE TRACKING ON dbo.orders TO {user};',
    );
    const sync = syncer(
      reader.connectionString,
      warehouse.connectionString,
      history,
    );
    const loaded = async () =>
      (
        await warehouseSql`SELECT id::int AS id, total::text FROM raw.dbo_orders ORDER BY id`
      ).map(({ id, total }) => [id, total]);

    const first = await sync();
    assert.deepEqual(await loaded(), [
      [1, '1.00'],
      [2, '2.00'],
      [3, '3.00'],
    ]);
    assert.equal(first.results[0]?.count, 3);
    await admin
      .request()
      .batch(
        'UPDATE dbo.orders SET total = 20.00 WHERE id = 2; DELETE dbo.orders WHERE id = 3; INSERT dbo.orders VALUES (4, 4.00);',
      );

    const second = await sync();

    assert.deepEqual(await loaded(), [
      [1, '1.00'],
      [2, '20.00'],
      [4, '4.00'],
    ]);
    assert.deepEqual(
      second.results.map(({ count, deleted }) => [count, deleted]),
      [[2, 1]],
    );
    const third = await sync();
    assert.deepEqual(
      third.results.map(({ count, deleted }) => [count, deleted]),
      [[0, 0]],
    );
  });

test('tables and columns named as Postgres cannot hold them load whole, under names Airbyte would give, and changes apply by their renamed key', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  const sha8 = (name: string) =>
    createHash('sha256').update(name).digest('hex').slice(0, 8);
  // A name past 63 bytes keeps its first 54, `_` and a hash of the name.
  const fitted = (name: string) => `${name.slice(0, 54)}_${sha8(name)}`;
  const part = 'k'.repeat(100);
  const placed = 'd'.repeat(60);
  const longTable = 't'.repeat(100);
  await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.[Line Items] (
      [last] int NOT NULL,
      [${part}] int NOT NULL,
      loaded_at nvarchar(20) NOT NULL,
      [Unit Price] money NOT NULL,
      [${placed}] datetimeoffset(0) NOT NULL,
      xmin float NOT NULL,
      PRIMARY KEY ([last], [${part}]));
    ALTER TABLE dbo.[Line Items] ENABLE CHANGE_TRACKING;
    INSERT dbo.[Line Items] VALUES
      (1, 1, N'one', 1.50, '2025-01-02T03:04:05+02:00', 0.5),
      (2, 1, N'two', 2.50, '2025-01-02T03:04:05-01:00', 1.5);
    CREATE TABLE dbo.[${longTable}] (id int PRIMARY KEY);
    INSERT dbo.[${longTable}] VALUES (7);`);
  await using reader = await readOnlyLogin(
    server,
    admin,
    'GRANT VIEW CHANGE TRACKING ON dbo.[Line Items] TO {user};',
  );
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  // The syncer names each raw table <schema>_<table>; the destination then
  // keeps a hash of a name sanitizing changed, and fits a long one.
  const items = `dbo_Line_Items_${sha8('dbo_Line Items')}`;
  const loaded = async () =>
    (
      await warehouseSql.unsafe(
        `SELECT "last"::int AS last, loaded_at_1, "Unit_Price"::text AS price,
          "${fitted(`${placed}_offset`)}"::int AS offset, xmin_1
          FROM raw."${items}" ORDER BY 1`,
      )
    ).map((row) => ({ ...row }));

  const first = await sync();

  assert.deepEqual(await loaded(), [
    { last: 1, loaded_at_1: 'one', price: '1.5000', offset: 120, xmin_1: 0.5 },
    { last: 2, loaded_at_1: 'two', price: '2.5000', offset: -60, xmin_1: 1.5 },
  ]);
  assert.deepEqual(
    [
      ...(await warehouseSql.unsafe(
        `SELECT id::int AS id FROM raw."${fitted(`dbo_${longTable}`)}"`,
      )),
    ].map(({ id }) => id),
    [7],
  );
  const [comment] =
    await warehouseSql`SELECT col_description(${`raw."${items}"`}::regclass, attnum) AS text
    FROM pg_attribute WHERE attrelid = ${`raw."${items}"`}::regclass AND attname = 'loaded_at_1'`;
  assert.match(String(comment?.text), /Source field: "loaded_at"\.$/);
  assert.equal(
    first.results.find(({ copy }) => copy.from.name === 'dbo.Line Items')
      ?.count,
    2,
  );

  await admin
    .request()
    .batch(
      "UPDATE dbo.[Line Items] SET loaded_at = N'uno' WHERE [last] = 1; DELETE dbo.[Line Items] WHERE [last] = 2;",
    );
  const second = await sync();

  assert.deepEqual(await loaded(), [
    { last: 1, loaded_at_1: 'uno', price: '1.5000', offset: 120, xmin_1: 0.5 },
  ]);
  const changes = (run: typeof first) =>
    run.results
      .filter(({ copy }) => copy.from.name === 'dbo.Line Items')
      .map(({ count, deleted }) => [count, deleted]);
  assert.deepEqual(changes(second), [[1, 1]]);
  assert.deepEqual(changes(await sync()), [[0, 0]]);
});

test('a truncated Change Tracking table, whose history no longer reaches the last sync, is loaded again in full', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items VALUES (1, N'one'), (2, N'two');`);
  await using reader = await readOnlyLogin(
    server,
    admin,
    'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
  );
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  await sync();

  await admin
    .request()
    .batch("TRUNCATE TABLE dbo.items; INSERT dbo.items VALUES (3, N'three');");
  await sync();

  assert.deepEqual(
    [
      ...(await warehouseSql`SELECT id::int AS id, name FROM raw.dbo_items ORDER BY id`),
    ],
    [{ id: 3, name: 'three' }],
  );
});

test('a column added to a Change Tracking table reaches every row: the table loads again', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items VALUES (1, N'one'), (2, N'two');`);
  await using reader = await readOnlyLogin(
    server,
    admin,
    'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
  );
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  await sync();

  await admin
    .request()
    .batch(
      "ALTER TABLE dbo.items ADD size char(1) NULL; EXEC('UPDATE dbo.items SET size = ''L'' WHERE id = 1');",
    );
  const { results } = await sync();

  assert.equal(results[0]?.count, 2);
  assert.deepEqual(
    [
      ...(await warehouseSql`SELECT id::int AS id, name, size FROM raw.dbo_items ORDER BY id`),
    ],
    [
      { id: 1, name: 'one', size: 'L' },
      { id: 2, name: 'two', size: null },
    ],
  );
});

test('a column added to a rowversion table reaches every stored row, and a row deleted upstream stays loaded', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    CREATE TABLE dbo.events (id int PRIMARY KEY, kind varchar(10) NOT NULL, stamp rowversion);
    INSERT dbo.events (id, kind) VALUES (1, 'open'), (2, 'open');`);
  await using reader = await readOnlyLogin(server, admin, '');
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  await sync();
  // A default fills the existing row without bumping its rowversion, so only
  // a read from the first row brings it.
  await admin
    .request()
    .batch(
      "DELETE dbo.events WHERE id = 2; ALTER TABLE dbo.events ADD size char(1) NOT NULL DEFAULT 'M';",
    );

  const { results } = await sync();

  assert.equal(results[0]?.count, 1);
  assert.deepEqual(
    [
      ...(await warehouseSql`SELECT id::int AS id, kind, size FROM raw.dbo_events ORDER BY id`),
    ],
    [
      { id: 1, kind: 'open', size: 'M' },
      { id: 2, kind: 'open', size: null },
    ],
  );
});

test('a rowversion table loads inserts and updates, a row still being written arrives on a later sync, and a deleted row stays loaded', async () => {
  await using server = await sqlServer.database();
  {
    await using configuration = new AsyncDisposableStack();
    const master = configuration.adopt(
      new sql.ConnectionPool({
        ...sql.ConnectionPool.parseConnectionString(server.connectionString),
        database: 'master',
      }),
      (pool) => pool.close(),
    );
    await master.connect();
    await master
      .request()
      .batch(
        `ALTER DATABASE [${server.database}] SET READ_COMMITTED_SNAPSHOT ON;`,
      );
  }
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    CREATE TABLE dbo.events (id int PRIMARY KEY, kind varchar(10) NOT NULL, stamp rowversion);
    INSERT dbo.events (id, kind) VALUES (1, 'open'), (2, 'open');`);
  await using reader = await readOnlyLogin(server, admin, '');
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  const loaded = async () =>
    (await warehouseSql`SELECT id, kind FROM raw.dbo_events ORDER BY id`).map(
      ({ id, kind }) => `${id}:${kind}`,
    );
  await sync();
  const writer = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await writer.connect();
  const open = new sql.Transaction(writer);
  let committed = false;
  try {
    await open.begin();
    await new sql.Request(open).query(
      "INSERT dbo.events (id, kind) VALUES (3, 'open')",
    );
    await admin
      .request()
      .batch(
        "UPDATE dbo.events SET kind = 'closed' WHERE id = 1; DELETE dbo.events WHERE id = 2;",
      );

    await sync();

    assert.deepEqual(await loaded(), ['1:open', '2:open']);
    await open.commit();
    committed = true;
    await sync();
    assert.deepEqual(await loaded(), ['1:closed', '2:open', '3:open']);
    const { results } = await sync();
    assert.equal(results[0]?.count, 0);
  } finally {
    if (!committed) await open.rollback();
  }
});

test('a keyed table with no change feed writes only the rows that are new or changed and deletes the rows that are gone, and a table with no key is read in full', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    CREATE TABLE dbo.log (message nvarchar(20) NOT NULL);
    CREATE TABLE dbo.codes (code char(2) PRIMARY KEY, label nvarchar(20) NOT NULL);
    INSERT dbo.log VALUES (N'started'), (N'stopped');
    INSERT dbo.codes VALUES ('EU', N'Europe'), ('AS', N'Asia'), ('NA', N'North America');`);
  await using reader = await readOnlyLogin(server, admin, '');
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  const loaded = async () => ({
    log: (
      await warehouseSql`SELECT message FROM raw.dbo_log ORDER BY message`
    ).map(({ message }) => message),
    codes: (
      await warehouseSql`SELECT code, label FROM raw.dbo_codes ORDER BY code`
    ).map(({ code, label }) => `${code} ${label}`),
  });
  const written = ({ results }: Awaited<ReturnType<typeof sync>>) =>
    results.map(({ copy, count }) => [copy.from.name, count]);
  await sync();

  await admin.request().batch(`
    DELETE dbo.log WHERE message = N'started';
    DELETE dbo.codes WHERE code = 'AS';
    UPDATE dbo.codes SET label = N'Europa' WHERE code = 'EU';
    INSERT dbo.codes VALUES ('AF', N'Africa');`);
  const changed = await sync();

  // The table with no key loads every row again; the keyed one only the
  // new and the changed row.
  assert.deepEqual(written(changed), [
    ['dbo.codes', 2],
    ['dbo.log', 1],
  ]);
  assert.deepEqual(await loaded(), {
    log: ['stopped'],
    codes: ['AF Africa', 'EU Europa', 'NA North America'],
  });
  const unchanged = await sync();
  assert.deepEqual(written(unchanged), [
    ['dbo.codes', 0],
    ['dbo.log', 1],
  ]);
  assert.deepEqual(await loaded(), {
    log: ['stopped'],
    codes: ['AF Africa', 'EU Europa', 'NA North America'],
  });
});

test(
  'a first load that fails after a committed page resumes after it, loading the rest exactly once',
  { timeout: 300_000 },
  async () => {
    await using server = await sqlServer.database();
    await using warehouse = await postgresServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    const warehouseSql = clients.adopt(
      postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
      (client) => client.end(),
    );
    const history = new PostgresSyncHistory({
      url: warehouse.connectionString,
    });
    // One page and five rows more; a lone surrogate on the second page fails
    // it. Pages follow id, so id 10003 is always on the second page.
    await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items SELECT TOP (10005) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), N'item' FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;
    UPDATE dbo.items SET name = NCHAR(55296) WHERE id = 10003;`);
    await using reader = await readOnlyLogin(
      server,
      admin,
      'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
    );
    const sync = syncer(
      reader.connectionString,
      warehouse.connectionString,
      history,
    );

    const error = await failing(sync);

    assert.match(
      String(error.results[0]?.failures[0]?.error),
      /field name has a lone surrogate/,
    );
    assert.equal(error.results[0]?.copy.from.name, 'dbo.items');
    const count = async () =>
      (
        await warehouseSql`SELECT count(*)::int AS rows, count(DISTINCT id)::int AS ids FROM raw.dbo_items`
      )[0];
    assert.deepEqual({ ...(await count()) }, { rows: 10000, ids: 10000 });
    await admin
      .request()
      .batch("UPDATE dbo.items SET name = N'fixed' WHERE id = 10003;");
    const { results } = await sync();
    assert.equal(results[0]?.count, 5);
    assert.deepEqual({ ...(await count()) }, { rows: 10005, ids: 10005 });
  },
);

test('a login the server refuses after discovery fails the copy as config, for the user to fix', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  await admin
    .request()
    .batch(
      'CREATE TABLE dbo.items (id int PRIMARY KEY); INSERT dbo.items VALUES (1);',
    );
  await using reader = await readOnlyLogin(server, admin, '');
  const source = await SqlServerSource.discover(
    new SqlServerDatabase(reader.connectionString),
  );
  await admin.request().batch(`ALTER LOGIN ${reader.user} DISABLE;`);
  const destination = new PostgresDestination({
    url: warehouse.connectionString,
    schema: 'raw',
  });

  const error = await failing(() =>
    new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url: warehouse.connectionString }),
      connections: [
        new Connection({
          name: 'sql-server',
          source,
          destination,
          checkpoints: new PostgresCheckpointStore({
            url: warehouse.connectionString,
            schema: 'raw',
          }),
          steps: sqlServerCopies(source, (stream) =>
            destination.table(stream.replace('.', '_')),
          ),
        }),
      ],
    }).run(),
  );

  assert.deepEqual(
    error.results.map(({ copy, failures }) => [
      copy.from.name,
      failures.map(({ error }) => error instanceof SqlServerLoginError),
    ]),
    [['dbo.items', [true]]],
  );
  assert.deepEqual(failureTypes(error), ['config']);
});

test('a tracked table the login cannot track falls back to its rowversion or to a snapshot, says which grant would help, and a read refused later fails only its own table and deletes none of its rows', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.plain (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    CREATE TABLE dbo.stamped (id int PRIMARY KEY, name nvarchar(10) NOT NULL, stamp rowversion);
    ALTER TABLE dbo.plain ENABLE CHANGE_TRACKING;
    ALTER TABLE dbo.stamped ENABLE CHANGE_TRACKING;
    INSERT dbo.plain VALUES (1, N'a');
    INSERT dbo.stamped (id, name) VALUES (1, N'b');`);
  await using reader = await readOnlyLogin(server, admin, '');
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );

  const { source } = await sync();

  const plain = source.streams.find(({ name }) => name === 'dbo.plain');
  const stamped = source.streams.find(({ name }) => name === 'dbo.stamped');
  assert.deepEqual(plain?.supportedSyncModes, ['full_refresh', 'incremental']);
  assert.equal(plain?.emitsDeletes, true);
  assert.match(
    String(plain?.jsonSchema.description),
    /Granting the login VIEW CHANGE TRACKING ON \[dbo\]\.\[plain\] would read only changes and deletions/,
  );
  assert.equal(stamped?.sourceDefinedCursor, true);
  assert.equal(stamped?.emitsDeletes, undefined);
  const names = async () => ({
    plain: (await warehouseSql`SELECT name FROM raw.dbo_plain`).map(
      ({ name }) => name,
    ),
    stamped: (await warehouseSql`SELECT name FROM raw.dbo_stamped`).map(
      ({ name }) => name,
    ),
  });
  assert.deepEqual(await names(), { plain: ['a'], stamped: ['b'] });
  await admin
    .request()
    .batch("UPDATE dbo.stamped SET name = N'c' WHERE id = 1;");
  const { results } = await sync();
  // The snapshot writes nothing for its unchanged row; the rowversion read
  // only the update.
  assert.deepEqual(
    results.map(({ copy, count }) => [copy.from.name, count]),
    [
      ['dbo.plain', 0],
      ['dbo.stamped', 1],
    ],
  );
  assert.deepEqual(await names(), { plain: ['a'], stamped: ['c'] });
  // Refused between discovery and the read.
  const discovered = await SqlServerSource.discover(
    new SqlServerDatabase(reader.connectionString),
  );
  await admin.request().batch(`DENY SELECT ON dbo.plain TO ${reader.user};`);
  const destination = new PostgresDestination({
    url: warehouse.connectionString,
    schema: 'raw',
  });
  const error = await failing(() =>
    new Pipeline({
      clock: globalThis,
      history,
      connections: [
        new Connection({
          name: 'sql-server',
          source: discovered,
          destination,
          checkpoints: new PostgresCheckpointStore({
            url: warehouse.connectionString,
            schema: 'raw',
          }),
          steps: sqlServerCopies(discovered, (stream) =>
            destination.table(stream.replace('.', '_')),
          ),
        }),
      ],
    }).run(),
  );
  assert.deepEqual(
    error.results.map(({ copy, failures }) => [
      copy.from.name,
      failures.map(({ error }) =>
        error instanceof SqlServerPermissionError ? error.grant : String(error),
      ),
    ]),
    [
      ['dbo.plain', ['SELECT ON [dbo].[plain]']],
      ['dbo.stamped', []],
    ],
  );
  assert.deepEqual(failureTypes(error), ['config']);
  // A read that failed is no complete scan, so no row it did not list is
  // deleted.
  assert.deepEqual(await names(), { plain: ['a'], stamped: ['c'] });
  // The next sync no longer finds a table the login cannot read.
  const { source: rediscovered } = await sync();
  assert.deepEqual(
    rediscovered.streams.map(({ name }) => name),
    ['dbo.stamped'],
  );
});

test('every type arrives in Postgres exactly, beside the offset and base type it needs, under the descriptions SQL Server keeps', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    CREATE TABLE dbo.everything (
      id bigint PRIMARY KEY, amount decimal(38, 10), cash money, wide float,
      stamp7 datetime2(7), stamp3 datetime2(3), legacy datetime, coarse smalldatetime,
      moment datetimeoffset(7), moment3 datetimeoffset(3), clock time(7), clock0 time(0), day date,
      bytes varbinary(max), node hierarchyid, place geography, anything sql_variant, version rowversion,
      note nvarchar(20), email varchar(50) MASKED WITH (FUNCTION = 'email()') NULL);
    EXEC sp_addextendedproperty 'MS_Description', N'Every type, once', 'SCHEMA', 'dbo', 'TABLE', 'everything';
    EXEC sp_addextendedproperty 'MS_Description', N'What someone wrote', 'SCHEMA', 'dbo', 'TABLE', 'everything', 'COLUMN', 'note';
    INSERT dbo.everything (id, amount, cash, wide, stamp7, stamp3, legacy, coarse, moment, moment3, clock, clock0, day, bytes, node, place, anything, note, email) VALUES
      (9223372036854775807, -9999999999999999999999999999.9999999999, 922337203685477.5807, 0.1,
       '2025-01-02T03:04:05', '2025-01-02T03:04:05.123', '1753-01-01T00:00:00.997', '2079-06-06T23:59:00',
       '2025-01-02T03:04:05.1234567-14:00', '2025-01-02T03:04:05.123+05:30', '23:59:59.9999999', '12:00:00', '0001-01-01',
       0x00FF, '/1/2/', geography::STGeomFromText('POINT(-122.349 47.651 10 3)', 4326), CAST(1.50 AS decimal(5, 2)),
       N'hello', 'someone@example.com'),
      (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`);
  await using reader = await readOnlyLogin(server, admin, '');
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );

  await sync();

  const [row] = await warehouseSql`
    SELECT id::text, amount::text, cash::text, wide, stamp7, stamp3::text, legacy::text, coarse::text,
      moment, moment_offset, moment3, moment3_offset, clock, clock0::text, day::text,
      encode(bytes, 'hex') AS bytes, node, place, anything, anything_type, version::text ~ '^[0-9]+$' AS version, note, email
    FROM raw.dbo_everything WHERE id <> 1`;
  assert.deepEqual(
    { ...row },
    {
      id: '9223372036854775807',
      amount: '-9999999999999999999999999999.9999999999',
      cash: '922337203685477.5807',
      wide: 0.1,
      stamp7: '2025-01-02T03:04:05.0000000',
      stamp3: '2025-01-02 03:04:05.123',
      legacy: '1753-01-01 00:00:00.997',
      coarse: '2079-06-06 23:59:00',
      moment: '2025-01-02T17:04:05.1234567Z',
      moment_offset: '-840',
      moment3: new Date('2025-01-01T21:34:05.123Z'),
      moment3_offset: '330',
      clock: '23:59:59.9999999',
      clock0: '12:00:00',
      day: '0001-01-01',
      bytes: '00ff',
      node: '/1/2/',
      place: 'SRID=4326;POINT (-122.349 47.651 10 3)',
      anything: '1.50',
      anything_type: 'decimal',
      version: true,
      note: 'hello',
      email: 'sXXX@XXXX.com',
    },
  );
  // A null column leaves its sibling null too.
  const [empty] = await warehouseSql`
    SELECT moment, moment_offset, anything, anything_type, node, place FROM raw.dbo_everything WHERE id = 1`;
  assert.deepEqual(
    { ...empty },
    {
      moment: null,
      moment_offset: null,
      anything: null,
      anything_type: null,
      node: null,
      place: null,
    },
  );
  const comments = Object.fromEntries(
    (
      await warehouseSql`
        SELECT attname AS name, col_description(attrelid, attnum) AS comment
        FROM pg_attribute WHERE attrelid = 'raw.dbo_everything'::regclass AND attname IN ('note', 'email', 'moment_offset', 'anything_type', 'version')`
    ).map(({ name, comment }) => [name, comment]),
  );
  assert.equal(comments.note, 'What someone wrote.');
  assert.match(String(comments.email), /Dynamic data masking applies/);
  assert.match(
    String(comments.moment_offset),
    /offset from UTC, in minutes, moment was written with/,
  );
  assert.match(
    String(comments.anything_type),
    /type of the value anything holds/,
  );
  assert.match(String(comments.version), /rowversion/);
  const [table] =
    await warehouseSql`SELECT obj_description('raw.dbo_everything'::regclass) AS comment`;
  assert.match(
    String(table?.comment),
    /Source record meaning: Every type, once\. Read by its rowversion column version: inserts and updates apply; deletions are not seen\./,
  );
});

test('discovery keeps only the schemas asked for, and refuses a schema asked for that holds no readable table', async () => {
  await using server = await sqlServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  await admin.request().batch(`
    EXEC('CREATE SCHEMA sales');
    EXEC('CREATE SCHEMA audit');
    CREATE TABLE sales.orders (id int PRIMARY KEY);
    CREATE TABLE audit.events (id int PRIMARY KEY);
    -- Outside the schemas asked for, so a filter that keeps it is caught.
    CREATE TABLE dbo.other (id int PRIMARY KEY);`);
  await using reader = await readOnlyLogin(server, admin, '');
  const database = new SqlServerDatabase(reader.connectionString);

  const sales = await SqlServerSource.discover(database, {
    schemas: ['sales', 'audit'],
  });

  assert.deepEqual(
    sales.streams.map(({ name }) => name),
    ['audit.events', 'sales.orders'],
  );
  await assert.rejects(
    SqlServerSource.discover(database, { schemas: ['sales', 'Audit'] }),
    /The schemas to keep name Audit, which holds no table this login can read in /,
  );
});

test('two databases that each hold a table of one name load side by side in one pipeline', async () => {
  await using billing = await sqlServer.database();
  await using impact = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  for (const [server, name] of [
    [billing, "N'invoice'"],
    [impact, "N'brief'"],
  ] as const) {
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    await admin
      .request()
      .batch(
        `CREATE TABLE dbo.files (id int PRIMARY KEY, name nvarchar(10) NOT NULL); INSERT dbo.files VALUES (1, ${name});`,
      );
  }
  // One schema per connection, as the Postgres destination is used.
  const connection = async (schema: string, server: Database) => {
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(server.connectionString),
    );
    const destination = new PostgresDestination({
      url: warehouse.connectionString,
      schema,
    });
    return new Connection({
      name: schema,
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouse.connectionString,
        schema,
      }),
      steps: sqlServerCopies(source, (stream) =>
        destination.table(stream.replace('.', '_')),
      ),
    });
  };

  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url: warehouse.connectionString }),
    connections: [
      await connection('billing', billing),
      await connection('impact', impact),
    ],
  }).run();

  assert.deepEqual(
    {
      billing: (await warehouseSql`SELECT name FROM billing.dbo_files`).map(
        ({ name }) => name,
      ),
      impact: (await warehouseSql`SELECT name FROM impact.dbo_files`).map(
        ({ name }) => name,
      ),
    },
    { billing: ['invoice'], impact: ['brief'] },
  );
});

test('a column already named as a datetimeoffset or sql_variant sibling would be leaves the sibling the next free name, and changes still apply by key', async () => {
  await using server = await sqlServer.database();
  await using warehouse = await postgresServer.database();
  await using clients = new AsyncDisposableStack();
  const admin = clients.adopt(
    new sql.ConnectionPool(server.connectionString),
    (pool) => pool.close(),
  );
  await admin.connect();
  const warehouseSql = clients.adopt(
    postgres(warehouse.connectionString, { max: 2, onnotice: () => {} }),
    (client) => client.end(),
  );
  const history = new PostgresSyncHistory({ url: warehouse.connectionString });
  await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.clashing (
      anything sql_variant PRIMARY KEY,
      anything_type int NOT NULL,
      placed datetimeoffset(0) NOT NULL,
      placed_offset int NOT NULL,
      placed_offset_1 int NOT NULL,
      PLACED_OFFSET_2 int NOT NULL);
    ALTER TABLE dbo.clashing ENABLE CHANGE_TRACKING;
    -- One row each: a VALUES list gives a column one type across its rows.
    INSERT dbo.clashing VALUES (CAST(1 AS int), 7, '2025-01-02T03:04:05+02:00', 8, 9, 10);
    INSERT dbo.clashing VALUES (CAST(N'two' AS nvarchar(10)), 70, '2025-01-02T03:04:05-01:00', 80, 90, 100);`);
  await using reader = await readOnlyLogin(
    server,
    admin,
    'GRANT VIEW CHANGE TRACKING ON dbo.clashing TO {user};',
  );
  const sync = syncer(
    reader.connectionString,
    warehouse.connectionString,
    history,
  );
  const loaded = async () =>
    (
      await warehouseSql`SELECT anything, anything_type::int, anything_type_1,
        placed_offset::int, placed_offset_1::int, "PLACED_OFFSET_2"::int AS upper, placed_offset_3::int
        FROM raw.dbo_clashing ORDER BY anything`
    ).map((row) => ({ ...row }));

  await sync();

  assert.deepEqual(await loaded(), [
    {
      anything: '1',
      anything_type: 7,
      anything_type_1: 'int',
      placed_offset: 8,
      placed_offset_1: 9,
      upper: 10,
      placed_offset_3: 120,
    },
    {
      anything: 'two',
      anything_type: 70,
      anything_type_1: 'nvarchar',
      placed_offset: 80,
      placed_offset_1: 90,
      upper: 100,
      placed_offset_3: -60,
    },
  ]);
  const [placed] =
    await warehouseSql`SELECT col_description('raw.dbo_clashing'::regclass, attnum) AS text
    FROM pg_attribute WHERE attrelid = 'raw.dbo_clashing'::regclass AND attname = 'placed'`;
  assert.match(String(placed?.text), /placed_offset_3 holds the offset/);

  await admin
    .request()
    .batch(
      "DELETE dbo.clashing WHERE anything = CAST(N'two' AS nvarchar(10));",
    );
  const { results } = await sync();

  // Applied by Change Tracking as one deletion, not by reading the table again.
  assert.deepEqual(
    results.map(({ count, deleted }) => [count, deleted]),
    [[0, 1]],
  );
  assert.deepEqual(
    (await loaded()).map(({ anything }) => anything),
    ['1'],
  );
});

test(
  'a watch wakes only the streams whose change counter moved',
  { timeout: 180_000 },
  async () => {
    await using server = await sqlServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.tracked (id int PRIMARY KEY);
    ALTER TABLE dbo.tracked ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.stamped (id int PRIMARY KEY, stamp rowversion);
    CREATE TABLE dbo.plain (id int PRIMARY KEY);`);
    await using reader = await readOnlyLogin(
      server,
      admin,
      'GRANT VIEW CHANGE TRACKING ON dbo.tracked TO {user};',
    );
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    const controller = new AbortController();
    const watch = source.watch({
      clock: globalThis,
      streams: source.streams,
      signal: controller.signal,
    });
    const woken = async () => {
      const next = await watch.next();
      return next.done ? [] : next.value.map(({ name }) => name).sort();
    };
    try {
      assert.deepEqual(await woken(), [
        'dbo.plain',
        'dbo.stamped',
        'dbo.tracked',
      ]);

      await admin.request().batch('INSERT dbo.tracked VALUES (1);');
      assert.deepEqual(await woken(), ['dbo.tracked']);
      await admin.request().batch('INSERT dbo.stamped (id) VALUES (1);');
      assert.deepEqual(await woken(), ['dbo.stamped']);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  'a watch wakes a keyed table with no change feed within one check of an insert, an update of a column with statistics, a statistics refresh, or a truncate, with a login that reads nothing more',
  { timeout: 120_000 },
  async (t) => {
    await using server = await sqlServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    // The index gives title statistics, which SQL Server counts changes in.
    // It builds the statistics of a table created empty when a query first
    // needs them, as the queries of a real database have; here the refresh
    // builds them.
    await admin.request().batch(`
    CREATE TABLE dbo.notes (id int PRIMARY KEY, title nvarchar(20) NOT NULL);
    CREATE INDEX notes_title ON dbo.notes (title);
    CREATE TABLE dbo.other (id int PRIMARY KEY);
    INSERT dbo.notes VALUES (1, N'a');
    INSERT dbo.other VALUES (1);
    UPDATE STATISTICS dbo.notes;
    UPDATE STATISTICS dbo.other;`);
    await using reader = await readOnlyLogin(server, admin, '');
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    // The login cannot read when each table was last written.
    assert.match(
      String(
        source.streams.find(({ name }) => name === 'dbo.notes')?.jsonSchema
          .description,
      ),
      /Granting the login VIEW SERVER STATE \(VIEW DATABASE STATE on Azure SQL Database\) would wake a watch on any write, also to a column with no statistics\./,
    );
    await using watch = watcher(t, source);
    assert.deepEqual(await watch.first(), ['dbo.notes', 'dbo.other']);

    await admin.request().batch("INSERT dbo.notes VALUES (2, N'b');");
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    await admin
      .request()
      .batch("UPDATE dbo.notes SET title = N'c' WHERE id = 1;");
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    await admin.request().batch('UPDATE STATISTICS dbo.notes;');
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    // The refresh sets the count back to 0, the count the last check read,
    // and an update leaves the row count as it was.
    await admin
      .request()
      .batch(
        "UPDATE dbo.notes SET title = N'd' WHERE id = 1; UPDATE STATISTICS dbo.notes;",
      );
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    await admin.request().batch('TRUNCATE TABLE dbo.notes;');
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
  },
);

test(
  'an update of a column with no statistics waits for the hour, which wakes the tables read in full or by snapshot and not those read by Change Tracking or rowversion',
  { timeout: 120_000 },
  async (t) => {
    await using server = await sqlServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    await admin.request().batch(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.tracked (id int PRIMARY KEY);
    ALTER TABLE dbo.tracked ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.stamped (id int PRIMARY KEY, stamp rowversion);
    CREATE TABLE dbo.tracked_stamped (id int PRIMARY KEY, stamp rowversion);
    ALTER TABLE dbo.tracked_stamped ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.notes (id int PRIMARY KEY, body nvarchar(50) NOT NULL);
    CREATE TABLE dbo.log (message nvarchar(20) NOT NULL);
    CREATE TABLE dbo.other (id int PRIMARY KEY);
    INSERT dbo.notes VALUES (1, N'x');
    INSERT dbo.other VALUES (1);
    UPDATE STATISTICS dbo.notes;
    UPDATE STATISTICS dbo.other;`);
    await using reader = await readOnlyLogin(
      server,
      admin,
      'GRANT VIEW CHANGE TRACKING ON dbo.tracked TO {user}; GRANT VIEW CHANGE TRACKING ON dbo.tracked_stamped TO {user};',
    );
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    const described = (name: string) =>
      String(
        source.streams.find((stream) => stream.name === name)?.jsonSchema
          .description,
      );
    // Change Tracking comes before the rowversion.
    assert.match(described('dbo.tracked_stamped'), /Change Tracking/);
    assert.match(described('dbo.log'), /Granting the login VIEW SERVER STATE/);
    await using watch = watcher(t, source);
    assert.deepEqual(await watch.first(), [
      'dbo.log',
      'dbo.notes',
      'dbo.other',
      'dbo.stamped',
      'dbo.tracked',
      'dbo.tracked_stamped',
    ]);

    // Only the insert into dbo.other moves a count.
    await admin
      .request()
      .batch(
        "UPDATE dbo.notes SET body = N'y' WHERE id = 1; INSERT dbo.other VALUES (2);",
      );
    assert.deepEqual(await watch.woken(), ['dbo.other']);
    // The rowversion moves, which a table read by Change Tracking ignores.
    await admin.request().batch('INSERT dbo.stamped (id) VALUES (1);');
    assert.deepEqual(await watch.woken(), ['dbo.stamped']);
    // 51 minutes after the start, past 08:00 on the clock.
    watch.clock.setSystemTime(watch.clock.now + 50 * 60_000);
    await admin.request().batch('INSERT dbo.other VALUES (3);');
    assert.deepEqual(await watch.woken(), ['dbo.other']);
    watch.clock.setSystemTime(watch.clock.now + 10 * 60_000);
    assert.deepEqual(await watch.woken(), [
      'dbo.log',
      'dbo.notes',
      'dbo.other',
    ]);
  },
);

test(
  'a login that may read when each table was last written wakes a table within one check of an update of a column with no statistics, and a table with no key or statistics after an insert',
  { timeout: 120_000 },
  async (t) => {
    await using server = await sqlServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    await admin.request().batch(`
    CREATE TABLE dbo.notes (id int PRIMARY KEY, body nvarchar(50) NOT NULL);
    CREATE TABLE dbo.log (message nvarchar(20) NOT NULL);
    INSERT dbo.notes VALUES (1, N'x');
    UPDATE STATISTICS dbo.notes;`);
    // A server permission, so it is granted in master.
    await using reader = await readOnlyLogin(
      server,
      admin,
      "EXEC master.sys.sp_executesql N'GRANT VIEW SERVER STATE TO {user}';",
    );
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    assert.doesNotMatch(
      String(
        source.streams.find(({ name }) => name === 'dbo.notes')?.jsonSchema
          .description,
      ),
      /VIEW SERVER STATE/,
    );
    await using watch = watcher(t, source);
    assert.deepEqual(await watch.first(), ['dbo.log', 'dbo.notes']);

    await admin
      .request()
      .batch("UPDATE dbo.notes SET body = N'y' WHERE id = 1;");
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    await admin.request().batch("INSERT dbo.log VALUES (N'started');");
    assert.deepEqual(await watch.woken(), ['dbo.log']);
  },
);

test(
  'a watch wakes a table whose statistics SQL Server has not built within one check of an insert or a delete, with a login that reads nothing more',
  { timeout: 120_000 },
  async (t) => {
    await using server = await sqlServer.database();
    await using clients = new AsyncDisposableStack();
    const admin = clients.adopt(
      new sql.ConnectionPool(server.connectionString),
      (pool) => pool.close(),
    );
    await admin.connect();
    // Created empty, and no query has needed their statistics since, so
    // SQL Server has not built them and they count nothing.
    await admin.request().batch(`
    CREATE TABLE dbo.notes (id int PRIMARY KEY, title nvarchar(20) NOT NULL);
    CREATE TABLE dbo.other (id int PRIMARY KEY);`);
    await using reader = await readOnlyLogin(server, admin, '');
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    await using watch = watcher(t, source);
    assert.deepEqual(await watch.first(), ['dbo.notes', 'dbo.other']);

    await admin.request().batch("INSERT dbo.notes VALUES (1, N'a');");
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
    await admin.request().batch('DELETE dbo.notes WHERE id = 1;');
    assert.deepEqual(await watch.woken(), ['dbo.notes']);
  },
);
