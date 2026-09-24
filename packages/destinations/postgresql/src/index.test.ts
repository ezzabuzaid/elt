import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  SQLiteCheckpointStore,
  Stream,
} from 'elt';
import postgres from 'postgres';
import { PostgresDestination } from './index.ts';

const server =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

// A database of its own for one test, dropped when the test ends.
async function scratchDatabase() {
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  const name = `elt_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(server).host} is unavailable. Start it with: docker compose -f infra/docker-compose.yml up -d --wait`,
      { cause },
    );
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  const sql = postgres(url.href, { max: 2, onnotice: () => {} });
  return {
    url: url.href,
    sql,
    async [Symbol.asyncDispose]() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

// Emits whatever the test sets on `messages`, then an empty checkpoint.
class Messages extends Source {
  messages: SourceMessage[] = [];
  extracted = 0;
  protected readonly catalog: Catalog;
  constructor(
    readonly stream: Stream,
    readonly identity = 'test',
  ) {
    super();
    this.catalog = new Catalog([stream]);
  }
  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }
  protected override async *extract(configuration: CopyConfiguration) {
    this.extracted++;
    yield* this.messages;
    if (configuration.syncMode === 'incremental')
      yield { type: 'STATE' as const, stream: this.stream.name, state: {} };
  }
}

const rows = (stream: Stream, data: readonly object[]): SourceMessage[] =>
  data.map((row) => ({ stream: stream.name, data: row }));

test('a copy creates its schema and a table typed from the stream schema', async () => {
  await using database = await scratchDatabase();
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: ['number', 'null'] },
        done: { type: 'boolean' },
        on: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        note: { type: 'string' },
      },
      required: ['id', 'count', 'ratio', 'done', 'on', 'at'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [
    {
      id: 'a',
      count: 9007199254740991,
      ratio: 0.25,
      done: true,
      on: '2024-02-29',
      at: '2025-01-02T03:04:05.006Z',
      note: 'x',
    },
    {
      id: 'b',
      count: -1,
      ratio: null,
      done: false,
      on: '2025-12-31',
      at: '2025-01-02T00:00:00.000Z',
    },
  ]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'Raw Source',
  });

  const [result] = await new Pipeline({
    source,
    destination,
    steps: [new Copy(stream, destination.table('Items'))],
  }).run();

  assert.equal(result?.count, 2);
  assert.deepEqual(
    await database.sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'Raw Source' AND table_name = 'Items' ORDER BY ordinal_position`.then(
      (columns) => columns.map((column) => ({ ...column })),
    ),
    [
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'count', data_type: 'bigint', is_nullable: 'NO' },
      {
        column_name: 'ratio',
        data_type: 'double precision',
        is_nullable: 'YES',
      },
      { column_name: 'done', data_type: 'boolean', is_nullable: 'NO' },
      { column_name: 'on', data_type: 'date', is_nullable: 'NO' },
      {
        column_name: 'at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      { column_name: 'note', data_type: 'text', is_nullable: 'YES' },
      {
        column_name: 'loaded_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
    ],
  );
  assert.deepEqual(
    await database.sql`SELECT id, count::text, ratio, done, "on"::text, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, note, loaded_at = min(loaded_at) OVER () AS one_load FROM "Raw Source"."Items" ORDER BY id`.then(
      (loaded) => loaded.map((row) => ({ ...row })),
    ),
    [
      {
        id: 'a',
        count: '9007199254740991',
        ratio: 0.25,
        done: true,
        on: '2024-02-29',
        at: '2025-01-02T03:04:05.006Z',
        note: 'x',
        one_load: true,
      },
      {
        id: 'b',
        count: '-1',
        ratio: null,
        done: false,
        on: '2025-12-31',
        at: '2025-01-02T00:00:00.000Z',
        note: null,
        one_load: true,
      },
    ],
  );
  const identity = destination.identity(destination.table('Items'));
  assert.doesNotMatch(identity, /postgres:postgres|password/);
  assert.match(identity, /"schema":"Raw Source"/);
});

test('overwrite replaces rows while readers keep seeing the previous load', async () => {
  await using database = await scratchDatabase();
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const load = (source: Source) =>
    new Pipeline({
      source,
      destination,
      steps: [new Copy(stream, destination.table('items'))],
    }).run();
  const first = new Messages(stream);
  first.messages = rows(stream, [{ id: 'old-1' }, { id: 'old-2' }]);
  await load(first);

  let seenDuringLoad: string[] = [];
  class Slow extends Messages {
    protected override async *extract(configuration: CopyConfiguration) {
      yield* super.extract(configuration);
      const reader = await database.sql.reserve();
      try {
        await reader`SET lock_timeout = '1s'`;
        seenDuringLoad = (
          await reader`SELECT id FROM raw.items ORDER BY id`
        ).map((row) => String(row.id));
      } finally {
        reader.release();
      }
    }
  }
  const second = new Slow(stream);
  second.messages = rows(stream, [{ id: 'new' }]);
  await load(second);

  assert.deepEqual(seenDuringLoad, ['old-1', 'old-2']);
  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.items`).map((row) => row.id),
    ['new'],
  );
});

test('append keeps every load', async () => {
  await using database = await scratchDatabase();
  const stream = new Stream({
    name: 'events',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [{ id: 'a' }]);
  const pipeline = new Pipeline({
    source,
    destination,
    steps: [
      new Copy(stream, destination.table('events'), {
        syncMode: 'full_refresh',
        destinationSyncMode: 'append',
      }),
    ],
  });

  await pipeline.run();
  await pipeline.run();

  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.events`).map((row) => row.id),
    ['a', 'a'],
  );
});

test('cursor_newer keeps the greatest cursor by byte order; replace keeps the newest extraction', async () => {
  await using database = await scratchDatabase();
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-pg-'));
  const stream = new Stream({
    name: 'versions',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['id', 'version', 'name'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const load = (
    table: string,
    dedupPolicy: 'cursor_newer' | 'replace',
    data: object[],
  ) => {
    const source = new Messages(stream);
    source.messages = rows(stream, data);
    return new Pipeline({
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(stream, destination.table(table), {
          id: table,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          cursorField: 'version',
          primaryKey: ['id'],
          dedupPolicy,
        }),
      ],
    }).run();
  };
  const names = async (table: string) =>
    Object.fromEntries(
      (
        await database.sql.unsafe(
          `SELECT id, name FROM raw.${table} ORDER BY id`,
        )
      ).map((row) => [row.id, row.name]),
    );
  // 'B' sorts before 'a' by bytes but after it in most locales.
  const first = [
    { id: 'x', version: 'a', name: 'x-first' },
    { id: 'x', version: 'B', name: 'x-older' },
    { id: 'x', version: 'a', name: 'x-tie' },
    { id: 'y', version: 'a', name: 'y-first' },
  ];

  await load('newer', 'cursor_newer', first);
  await load('newer', 'cursor_newer', [
    { id: 'y', version: 'b', name: 'y-second' },
    { id: 'x', version: 'B', name: 'x-replayed' },
  ]);
  await load('restated', 'replace', first);
  await load('restated', 'replace', [
    { id: 'y', version: 'B', name: 'y-restated' },
  ]);
  const many = Array.from({ length: 2500 }, (_, index) => ({
    id: String(index % 1200),
    version: 'v',
    name: `row-${index}`,
  }));
  await load('many', 'replace', many);

  assert.deepEqual(await names('newer'), { x: 'x-first', y: 'y-second' });
  assert.deepEqual(await names('restated'), {
    x: 'x-tie',
    y: 'y-restated',
  });
  const loaded = await names('many');
  assert.equal(Object.keys(loaded).length, 1200);
  assert.equal(loaded['0'], 'row-2400');
  // 1199 recurs at 2399, one batch later.
  assert.equal(loaded['1199'], 'row-2399');
});

test('deletions remove keyed rows in source order', async () => {
  await using database = await scratchDatabase();
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-pg-'));
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', format: 'date' },
        id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['day', 'id', 'name'],
    },
    primaryKey: ['day', 'id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  const source = new Messages(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [
      new Copy(stream, destination.table('items'), {
        id: 'items',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        primaryKey: ['day', 'id'],
      }),
    ],
  });
  source.messages = rows(stream, [
    { day: '2026-01-01', id: 1, name: 'one' },
    { day: '2026-01-01', id: 2, name: 'two' },
  ]);
  await pipeline.run();

  source.messages = [
    { stream: 'items', data: { day: '2026-01-01', id: 3, name: 'three' } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-01', id: 3 } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-01', id: 1 } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-02', id: 2 } },
  ];
  const [result] = await pipeline.run();

  assert.deepEqual(
    { count: result?.count, deleted: result?.deleted },
    { count: 1, deleted: 3 },
  );
  assert.deepEqual(
    (await database.sql`SELECT name FROM raw.items ORDER BY id`).map(
      (row) => row.name,
    ),
    ['two'],
  );
});

test('a source failure commits nothing: no table, rows or claim', async () => {
  await using database = await scratchDatabase();
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  class Failing extends Messages {
    protected override async *extract(configuration: CopyConfiguration) {
      yield* super.extract(configuration);
      throw new Error('source broke');
    }
  }
  const source = new Failing(stream);
  source.messages = rows(stream, [{ id: 'a' }]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });

  await assert.rejects(
    new Pipeline({
      source,
      destination,
      steps: [new Copy(stream, destination.table('items'))],
    }).run(),
    /source broke/,
  );

  assert.deepEqual(
    [...(await database.sql`SELECT to_regnamespace('raw') AS schema`)],
    [{ schema: null }],
  );
});

test('writers share a table only when each upserts by the same key over its own partitions', async () => {
  await using database = await scratchDatabase();
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-pg-'));
  const stream = new Stream({
    name: 'records',
    jsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        id: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['owner', 'id', 'version'],
    },
    primaryKey: ['owner', 'id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    partitionKey: ['owner'],
  });
  class Owned extends Messages {
    constructor(readonly owner: string) {
      super(stream, owner);
      this.messages = rows(stream, [{ owner, id: '1', version: 1 }]);
    }
    protected override partitions() {
      return [{ owner: this.owner }];
    }
  }
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const upsert = (id: string, source: Owned) =>
    new Pipeline({
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(stream, destination.table('records'), {
          id,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          cursorField: 'version',
          primaryKey: ['owner', 'id'],
        }),
      ],
    }).run();
  const late = new Owned('c');

  await upsert('a', new Owned('a'));
  await upsert('b', new Owned('b'));
  await assert.rejects(
    new Pipeline({
      source: late,
      destination,
      steps: [new Copy(stream, destination.table('records'))],
    }).run(),
    /is written by \{"copy":"a"\}.*\(overwrite for \[\{"owner":"c"\}\]\) cannot share it/,
  );
  await assert.rejects(upsert('again', new Owned('a')), /cannot share it/);

  assert.equal(late.extracted, 0);
  assert.deepEqual(
    (await database.sql`SELECT owner FROM raw.records ORDER BY owner`).map(
      (row) => row.owner,
    ),
    ['a', 'b'],
  );
  await database.sql`DROP TABLE raw.records`;
  await new Pipeline({
    source: late,
    destination,
    steps: [new Copy(stream, destination.table('records'))],
  }).run();
  assert.equal(late.extracted, 1);
});

test('an existing key column of another type is refused, and a changed key rebuilds the index', async () => {
  await using database = await scratchDatabase();
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['id', 'kind', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [
    { id: '1', kind: 'a', version: 1 },
    { id: '1', kind: 'b', version: 1 },
  ]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const dedup = (primaryKey: string[]) =>
    new Pipeline({
      source,
      destination,
      steps: [
        new Copy(stream, destination.table('items'), {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
          cursorField: 'version',
          primaryKey,
        }),
      ],
    }).run();
  const indexes = async () =>
    (
      await database.sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'raw' AND tablename = 'items' AND indexname LIKE '\_mac\_elt\_dedup\_%'`
    ).map((row) => String(row.indexdef).replace(/^.* USING btree /, ''));

  await dedup(['id', 'kind']);
  assert.deepEqual(await indexes(), ['(id, kind)']);
  await dedup(['id']);
  assert.deepEqual(await indexes(), ['(id)']);

  await database.sql`DROP TABLE raw.items`;
  await database.sql`CREATE TABLE raw.items (id bigint, kind text, version bigint, loaded_at timestamptz NOT NULL)`;
  await assert.rejects(dedup(['id']), /incompatible storage type/);
});

test('declarations are checked before any connection', () => {
  const url = 'postgres://u:p@127.0.0.1:1/db';
  assert.throws(
    () => new PostgresDestination({ url: 'mysql://x/y', schema: 'raw' }),
    /postgres:\/\/ connection URL/,
  );
  assert.throws(
    () => new PostgresDestination({ url, schema: 'pg_raw' }),
    /reserved/,
  );
  const destination = new PostgresDestination({ url, schema: 'raw' });
  assert.throws(() => destination.table('_MAC_ELT_writers'), /reserved/);
  assert.throws(() => destination.table('x'.repeat(64)), /Invalid table name/);
  assert.throws(
    () => destination.table('items', (columns) => [columns.text('loaded_at')]),
    /reserved/,
  );
  assert.doesNotMatch(JSON.stringify(destination), /u:p/);
});
