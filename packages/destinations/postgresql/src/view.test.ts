import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

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
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
  View,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// Records with ids, loaded into _warehouse.raw_records and read through
// marts.records; it fails every read while failing is set.
class Records extends Source {
  readonly identity: string = 'records';
  failing = false;
  ids: readonly string[];
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

  constructor(ids: readonly string[]) {
    super();
    this.ids = ids;
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
      yield { stream: configuration.stream.name, data: { id } };
  }
}

// The pipeline of one copy of the records, and the derived datasets that
// derive gives over its destination.
function recordsPipeline(
  url: string,
  source: Records,
  derive: (marts: PostgresDestination) => DerivedDataset<PostgresTable>[],
) {
  const destination = new PostgresDestination({ url });
  return new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
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
}

const count = (into: PostgresDestination, sql: string) =>
  new View({
    into,
    name: 'record_count',
    description: 'How many records loaded.',
    columns: { n: 'Number of records.' },
    sql,
  });

const client = (url: string, clients: AsyncDisposableStack) =>
  clients.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );

const views = async (sql: postgres.Sql) =>
  (
    await sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.views
      WHERE table_schema = 'marts' ORDER BY table_name`
  ).map(({ name }) => name);

test('a view a pipeline declares appears once the tables it reads have loaded, with its columns in the catalog, and a run that changes nothing leaves it as it was', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const pipeline = recordsPipeline(url, new Records(['r1', 'r2']), (marts) => [
    count(marts, 'SELECT count(*)::int AS n FROM records'),
  ]);

  await pipeline.run();
  const [made] = await sql`SELECT 'marts.record_count'::regclass::oid AS oid`;
  await pipeline.run();

  assert.deepEqual(
    {
      rows: [...(await sql`SELECT n FROM marts.record_count`)],
      catalog: [
        ...(await sql`
          SELECT kind, name, description FROM marts.catalog
          WHERE name LIKE 'record_count%' ORDER BY name`),
      ],
      same: [...(await sql`SELECT 'marts.record_count'::regclass::oid AS oid`)],
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
      same: [made],
    },
  );
});

test('a view that reads a table no copy of the pipeline makes fails the run with the error of Postgres, after the copies loaded', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const pipeline = recordsPipeline(url, new Records(['r1']), (marts) => [
    count(marts, 'SELECT count(*)::int AS n FROM recordz'),
  ]);

  const error = await pipeline.run().then(
    () => assert.fail('the run reported nothing'),
    (error: unknown) => error,
  );

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(Error.isError(error));
  assert.match(error.message, /relation "recordz" does not exist/);
  assert.deepEqual(
    {
      loaded: [...(await sql`SELECT id FROM marts.records`)],
      views: (await views(sql)).includes('record_count'),
    },
    { loaded: [{ id: 'r1' }], views: false },
  );
});

test('a view whose input has not loaded yet stays absent, and appears with the run that loads it', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const source = new Records(['r1']);
  const pipeline = recordsPipeline(url, source, (marts) => [
    count(marts, 'SELECT count(*)::int AS n FROM _warehouse.raw_records'),
  ]);
  source.failing = true;

  const failed = await pipeline.run().then(
    () => assert.fail('the copy reported no failure'),
    (error: unknown) => error,
  );
  const before = await views(sql);
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    {
      before: before.includes('record_count'),
      rows: [...(await sql`SELECT n FROM marts.record_count`)],
    },
    { before: false, rows: [{ n: 1 }] },
  );
});

test('marts.derived_status says that a view waits while its input has not loaded, that it is current once it appears, and that it failed, with the error of Postgres, when its SQL does not compile', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const source = new Records(['r1']);
  const status = async () => [
    ...(await sql`
      SELECT dataset, kind, state, error IS NOT NULL AS failing
      FROM marts.derived_status ORDER BY dataset`),
  ];
  const counting = (query: string) =>
    recordsPipeline(url, source, (marts) => [count(marts, query)]);
  source.failing = true;
  await counting('SELECT count(*)::int AS n FROM _warehouse.raw_records')
    .run()
    .catch(() => undefined);
  const waiting = await status();
  source.failing = false;
  await counting('SELECT count(*)::int AS n FROM _warehouse.raw_records').run();
  const current = await status();

  await counting('SELECT count(*)::int AS n FROM recordz')
    .run()
    .catch(() => undefined);

  assert.deepEqual(
    { waiting, current, failed: await status() },
    {
      waiting: [
        {
          dataset: 'marts.record_count',
          kind: 'view',
          state: 'waiting',
          failing: false,
        },
      ],
      current: [
        {
          dataset: 'marts.record_count',
          kind: 'view',
          state: 'current',
          failing: false,
        },
      ],
      failed: [
        {
          dataset: 'marts.record_count',
          kind: 'view',
          state: 'failed',
          failing: true,
        },
      ],
    },
  );
});

test('a view that reads a view still waiting for its copy waits too, and both appear with the run that loads the copy', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const source = new Records(['r1', 'r2']);
  const pipeline = recordsPipeline(url, source, (marts) => [
    count(marts, 'SELECT count(*)::int AS n FROM records'),
    new View({
      into: marts,
      name: 'record_load',
      description: 'Whether more than one record loaded.',
      columns: { many: 'Whether more than one record loaded.' },
      sql: 'SELECT n > 1 AS many FROM record_count',
    }),
  ]);
  source.failing = true;

  const failed = await pipeline.run().then(
    () => assert.fail('the copy reported no failure'),
    (error: unknown) => error,
  );
  const before = await views(sql);
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    {
      before: before.filter((name) => name.startsWith('record_')),
      rows: [...(await sql`SELECT many FROM marts.record_load`)],
    },
    { before: [], rows: [{ many: true }] },
  );
});

// The records of a second store, which a second connection loads.
class Inputs extends Records {
  override readonly identity = 'inputs';
}

// A pipeline whose connection records loads _warehouse.raw_records, read through
// marts.records, whose connection inputs loads _warehouse.raw_dataset_inputs, read
// through marts.dataset_inputs, and whose views in marts are candidates and
// judgment_inputs, which reads candidates.
function judgedPipeline(
  url: string,
  sources: { records: Records; inputs: Inputs },
  candidates: { sql: string; columns: Readonly<Record<string, string>> },
  judged: { sql: string; columns: Readonly<Record<string, string>> },
) {
  const marts = new PostgresDestination({ url });
  return new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
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
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const sources = { records: new Records(['r1']), inputs: new Inputs(['r1']) };
  sources.inputs.failing = true;
  await judgedPipeline(
    url,
    sources,
    { sql: 'SELECT id FROM records', columns: { id: 'Record id.' } },
    { sql: 'SELECT id FROM candidates', columns: { id: 'Record id.' } },
  )
    .run()
    .catch(() => undefined);
  const ownViews = (names: readonly string[]) =>
    names.filter((name) => name === 'candidates' || name === 'judgment_inputs');
  const before = ownViews(await views(sql));

  const error = await judgedPipeline(
    url,
    sources,
    {
      sql: 'SELECT r.id, d.id AS input FROM records r JOIN dataset_inputs d USING (id)',
      columns: { id: 'Record id.', input: 'Its input.' },
    },
    { sql: 'SELECT input FROM candidates', columns: { input: 'Its input.' } },
  )
    .run()
    .then(
      () => assert.fail('the run reported no failure'),
      (error: unknown) => error,
    );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    {
      before,
      error: error.errors.map(({ message }: Error) => message),
      after: ownViews(await views(sql)),
      status: [
        ...(await sql`
          SELECT dataset, state FROM marts.derived_status ORDER BY dataset`),
      ],
    },
    {
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

test('a view that reads a view declared after it fails the run with the error of Postgres', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const pipeline = recordsPipeline(url, new Records(['r1', 'r2']), (marts) => [
    new View({
      into: marts,
      name: 'record_load',
      description: 'Whether more than one record loaded.',
      columns: { many: 'Whether more than one record loaded.' },
      sql: 'SELECT n > 1 AS many FROM record_count',
    }),
    count(marts, 'SELECT count(*)::int AS n FROM records'),
  ]);

  const error = await pipeline.run().then(
    () => assert.fail('the run reported nothing'),
    (error: unknown) => error,
  );

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(Error.isError(error));
  assert.match(error.message, /relation "record_count" does not exist/);
  assert.equal((await views(sql)).includes('record_load'), false);
});

test('a changed declaration replaces the view, and a view that someone made over it reads the new one and keeps its comment', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const source = new Records(['r1', 'r2']);
  await recordsPipeline(url, source, (marts) => [
    count(marts, 'SELECT count(*)::int AS n FROM records'),
  ]).run();
  await sql.unsafe(`
    CREATE SCHEMA reports;
    CREATE VIEW reports.loaded AS SELECT n FROM marts.record_count;
    COMMENT ON VIEW reports.loaded IS 'What loaded.';
  `);

  await recordsPipeline(url, source, (marts) => [
    new View({
      into: marts,
      name: 'record_count',
      description: 'How many records loaded, and the first.',
      columns: { n: 'Number of records.', first: 'The first record id.' },
      sql: 'SELECT count(*)::int AS n, min(id) AS first FROM records',
    }),
  ]).run();

  assert.deepEqual(
    {
      view: [...(await sql`SELECT n, first FROM marts.record_count`)],
      reports: [...(await sql`SELECT n FROM reports.loaded`)],
      comment: [
        ...(await sql`SELECT obj_description('reports.loaded'::regclass, 'pg_class') AS d`),
      ],
    },
    {
      view: [{ n: 2, first: 'r1' }],
      reports: [{ n: 2 }],
      comment: [{ d: 'What loaded.' }],
    },
  );
});
