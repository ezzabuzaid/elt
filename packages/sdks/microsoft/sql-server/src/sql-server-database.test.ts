import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inspect } from 'node:util';

import sql from 'mssql';

import {
  ChangeHistoryExpiredError,
  type ChangePosition,
  OffsetTimestamp,
  type SqlServerChange,
  SqlServerDatabase,
  SqlServerPermissionError,
  type SqlServerSession,
  type SqlServerTable,
  SqlServerUnavailableError,
  VariantValue,
} from './index.ts';

const server =
  process.env.TEST_SQLSERVER_CONNECTION_STRING ??
  'Server=localhost,51433;Database=master;User Id=sa;Password=Context-Compiler-1;Encrypt=true;TrustServerCertificate=true';

/**
 * A database of its own on `server` for one test, dropped with every login
 * it made when the test ends. `settings` are ALTER DATABASE options applied
 * before anyone else connects, as some need the database to themselves. `run` executes statements there as the
 * administrator; `login` makes a db_datareader login, runs `setup` with its
 * user name in place of {user}, and returns the user and its connection
 * string.
 */
async function scratchDatabase(settings: readonly string[] = []) {
  const config = sql.ConnectionPool.parseConnectionString(server);
  const name = `sdk_test_${randomUUID().replaceAll('-', '')}`;
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

// Every row a read yields, each as its primary key values.
async function keys(
  rows: AsyncIterable<{ readonly position: readonly string[] }>,
) {
  const read: string[][] = [];
  for await (const row of rows) read.push([...row.position]);
  return read;
}

function table(
  tables: readonly SqlServerTable[],
  name: string,
): SqlServerTable {
  const found = tables.find(
    (table) => `${table.schema}.${table.name}` === name,
  );
  assert.ok(found, `discovery lists ${name}`);
  return found;
}

async function changes(
  session: SqlServerSession,
  of: SqlServerTable,
  since: ChangePosition,
) {
  await using set = await session.changes(of, since);
  const read: SqlServerChange[] = [];
  for await (const change of set) read.push(change);
  return { position: set.position, read };
}

test('a connection string must name its database, and one that cannot connect names the server and database but never the password', async () => {
  assert.throws(
    () =>
      new SqlServerDatabase(
        'Server=localhost,51433;User Id=sa;Password=never-printed',
      ),
    /must name its Server and its Database/,
  );
  const unreachable = new SqlServerDatabase(
    'Server=localhost,1;Database=shop;User Id=sa;Password=never-printed;Connect Timeout=3',
  );
  assert.equal(unreachable.location, 'localhost:1/shop');

  const error = await unreachable.open().then(
    () => assert.fail('nothing listens on port 1'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof SqlServerUnavailableError, String(error));
  assert.equal(error.message, 'SQL Server localhost:1/shop cannot be opened.');
  // The driver's error, kept as the cause, prints with it.
  assert.ok(error.cause);
  assert.doesNotMatch(inspect(error, { depth: Infinity }), /never-printed/);
});

test('discovery shows only what the login may read, and a read refused later names the grant it needs', async () => {
  await using scratch = await scratchDatabase();
  await scratch.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.orders (id int PRIMARY KEY, total decimal(9, 2));
    ALTER TABLE dbo.orders ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.people (id int, region char(2), secret nvarchar(10), name nvarchar(10), CONSTRAINT people_key PRIMARY KEY (id, region));
    INSERT dbo.orders VALUES (1, 9.50);
    INSERT dbo.people VALUES (1, 'EU', N's', N'Ada');`);
  const reader = await scratch.login(
    'DENY SELECT ON dbo.people (region) TO {user};',
  );
  const database = new SqlServerDatabase(reader.connectionString);
  {
    await using session = await database.open();
    const tables = await session.tables();
    const orders = table(tables, 'dbo.orders');
    const people = table(tables, 'dbo.people');

    // Tracked, but the login lacks VIEW CHANGE TRACKING.
    assert.equal(orders.changeTracking, 'denied');
    await assert.rejects(
      changes(session, orders, { version: '0', generation: '' }),
      (error: unknown) =>
        error instanceof SqlServerPermissionError &&
        error.grant === 'VIEW CHANGE TRACKING ON [dbo].[orders]',
    );
    // A key the login cannot read in full identifies nothing.
    assert.deepEqual(
      people.columns.map(({ name }) => name),
      ['id', 'secret', 'name'],
    );
    assert.deepEqual(people.unreadable, ['region']);
    assert.deepEqual(people.primaryKey, []);

    // Grants revoked after discovery.
    await scratch.run(
      `DENY SELECT ON dbo.people (secret) TO ${reader.user}; DENY SELECT ON dbo.orders TO ${reader.user};`,
    );
    await assert.rejects(
      keys(session.rows(people)),
      (error: unknown) =>
        error instanceof SqlServerPermissionError &&
        error.grant === 'SELECT ON [dbo].[people] ([secret])',
    );
    await assert.rejects(
      keys(session.rows(orders)),
      (error: unknown) =>
        error instanceof SqlServerPermissionError &&
        error.grant === 'SELECT ON [dbo].[orders]',
    );
  }
  await scratch.run(
    `REVOKE SELECT ON dbo.orders FROM ${reader.user}; GRANT VIEW CHANGE TRACKING ON dbo.orders TO ${reader.user};`,
  );
  await using session = await database.open();

  assert.equal(
    table(await session.tables(), 'dbo.orders').changeTracking,
    'readable',
  );
});

// Every key page by page, each page read after the last key of the one before.
async function pagedBy(
  session: SqlServerSession,
  of: SqlServerTable,
  size: number,
) {
  const read: string[][] = [];
  let after: readonly string[] | null = null;
  for (;;) {
    const page = await keys(session.page(of, after, size));
    read.push(...page);
    if (page.length < size) return read;
    after = page.at(-1) ?? null;
  }
}

// A change as plain values, so a set of them compares regardless of order.
function described(change: SqlServerChange): string {
  return change.type === 'upsert'
    ? `upsert ${JSON.stringify(change.row.values)}`
    : `delete ${JSON.stringify(change.key)}`;
}

test('a Change Tracking version the history no longer covers, after a truncate or ahead of the database, is refused as expired', async () => {
  await using scratch = await scratchDatabase();
  await scratch.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.items (id int PRIMARY KEY, v int);
    ALTER TABLE dbo.items ENABLE CHANGE_TRACKING;
    INSERT dbo.items VALUES (1, 1);`);
  const reader = await scratch.login(
    'GRANT VIEW CHANGE TRACKING ON dbo.items TO {user};',
  );
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();
  const items = table(await session.tables(), 'dbo.items');
  const synced = await session.changeTrackingPosition(items);
  await scratch.run('UPDATE dbo.items SET v = 2;');
  const { position } = await changes(session, items, synced);

  // Nothing changed in between, so the truncate leaves the minimum valid
  // version where the last read stopped: only the generation shows it.
  await scratch.run('TRUNCATE TABLE dbo.items;');

  await assert.rejects(
    changes(session, items, position),
    ChangeHistoryExpiredError,
  );
  const truncated = await session.changeTrackingPosition(items);
  await assert.rejects(
    changes(session, items, {
      ...truncated,
      version: String(BigInt(truncated.version) + 1n),
    }),
    ChangeHistoryExpiredError,
  );
  // Rows changed while tracking was off leave no history at all.
  await scratch.run(
    'ALTER TABLE dbo.items DISABLE CHANGE_TRACKING; INSERT dbo.items VALUES (3, 3);',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await scratch.run(
    `ALTER TABLE dbo.items ENABLE CHANGE_TRACKING; GRANT VIEW CHANGE TRACKING ON dbo.items TO ${reader.user};`,
  );
  await assert.rejects(
    changes(session, items, truncated),
    ChangeHistoryExpiredError,
  );
});

test(
  'stopping a read or a change set partway frees its connection for later reads and for closing',
  { timeout: 120_000 },
  async () => {
    await using scratch = await scratchDatabase([
      'ALLOW_SNAPSHOT_ISOLATION ON',
    ]);
    await scratch.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    CREATE TABLE dbo.numbers (id int PRIMARY KEY);
    ALTER TABLE dbo.numbers ENABLE CHANGE_TRACKING;
    INSERT dbo.numbers SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;`);
    const reader = await scratch.login(
      'GRANT VIEW CHANGE TRACKING ON dbo.numbers TO {user};',
    );
    await using session = await new SqlServerDatabase(
      reader.connectionString,
    ).open();
    const numbers = table(await session.tables(), 'dbo.numbers');

    // More abandoned reads, and abandoned snapshots, than the session holds
    // connections.
    for (let read = 0; read < 6; read += 1) {
      const rows = session.rows(numbers);
      await rows.next();
      await rows.return(undefined);
      // From before the 20000 inserts, so the set is still streaming.
      await using set = await session.changes(numbers, {
        ...(await session.changeTrackingPosition(numbers)),
        version: '0',
      });
      await set[Symbol.asyncIterator]().next();
    }

    assert.deepEqual(await keys(session.page(numbers, ['19998'], 10)), [
      ['19999'],
      ['20000'],
    ]);
  },
);

for (const snapshot of [false, true])
  test(`changes report each changed key once, as its row now or as a deletion${snapshot ? ', from one snapshot' : ''}`, async () => {
    await using scratch = await scratchDatabase(
      snapshot ? ['ALLOW_SNAPSHOT_ISOLATION ON'] : [],
    );
    await scratch.run(`
      ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
      CREATE TABLE dbo.lines (orderId int, line int, amount decimal(9, 2), placed datetimeoffset(7), CONSTRAINT lines_key PRIMARY KEY (orderId, line));
      ALTER TABLE dbo.lines ENABLE CHANGE_TRACKING;
      INSERT dbo.lines VALUES (1, 1, 1.00, '2025-01-02T03:04:05.1234567+05:30'), (1, 2, 2.00, NULL), (2, 1, 3.00, NULL);`);
    const reader = await scratch.login(
      'GRANT VIEW CHANGE TRACKING ON dbo.lines TO {user};',
    );
    await using session = await new SqlServerDatabase(
      reader.connectionString,
    ).open();
    const lines = table(await session.tables(), 'dbo.lines');
    const synced = await session.changeTrackingPosition(lines);
    await scratch.run(`
      UPDATE dbo.lines SET amount = 11.00 WHERE orderId = 1 AND line = 1;
      DELETE dbo.lines WHERE orderId = 1 AND line = 2;
      INSERT dbo.lines VALUES (3, 1, 4.00, NULL);
      UPDATE dbo.lines SET amount = 5.00 WHERE orderId = 3;
      DELETE dbo.lines WHERE orderId = 2;
      INSERT dbo.lines VALUES (2, 1, 6.00, NULL);`);

    await using set = await session.changes(lines, synced);
    // Written after the change set took its version but before it reads: a
    // snapshot does not see it; without one it is read now and again later.
    await scratch.run('INSERT dbo.lines VALUES (4, 1, 7.00, NULL);');
    const read: SqlServerChange[] = [];
    for await (const change of set) read.push(change);

    assert.ok(BigInt(set.position.version) > BigInt(synced.version));
    assert.equal(set.position.generation, synced.generation);
    assert.deepEqual(read.map(described).sort(), [
      'delete [1,2]',
      `upsert ${JSON.stringify([1, 1, '11.00', new OffsetTimestamp('2025-01-01T21:34:05.1234567Z', 330)])}`,
      'upsert [2,1,"6.00",null]',
      'upsert [3,1,"5.00",null]',
      ...(snapshot ? [] : ['upsert [4,1,"7.00",null]']),
    ]);
    assert.deepEqual(
      (await changes(session, lines, set.position)).read.map(described),
      ['upsert [4,1,"7.00",null]'],
    );
  });

test('rowversion reads stop below the oldest open write, so a row still being written is read once it commits, and pages resume after the last version', async () => {
  await using scratch = await scratchDatabase(['READ_COMMITTED_SNAPSHOT ON']);
  await scratch.run(`
    CREATE TABLE dbo.events (id int PRIMARY KEY, stamp rowversion);
    INSERT dbo.events (id) VALUES (1), (2), (3);`);
  const reader = await scratch.login();
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();
  const events = table(await session.tables(), 'dbo.events');
  const stamp = events.rowversion;
  assert.ok(stamp);
  const read = async (above: string, below: string) => {
    const ids: unknown[] = [];
    let last = above;
    for (;;) {
      let count = 0;
      for await (const row of session.rowversions(events, last, below, 1)) {
        ids.push(row.values[0]);
        last = String(row.value(stamp));
        count += 1;
      }
      if (count === 0) return { ids, last };
    }
  };
  const writer = new sql.ConnectionPool(
    sql.ConnectionPool.parseConnectionString(scratch.administrator),
  );
  await writer.connect();
  const open = new sql.Transaction(writer);
  let committed = false;
  try {
    await open.begin();
    await new sql.Request(open).query('INSERT dbo.events (id) VALUES (4)');
    // Committed after 4 began, so its rowversion is above 4's.
    await scratch.run('INSERT dbo.events (id) VALUES (5);');

    const first = await read('0', await session.minActiveRowversion());

    assert.deepEqual(first.ids, [1, 2, 3]);
    await open.commit();
    committed = true;
    const second = await read(first.last, await session.minActiveRowversion());
    assert.deepEqual(second.ids, [4, 5]);
  } finally {
    // A failed assertion leaves the write open, which would hold the
    // database until the test times out.
    if (!committed) await open.rollback();
    await writer.close();
  }
});

test('the database version moves when a rowversion or a tracked table changes, and has no Change Tracking part while tracking is off', async () => {
  await using scratch = await scratchDatabase();
  await scratch.run(
    'CREATE TABLE dbo.stamped (id int PRIMARY KEY, note int, stamp rowversion);',
  );
  const reader = await scratch.login();
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();
  const untracked = await session.version();
  assert.equal(untracked.changeTracking, null);

  await scratch.run('INSERT dbo.stamped (id, note) VALUES (1, 1);');
  const inserted = await session.version();
  assert.ok(BigInt(inserted.rowversion) > BigInt(untracked.rowversion));
  await scratch.run(
    'ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON; ALTER TABLE dbo.stamped ENABLE CHANGE_TRACKING;',
  );
  const tracked = await session.version();
  assert.notEqual(tracked.changeTracking, null);

  await scratch.run('UPDATE dbo.stamped SET note = 2;');

  const updated = await session.version();
  assert.notEqual(updated.changeTracking, null);
  assert.ok(
    BigInt(String(updated.changeTracking)) >
      BigInt(String(tracked.changeTracking)),
  );
  assert.ok(BigInt(updated.rowversion) > BigInt(tracked.rowversion));
});

test('discovery lists user tables but not views, each with its key in key order, its rowversion, its Change Tracking and its descriptions', async () => {
  await using scratch = await scratchDatabase();
  await scratch.run(`
    ALTER DATABASE CURRENT SET CHANGE_TRACKING = ON;
    EXEC('CREATE SCHEMA sales');
    CREATE TABLE dbo.orders (region char(2), id int, stamp rowversion, note nvarchar(10), CONSTRAINT orders_key PRIMARY KEY (id, region));
    CREATE TABLE sales.items (id uniqueidentifier PRIMARY KEY, body xml);
    ALTER TABLE sales.items ENABLE CHANGE_TRACKING;
    CREATE TABLE dbo.log (message nvarchar(max));
    EXEC('CREATE VIEW dbo.recent AS SELECT id FROM dbo.orders');
    EXEC sp_addextendedproperty 'MS_Description', N'Orders as placed', 'SCHEMA', 'dbo', 'TABLE', 'orders';
    EXEC sp_addextendedproperty 'MS_Description', N'What the buyer wrote', 'SCHEMA', 'dbo', 'TABLE', 'orders', 'COLUMN', 'note';`);
  const reader = await scratch.login(
    'GRANT VIEW CHANGE TRACKING ON sales.items TO {user};',
  );
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();

  const tables = await session.tables();

  assert.deepEqual(
    tables.map(({ schema, name }) => `${schema}.${name}`),
    ['dbo.log', 'dbo.orders', 'sales.items'],
  );
  const orders = table(tables, 'dbo.orders');
  assert.deepEqual(
    orders.columns.map(({ name, type, nullable, description }) => [
      name,
      type,
      nullable,
      description,
    ]),
    [
      ['region', 'char(2)', false, null],
      ['id', 'int', false, null],
      ['stamp', 'timestamp', false, null],
      ['note', 'nvarchar(10)', true, 'What the buyer wrote'],
    ],
  );
  assert.equal(orders.description, 'Orders as placed');
  assert.deepEqual(
    orders.primaryKey.map(({ name }) => name),
    ['id', 'region'],
  );
  assert.equal(orders.rowversion?.name, 'stamp');
  assert.equal(orders.changeTracking, 'off');
  assert.equal(orders.pageable, true);
  const items = table(tables, 'sales.items');
  assert.equal(items.changeTracking, 'readable');
  assert.equal(items.rowversion, undefined);
  const log = table(tables, 'dbo.log');
  assert.deepEqual(log.primaryKey, []);
  assert.equal(log.pageable, false);
});

test('paging by two over every kind of key reads each row once, in the order the key sorts', async () => {
  await using scratch = await scratchDatabase();
  // Each kind: its key columns, and its rows.
  const kinds: Record<string, [string, string]> = {
    words: [
      'a int, b varchar(10) COLLATE SQL_Latin1_General_CP1_CI_AS, PRIMARY KEY (a, b)',
      "(1, 'co-op'), (1, 'coop'), (1, 'co'), (1, 'cop'), (1, 'Coat'), (1, 'co-z'), (1, 'cob'), (2, '-a'), (2, 'a')",
    ],
    cased: [
      'k nvarchar(10) COLLATE Latin1_General_CS_AS PRIMARY KEY',
      "(N'a'), (N'A'), (N'b'), (N'B'), (N'ä'), (N'Ä'), (N'z')",
    ],
    padded: ['k char(5) PRIMARY KEY', "('a'), ('a b'), ('ab'), ('b'), ('')"],
    guids: [
      'k uniqueidentifier PRIMARY KEY',
      "('00000000-0000-0000-0000-000000000001'), ('01000000-0000-0000-0000-000000000000'), ('00000000-0000-0000-0100-000000000000'), ('00000000-0001-0000-0000-000000000000'), ('00000000-0000-0001-0000-000000000000'), ('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')",
    ],
    precise: [
      'k datetime2(7) PRIMARY KEY',
      "('2025-01-02T03:04:05.0000001'), ('2025-01-02T03:04:05.0000002'), ('2025-01-02T03:04:05'), ('0001-01-01'), ('9999-12-31T23:59:59.9999999')",
    ],
    offsets: [
      'k datetimeoffset(7) PRIMARY KEY',
      "('2025-01-02T03:04:05+05:30'), ('2025-01-02T03:04:05-03:45'), ('2025-01-02T03:04:05.0000001+00:00'), ('2025-01-01T21:34:05.0000002+00:00'), ('2025-01-02T03:04:05+00:00')",
    ],
    amounts: [
      'k decimal(19, 4) PRIMARY KEY',
      '(-1.5), (-0.0001), (0), (0.0001), (10), (922337203685477.5807)',
    ],
    // Trailing zero bytes do not count, so 0x00, 0x0000 and 0x are one key.
    bytes: [
      'k varbinary(8) PRIMARY KEY',
      '(0x00), (0x0001), (0x01), (0xFF), (0x00FF), (0xFF01)',
    ],
    counts: [
      'k bigint PRIMARY KEY',
      '(-9223372036854775808), (-1), (0), (1), (9007199254740993), (9223372036854775807)',
    ],
    moments: [
      'd date, t time(7), PRIMARY KEY (d, t)',
      "('2025-01-01', '00:00:00'), ('2025-01-01', '23:59:59.9999999'), ('0001-01-01', '12:00:00.0000001'), ('2025-01-01', '12:00:00.0000001')",
    ],
    tree: [
      'k hierarchyid PRIMARY KEY',
      "('/'), ('/1/'), ('/1/1/'), ('/2/'), ('/1/2/'), ('/1.5/')",
    ],
    ratios: [
      'k float PRIMARY KEY',
      '(-1e308), (-0.1), (0), (0.1), (2.2250738585072014e-308), (1.7976931348623157e308)',
    ],
    flags: [
      'flag bit, n smallint, PRIMARY KEY (flag, n)',
      '(1, -1), (0, 5), (1, 0), (0, -32768)',
    ],
  };
  await scratch.run(
    Object.entries(kinds)
      .map(
        ([name, [columns, rows]]) =>
          `CREATE TABLE dbo.[${name}] (${columns}); INSERT dbo.[${name}] VALUES ${rows};`,
      )
      .join('\n'),
  );
  const reader = await scratch.login();
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();
  const tables = await session.tables();

  for (const name of Object.keys(kinds)) {
    const of = table(tables, `dbo.${name}`);
    // One page holds the table as ORDER BY sorts it, with no position to cast.
    const sorted = await keys(session.page(of, null, 1000));
    const inserted = (kinds[name]?.[1].match(/\(/g) ?? []).length;
    assert.equal(sorted.length, inserted, name);

    assert.deepEqual(await pagedBy(session, of, 2), sorted, name);
    assert.equal(
      new Set(sorted.map((key) => JSON.stringify(key))).size,
      sorted.length,
      name,
    );
  }
});

test('every type reads back exactly, at its limits, as the text or number that keeps it whole', async () => {
  await using scratch = await scratchDatabase();
  // A batch cannot use a type it creates.
  await scratch.run('CREATE TYPE dbo.Phone FROM nvarchar(20) NULL;');
  await scratch.run(`
    CREATE TABLE dbo.everything (
      id int PRIMARY KEY,
      tiny tinyint, small smallint, whole int, big bigint, flag bit,
      wide decimal(38, 10), round numeric(5, 0), cash money, petty smallmoney,
      approx float, single real,
      day date, stamp7 datetime2(7), stamp0 datetime2(0), stamp3 datetime2(3), legacy datetime, coarse smalldatetime,
      moment datetimeoffset(7), moment0 datetimeoffset(0),
      clock7 time(7), clock0 time(0), clock3 time(3),
      fixed char(5), fixedWide nchar(5), name nvarchar(max), latin varchar(20), old text, oldWide ntext,
      bytes binary(4), blob varbinary(max), picture image,
      guid uniqueidentifier, doc xml, node hierarchyid, place geography, shape geometry, anything sql_variant,
      version rowversion,
      phone dbo.Phone,
      email varchar(50) MASKED WITH (FUNCTION = 'email()') NULL);
    INSERT dbo.everything (id, tiny, small, whole, big, flag, wide, round, cash, petty, approx, single, day, stamp7, stamp0, stamp3, legacy, coarse, moment, moment0, clock7, clock0, clock3, fixed, fixedWide, name, latin, old, oldWide, bytes, blob, picture, guid, doc, node, place, shape, anything, phone, email) VALUES
      (1, 255, 32767, 2147483647, 9223372036854775807, 1,
       9999999999999999999999999999.9999999999, 99999, 922337203685477.5807, 214748.3647,
       1.7976931348623157e308, 3.4028234663852886e38,
       '9999-12-31', '9999-12-31T23:59:59.9999999', '9999-12-31T23:59:59', '9999-12-31T23:59:59.999', '9999-12-31T23:59:59.997', '2079-06-06T23:59:00',
       '9999-12-31T23:59:59.9999999+00:00', '2025-06-01T12:00:00+14:00',
       '23:59:59.9999999', '23:59:59', '23:59:59.999',
       'ab', N'é', N'😀 astral', 'café', 'text', N'ntext',
       0x00FF00FF, 0x0102, 0xFF,
       '6F9619FF-8B86-D011-B42D-00C04FC964FF', '<a b="1"/>', '/1/2/',
       geography::STGeomFromText('POINT(-122.349 47.651 10 3)', 4326), geometry::STGeomFromText('LINESTRING(0 0, 1 1)', 0),
       CAST(1.50 AS decimal(5, 2)), N'555-0100', 'someone@example.com'),
      (2, 0, -32768, -2147483648, -9223372036854775808, 0,
       -0.0000000001, -99999, -922337203685477.5808, -214748.3648,
       2.2250738585072014e-308, 1.1754943508222875e-38,
       '0001-01-01', '0001-01-01T00:00:00', '0001-01-01T00:00:00', '2025-01-02T03:04:05', '1753-01-01T00:00:00', '1900-01-01T00:00:00',
       '2025-01-02T03:04:05-14:00', '2025-01-02T03:04:05+05:30',
       '00:00:00', '00:00:00', '00:00:00',
       '', N'', N'', '', '', N'',
       0x00000000, 0x, 0x,
       '00000000-0000-0000-0000-000000000000', '', '/',
       geography::Point(0, 0, 4326), geometry::STGeomFromText('POINT(1 2 3)', 3857),
       CAST(CAST('2025-01-02T03:04:05.1234567' AS datetime2(7)) AS sql_variant), N'', NULL),
      (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`);
  const reader = await scratch.login();
  await using session = await new SqlServerDatabase(
    reader.connectionString,
  ).open();
  const everything = table(await session.tables(), 'dbo.everything');

  const rows: unknown[][] = [];
  for await (const row of session.page(everything, null, 10))
    rows.push([...row.values]);

  const version = everything.columns.findIndex(
    ({ name }) => name === 'version',
  );
  for (const row of rows)
    assert.match(String(row.splice(version, 1)[0]), /^\d+$/);
  assert.deepEqual(rows, [
    [
      1,
      255,
      32767,
      2147483647,
      '9223372036854775807',
      true,
      '9999999999999999999999999999.9999999999',
      '99999',
      '922337203685477.5807',
      '214748.3647',
      1.7976931348623157e308,
      3.4028234663852886e38,
      '9999-12-31',
      '9999-12-31T23:59:59.9999999',
      '9999-12-31T23:59:59',
      '9999-12-31T23:59:59.999',
      '9999-12-31T23:59:59.997',
      '2079-06-06T23:59:00',
      new OffsetTimestamp('9999-12-31T23:59:59.9999999Z', 0),
      new OffsetTimestamp('2025-05-31T22:00:00Z', 840),
      '23:59:59.9999999',
      '23:59:59',
      '23:59:59.999',
      'ab   ',
      'é    ',
      '😀 astral',
      'café',
      'text',
      'ntext',
      'AP8A/w==',
      'AQI=',
      '/w==',
      '6F9619FF-8B86-D011-B42D-00C04FC964FF',
      '<a b="1"/>',
      '/1/2/',
      'SRID=4326;POINT (-122.349 47.651 10 3)',
      'SRID=0;LINESTRING (0 0, 1 1)',
      new VariantValue('1.50', 'decimal'),
      '555-0100',
      'sXXX@XXXX.com',
    ],
    [
      2,
      0,
      -32768,
      -2147483648,
      '-9223372036854775808',
      false,
      '-0.0000000001',
      '-99999',
      '-922337203685477.5808',
      '-214748.3648',
      2.2250738585072014e-308,
      1.1754943508222875e-38,
      '0001-01-01',
      '0001-01-01T00:00:00.0000000',
      '0001-01-01T00:00:00',
      '2025-01-02T03:04:05.000',
      '1753-01-01T00:00:00.000',
      '1900-01-01T00:00:00',
      new OffsetTimestamp('2025-01-02T17:04:05.0000000Z', -840),
      new OffsetTimestamp('2025-01-01T21:34:05Z', 330),
      '00:00:00.0000000',
      '00:00:00',
      '00:00:00.000',
      '     ',
      '     ',
      '',
      '',
      '',
      '',
      'AAAAAA==',
      '',
      '',
      '00000000-0000-0000-0000-000000000000',
      '',
      '/',
      'SRID=4326;POINT (0 0)',
      'SRID=3857;POINT (1 2 3)',
      new VariantValue('2025-01-02T03:04:05.1234567', 'datetime2'),
      '',
      null,
    ],
    [3, ...Array.from({ length: 39 }, () => null)],
  ]);
  const column = (name: string) =>
    everything.columns.find((column) => column.name === name);
  assert.equal(column('phone')?.type, 'nvarchar(20)');
  assert.equal(column('email')?.masked, true);
  assert.equal(column('name')?.masked, false);
});
