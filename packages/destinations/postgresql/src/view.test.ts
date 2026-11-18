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

// Records with ids, loaded into raw.raw_records and read through
// marts.records; it fails every read while failing is set.
class Records extends Source {
  readonly identity = 'records';
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
// derive gives over the destination of marts.
function recordsPipeline(
  url: string,
  source: Records,
  derive: (marts: PostgresDestination) => DerivedDataset<PostgresTable>[],
) {
  const raw = new PostgresDestination({ url, schema: 'raw' });
  return new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination: raw,
        steps: [
          new Copy(
            source.records,
            raw.table('raw_records').withReaderView('marts', 'records'),
          ),
        ],
      }),
    ],
    derived: derive(new PostgresDestination({ url, schema: 'marts' })),
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
    count(marts, 'SELECT count(*)::int AS n FROM raw.raw_records'),
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
