import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type LoadedRow,
  Pipeline,
  Rule,
  type RuleResult,
  type RuleValues,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  ComputedDataset,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
  View,
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

// Two records, r1 and r2, loaded into _warehouse.raw_records and read
// through marts.records.
class Records extends Source {
  readonly identity = 'records';
  readonly records = new Stream({
    name: 'records',
    jsonSchema: {
      type: 'object',
      description: 'A record.',
      properties: { id: { type: 'string', description: 'Record id.' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.records]);

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const id of ['r1', 'r2'])
      yield { stream: configuration.stream.name, data: { id } };
  }
}

// The size of each record, as a model that measures records gives it.
const sized = {
  size: { type: 'integer', description: 'The size of the record.' },
} as const;

class Size extends Rule<string, typeof sized> {
  override readonly key = { name: 'id', description: 'The record.' };
  override readonly output = sized;
  override readonly batch = 10;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return typeof row.id === 'string' ? { key: row.id, input: row.id } : null;
  }

  override async identity() {
    return 'size-1';
  }

  override async compute(
    ids: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<typeof sized>>[]> {
    return ids.map((id) => ({ value: { size: id.length } }));
  }
}

type Counted = {
  readonly description: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly sql: string;
};

const counted: Counted = {
  description: 'How many records loaded.',
  columns: { n: 'Number of records.' },
  sql: 'SELECT count(*) AS n FROM records',
};

// A writer's pipeline, built anew for each start as a deploy builds it: one
// copy of the records, the view marts.record_count over it, and the computed
// dataset marts.sizes with an index on its size.
function warehouse(login: SqlServerLogin, count: Counted = counted) {
  const destination = new SqlServerDestination({ login });
  const source = new Records();
  const target = destination.table('records');
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [new Copy(source.records, target)],
      }),
    ],
    derived: [
      new View({ into: destination, name: 'record_count', ...count }),
      new ComputedDataset({
        into: destination,
        name: 'sizes',
        description: 'The size of each record.',
        from: [target],
        compute: new Size(),
        indexes: [{ type: 'nonclustered', columns: ['size'] }],
      }),
    ],
  });
}

// One reading for each view of marts, each open from now on: a statement
// that fails ends the SNAPSHOT transaction of its reading, so each view
// needs a reading of its own.
async function readings(
  admin: SqlServerConnection,
  destination: SqlServerDestination,
  stack: AsyncDisposableStack,
) {
  const views = await admin.query(
    "SELECT QUOTENAME([name]) AS [name] FROM sys.views WHERE [schema_id] = SCHEMA_ID(N'marts') ORDER BY [name]",
  );
  const open = [];
  for (const { name } of views) {
    const reading = await destination.reading();
    if ('expired' in reading) assert.fail(reading.expired);
    stack.use(reading);
    open.push({ view: `marts.${String(name)}`, reading });
  }
  return open;
}

// The error number of each view that its reading failed to read, by view.
async function failures(open: Awaited<ReturnType<typeof readings>>) {
  const failed: Record<string, unknown> = {};
  for (const { view, reading } of open)
    try {
      await reading.sql.query(`SELECT count(*) AS [n] FROM ${view}`);
    } catch (error) {
      failed[view] =
        Error.isError(error) && 'number' in error ? error.number : error;
    }
  return failed;
}

test('a start whose declarations equal what the database holds changes no object in marts, so each reading open before it still reads every view', async () => {
  await using database = await scratch();
  await warehouse(database.login).run();
  await using stack = new AsyncDisposableStack();
  const open = await readings(
    database.admin,
    new SqlServerDestination({ login: database.login }),
    stack,
  );

  await warehouse(database.login).run();

  const views = open.map(({ view }) => view);
  assert.deepEqual(
    {
      read: [
        'marts.[catalog]',
        'marts.[record_count]',
        'marts.[records]',
        'marts.[sizes]',
        'marts.[sync_status]',
      ].filter((view) => views.includes(view)).length,
      failed: await failures(open),
    },
    { read: 5, failed: {} },
  );
});

test('a start that changes the SQL and the descriptions of a view puts them in SQL Server, also a description that changes only by a trailing space or only in case, and a reading open before it fails on that view with error 3961', async () => {
  await using database = await scratch();
  await warehouse(database.login).run();
  await using stack = new AsyncDisposableStack();
  const open = await readings(
    database.admin,
    new SqlServerDestination({ login: database.login }),
    stack,
  );

  await warehouse(database.login, {
    description: 'How many records loaded. ',
    columns: { n: 'Number of Records.' },
    sql: 'SELECT count(*) * 10 AS n FROM records',
  }).run();

  assert.deepEqual(
    {
      rows: (
        await database.admin.query('SELECT n FROM marts.record_count')
      ).map((row) => ({ ...row })),
      catalog: (
        await database.admin.query(
          "SELECT [name], [description] FROM marts.catalog WHERE [name] LIKE N'record[_]count%' ORDER BY [name]",
        )
      ).map((row) => ({ ...row })),
      failed: await failures(open),
    },
    {
      rows: [{ n: 20 }],
      catalog: [
        {
          name: 'record_count',
          description: 'How many records loaded. ',
        },
        { name: 'record_count.n', description: 'Number of Records.' },
      ],
      failed: { 'marts.[record_count]': 3961 },
    },
  );
});
