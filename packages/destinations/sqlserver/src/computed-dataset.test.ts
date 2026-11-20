import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';
import { Vector } from '@zukhruf/vectors';
import { fromSql } from '@zukhruf/vectors/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DerivedDatasetError,
  type LoadedRow,
  Pipeline,
  PipelineError,
  Rule,
  type RuleColumns,
  type RuleResult,
  type RuleValues,
  Source,
  Stream,
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

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

// Records with an id and a title, loaded into _warehouse.raw_records and read
// through marts.records; it fails every read while failing is set.
class Records extends Source {
  readonly identity: string = 'records';
  failing = false;
  ids: readonly string[];
  readonly records = new Stream({
    name: 'records',
    jsonSchema: {
      type: 'object',
      description: 'A record.',
      properties: {
        id: { type: 'string', description: 'Record id.' },
        title: { type: 'string', description: 'Record title.' },
      },
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
      yield {
        stream: configuration.stream.name,
        data: { id, title: `title of ${id}` },
      };
  }
}

// A size, a label and a vector of the dimensions the test asks for, for each
// record, as a model that measures records gives them; the test sets the
// answer for each id and the identity of the model.
const measured = (dimensions: number) =>
  ({
    size: { type: 'integer', description: 'The size of the record.' },
    label: { type: 'text', description: 'The label of the record.' },
    vector: {
      type: 'vector',
      dimensions,
      description: 'The record as a vector.',
    },
  }) as const;

type Measured = ReturnType<typeof measured>;

class Measure extends Rule<string, Measured> {
  override readonly key = { name: 'id', description: 'The record.' };
  override readonly output: Measured;
  override readonly batch = 10;
  override readonly concurrency = 1;
  readonly answers = new Map<string, RuleValues<Measured>>();
  model = 'measure-1';

  constructor(dimensions = 3) {
    super();
    this.output = measured(dimensions);
  }

  override read(row: LoadedRow) {
    return typeof row.id === 'string' ? { key: row.id, input: row.id } : null;
  }

  override async identity() {
    return this.model;
  }

  override async compute(
    ids: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<Measured>>[]> {
    return ids.map((id) => ({ value: this.answers.get(id) ?? {} }));
  }
}

// The pipeline of one copy of the records, with the dataset marts.measures
// over it and the views that view gives over the dataset.
function measuresPipeline(
  login: SqlServerLogin,
  source: Records,
  measure: Measure,
  views: (marts: SqlServerDestination) => View[] = () => [],
  afterCreate?: (table: string) => readonly string[],
) {
  const destination = new SqlServerDestination({ login });
  const target = destination.table('records');
  const pipeline = new Pipeline({
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
      new ComputedDataset({
        into: destination,
        name: 'measures',
        description: 'The size, label and vector of each record.',
        from: [target],
        compute: measure,
        afterCreate,
      }),
      ...views(destination),
    ],
  });
  return { pipeline, destination };
}

const plain = (rows: readonly Record<string, unknown>[]) =>
  rows.map((row) => ({ ...row }));

const rejection = (run: Promise<unknown>) =>
  run.then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

const measures =
  'SELECT [id], [status], [size], [label], CAST([vector] AS nvarchar(max)) AS [vector], [error] FROM marts.measures ORDER BY [id]';

test('a rule with text, integer and vector columns stores them as NVARCHAR(MAX), BIGINT and VECTOR(n), the vector reads back with fromSql and measures with VECTOR_DISTANCE, and marts.derived_status counts the rows', async () => {
  await using database = await scratch();
  const measure = new Measure();
  const { pipeline } = measuresPipeline(
    database.login,
    new Records(['r1', 'r2']),
    measure,
  );
  measure.answers.set('r1', {
    size: Number.MAX_SAFE_INTEGER,
    label: 'größe 🌍',
    vector: Vector.from([0.5, -1, 2]),
  });

  await pipeline.run();

  const rows = plain(await database.admin.query(measures));
  assert.deepEqual(
    {
      rows: rows.map(({ vector, ...row }) => ({
        ...row,
        vector:
          typeof vector === 'string'
            ? [...fromSql(Vector, vector).values]
            : vector,
      })),
      distance: plain(
        await database.admin.query(
          "SELECT VECTOR_DISTANCE('euclidean', [vector], CAST(N'[0.5,-1,2]' AS VECTOR(3))) AS [distance] FROM marts.measures WHERE [id] = N'r1'",
        ),
      ),
      declared: plain(
        await database.admin.query(
          "SELECT c.[name], TYPE_NAME(c.[user_type_id]) AS [type], c.[vector_dimensions] AS [dimensions] FROM sys.columns AS c WHERE c.[object_id] = OBJECT_ID(N'_warehouse.raw_measures') AND c.[name] IN (N'id', N'size', N'label', N'vector') ORDER BY c.[name]",
        ),
      ),
      status: plain(
        await database.admin.query(
          'SELECT [dataset], [kind], [state], CAST([inputs] AS int) AS [inputs], CAST([computed] AS int) AS [computed], CAST([failed] AS int) AS [failed], CAST([pending] AS int) AS [pending] FROM marts.derived_status',
        ),
      ),
    },
    {
      rows: [
        {
          id: 'r1',
          status: 'computed',
          size: String(Number.MAX_SAFE_INTEGER),
          label: 'größe 🌍',
          vector: [0.5, -1, 2],
          error: null,
        },
        {
          id: 'r2',
          status: 'computed',
          size: null,
          label: null,
          vector: null,
          error: null,
        },
      ],
      distance: [{ distance: 0 }],
      declared: [
        { name: 'id', type: 'nvarchar', dimensions: null },
        { name: 'label', type: 'nvarchar', dimensions: null },
        { name: 'size', type: 'bigint', dimensions: null },
        { name: 'vector', type: 'vector', dimensions: 3 },
      ],
      status: [
        {
          dataset: 'marts.measures',
          kind: 'computed',
          state: 'current',
          inputs: 2,
          computed: 2,
          failed: 0,
          pending: 0,
        },
      ],
    },
  );
});

test('a vector of other dimensions than its column fails its row with both counts, the run and the other rows succeed, and the next run that fails the row the same way keeps its commit', async () => {
  await using database = await scratch();
  const measure = new Measure();
  const { pipeline } = measuresPipeline(
    database.login,
    new Records(['r1', 'r2']),
    measure,
  );
  measure.answers.set('r1', { vector: Vector.from([1, 2]) });
  measure.answers.set('r2', { vector: Vector.from([1, 2, 3]) });
  const rows = async () =>
    plain(
      await database.admin.query(
        'SELECT [id], [status], [error], IIF([vector] IS NULL, 0, 1) AS [stored], [committed_in] FROM _warehouse.raw_measures ORDER BY [id]',
      ),
    );

  await pipeline.run();
  const first = await rows();
  // The refresh after the passes asks the rule again for a failed row, and
  // the row it makes has the values of the stored row.
  await pipeline.run();

  assert.deepEqual(await rows(), first);
  assert.deepEqual(
    first.map(({ committed_in: _, ...row }) => row),
    [
      {
        id: 'r1',
        status: 'failed',
        error:
          'The column vector takes a vector of 3 dimensions, and the rule gave one of 2.',
        stored: 0,
      },
      { id: 'r2', status: 'computed', error: null, stored: 1 },
    ],
  );
});

test('a refresh whose outputs did not change keeps their commits, a changed rule writes each row in a new commit that a reading of the earlier position does not see, and a gone input removes its row', async () => {
  await using database = await scratch();
  const source = new Records(['r1', 'r2']);
  const measure = new Measure();
  const { pipeline, destination } = measuresPipeline(
    database.login,
    source,
    measure,
  );
  const commits = async () =>
    plain(
      await database.admin.query(
        'SELECT [id], [committed_in] FROM _warehouse.raw_measures ORDER BY [id]',
      ),
    );
  measure.answers.set('r1', { label: 'first' });
  await pipeline.run();
  const first = await commits();
  const positions = await destination.positions();
  const before = Array.isArray(positions) ? positions.at(-1) : undefined;
  assert.ok(before !== undefined, 'the first run made no position');

  await pipeline.run();
  const unchanged = await commits();
  measure.model = 'measure-2';
  measure.answers.set('r1', { label: 'second' });
  source.ids = ['r1'];
  await pipeline.run();

  const then = await destination.reading(before);
  if ('expired' in then) assert.fail(then.expired);
  await using _then = then;
  assert.deepEqual(
    {
      unchanged,
      then: plain(
        await then.sql.query(
          'SELECT [id], [label] FROM marts.measures ORDER BY [id]',
        ),
      ),
      now: plain(
        await database.admin.query(
          'SELECT [id], [rule], [label] FROM marts.measures ORDER BY [id]',
        ),
      ),
    },
    {
      unchanged: first,
      then: [
        { id: 'r1', label: 'first' },
        { id: 'r2', label: null },
      ],
      now: [{ id: 'r1', rule: 'measure-2', label: 'second' }],
    },
  );
});

test('a vector column of other dimensions makes the raw table again with the new VECTOR(n), and each row again', async () => {
  await using database = await scratch();
  const source = new Records(['r1']);
  const three = new Measure(3);
  three.answers.set('r1', { vector: Vector.from([1, 2, 3]) });
  await measuresPipeline(database.login, source, three).pipeline.run();
  const four = new Measure(4);
  four.model = 'measure-4';
  four.answers.set('r1', { vector: Vector.from([1, 2, 3, 4]) });

  await measuresPipeline(database.login, source, four).pipeline.run();

  assert.deepEqual(
    {
      rows: plain(await database.admin.query(measures)).map(
        ({ id, status, vector }) => ({
          id,
          status,
          vector:
            typeof vector === 'string'
              ? [...fromSql(Vector, vector).values]
              : vector,
        }),
      ),
      dimensions: plain(
        await database.admin.query(
          "SELECT c.[vector_dimensions] AS [dimensions] FROM sys.columns AS c WHERE c.[object_id] = OBJECT_ID(N'_warehouse.raw_measures') AND c.[name] = N'vector'",
        ),
      ),
    },
    {
      rows: [{ id: 'r1', status: 'computed', vector: [1, 2, 3, 4] }],
      dimensions: [{ dimensions: 4 }],
    },
  );
});

test('afterCreate gets the raw table, and its statements run when the dataset makes the table and again when a changed declaration makes it again', async () => {
  await using database = await scratch();
  const source = new Records(['r1']);
  const tables: string[] = [];
  const afterCreate = (table: string) => {
    tables.push(table);
    return [`CREATE INDEX [by_commit] ON ${table} ([committed_in])`];
  };
  const indexes = async () =>
    plain(
      await database.admin.query(
        "SELECT i.[name] FROM sys.indexes AS i WHERE i.[object_id] = OBJECT_ID(N'_warehouse.raw_measures') AND i.[name] = N'by_commit'",
      ),
    );
  await measuresPipeline(
    database.login,
    source,
    new Measure(3),
    () => [],
    afterCreate,
  ).pipeline.run();
  const made = await indexes();
  const four = new Measure(4);
  four.model = 'measure-4';

  await measuresPipeline(
    database.login,
    source,
    four,
    () => [],
    afterCreate,
  ).pipeline.run();

  assert.deepEqual(
    {
      tables,
      made,
      remade: await indexes(),
      dimensions: plain(
        await database.admin.query(
          "SELECT c.[vector_dimensions] AS [dimensions] FROM sys.columns AS c WHERE c.[object_id] = OBJECT_ID(N'_warehouse.raw_measures') AND c.[name] = N'vector'",
        ),
      ),
    },
    {
      tables: ['[_warehouse].[raw_measures]', '[_warehouse].[raw_measures]'],
      made: [{ name: 'by_commit' }],
      remade: [{ name: 'by_commit' }],
      dimensions: [{ dimensions: 4 }],
    },
  );
});

test('an afterCreate statement that fails fails the dataset, and the transaction leaves no raw table', async () => {
  await using database = await scratch();
  const { pipeline } = measuresPipeline(
    database.login,
    new Records(['r1']),
    new Measure(),
    () => [],
    (table) => [`CREATE INDEX [by_nothing] ON ${table} ([nothing])`],
  );

  const failed = await rejection(pipeline.run());

  assert.ok(failed instanceof DerivedDatasetError, String(failed));
  assert.deepEqual(
    {
      error: failed.message,
      tables: plain(
        await database.admin.query(
          "SELECT OBJECT_ID(N'_warehouse.raw_measures') AS [raw], OBJECT_ID(N'marts.measures') AS [view]",
        ),
      ),
      status: plain(
        await database.admin.query(
          "SELECT [state] FROM marts.derived_status WHERE [dataset] = N'marts.measures'",
        ),
      ),
    },
    {
      error:
        "Derived dataset measures failed: Column name 'nothing' does not exist in the target table, index or view.",
      tables: [{ raw: null, view: null }],
      status: [{ state: 'failed' }],
    },
  );
});

test('a view over the dataset waits while the dataset waits for its input, and appears with the run that loads it', async () => {
  await using database = await scratch();
  const source = new Records(['r1', 'r2']);
  const { pipeline } = measuresPipeline(
    database.login,
    source,
    new Measure(),
    (marts) => [
      new View({
        into: marts,
        name: 'measure_count',
        description: 'How many records were measured.',
        columns: { n: 'Number of measured records.' },
        sql: "SELECT count(*) AS n FROM measures WHERE status = N'computed'",
      }),
    ],
  );
  const status = async () =>
    plain(
      await database.admin.query(
        'SELECT [dataset], [state] FROM marts.derived_status ORDER BY [dataset]',
      ),
    );
  source.failing = true;

  const failed = await rejection(pipeline.run());
  const waiting = await status();
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    {
      errors: failed.errors.map(({ message }: Error) => message),
      waiting,
      current: await status(),
      rows: plain(
        await database.admin.query('SELECT n FROM marts.measure_count'),
      ),
    },
    {
      errors: ['the store is gone'],
      waiting: [
        { dataset: 'marts.measure_count', state: 'waiting' },
        { dataset: 'marts.measures', state: 'waiting' },
      ],
      current: [
        { dataset: 'marts.measure_count', state: 'current' },
        { dataset: 'marts.measures', state: 'current' },
      ],
      rows: [{ n: 2 }],
    },
  );
});

test('a vector column of more than 1,998 dimensions is refused when the dataset is constructed', () => {
  const destination = new SqlServerDestination({
    login: 'Server=none;Database=none',
  });
  assert.throws(
    () =>
      new ComputedDataset({
        into: destination,
        name: 'measures',
        description: 'The vector of each record.',
        from: [],
        compute: new Measure(1999),
      }),
    new TypeError(
      'The vector column vector has 1999 dimensions; a float32 VECTOR of SQL Server holds at most 1998',
    ),
  );
});

// A rule that only names its columns: the dataset checks them when it is
// constructed, before any input reaches compute.
class NamedColumns extends Rule<string, RuleColumns> {
  override readonly key = { name: 'ref', description: 'The input.' };
  override readonly output: RuleColumns;
  override readonly batch = 1;
  override readonly concurrency = 1;

  constructor(output: readonly string[]) {
    super();
    this.output = Object.fromEntries(
      output.map((name) => [name, { type: 'text', description: name }]),
    );
  }

  override read() {
    return null;
  }

  override async identity() {
    return null;
  }

  override async compute() {
    return [];
  }
}

for (const [column, taken, owner] of [
  ['replaced_in', 'replaced_in', 'the column its history adds'],
  ['Committed_In', 'committed_in', 'in another case, as SQL Server compares'],
  ['status', 'status', 'an engine column'],
  ['ref', 'ref', 'the key column'],
  ['_elt_row', '_elt_row', 'the row number of the raw table'],
  ['_elt_row_hash', '_elt_row_hash', 'the row hash of the raw table'],
  ['_ELT_KEY_HASH', '_elt_key_hash', 'the key hash of the raw table'],
] as const)
  test(`a rule output column named ${column}, ${owner}, is refused when the dataset is constructed`, () => {
    assert.throws(
      () =>
        new ComputedDataset({
          into: new SqlServerDestination({
            login: 'Server=none;Database=none',
          }),
          name: 'measures',
          description: 'The text of each record.',
          from: [],
          compute: new NamedColumns(['content', column]),
        }),
      new TypeError(
        `Computed dataset measures cannot have the column ${column}: the dataset already has the column ${taken}`,
      ),
    );
  });
