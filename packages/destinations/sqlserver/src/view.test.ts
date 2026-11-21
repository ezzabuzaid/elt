import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type DerivedDataset,
  Pipeline,
  PipelineError,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
  type SqlServerTable,
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

// Records with ids and the fields a test asks for, loaded into
// _warehouse.raw_records and read through marts.records; it fails every read
// while failing is set.
class Records extends Source {
  readonly identity: string = 'records';
  failing = false;
  ids: readonly string[];
  readonly #fields: readonly string[];
  readonly records: Stream;
  protected readonly catalog: Catalog;

  constructor(ids: readonly string[], fields: readonly string[] = ['id']) {
    super();
    this.ids = ids;
    this.#fields = fields;
    this.records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        description: 'A record.',
        properties: Object.fromEntries(
          fields.map((field) => [
            field,
            { type: 'string', description: `Record ${field}.` },
          ]),
        ),
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
    this.catalog = new Catalog([this.records]);
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

  protected override async *extract(configuration: CopyConfiguration) {
    if (this.failing) throw new Error('the store is gone');
    for (const id of this.ids)
      yield {
        stream: configuration.stream.name,
        data: Object.fromEntries(
          this.#fields.map((field) => [
            field,
            field === 'id' ? id : `${field} of ${id}`,
          ]),
        ),
      };
  }
}

// The pipeline of one copy of the records, and the derived datasets that
// derive gives over its destination.
function recordsPipeline(
  login: SqlServerLogin,
  source: Records,
  derive: (marts: SqlServerDestination) => DerivedDataset<SqlServerTable>[],
) {
  const destination = new SqlServerDestination({ login });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [new Copy(source.records, destination.table('records'))],
      }),
    ],
    derived: derive(destination),
  });
  return { pipeline, destination };
}

const count = (into: SqlServerDestination, sql: string) =>
  new View({
    into,
    name: 'record_count',
    description: 'How many records loaded.',
    columns: { n: 'Number of records.' },
    sql,
  });

const plain = (rows: readonly Record<string, unknown>[]) =>
  rows.map((row) => ({ ...row }));

const views = async (database: { admin: SqlServerConnection }) =>
  (
    await database.admin.query(
      "SELECT [name] FROM sys.views WHERE SCHEMA_NAME([schema_id]) = N'marts' ORDER BY [name]",
    )
  ).map(({ name }) => String(name));

const rejection = (run: Promise<unknown>) =>
  run.then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

test('a view with the name of a reader view that a copy makes fails the run before any copy reads', async () => {
  await using database = await scratch();
  const { pipeline } = recordsPipeline(
    database.login,
    new Records(['r1']),
    (marts) => [
      new View({
        into: marts,
        name: 'Records',
        description: 'The records again.',
        columns: { id: 'Record id.' },
        sql: 'SELECT id FROM _warehouse.raw_records',
      }),
    ],
  );

  await assert.rejects(
    pipeline.run(),
    /View marts\.Records has the name of a table or reader view a copy makes/,
  );
  assert.equal((await views(database)).includes('records'), false);
});

test('a view a pipeline declares appears once the tables it reads have loaded, with its descriptions in the catalog, and a run that changes nothing leaves it as it was', async () => {
  await using database = await scratch();
  const { pipeline } = recordsPipeline(
    database.login,
    new Records(['r1', 'r2']),
    (marts) => [count(marts, 'SELECT count(*) AS n FROM records')],
  );
  const made = () =>
    database.admin.query(
      "SELECT [object_id], [modify_date] FROM sys.objects WHERE [object_id] = OBJECT_ID(N'marts.record_count')",
    );

  await pipeline.run();
  const first = plain(await made());
  await pipeline.run();

  assert.equal(first.length, 1);
  assert.deepEqual(
    {
      rows: plain(
        await database.admin.query('SELECT n FROM marts.record_count'),
      ),
      catalog: plain(
        await database.admin.query(
          "SELECT [kind], [name], [description] FROM marts.catalog WHERE [name] LIKE N'record[_]count%' ORDER BY [name]",
        ),
      ),
      same: plain(await made()),
    },
    {
      rows: [{ n: 2 }],
      catalog: [
        {
          kind: 'view',
          name: 'record_count',
          description: 'How many records loaded.',
        },
        {
          kind: 'column',
          name: 'record_count.n',
          description: 'Number of records.',
        },
      ],
      same: first,
    },
  );
});

test('a view that reads a table no copy of the pipeline makes fails the run with the error of SQL Server, after the copies loaded', async () => {
  await using database = await scratch();
  const { pipeline } = recordsPipeline(
    database.login,
    new Records(['r1']),
    (marts) => [count(marts, 'SELECT count(*) AS n FROM recordz')],
  );

  const error = await rejection(pipeline.run());

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(Error.isError(error));
  assert.match(error.message, /Invalid object name 'recordz'/);
  assert.deepEqual(
    {
      loaded: plain(await database.admin.query('SELECT id FROM marts.records')),
      views: (await views(database)).includes('record_count'),
    },
    { loaded: [{ id: 'r1' }], views: false },
  );
});

test('a view whose input has not loaded yet, named with its schema in brackets, stays absent, and appears with the run that loads it', async () => {
  await using database = await scratch();
  const source = new Records(['r1']);
  const { pipeline } = recordsPipeline(database.login, source, (marts) => [
    count(marts, 'SELECT count(*) AS n FROM [_warehouse].[raw_records]'),
  ]);
  source.failing = true;

  const failed = await rejection(pipeline.run());
  const before = await views(database);
  const waited = plain(
    await database.admin.query(
      'SELECT [dataset], [state] FROM marts.derived_status',
    ),
  );
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    {
      errors: failed.errors.map(({ message }: Error) => message),
      waited,
      before: before.includes('record_count'),
      rows: plain(
        await database.admin.query('SELECT n FROM marts.record_count'),
      ),
    },
    {
      errors: ['the store is gone'],
      waited: [{ dataset: 'marts.record_count', state: 'waiting' }],
      before: false,
      rows: [{ n: 1 }],
    },
  );
});

test('marts.derived_status says that a view waits while its input has not loaded, that it is current once it appears, and that it failed, with the error of SQL Server, when its SQL does not compile', async () => {
  await using database = await scratch();
  const source = new Records(['r1']);
  const status = async () =>
    plain(
      await database.admin.query(
        'SELECT [dataset], [kind], [state], IIF([error] IS NULL, 0, 1) AS [failing], IIF([as_of] IS NULL, 0, 1) AS [dated] FROM marts.derived_status ORDER BY [dataset]',
      ),
    );
  const counting = (query: string) =>
    recordsPipeline(database.login, source, (marts) => [count(marts, query)])
      .pipeline;
  source.failing = true;
  await counting('SELECT count(*) AS n FROM _warehouse.raw_records')
    .run()
    .catch(() => undefined);
  const waiting = await status();
  source.failing = false;
  await counting('SELECT count(*) AS n FROM _warehouse.raw_records').run();
  const current = await status();

  await counting('SELECT count(*) AS n FROM recordz')
    .run()
    .catch(() => undefined);

  const row = (state: string, failing: number, dated: number) => ({
    dataset: 'marts.record_count',
    kind: 'view',
    state,
    failing,
    dated,
  });
  assert.deepEqual(
    { waiting, current, failed: await status() },
    {
      waiting: [row('waiting', 0, 0)],
      current: [row('current', 0, 1)],
      failed: [row('failed', 1, 1)],
    },
  );
});

test('a view that reads a view still waiting for its copy waits too, and both appear with the run that loads the copy', async () => {
  await using database = await scratch();
  const source = new Records(['r1', 'r2']);
  const { pipeline } = recordsPipeline(database.login, source, (marts) => [
    count(marts, 'SELECT count(*) AS n FROM records'),
    new View({
      into: marts,
      name: 'record_load',
      description: 'Whether more than one record loaded.',
      columns: { many: 'Whether more than one record loaded.' },
      sql: 'SELECT CAST(IIF(n > 1, 1, 0) AS bit) AS many FROM record_count',
    }),
  ]);
  source.failing = true;

  const failed = await rejection(pipeline.run());
  const before = await views(database);
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    {
      errors: failed.errors.map(({ message }: Error) => message),
      before: before.filter((name) => name.startsWith('record_')),
      rows: plain(
        await database.admin.query('SELECT many FROM marts.record_load'),
      ),
    },
    { errors: ['the store is gone'], before: [], rows: [{ many: true }] },
  );
});

// The records of a second store, which a second connection loads.
class Inputs extends Records {
  override readonly identity = 'inputs';
}

// A pipeline whose connection records loads _warehouse.raw_records, read
// through marts.records, whose connection inputs loads
// _warehouse.raw_dataset_inputs, read through marts.dataset_inputs, and whose
// views in marts are candidates and judgment_inputs, which reads candidates.
function judgedPipeline(
  login: SqlServerLogin,
  sources: { records: Records; inputs: Inputs },
  candidates: { sql: string; columns: Readonly<Record<string, string>> },
  judged: { sql: string; columns: Readonly<Record<string, string>> },
) {
  const marts = new SqlServerDestination({ login });
  return new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'records',
        source: sources.records,
        destination: marts,
        steps: [new Copy(sources.records.records, marts.table('records'))],
      }),
      new Connection({
        name: 'inputs',
        source: sources.inputs,
        destination: marts,
        steps: [
          new Copy(sources.inputs.records, marts.table('dataset_inputs')),
        ],
      }),
    ],
    derived: [
      new View({
        into: marts,
        name: 'candidates',
        description: 'The records to judge.',
        ...candidates,
      }),
      new View({
        into: marts,
        name: 'judgment_inputs',
        description: 'What each judgment reads.',
        ...judged,
      }),
    ],
  });
}

test('a view redeclared over a table its copy has not loaded yet leaves no view of its earlier declaration, so a view that reads it waits too, not fails', async () => {
  await using database = await scratch();
  const sources = { records: new Records(['r1']), inputs: new Inputs(['r1']) };
  sources.inputs.failing = true;
  const first = await rejection(
    judgedPipeline(
      database.login,
      sources,
      { sql: 'SELECT id FROM records', columns: { id: 'Record id.' } },
      { sql: 'SELECT id FROM candidates', columns: { id: 'Record id.' } },
    ).run(),
  );
  assert.ok(first instanceof PipelineError, String(first));
  const ownViews = (names: readonly string[]) =>
    names.filter((name) => name === 'candidates' || name === 'judgment_inputs');
  const before = ownViews(await views(database));

  const error = await rejection(
    judgedPipeline(
      database.login,
      sources,
      {
        sql: 'SELECT r.id, d.id AS input FROM records AS r JOIN dataset_inputs AS d ON d.id = r.id',
        columns: { id: 'Record id.', input: 'Its input.' },
      },
      { sql: 'SELECT input FROM candidates', columns: { input: 'Its input.' } },
    ).run(),
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    {
      first: first.errors.map(({ message }: Error) => message),
      before,
      error: error.errors.map(({ message }: Error) => message),
      after: ownViews(await views(database)),
      status: plain(
        await database.admin.query(
          'SELECT [dataset], [state] FROM marts.derived_status ORDER BY [dataset]',
        ),
      ),
    },
    {
      first: ['the store is gone'],
      before: ['candidates', 'judgment_inputs'],
      error: ['the store is gone'],
      after: [],
      status: [
        { dataset: 'marts.candidates', state: 'waiting' },
        { dataset: 'marts.judgment_inputs', state: 'waiting' },
      ],
    },
  );
});

test('a view that reads a view declared after it fails the run with the error of SQL Server', async () => {
  await using database = await scratch();
  const { pipeline } = recordsPipeline(
    database.login,
    new Records(['r1', 'r2']),
    (marts) => [
      new View({
        into: marts,
        name: 'record_load',
        description: 'Whether more than one record loaded.',
        columns: { many: 'Whether more than one record loaded.' },
        sql: 'SELECT CAST(IIF(n > 1, 1, 0) AS bit) AS many FROM record_count',
      }),
      count(marts, 'SELECT count(*) AS n FROM records'),
    ],
  );

  const error = await rejection(pipeline.run());

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(Error.isError(error));
  assert.match(error.message, /Invalid object name 'record_count'/);
  assert.equal((await views(database)).includes('record_load'), false);
});

test('a changed declaration alters the view in place, and a view that someone made over all its columns shows the new one and keeps its description', async () => {
  await using database = await scratch();
  const source = new Records(['r1', 'r2']);
  await recordsPipeline(database.login, source, (marts) => [
    count(marts, 'SELECT count(*) AS n FROM records'),
  ]).pipeline.run();
  await database.admin.query('CREATE SCHEMA reports');
  await database.admin.query(
    'CREATE VIEW reports.loaded AS SELECT * FROM marts.record_count',
  );
  await database.admin.query(
    "EXEC sp_addextendedproperty N'MS_Description', N'What loaded.', 'SCHEMA', N'reports', 'VIEW', N'loaded'",
  );
  const object = () =>
    database.admin.query("SELECT OBJECT_ID(N'marts.record_count') AS [id]");
  const made = plain(await object());

  await recordsPipeline(database.login, source, (marts) => [
    new View({
      into: marts,
      name: 'record_count',
      description: 'How many records loaded, and the first.',
      columns: { n: 'Number of records.', first: 'The first record id.' },
      sql: 'SELECT count(*) AS n, min(id) AS first FROM records',
    }),
  ]).pipeline.run();

  assert.deepEqual(
    {
      same: plain(await object()),
      view: plain(
        await database.admin.query('SELECT n, first FROM marts.record_count'),
      ),
      reports: plain(
        await database.admin.query('SELECT * FROM reports.loaded'),
      ),
      description: plain(
        await database.admin.query(
          "SELECT CAST([value] AS nvarchar(100)) AS [d] FROM sys.extended_properties WHERE [major_id] = OBJECT_ID(N'reports.loaded') AND [minor_id] = 0 AND [name] = N'MS_Description'",
        ),
      ),
    },
    {
      same: made,
      view: [{ n: 2, first: 'r1' }],
      reports: [{ n: 2, first: 'r1' }],
      description: [{ d: 'What loaded.' }],
    },
  );
});

test('a change of the shape of a table refreshes a view over all its columns, so the view shows the new column that its declaration then describes', async () => {
  await using database = await scratch();
  const every = (
    marts: SqlServerDestination,
    columns: Record<string, string>,
  ) =>
    new View({
      into: marts,
      name: 'every_record',
      description: 'Every record.',
      columns,
      sql: 'SELECT * FROM records',
    });
  await recordsPipeline(database.login, new Records(['r1']), (marts) => [
    every(marts, { id: 'Record id.', loaded_at: 'When it loaded.' }),
  ]).pipeline.run();

  await recordsPipeline(
    database.login,
    new Records(['r1'], ['id', 'title']),
    (marts) => [
      every(marts, {
        id: 'Record id.',
        title: 'Record title.',
        loaded_at: 'When it loaded.',
      }),
    ],
  ).pipeline.run();

  assert.deepEqual(
    {
      rows: plain(
        await database.admin.query(
          'SELECT id, title FROM marts.every_record ORDER BY id',
        ),
      ),
      described: plain(
        await database.admin.query(
          "SELECT [description] FROM marts.catalog WHERE [name] = N'every_record.title'",
        ),
      ),
    },
    {
      rows: [{ id: 'r1', title: 'title of r1' }],
      described: [{ description: 'Record title.' }],
    },
  );
});

test('a reading as of an earlier position reads a view as of that position, and a reading with no position reads it as it is now', async () => {
  await using database = await scratch();
  const source = new Records(['r1', 'r2']);
  const { pipeline, destination } = recordsPipeline(
    database.login,
    source,
    (marts) => [count(marts, 'SELECT count(*) AS n FROM records')],
  );
  await pipeline.run();
  const positions = await destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const before = positions.at(-1);
  if (before === undefined) assert.fail('the database has no position yet');
  source.ids = ['r1'];
  await pipeline.run();

  const read = async (position?: string) => {
    const reading = await destination.reading(position);
    if ('expired' in reading) assert.fail(reading.expired);
    await using _reading = reading;
    return plain(await reading.sql.query('SELECT n FROM marts.record_count'));
  };

  assert.deepEqual(
    { then: await read(before), now: await read() },
    { then: [{ n: 2 }], now: [{ n: 1 }] },
  );
});
