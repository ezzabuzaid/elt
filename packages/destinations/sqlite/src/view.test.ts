import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  PipelineError,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import { SQLiteDestination, SQLiteSyncHistory, View } from './index.ts';

// Records with ids, loaded into raw_records and read through records; it
// fails every read while failing is set.
class Records extends Source {
  readonly identity = 'records';
  failing = false;
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
  readonly ids: readonly string[];

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

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(configuration: CopyConfiguration) {
    if (this.failing) throw new Error('the store is gone');
    for (const id of this.ids)
      yield { stream: configuration.stream.name, data: { id } };
  }
}

function recordsPipeline(path: string, source: Records, sql: string) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [
          new Copy(
            source.records,
            destination.table('raw_records').withReaderView('records'),
          ),
        ],
      }),
    ],
    derived: [
      new View({
        into: destination,
        name: 'record_count',
        description: 'How many records loaded.',
        columns: { n: 'Number of records.' },
        sql,
      }),
    ],
  });
}

// The sqlite3 shell agents read with.
function shell(database: string, sql: string) {
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database, sql],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr };
}

const views = (path: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name")
    .all()
    .map(({ name }) => String(name));
};

const schemaVersion = (path: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database.prepare('PRAGMA schema_version').get()?.schema_version;
};

test('a view a pipeline declares appears once the tables it reads have loaded, with its columns in the catalog, and a run that changes nothing leaves it as it was', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const pipeline = recordsPipeline(
    path,
    new Records(['r1', 'r2']),
    'SELECT count(*) AS n FROM records',
  );

  await pipeline.run();
  const version = schemaVersion(path);
  await pipeline.run();

  assert.deepEqual(shell(path, 'SELECT n FROM record_count').rows, [{ n: 2 }]);
  assert.deepEqual(
    shell(
      path,
      "SELECT kind, name, description FROM catalog WHERE name LIKE 'record_count%' ORDER BY name",
    ).rows,
    [
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
  );
  assert.equal(schemaVersion(path), version);
});

test('a view that reads a table no copy of the pipeline makes fails the run with the error of SQLite, after the copies loaded', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const pipeline = recordsPipeline(
    path,
    new Records(['r1']),
    'SELECT count(*) AS n FROM recordz',
  );

  const error = await pipeline.run().then(
    () => assert.fail('the run reported nothing'),
    (error: unknown) => error,
  );

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(error instanceof Error);
  assert.match(error.message, /no such table: (main\.)?recordz/);
  assert.deepEqual(shell(path, 'SELECT id FROM records').rows, [{ id: 'r1' }]);
  assert.equal(views(path).includes('record_count'), false);
});

test('a view whose input has not loaded yet stays absent, and appears with the run that loads it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const source = new Records(['r1']);
  const pipeline = recordsPipeline(
    path,
    source,
    'SELECT count(*) AS n FROM records',
  );
  source.failing = true;

  const failed = await pipeline.run().then(
    () => assert.fail('the copy reported no failure'),
    (error: unknown) => error,
  );
  const before = views(path);
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError);
  assert.equal(before.includes('record_count'), false);
  assert.deepEqual(shell(path, 'SELECT n FROM record_count').rows, [{ n: 1 }]);
});

test('a view that reads a view still waiting for its copy waits too, and both appear with the run that loads the copy', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const source = new Records(['r1', 'r2']);
  const destination = new SQLiteDestination({ path });
  const pipeline = new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [
          new Copy(
            source.records,
            destination.table('raw_records').withReaderView('records'),
          ),
        ],
      }),
    ],
    derived: [
      new View({
        into: destination,
        name: 'record_count',
        description: 'How many records loaded.',
        columns: { n: 'Number of records.' },
        sql: 'SELECT count(*) AS n FROM raw_records',
      }),
      new View({
        into: destination,
        name: 'record_load',
        description: 'Whether more than one record loaded.',
        columns: { many: 'Whether more than one record loaded.' },
        sql: 'SELECT n > 1 AS many FROM record_count',
      }),
    ],
  });
  source.failing = true;

  const failed = await pipeline.run().then(
    () => assert.fail('the copy reported no failure'),
    (error: unknown) => error,
  );
  const before = views(path);
  source.failing = false;
  await pipeline.run();

  assert.ok(failed instanceof PipelineError, String(failed));
  assert.deepEqual(
    before.filter((name) => name.startsWith('record_')),
    [],
  );
  assert.deepEqual(shell(path, 'SELECT many FROM record_load').rows, [
    { many: 1 },
  ]);
});

test('a view that reads a view declared after it fails the run with the error of SQLite', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const source = new Records(['r1', 'r2']);
  const destination = new SQLiteDestination({ path });
  const pipeline = new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [
          new Copy(
            source.records,
            destination.table('raw_records').withReaderView('records'),
          ),
        ],
      }),
    ],
    derived: [
      new View({
        into: destination,
        name: 'record_load',
        description: 'Whether more than one record loaded.',
        columns: { many: 'Whether more than one record loaded.' },
        sql: 'SELECT n > 1 AS many FROM record_count',
      }),
      new View({
        into: destination,
        name: 'record_count',
        description: 'How many records loaded.',
        columns: { n: 'Number of records.' },
        sql: 'SELECT count(*) AS n FROM raw_records',
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('the run reported nothing'),
    (error: unknown) => error,
  );

  assert.ok(!(error instanceof PipelineError), String(error));
  assert.ok(error instanceof Error);
  assert.match(error.message, /no such table: (main\.)?record_count/);
  assert.equal(views(path).includes('record_load'), false);
});

test('under a watch, a view that reads a view still waiting for its copy waits too, and the watch goes on to its end', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const source = new Records(['r1']);
  const destination = new SQLiteDestination({ path });
  const pipeline = new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'records',
        source,
        destination,
        steps: [
          new Copy(
            source.records,
            destination.table('raw_records').withReaderView('records'),
          ),
        ],
      }),
    ],
    derived: [
      new View({
        into: destination,
        name: 'record_count',
        description: 'How many records loaded.',
        columns: { n: 'Number of records.' },
        sql: 'SELECT count(*) AS n FROM raw_records',
      }),
      new View({
        into: destination,
        name: 'record_load',
        description: 'Whether more than one record loaded.',
        columns: { many: 'Whether more than one record loaded.' },
        sql: 'SELECT n > 1 AS many FROM record_count',
      }),
    ],
  });
  source.failing = true;
  const controller = new AbortController();

  const watching = pipeline.watch({ signal: controller.signal });
  const pass = await watching.next();
  // The source watches once, so the watch ends after that pass's refresh.
  const end = await watching.next();

  assert.equal(pass.done, false);
  assert.equal(end.done, true);
  assert.deepEqual(
    views(path).filter((name) => name.startsWith('record_')),
    [],
  );
});

test('under a watch, a view appears after the pass that loads its input, without holding the pass back', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-view-'));
  const path = join(scratch.path, 'data.sqlite');
  const pipeline = recordsPipeline(
    path,
    new Records(['r1', 'r2']),
    'SELECT count(*) AS n FROM records',
  );
  const controller = new AbortController();

  const watching = pipeline.watch({ signal: controller.signal });
  const pass = await watching.next();
  for (let tries = 0; !views(path).includes('record_count'); tries++) {
    if (tries > 200) assert.fail('the view never appeared');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await watching.return(undefined);

  assert.equal(pass.done, false);
  assert.deepEqual(shell(path, 'SELECT n FROM record_count').rows, [{ n: 2 }]);
});
