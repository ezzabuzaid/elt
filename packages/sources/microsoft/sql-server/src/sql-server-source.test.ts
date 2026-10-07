import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import sql from 'mssql';
import postgres from 'postgres';

import { Connection, Pipeline, PipelineError } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@workspace/elt-postgresql';
import {
  SqlServerDatabase,
  SqlServerPermissionError,
} from '@workspace/sdk-microsoft-sql-server';

import { sqlServerCopies } from './sql-server-copies.ts';
import { SqlServerSource } from './sql-server-source.ts';

const sqlServer =
  process.env.TEST_SQLSERVER_CONNECTION_STRING ??
  'Server=localhost,51433;Database=master;User Id=sa;Password=Context-Compiler-1;Encrypt=true;TrustServerCertificate=true';
const postgresServer =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

/**
 * A SQL Server database of its own for one test, dropped with every login it
 * made when the test ends. `settings` are ALTER DATABASE options applied
 * before anyone else connects. `run` executes statements as the
 * administrator; `login` makes a db_datareader login, runs `setup` with its
 * user in place of {user}, and returns the user and its connection string.
 */
async function scratchSqlServer(settings: readonly string[] = []) {
  const config = sql.ConnectionPool.parseConnectionString(sqlServer);
  const name = `source_test_${randomUUID().replaceAll('-', '')}`;
  const master = new sql.ConnectionPool(config);
  try {
    await master.connect();
  } catch (cause) {
    throw new Error(
      `Test SQL Server at ${config.server}:${config.port} is unavailable. Start it with: npx nx run infra:up-sqlserver`,
      { cause },
    );
  }
  const logins: string[] = [];
  const admin = new sql.ConnectionPool({ ...config, database: name });
  const connectionString = (user: string, password: string) =>
    `Server=${config.server},${config.port};Database=${name};User Id=${user};Password=${password};Encrypt=true;TrustServerCertificate=true`;
  try {
    await master
      .request()
      .batch(
        `CREATE DATABASE [${name}]; ${settings.map((setting) => `ALTER DATABASE [${name}] SET ${setting};`).join(' ')}`,
      );
    await admin.connect();
  } catch (error) {
    await master.close();
    throw error;
  }
  return {
    administrator: connectionString(config.user ?? '', config.password ?? ''),
    async run(statements: string) {
      await admin.request().batch(statements);
    },
    async login(setup = '') {
      const user = `reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const password = `Reader-${randomUUID()}`;
      logins.push(user);
      await master
        .request()
        .batch(
          `CREATE LOGIN [${user}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`,
        );
      await admin
        .request()
        .batch(
          `CREATE USER [${user}] FOR LOGIN [${user}]; ALTER ROLE db_datareader ADD MEMBER [${user}]; ${setup.replaceAll('{user}', `[${user}]`)}`,
        );
      return {
        user: `[${user}]`,
        connectionString: connectionString(user, password),
      };
    },
    async [Symbol.asyncDispose]() {
      await admin.close();
      await master
        .request()
        .batch(
          `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; ${logins.map((user) => `DROP LOGIN [${user}];`).join(' ')}`,
        );
      await master.close();
    },
  };
}

/** A Postgres database of its own for one test, dropped when the test ends. */
async function scratchWarehouse() {
  const admin = postgres(postgresServer, { max: 1, onnotice: () => {} });
  const name = `source_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(postgresServer).host} is unavailable. Start it with: npx nx run infra:up`,
      { cause },
    );
  }
  const url = new URL(postgresServer);
  url.pathname = `/${name}`;
  const warehouse = postgres(url.href, { max: 2, onnotice: () => {} });
  return {
    url: url.href,
    sql: warehouse,
    async [Symbol.asyncDispose]() {
      await warehouse.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * Loads the SQL Server database into the warehouse's raw schema as a host
 * does: the source is discovered again on every run, each stream lands in a
 * table named after it, and checkpoints stay beside the data.
 */
function syncer(connectionString: string, warehouse: string) {
  const database = new SqlServerDatabase(connectionString);
  const destination = new PostgresDestination({
    url: warehouse,
    schema: 'raw',
  });
  const checkpoints = new PostgresCheckpointStore({
    url: warehouse,
    schema: 'raw',
  });
  return async () => {
    const source = await SqlServerSource.discover(database);
    const pipeline = new Pipeline({
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

// A run expected to fail, with its outcome per copy.
async function failing(run: () => Promise<unknown>) {
  const error = await run().then(
    () => assert.fail('the run should fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof PipelineError, String(error));
  return error;
}

for (const snapshot of [false, true])
  test(`a Change Tracking table loads every row, then applies what changed, deletions included, and writes nothing when nothing changed${snapshot ? ', in a database that allows snapshot isolation' : ''}`, async () => {
    await using server = await scratchSqlServer(
      snapshot ? ['ALLOW_SNAPSHOT_ISOLATION ON'] : [],
    );
    await using warehouse = await scratchWarehouse();
    await server.run(`
      ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
      CREATE TABLE dbo.orders (id int PRIMARY KEY, total decimal(9, 2) NOT NULL);
      ALTER TABLE dbo.orders ENABLE CHANGE_TRACKING;
      INSERT dbo.orders VALUES (1, 1.00), (2, 2.00), (3, 3.00);`);
    const reader = await server.login(
      'GRANT VIEW CHANGE TRACKING ON dbo.orders TO {user};',
    );
    const sync = syncer(reader.connectionString, warehouse.url);
    const loaded = async () =>
      (
        await warehouse.sql`SELECT id::int AS id, total::text FROM raw.dbo_orders ORDER BY id`
      ).map(({ id, total }) => [id, total]);

    const first = await sync();
    assert.deepEqual(await loaded(), [
      [1, '1.00'],
      [2, '2.00'],
      [3, '3.00'],
    ]);
    assert.equal(first.results[0]?.count, 3);
    await server.run(
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

test('a truncated Change Tracking table, whose history no longer reaches the last sync, is loaded again in full', async () => {
  await using server = await scratchSqlServer();
  await using warehouse = await scratchWarehouse();
  await server.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items VALUES (1, N'one'), (2, N'two');`);
  const reader = await server.login(
    'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
  );
  const sync = syncer(reader.connectionString, warehouse.url);
  await sync();

  await server.run(
    "TRUNCATE TABLE dbo.items; INSERT dbo.items VALUES (3, N'three');",
  );
  await sync();

  assert.deepEqual(
    [
      ...(await warehouse.sql`SELECT id::int AS id, name FROM raw.dbo_items ORDER BY id`),
    ],
    [{ id: 3, name: 'three' }],
  );
});

test('a column added upstream starts its table over, and every row arrives with it', async () => {
  await using server = await scratchSqlServer();
  await using warehouse = await scratchWarehouse();
  await server.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items VALUES (1, N'one'), (2, N'two');`);
  const reader = await server.login(
    'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
  );
  const sync = syncer(reader.connectionString, warehouse.url);
  await sync();

  await server.run(
    "ALTER TABLE dbo.items ADD size char(1) NULL; EXEC('UPDATE dbo.items SET size = ''L'' WHERE id = 1');",
  );
  const { results } = await sync();

  assert.equal(results[0]?.count, 2);
  assert.deepEqual(
    [
      ...(await warehouse.sql`SELECT id::int AS id, name, size FROM raw.dbo_items ORDER BY id`),
    ],
    [
      { id: 1, name: 'one', size: 'L' },
      { id: 2, name: 'two', size: null },
    ],
  );
});

test('a rowversion table loads inserts and updates, a row still being written arrives on a later sync, and a deleted row stays loaded', async () => {
  await using server = await scratchSqlServer(['READ_COMMITTED_SNAPSHOT ON']);
  await using warehouse = await scratchWarehouse();
  await server.run(`
    CREATE TABLE dbo.events (id int PRIMARY KEY, kind varchar(10) NOT NULL, stamp rowversion);
    INSERT dbo.events (id, kind) VALUES (1, 'open'), (2, 'open');`);
  const reader = await server.login();
  const sync = syncer(reader.connectionString, warehouse.url);
  const loaded = async () =>
    (await warehouse.sql`SELECT id, kind FROM raw.dbo_events ORDER BY id`).map(
      ({ id, kind }) => `${id}:${kind}`,
    );
  await sync();
  const writer = new sql.ConnectionPool(
    sql.ConnectionPool.parseConnectionString(server.administrator),
  );
  await writer.connect();
  const open = new sql.Transaction(writer);
  let committed = false;
  try {
    await open.begin();
    await new sql.Request(open).query(
      "INSERT dbo.events (id, kind) VALUES (3, 'open')",
    );
    await server.run(
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
    await writer.close();
  }
});

test('a table with no change signal is read in full each sync, so a deleted row disappears', async () => {
  await using server = await scratchSqlServer();
  await using warehouse = await scratchWarehouse();
  await server.run(`
    CREATE TABLE dbo.log (message nvarchar(20) NOT NULL);
    CREATE TABLE dbo.codes (code char(2) PRIMARY KEY, label nvarchar(20) NOT NULL);
    INSERT dbo.log VALUES (N'started'), (N'stopped');
    INSERT dbo.codes VALUES ('EU', N'Europe'), ('AS', N'Asia');`);
  const reader = await server.login();
  const sync = syncer(reader.connectionString, warehouse.url);
  const loaded = async () => ({
    log: (
      await warehouse.sql`SELECT message FROM raw.dbo_log ORDER BY message`
    ).map(({ message }) => message),
    codes: (
      await warehouse.sql`SELECT code FROM raw.dbo_codes ORDER BY code`
    ).map(({ code }) => code),
  });
  await sync();

  await server.run(
    "DELETE dbo.log WHERE message = N'started'; DELETE dbo.codes WHERE code = 'AS';",
  );
  await sync();

  assert.deepEqual(await loaded(), { log: ['stopped'], codes: ['EU'] });
  await sync();
  assert.deepEqual(await loaded(), { log: ['stopped'], codes: ['EU'] });
});

test(
  'a first load that fails after a committed page resumes after it, loading the rest exactly once',
  { timeout: 300_000 },
  async () => {
    await using server = await scratchSqlServer();
    await using warehouse = await scratchWarehouse();
    // One page and five rows more; a lone surrogate on the second page fails
    // it. Pages follow id, so id 10003 is always on the second page.
    await server.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items SELECT TOP (10005) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), N'item' FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;
    UPDATE dbo.items SET name = NCHAR(55296) WHERE id = 10003;`);
    const reader = await server.login(
      'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
    );
    const sync = syncer(reader.connectionString, warehouse.url);

    const error = await failing(sync);

    assert.match(
      String(error.results[0]?.failures[0]?.error),
      /field name has a lone surrogate/,
    );
    assert.equal(error.results[0]?.copy.id, 'dbo.items');
    const count = async () =>
      (
        await warehouse.sql`SELECT count(*)::int AS rows, count(DISTINCT id)::int AS ids FROM raw.dbo_items`
      )[0];
    assert.deepEqual({ ...(await count()) }, { rows: 10000, ids: 10000 });
    await server.run("UPDATE dbo.items SET name = N'fixed' WHERE id = 10003;");
    const { results } = await sync();
    assert.equal(results[0]?.count, 5);
    assert.deepEqual({ ...(await count()) }, { rows: 10005, ids: 10005 });
  },
);

test('a tracked table the login cannot track falls back to its rowversion or to full reads, says which grant would help, and a read refused later fails only its own table', async () => {
  await using server = await scratchSqlServer();
  await using warehouse = await scratchWarehouse();
  await server.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.plain (id int PRIMARY KEY, name nvarchar(10) NOT NULL);
    CREATE TABLE dbo.stamped (id int PRIMARY KEY, name nvarchar(10) NOT NULL, stamp rowversion);
    ALTER TABLE dbo.plain ENABLE CHANGE_TRACKING;
    ALTER TABLE dbo.stamped ENABLE CHANGE_TRACKING;
    INSERT dbo.plain VALUES (1, N'a');
    INSERT dbo.stamped (id, name) VALUES (1, N'b');`);
  const reader = await server.login();
  const sync = syncer(reader.connectionString, warehouse.url);

  const { source } = await sync();

  const plain = source.streams.find(({ name }) => name === 'dbo.plain');
  const stamped = source.streams.find(({ name }) => name === 'dbo.stamped');
  assert.deepEqual(plain?.supportedSyncModes, ['full_refresh']);
  assert.match(
    String(plain?.jsonSchema.description),
    /Granting the login VIEW CHANGE TRACKING ON \[dbo\]\.\[plain\] would read only changes and deletions/,
  );
  assert.equal(stamped?.sourceDefinedCursor, true);
  assert.equal(stamped?.emitsDeletes, undefined);
  const names = async () => ({
    plain: (await warehouse.sql`SELECT name FROM raw.dbo_plain`).map(
      ({ name }) => name,
    ),
    stamped: (await warehouse.sql`SELECT name FROM raw.dbo_stamped`).map(
      ({ name }) => name,
    ),
  });
  assert.deepEqual(await names(), { plain: ['a'], stamped: ['b'] });
  await server.run("UPDATE dbo.stamped SET name = N'c' WHERE id = 1;");
  const { results } = await sync();
  // The full read loads its row again; the rowversion read only the update.
  assert.deepEqual(
    results.map(({ copy, count }) => [copy.id, count]),
    [
      ['dbo.plain', 1],
      ['dbo.stamped', 1],
    ],
  );
  assert.deepEqual(await names(), { plain: ['a'], stamped: ['c'] });
  // Refused between discovery and the read.
  const discovered = await SqlServerSource.discover(
    new SqlServerDatabase(reader.connectionString),
  );
  await server.run(`DENY SELECT ON dbo.plain TO ${reader.user};`);
  const destination = new PostgresDestination({
    url: warehouse.url,
    schema: 'raw',
  });
  const error = await failing(() =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'sql-server',
          source: discovered,
          destination,
          checkpoints: new PostgresCheckpointStore({
            url: warehouse.url,
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
      copy.id,
      failures.map(({ error }) =>
        error instanceof SqlServerPermissionError ? error.grant : String(error),
      ),
    ]),
    [
      ['dbo.plain', ['SELECT ON [dbo].[plain]']],
      ['dbo.stamped', []],
    ],
  );
  // The next sync no longer finds a table the login cannot read.
  const { source: rediscovered } = await sync();
  assert.deepEqual(
    rediscovered.streams.map(({ name }) => name),
    ['dbo.stamped'],
  );
});

test('every type arrives in Postgres exactly, beside the offset and base type it needs, under the descriptions SQL Server keeps', async () => {
  await using server = await scratchSqlServer();
  await using warehouse = await scratchWarehouse();
  await server.run(`
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
  const reader = await server.login();
  const sync = syncer(reader.connectionString, warehouse.url);

  await sync();

  const [row] = await warehouse.sql`
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
  const [empty] = await warehouse.sql`
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
      await warehouse.sql`
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
    await warehouse.sql`SELECT obj_description('raw.dbo_everything'::regclass) AS comment`;
  assert.match(
    String(table?.comment),
    /Source record meaning: Every type, once\. Read by its rowversion column version: inserts and updates apply; deletions are not seen\./,
  );
});

test('discovery keeps only the schemas asked for, refuses a schema asked for that holds no readable table, and refuses a table whose column already holds a name its offset or base type needs', async () => {
  await using server = await scratchSqlServer();
  await server.run(`
    EXEC('CREATE SCHEMA sales');
    EXEC('CREATE SCHEMA audit');
    EXEC('CREATE SCHEMA typed');
    CREATE TABLE sales.orders (id int PRIMARY KEY);
    CREATE TABLE audit.events (id int PRIMARY KEY);
    CREATE TABLE dbo.clashing (id int PRIMARY KEY, placed datetimeoffset, placed_offset int);
    CREATE TABLE typed.clashing (id int PRIMARY KEY, anything sql_variant, anything_type int);`);
  const reader = await server.login();
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
  await assert.rejects(
    SqlServerSource.discover(database, { schemas: ['dbo'] }),
    /\[dbo\]\.\[clashing\] has a column placed_offset, the name its placed needs for its offset/,
  );
  await assert.rejects(
    SqlServerSource.discover(database, { schemas: ['typed'] }),
    /\[typed\]\.\[clashing\] has a column anything_type, the name its anything needs for its base type/,
  );
});

test(
  'a watch wakes only the streams whose change counter moved',
  { timeout: 180_000 },
  async () => {
    await using server = await scratchSqlServer();
    await server.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.tracked (id int PRIMARY KEY);
    ALTER TABLE dbo.tracked ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.stamped (id int PRIMARY KEY, stamp rowversion);
    CREATE TABLE dbo.plain (id int PRIMARY KEY);`);
    const reader = await server.login(
      'GRANT VIEW CHANGE TRACKING ON dbo.tracked TO {user};',
    );
    const source = await SqlServerSource.discover(
      new SqlServerDatabase(reader.connectionString),
    );
    const controller = new AbortController();
    const watch = source.watch({
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

      await server.run('INSERT dbo.tracked VALUES (1);');
      assert.deepEqual(await woken(), ['dbo.tracked']);
      await server.run('INSERT dbo.stamped (id) VALUES (1);');
      assert.deepEqual(await woken(), ['dbo.stamped']);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);
