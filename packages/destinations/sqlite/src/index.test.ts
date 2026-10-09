import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, on, once } from 'node:events';
import { rmSync } from 'node:fs';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type Destination,
  type FileContent,
  LocalFiles,
  type Partition,
  Pipeline,
  PipelineError,
  type Properties,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
  StreamChangeError,
  StreamStatus,
  type Target,
  TargetOwnedError,
  diffGroupedSnapshot,
  diffSnapshot,
  expiredAfter,
} from '@workspace/elt';

import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from './index.ts';

test('the public ELT API copies source records into SQLite', async () => {
  class TestSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'test';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });

    protected readonly catalog = new Catalog([this.records]);

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'record-1', name: 'Test record' },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-test-'));
  const source = new TestSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'records.sqlite'),
  });
  const copy = new Copy(source.records, destination.table('records'));
  const results = await new Pipeline({
    connections: [
      new Connection({ name: 'test', source, destination, steps: [copy] }),
    ],
  }).run();

  assert.deepEqual(results, [{ copy, count: 1, deleted: 0 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const row = database.prepare('SELECT id, name FROM records').get();
  assert.ok(row);
  assert.deepEqual({ ...row }, { id: 'record-1', name: 'Test record' });
});

test('the macOS sqlite3 shell reads the catalog of a loaded file: every described view and column', async () => {
  class DescribedSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'described';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        description: 'Records a person kept.',
        properties: {
          id: { type: 'string', description: 'Record identifier.' },
          name: { type: 'string', description: 'What the person called it.' },
        },
        required: ['id', 'name'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });

    protected readonly catalog = new Catalog([this.records]);

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'record-1', name: 'Test record' },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-test-'));
  const source = new DescribedSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'records.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  await new Pipeline({
    connections: [
      new Connection({
        name: 'described',
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
    history,
  }).run();

  // The shell readers use; it refuses virtual tables inside a view.
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      destination.path,
      "SELECT kind, name, data_type, description FROM catalog WHERE name LIKE 'records%' OR name = 'stream_status.status' ORDER BY name",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  const rows = JSON.parse(stdout);
  assert.deepEqual(
    rows.map(({ kind, name }: { kind: string; name: string }) => [kind, name]),
    [
      ['view', 'records'],
      ['column', 'records.id'],
      ['column', 'records.loaded_at'],
      ['column', 'records.name'],
      ['column', 'stream_status.status'],
    ],
  );
  const column = (name: string) =>
    rows.find((row: { name: string }) => row.name === name);
  assert.match(column('records').description, /Records a person kept\./);
  assert.deepEqual(
    { ...column('records.name') },
    {
      kind: 'column',
      name: 'records.name',
      data_type: 'text',
      description: 'What the person called it.',
    },
  );
  assert.equal(column('records.loaded_at').data_type, 'timestamp');
  assert.ok(column('stream_status.status').description);
});

test('every name is sanitized as Airbyte does, around the names SQLite takes as one, and the catalog names each source field', async () => {
  const sha8 = (name: string) =>
    createHash('sha256').update(name).digest('hex').slice(0, 8);
  const long = 'z'.repeat(200);
  // Each field, in field order, and the column the documented rule gives it.
  // SQLite compares names without ASCII case, and keeps names of any length.
  const before: (readonly [string, string])[] = [
    ['id', 'id'],
    ['Order Items', 'Order_Items'],
    ['c  d', 'c_d'],
    ['x-y', 'x_y'],
    ['0th', '_0th'],
    ['', '_'],
    ['LOADED_AT', 'LOADED_AT_1'],
    ['_ELT_op', 'ELT_op'],
    ['Foo', 'Foo'],
    ['foo', 'foo_1'],
    ['spécial', 'special'],
    [long, long],
  ];
  const shaped = (names: readonly (readonly [string, string])[]) =>
    new Stream({
      name: 'odd',
      jsonSchema: {
        type: 'object',
        description: 'One row per odd record.',
        properties: Object.fromEntries(
          names.map(([field], index) => [
            field,
            { type: 'string', description: `Field ${index}.` },
          ]),
        ),
        required: names.map(([field]) => field),
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
    });
  const pair = (name: string) =>
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-names-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  const spaced = pair('spaced');
  const underscored = pair('underscored');
  const run = (names: readonly (readonly [string, string])[], pass: number) => {
    const odd = shaped(names);
    return new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new ScriptedSource([odd, spaced, underscored], {
            odd: [
              ...(pass === 2
                ? []
                : [
                    {
                      stream: 'odd',
                      data: Object.fromEntries(
                        names.map(([field]) => [field, `a:${field}`]),
                      ),
                    },
                  ]),
              checkpoint('odd', { pass }),
            ],
            spaced: [{ stream: 'spaced', data: { id: 'spaced' } }],
            underscored: [
              { stream: 'underscored', data: { id: 'underscored' } },
            ],
          }),
          destination,
          checkpoints,
          steps: [
            new Copy(
              odd,
              destination.table('_ELT_items').withReaderView('odd'),
              {
                id: 'odd',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
            new Copy(spaced, destination.table('dbo.a b'), {
              id: 'spaced',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
            new Copy(underscored, destination.table('dbo.a_b'), {
              id: 'underscored',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
          ],
        }),
      ],
      history,
    }).run();
  };
  const view = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT * FROM odd')
      .all()
      .map((row) => ({ ...row }));
  };

  await run(before, 1);
  const loaded = view();
  await run(before, 2);

  // Nothing changed upstream, so nothing was rewritten.
  assert.deepEqual(view(), loaded);
  const [row] = loaded;
  assert.deepEqual(
    before.map(([, column]) => row?.[column]),
    before.map(([field]) => `a:${field}`),
  );
  {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    const ids = (table: string) =>
      database
        .prepare(`SELECT id FROM "${table}"`)
        .all()
        .map(({ id }) => id);
    assert.deepEqual(ids(`ELT_items_${sha8('_ELT_items')}`), ['a:id']);
    assert.deepEqual(ids(`dbo_a_b_${sha8('dbo.a b')}`), ['spaced']);
    assert.deepEqual(ids(`dbo_a_b_${sha8('dbo.a_b')}`), ['underscored']);
  }
  const { stdout, stderr } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      destination.path,
      "SELECT name, data_type, description FROM catalog WHERE kind = 'column' AND name LIKE 'odd.%'",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  const described = new Map(
    JSON.parse(stdout).map(
      ({ name, description }: { name: string; description: string }) => [
        name,
        description,
      ],
    ),
  );
  assert.equal(
    JSON.parse(stdout).find(
      ({ name }: { name: string }) => name === 'odd.Order_Items',
    )?.data_type,
    'text',
  );
  for (const [index, [field, column]] of before.entries())
    assert.equal(
      described.get(`odd.${column}`),
      field === column
        ? `Field ${index}.`
        : `Field ${index}. Source field: ${JSON.stringify(field)}.`,
    );

  await run([...before, ['New Field', 'New_Field']], 3);

  const [reloaded] = view();
  assert.equal(reloaded?.New_Field, 'a:New Field');
  assert.equal(reloaded?.LOADED_AT_1, 'a:LOADED_AT');
});

test('array fields load as JSON arrays that SQLite checks and reads element by element', async () => {
  class ListSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'lists';
    readonly lists = new Stream({
      name: 'lists',
      jsonSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          counts: { type: 'array', items: { type: 'integer' } },
          words: { type: ['array', 'null'], items: { type: 'string' } },
          flags: { type: 'array', items: { type: 'boolean' } },
        },
        required: ['id', 'counts', 'words', 'flags'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });

    protected readonly catalog = new Catalog([this.lists]);

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'a', counts: [3, 1], words: ['b', 'a'], flags: [true] },
      };
      yield {
        stream: configuration.stream.name,
        data: { id: 'b', counts: [], words: null, flags: [] },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-lists-'));
  const source = new ListSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'lists.sqlite'),
  });
  const copy = new Copy(source.lists, destination.table('lists'));

  const results = await new Pipeline({
    connections: [
      new Connection({ name: 'test', source, destination, steps: [copy] }),
    ],
  }).run();

  assert.deepEqual(results, [{ copy, count: 2, deleted: 0 }]);
  {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare(
          "SELECT id, counts, words, flags, (SELECT group_concat(value, '+') FROM json_each(lists.counts)) AS summed FROM lists ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: 'a',
          counts: '[3,1]',
          words: '["b","a"]',
          flags: '[true]',
          summed: '3+1',
        },
        { id: 'b', counts: '[]', words: null, flags: '[]', summed: null },
      ],
    );
  }
  using writable = new DatabaseSync(destination.path);
  assert.throws(
    () => writable.exec("UPDATE lists SET counts = '{}' WHERE id = 'a'"),
    /CHECK constraint failed/,
  );
});

test('a source accepts only the stream objects from its own catalog', async () => {
  class OwnedSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'owned-test';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      supportedSyncModes: ['full_refresh'],
    });
    protected readonly catalog = new Catalog([this.records]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {}
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-owned-'));
  const source = new OwnedSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'owned.sqlite'),
  });
  const signal = new AbortController().signal;

  assert.deepEqual((await source.discover()).streams, [source.records]);
  for (const stream of [
    new Stream({ ...source.records }),
    new OwnedSource().records,
  ]) {
    assert.throws(
      () =>
        new Copy(stream, destination.table('records')).validate(
          source,
          destination,
        ),
      /not from this source's discovered catalog/,
    );
    await assert.rejects(
      source.watch({ streams: [stream], signal }).next(),
      /not from this source's discovered catalog/,
    );
  }
  new Copy(source.records, destination.table('records')).validate(
    source,
    destination,
  );
  assert.deepEqual(
    await source.watch({ streams: [source.records], signal }).next(),
    { value: [source.records], done: false },
  );
});

test('watch loads and checkpoints before yielding, coalesces edits during a load, and closes on break', async () => {
  const changes = new EventEmitter();
  const reads = new EventEmitter();
  let version = 1;
  const previousStates: unknown[] = [];
  class WatchingSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'watch-test';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer' } },
        required: ['id', 'version'],
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
    });
    readonly other = new Stream({ ...this.records, name: 'other' });

    protected readonly catalog = new Catalog([this.records, this.other]);

    protected override async *observe({ streams, signal }: SourceWatchOptions) {
      await using events = on(changes, 'change', { signal });
      yield streams;
      for await (const [affected] of events) yield affected;
    }

    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      previousStates.push(state);
      const current = version;
      reads.emit('read');
      yield {
        stream: configuration.stream.name,
        data: { id: 'record-1', version: current },
      };
      yield {
        type: 'STATE' as const,
        stream: configuration.stream.name,
        state: { version: current },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-watch-'));
  const source = new WatchingSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const copy = new Copy(source.records, destination.table('records'), {
    id: 'records',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
    primaryKey: ['id'],
  });
  const other = new Copy(source.other, destination.table('other'));
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy, other],
      }),
    ],
  });
  const controller = new AbortController();
  const watching = pipeline.watch({ signal: controller.signal });
  reads.once('read', () => {
    assert.equal(
      changes.listenerCount('change'),
      1,
      'subscribed before extraction',
    );
    version = 2;
    changes.emit('change', [source.records]);
    changes.emit('change', [source.records]);
  });
  assert.deepEqual((await watching.next()).value?.outcomes, [
    { copy, count: 1, deleted: 0, failures: [], cancelled: false },
    { copy: other, count: 1, deleted: 0, failures: [], cancelled: false },
  ]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  using state = new DatabaseSync(checkpoints.path, { readOnly: true });
  const loadedVersion = () =>
    database.prepare('SELECT version FROM records').get()?.version;
  const savedVersion = () =>
    JSON.parse(
      String(
        state
          .prepare('SELECT state FROM checkpoints WHERE id = ?')
          .get('records')?.state,
      ),
    ).state;
  assert.equal(loadedVersion(), 1);
  assert.deepEqual(savedVersion(), { version: 1 });
  assert.deepEqual((await watching.next()).value?.outcomes, [
    { copy, count: 1, deleted: 0, failures: [], cancelled: false },
  ]);
  assert.equal(loadedVersion(), 2);
  assert.deepEqual(savedVersion(), { version: 2 });
  assert.deepEqual(previousStates, [null, null, { version: 1 }]);

  // Changes received while the consumer is handling a result remain pending.
  version = 3;
  changes.emit('change', [source.records]);
  for await (const { outcomes } of watching) {
    assert.deepEqual(outcomes, [
      { copy, count: 1, deleted: 0, failures: [], cancelled: false },
    ]);
    assert.equal(loadedVersion(), 3);
    assert.deepEqual(savedVersion(), { version: 3 });
    break;
  }
  assert.equal(changes.listenerCount('change'), 0);
  assert.equal(changes.listenerCount('error'), 0);

  const restarted = pipeline.watch({ signal: controller.signal });
  await restarted.next();
  assert.deepEqual(previousStates.at(-2), { version: 3 });
  const idle = restarted.next();
  changes.emit('change', []);
  controller.abort();
  assert.deepEqual(await idle, { value: undefined, done: true });
  assert.equal(changes.listenerCount('change'), 0);

  // A batch that does not load is reported, and watching goes on, as a
  // schedule does after a failed sync.
  const failing = new AbortController();
  const failed = pipeline.watch({ signal: failing.signal });
  await failed.next();
  version = Number.NaN;
  changes.emit('change', [source.records]);
  const incomplete = await failed.next();
  if (incomplete.done) assert.fail('watching ended on a failed batch');
  assert.ok(
    incomplete.value.outcomes.some(({ failures }) => failures.length > 0),
    'the failed batch reports its failure',
  );
  assert.equal(loadedVersion(), 3);
  assert.deepEqual(savedVersion(), { version: 3 });
  assert.equal(changes.listenerCount('change'), 1);
  version = 4;
  changes.emit('change', [source.records]);
  const recovered = await failed.next();
  if (recovered.done) assert.fail('watching ended before the retry');
  assert.deepEqual(
    recovered.value.outcomes.map(({ failures }) => failures),
    [[]],
  );
  assert.equal(loadedVersion(), 4);
  failing.abort();
  assert.deepEqual(await failed.next(), { value: undefined, done: true });
  assert.equal(changes.listenerCount('change'), 0);

  version = 4;
  const broken = pipeline.watch({ signal: new AbortController().signal });
  await broken.next();
  const nativeError = new Error('Native watcher failed');
  changes.emit('error', nativeError);
  await assert.rejects(
    broken.next(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0].cause === nativeError,
  );
  assert.equal(changes.listenerCount('change'), 0);

  const unselected = pipeline.watch({ signal: new AbortController().signal });
  await unselected.next();
  changes.emit('change', [new Stream({ ...source.records, name: 'unknown' })]);
  await assert.rejects(unselected.next(), /unselected stream/);
  assert.equal(changes.listenerCount('change'), 0);

  version = 5;
  const stopping = new AbortController();
  const inFlight = pipeline.watch({ signal: stopping.signal });
  reads.once('read', () => stopping.abort());
  assert.deepEqual((await inFlight.next()).value?.outcomes, [
    { copy, count: 1, deleted: 0, failures: [], cancelled: false },
    { copy: other, count: 1, deleted: 0, failures: [], cancelled: false },
  ]);
  assert.equal(loadedVersion(), 5);
  assert.deepEqual(savedVersion(), { version: 5 });
  assert.deepEqual(await inFlight.next(), { value: undefined, done: true });
  assert.equal(changes.listenerCount('change'), 0);

  assert.deepEqual(
    await pipeline.watch({ signal: AbortSignal.abort() }).next(),
    { value: undefined, done: true },
  );
  const invalid = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy, copy],
      }),
    ],
  });
  await assert.rejects(
    invalid.watch({ signal: new AbortController().signal }).next(),
    /IDs must be distinct/,
  );
  assert.equal(changes.listenerCount('change'), 0);
});

test('a cursor inside the primary key is rejected unless the policy replaces', async () => {
  class MetricsSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'metrics-test';
    readonly metrics = new Stream({
      name: 'metrics',
      jsonSchema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          query: { type: 'string' },
          clicks: { type: 'number' },
        },
        required: ['date', 'query', 'clicks'],
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
    });

    protected readonly catalog = new Catalog([this.metrics]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { date: '2026-09-20', query: 'elt', clicks: 1 },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-policy-'));
  const source = new MetricsSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const guarded = {
    id: 'metrics',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'date',
    primaryKey: ['date', 'query'],
  } as const;
  // A Copy is a declaration; the pipeline validates it before extracting.
  // Each accepted selection needs its own id, because a checkpoint binding
  // covers the whole configuration.
  const validating = (
    name: string,
    modes: ConstructorParameters<typeof CopyConfiguration>[1] & { id?: string },
  ) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(source.metrics, destination.table(name), {
              ...modes,
              id: name,
            }),
          ],
        }),
      ],
    }).run();

  await assert.rejects(
    validating('guarded', guarded),
    /can never update a conflicting row/,
  );
  await assert.rejects(
    // @ts-expect-error -- 'newest' is not a DedupPolicy; validation must reject it
    validating('unknown', { ...guarded, dedupPolicy: 'newest' }),
    /Unsupported dedupPolicy/,
  );
  await assert.rejects(
    validating('misplaced', {
      syncMode: 'full_refresh',
      destinationSyncMode: 'overwrite',
      dedupPolicy: 'replace',
    }),
    /only for deduplication loading/,
  );
  // Replacing accepts the equal cursor, and a cursor outside the primary key
  // keeps guarding replay without any policy.
  assert.deepEqual(
    (await validating('replacing', { ...guarded, dedupPolicy: 'replace' })).map(
      ({ count }) => count,
    ),
    [1],
  );
  assert.deepEqual(
    (await validating('outside', { ...guarded, primaryKey: ['query'] })).map(
      ({ count }) => count,
    ),
    [1],
  );
});

test('replace loads a restated fact that cursor_newer discards', async () => {
  let clicks = 12;
  class RestatingSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'restating-test';
    readonly metrics = new Stream({
      name: 'metrics',
      jsonSchema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          query: { type: 'string' },
          clicks: { type: 'number' },
        },
        required: ['date', 'query', 'clicks'],
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
    });

    protected readonly catalog = new Catalog([this.metrics]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      // The same fact, re-extracted after the upstream restated its metrics.
      yield {
        stream: configuration.stream.name,
        data: { date: '2026-09-20', query: 'elt', clicks },
      };
      yield {
        type: 'STATE' as const,
        stream: configuration.stream.name,
        state: { date: '2026-09-20' },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-restate-'));
  const source = new RestatingSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const replacing = new Copy(source.metrics, destination.table('replacing'), {
    id: 'replacing',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'date',
    primaryKey: ['date', 'query'],
    dedupPolicy: 'replace',
  });
  // Same equal-cursor conflict, but guarded: the restatement is a no-op.
  const guarding = new Copy(source.metrics, destination.table('guarding'), {
    id: 'guarding',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'date',
    primaryKey: ['query'],
  });
  // A read copies each stream once, so each copy of metrics has its own pipeline.
  const run = async () => {
    const results = [];
    for (const copy of [replacing, guarding])
      results.push(
        await new Pipeline({
          connections: [
            new Connection({
              name: 'test',
              source,
              destination,
              checkpoints,
              steps: [copy],
            }),
          ],
        }).run(),
      );
    return results;
  };

  assert.deepEqual(await run(), [
    [{ copy: replacing, count: 1, deleted: 0 }],
    [{ copy: guarding, count: 1, deleted: 0 }],
  ]);
  clicks = 19;
  // The replay is accepted by both copies; only the policy decides the row.
  assert.deepEqual(await run(), [
    [{ copy: replacing, count: 1, deleted: 0 }],
    [{ copy: guarding, count: 1, deleted: 0 }],
  ]);

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const rows = (table: string) =>
    database
      .prepare(`SELECT date, query, clicks FROM ${table}`)
      .all()
      .map((row) => ({ ...row }));
  assert.deepEqual(rows('replacing'), [
    { date: '2026-09-20', query: 'elt', clicks: 19 },
  ]);
  assert.deepEqual(rows('guarding'), [
    { date: '2026-09-20', query: 'elt', clicks: 12 },
  ]);
});

test('deletions remove keyed rows from a deduplicating SQLite table', async () => {
  let messages: SourceMessage[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class DeletingSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'deleting-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
      yield { type: 'STATE' as const, stream: 'items', state: {} };
    }
  }
  const record = (id: string, name: string) => ({
    stream: 'items',
    data: { id, name },
  });
  const remove = (id: string) => ({
    type: 'DELETE' as const,
    stream: 'items',
    key: { id },
  });

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-delete-'));
  const source = new DeletingSource();
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination: sqlite,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(items, sqlite.table('items'), {
            id: 'sqlite',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const names = () => {
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    return database
      .prepare('SELECT name FROM items ORDER BY id')
      .all()
      .map((row) => row.name);
  };
  const runAll = async () =>
    (await pipeline.run()).map(({ count, deleted }) => ({ count, deleted }));

  messages = [record('a', 'A'), record('b', 'B'), record('c', 'C')];
  await runAll();
  // Operations apply in source order: b is deleted, re-added, then deleted again.
  messages = [
    remove('b'),
    record('b', 'B2'),
    remove('b'),
    remove('c'),
    record('a', 'A2'),
  ];
  assert.deepEqual(await runAll(), [{ count: 2, deleted: 3 }]);
  assert.deepEqual(names(), ['A2']);
  // At-least-once replay of the same operations leaves the table unchanged.
  assert.deepEqual(await runAll(), [{ count: 2, deleted: 3 }]);
  assert.deepEqual(names(), ['A2']);
});

test('deletion streams require keyed deduplicating copies and well-formed keys', async () => {
  const selectable = (overrides: object = {}) =>
    new Stream({
      name: 'items',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, rank: { type: 'integer' } },
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      ...overrides,
    });
  const items = selectable();
  let messages: SourceMessage[] = [];
  class DeletingSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'deleting-rules-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-delete-'));
  const source = new DeletingSource();
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const rejects = (
    options: Partial<ConstructorParameters<typeof Copy>[2]>,
    message: RegExp,
  ) =>
    assert.throws(
      () =>
        new Copy(items, sqlite.table('items'), {
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          id: 'items',
          ...options,
        }).validate(source, sqlite, checkpoints),
      message,
    );

  assert.throws(
    () => selectable({ supportedSyncModes: ['full_refresh'] }),
    /require incremental support/,
  );
  assert.throws(() => selectable({ primaryKey: [] }), /requires a primaryKey/);
  rejects(
    { destinationSyncMode: 'append', primaryKey: undefined },
    /require append_dedup/,
  );
  rejects(
    { primaryKey: ['rank'] },
    /defines its own primary key; omit primaryKey/,
  );
  rejects({ cursorField: 'rank' }, /defines its own cursor; omit cursorField/);
  rejects({ dedupPolicy: 'cursor_newer' }, /no cursor field to compare/);
  const copy = new Copy(items, sqlite.table('items'), {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    id: 'items',
  });
  assert.equal(copy.configuration.dedupPolicy, 'replace');

  const run = (to = copy) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints,
          steps: [to],
        }),
      ],
    }).run();
  for (const [key, message] of [
    [{}, /exactly its primary key/],
    [{ id: 'a', rank: 1 }, /exactly its primary key/],
    [{ id: 1 }, /DELETE for items has an invalid id|requires non-null string/],
    [{ id: '\uD800' }, /invalid id/],
  ] as const) {
    messages = [{ type: 'DELETE', stream: 'items', key }];
    await assert.rejects(run(), message);
  }
  // A full-refresh overwrite cannot apply a deletion, and a stream that does
  // not declare deletions cannot send one.
  messages = [{ type: 'DELETE', stream: 'items', key: { id: 'a' } }];
  await assert.rejects(
    run(new Copy(items, sqlite.table('snapshot'))),
    /Only deduplicating loads can apply deletions/,
  );
  const plain = new Stream({
    ...selectable(),
    sourceDefinedCursor: undefined,
    emitsDeletes: undefined,
  });
  class PlainSource extends DeletingSource {
    protected override readonly catalog = new Catalog([plain]);
  }
  await assert.rejects(
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new PlainSource(),
          destination: sqlite,
          steps: [new Copy(plain, sqlite.table('plain'))],
        }),
      ],
    }).run(),
    /Stream items does not emit deletions/,
  );
});

test('snapshot diffs load only changes, delete vanished keys and survive replay', async () => {
  let rows: Record<string, unknown>[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class SnapshotSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'snapshot-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffSnapshot(configuration.stream, rows, state);
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-snap-'));
  const source = new SnapshotSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
  const copy = new Copy(items, destination.table('items'), {
    id: 'items',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: statePath }),
        steps: [copy],
      }),
    ],
  });
  const table = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name, loaded_at FROM items ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  };
  const savedState = () => {
    using database = new DatabaseSync(statePath, { readOnly: true });
    return JSON.parse(
      String(database.prepare('SELECT state FROM checkpoints').get()?.state),
    ).state;
  };
  const names = () => table().map(({ id, name }) => `${id}:${name}`);

  rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
  const firstState = savedState();
  assert.deepEqual(Object.keys(firstState.snapshot), [
    '["a"]',
    '["b"]',
    '["c"]',
  ]);

  rows = [
    { name: 'A', id: 'a' },
    { id: 'b', name: 'B2' },
    { id: 'd', name: 'D' },
  ];
  // Key order does not matter: a stays unchanged; b changed, d added, c removed.
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 1 }]);
  assert.deepEqual(names(), ['a:A', 'b:B2', 'd:D']);

  const settled = table();
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  assert.deepEqual(table(), settled);

  // A checkpoint save that failed after commit replays the older state: the
  // diff re-applies the same upserts and deletions and lands on the same rows.
  {
    using state = new DatabaseSync(statePath);
    state
      .prepare('UPDATE checkpoints SET state = ?')
      .run(JSON.stringify(firstState));
  }
  await pipeline.run();
  assert.deepEqual(names(), ['a:A', 'b:B2', 'd:D']);

  rows = [
    { id: 'a', name: 'A' },
    { id: 'a', name: 'again' },
  ];
  // A failed read ends the stream with a failure the stage discards, never a
  // partial scan that would delete keys.
  const messages = await Array.fromAsync(
    source.read([copy.configuration], new Map()),
  );
  const failure = messages.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(failure instanceof StreamStatus);
  assert.match(String(failure.error), /returned key \["a"\] twice in one scan/);
  const plain = new Stream({
    ...items,
    sourceDefinedCursor: undefined,
    emitsDeletes: undefined,
  });
  await assert.rejects(
    Array.fromAsync(diffSnapshot(plain, [], null)),
    /must declare sourceDefinedCursor to diff snapshots/,
  );
});

test('a snapshot stream that emits no deletions keeps the rows of keys its upstream forgot', async () => {
  let rows: Record<string, unknown>[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  class ForgetfulSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'forgetful-snapshot-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffSnapshot(configuration.stream, rows, state);
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-forget-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const copy = new Copy(items, destination.table('items'), {
    id: 'items',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new ForgetfulSource(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [copy],
      }),
    ],
  });
  const names = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name FROM items ORDER BY id')
      .all()
      .map(({ id, name }) => `${id}:${name}`);
  };

  rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);

  rows = [
    { id: 'b', name: 'B2' },
    { id: 'c', name: 'C' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  assert.deepEqual(names(), ['a:A', 'b:B2', 'c:C']);

  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);

  // a left the snapshot when the upstream forgot it, so the state holds only
  // what the upstream keeps: a returning a loads again, though unchanged.
  rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B2' },
    { id: 'c', name: 'C' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 0 }]);
  assert.deepEqual(names(), ['a:A', 'b:B2', 'c:C']);
});

test('a grouped snapshot stream that emits no deletions keeps the rows of a group its upstream forgot', async () => {
  type Group = { key: string; rows: { id: string; name: string }[] };
  let groups: Group[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  class ForgetfulGroups extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'forgetful-grouped-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffGroupedSnapshot(
        configuration.stream,
        groups.map(({ key, rows }) => ({
          key,
          fingerprint: null,
          records: () => rows,
        })),
        state,
      );
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-forget-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const copy = new Copy(items, destination.table('items'), {
    id: 'items',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new ForgetfulGroups(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [copy],
      }),
    ],
  });
  const names = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name FROM items ORDER BY id')
      .all()
      .map(({ id, name }) => `${id}:${name}`);
  };

  groups = [
    { key: 'one', rows: [{ id: 'a', name: 'A' }] },
    { key: 'two', rows: [{ id: 'b', name: 'B' }] },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);

  groups = [{ key: 'two', rows: [{ id: 'b', name: 'B' }] }];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  assert.deepEqual(names(), ['a:A', 'b:B']);

  // one left the state with its group, so its return loads a again, though
  // unchanged.
  groups = [
    { key: 'one', rows: [{ id: 'a', name: 'A' }] },
    { key: 'two', rows: [{ id: 'b', name: 'B' }] },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 0 }]);
  assert.deepEqual(names(), ['a:A', 'b:B']);
});

test('grouped snapshot diffs keep unchanged groups without reading them, and still delete what no group produced', async () => {
  type Row = { id: string; name: string };
  type Group = { key: string; fingerprint: string | null; rows: Row[] };
  let groups: Group[] = [];
  const read: string[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class GroupedSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'grouped-snapshot-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffGroupedSnapshot(
        configuration.stream,
        groups.map(({ key, fingerprint, rows }) => ({
          key,
          fingerprint,
          records() {
            read.push(key);
            return rows;
          },
        })),
        state,
      );
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-group-'));
  const source = new GroupedSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const copy = new Copy(items, destination.table('items'), {
    id: 'items',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [copy],
      }),
    ],
  });
  const names = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, name FROM items ORDER BY id')
      .all()
      .map(({ id, name }) => `${id}:${name}`);
  };
  const run = async (next: Group[]) => {
    groups = next;
    read.length = 0;
    return await pipeline.run();
  };

  assert.deepEqual(
    await run([
      {
        key: 'one',
        fingerprint: 'v1',
        rows: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      },
      { key: 'two', fingerprint: 'v1', rows: [{ id: 'c', name: 'C' }] },
    ]),
    [{ copy, count: 3, deleted: 0 }],
  );

  // one is unchanged, so it is carried without a read even though its input
  // now says something else; two changed, and only its changed row loads.
  assert.deepEqual(
    await run([
      {
        key: 'one',
        fingerprint: 'v1',
        rows: [{ id: 'a', name: 'never read' }],
      },
      {
        key: 'two',
        fingerprint: 'v2',
        rows: [
          { id: 'c', name: 'C2' },
          { id: 'd', name: 'D' },
        ],
      },
    ]),
    [{ copy, count: 2, deleted: 0 }],
  );
  assert.deepEqual(read, ['two']);
  assert.deepEqual(names(), ['a:A', 'b:B', 'c:C2', 'd:D']);

  // A vanished group deletes its rows; a changed group deletes rows it no
  // longer produces; an unknown fingerprint is always read, and its
  // unchanged rows load nothing.
  assert.deepEqual(
    await run([
      { key: 'two', fingerprint: 'v3', rows: [{ id: 'c', name: 'C2' }] },
      { key: 'three', fingerprint: null, rows: [{ id: 'e', name: 'E' }] },
    ]),
    [{ copy, count: 1, deleted: 3 }],
  );
  assert.deepEqual(names(), ['c:C2', 'e:E']);
  assert.deepEqual(
    await run([
      { key: 'two', fingerprint: 'v3', rows: [] },
      { key: 'three', fingerprint: null, rows: [{ id: 'e', name: 'E' }] },
    ]),
    [{ copy, count: 0, deleted: 0 }],
  );
  assert.deepEqual(read, ['three']);

  // A row that moves to another group is compared with where it was, so an
  // unchanged row loads nothing and is not deleted.
  assert.deepEqual(
    await run([
      { key: 'two', fingerprint: 'v4', rows: [] },
      { key: 'three', fingerprint: null, rows: [{ id: 'e', name: 'E' }] },
      { key: 'four', fingerprint: 'v1', rows: [{ id: 'c', name: 'C2' }] },
    ]),
    [{ copy, count: 0, deleted: 0 }],
  );
  assert.deepEqual(names(), ['c:C2', 'e:E']);

  // A key a carried group already holds cannot come from another group, and a
  // group cannot appear twice: either fails the scan before it deletes anything.
  const failing: [Group[], RegExp][] = [
    [
      [
        { key: 'four', fingerprint: 'v1', rows: [] },
        { key: 'five', fingerprint: 'v1', rows: [{ id: 'c', name: 'C' }] },
      ],
      /returned key \["c"\] twice in one scan/,
    ],
    [
      [
        { key: 'four', fingerprint: 'v1', rows: [] },
        { key: 'four', fingerprint: 'v1', rows: [] },
      ],
      /returned group four twice in one scan/,
    ],
  ];
  for (const [scan, message] of failing)
    await assert.rejects(run(scan), message);
  assert.deepEqual(names(), ['c:C2', 'e:E']);
  assert.deepEqual(
    await run([
      { key: 'three', fingerprint: null, rows: [{ id: 'e', name: 'E' }] },
      { key: 'four', fingerprint: 'v1', rows: [] },
    ]),
    [{ copy, count: 0, deleted: 0 }],
  );
});

test('an expiring stream keeps the rows its upstream expired and deletes only what vanished after the horizon', async () => {
  type Row = { id: string; seenAt: string };
  type Group = { key: string; fingerprint: string; rows: Row[] };
  let scan: { horizon: string; groups: Group[] } = { horizon: '', groups: [] };
  const fields = {
    id: { type: 'string' },
    seenAt: { type: 'string', format: 'date-time' },
  } as const;
  const declaration = {
    jsonSchema: { type: 'object', properties: fields },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
    expiresBy: 'seenAt',
  } as const;
  const events = new Stream({ name: 'events', ...declaration });
  const grouped = new Stream({ name: 'grouped', ...declaration });
  class ExpiringSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'expiring-test';
    protected readonly catalog = new Catalog([events, grouped]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      if (configuration.stream === events)
        yield* diffSnapshot(
          events,
          scan.groups.flatMap(({ rows }) => rows),
          state,
          { covers: expiredAfter(scan.horizon) },
        );
      else
        yield* diffGroupedSnapshot(
          grouped,
          scan.groups.map(({ key, fingerprint, rows }) => ({
            key,
            fingerprint,
            records: () => rows,
          })),
          state,
          { covers: expiredAfter(scan.horizon) },
        );
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-expire-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
  const copies = [events, grouped].map(
    (stream) =>
      new Copy(stream, destination.table(stream.name), {
        id: stream.name,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      }),
  );
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new ExpiringSource(),
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: statePath }),
        steps: copies,
      }),
    ],
  });
  const loaded = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(`SELECT id FROM ${table} ORDER BY id`)
      .all()
      .map(({ id }) => id);
  };
  const remembered = () => {
    using database = new DatabaseSync(statePath, { readOnly: true });
    const states = database
      .prepare('SELECT id, state FROM checkpoints ORDER BY id')
      .all()
      .map(({ state }) => JSON.parse(String(state)).state);
    return [
      Object.keys(states[0].snapshot),
      Object.values<{ snapshot: object }>(states[1].groups).flatMap(
        ({ snapshot }) => Object.keys(snapshot),
      ),
    ];
  };
  const run = async (horizon: string, groups: Group[]) => {
    scan = { horizon, groups };
    return (await pipeline.run()).map(({ count, deleted }) => ({
      count,
      deleted,
    }));
  };
  const c = { id: 'c', seenAt: '2026-10-02T08:00:00.000Z' };
  const old = {
    key: 'old',
    fingerprint: 'v1',
    rows: [{ id: 'a', seenAt: '2026-09-01T08:00:00.000Z' }],
  };
  const recent = {
    key: 'recent',
    fingerprint: 'v1',
    rows: [{ id: 'b', seenAt: '2026-10-01T08:00:00.000Z' }, c],
  };

  assert.deepEqual(await run('2026-09-01T00:00:00.000Z', [old, recent]), [
    { count: 3, deleted: 0 },
    { count: 3, deleted: 0 },
  ]);

  // a vanished before the horizon, so it expired: its row stays and the
  // snapshot forgets it; b vanished after the horizon, so it was deleted.
  const later = { ...recent, fingerprint: 'v2', rows: [c] };
  assert.deepEqual(await run('2026-09-08T00:00:00.000Z', [later]), [
    { count: 0, deleted: 1 },
    { count: 0, deleted: 1 },
  ]);
  assert.deepEqual(loaded('events'), ['a', 'c']);
  assert.deepEqual(loaded('grouped'), ['a', 'c']);
  assert.deepEqual(remembered(), [['["c"]'], ['["c"]']]);

  // An expired key that turns up again, such as an event another device
  // synced late, loads as new.
  assert.deepEqual(await run('2026-09-08T00:00:00.000Z', [old, later]), [
    { count: 1, deleted: 0 },
    { count: 1, deleted: 0 },
  ]);
  assert.deepEqual(loaded('events'), ['a', 'c']);

  // A diff of an expiring stream needs to know what its scan covers, and
  // timestamps to expire by; the horizon it expires after is a timestamp.
  const failing: [() => AsyncIterable<unknown>, RegExp][] = [
    [
      () => diffSnapshot(events, [], null),
      /expires by seenAt, so its snapshot diff needs covers/,
    ],
    [
      () =>
        diffSnapshot(events, [{ id: 'x', seenAt: 'yesterday' }], null, {
          covers: expiredAfter(scan.horizon),
        }),
      /must carry seenAt as a timestamp to expire/,
    ],
  ];
  for (const [diff, message] of failing)
    await assert.rejects(Array.fromAsync(diff()), message);
  assert.throws(
    () => expiredAfter('yesterday'),
    /Expiry horizon yesterday is not a timestamp/,
  );
  for (const invalid of [
    { ...declaration, expiresBy: 'id' },
    { ...declaration, expiresBy: 'missing' },
    { ...declaration, emitsDeletes: undefined },
    {
      ...declaration,
      jsonSchema: {
        type: 'object',
        properties: {
          ...fields,
          seenAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  ] as const)
    assert.throws(
      () => new Stream({ name: 'invalid', ...invalid }),
      /expiresBy must name a non-null date-time property of a stream that emits deletions/,
    );
});

test('a read that covers part of a stream deletes the vanished rows it covers and keeps the rest', async () => {
  type Row = { channel: string; ts: string };
  // The ranges of each channel the upstream holds, as a cache holds the part
  // of a history it loaded: a row it no longer lists inside them was deleted.
  let scan: { held: Map<string, [string, string]>; rows: Row[] } = {
    held: new Map(),
    rows: [],
  };
  const covers = ({ key }: { key: Readonly<Record<string, unknown>> }) => {
    const range = scan.held.get(String(key.channel));
    return (
      range !== undefined &&
      String(key.ts) >= range[0] &&
      String(key.ts) <= range[1]
    );
  };
  const declaration = {
    jsonSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, ts: { type: 'string' } },
    },
    primaryKey: ['channel', 'ts'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  } as const;
  const messages = new Stream({ name: 'messages', ...declaration });
  const grouped = new Stream({ name: 'grouped', ...declaration });
  class CachedSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'cached-test';
    protected readonly catalog = new Catalog([messages, grouped]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      if (configuration.stream === messages)
        yield* diffSnapshot(messages, scan.rows, state, { covers });
      else
        yield* diffGroupedSnapshot(
          grouped,
          [...new Set(scan.rows.map(({ channel }) => channel))].map(
            (channel) => ({
              key: channel,
              fingerprint: null,
              records: () => scan.rows.filter((row) => row.channel === channel),
            }),
          ),
          state,
          { covers },
        );
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-covers-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new CachedSource(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [messages, grouped].map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
  const loaded = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(`SELECT channel || ts AS id FROM ${table} ORDER BY id`)
      .all()
      .map(({ id }) => id);
  };
  const run = async (held: [string, [string, string]][], rows: Row[]) => {
    scan = { held: new Map(held), rows };
    return (await pipeline.run()).map(({ count, deleted }) => ({
      count,
      deleted,
    }));
  };
  const row = (channel: string, ts: string) => ({ channel, ts });

  assert.deepEqual(
    await run(
      [
        ['A', ['1', '3']],
        ['B', ['1', '1']],
      ],
      [row('A', '1'), row('A', '2'), row('A', '3'), row('B', '1')],
    ),
    [
      { count: 4, deleted: 0 },
      { count: 4, deleted: 0 },
    ],
  );

  // A1 left the held range and B is no longer held, so both stay; A2
  // vanished inside the range the upstream still holds, so it was deleted.
  assert.deepEqual(await run([['A', ['2', '3']]], [row('A', '3')]), [
    { count: 0, deleted: 1 },
    { count: 0, deleted: 1 },
  ]);
  assert.deepEqual(loaded('messages'), ['A1', 'A3', 'B1']);
  assert.deepEqual(loaded('grouped'), ['A1', 'A3', 'B1']);

  // A stream whose upstream forgets records rather than deleting them takes
  // no covers: none of its vanished rows is ever deleted.
  await assert.rejects(
    Array.fromAsync(
      diffSnapshot(
        new Stream({ ...messages, emitsDeletes: undefined }),
        [],
        null,
        { covers },
      ),
    ),
    /emits no deletions, so its snapshot diff takes no covers/,
  );
  // An expiring upstream's read covers what vanished at or after its horizon.
  const covered = expiredAfter('2026-09-08T00:00:00.000Z');
  assert.equal(
    covered({ key: {}, expiresBy: '2026-09-08T00:00:00.000Z' }),
    true,
  );
  assert.equal(
    covered({ key: {}, expiresBy: '2026-09-07T23:59:59.999Z' }),
    false,
  );
});

test('a target has one writer, even when another loads only its own partitions', async () => {
  class Records extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    extracted = 0;
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'integer' },
        },
        required: ['owner', 'id', 'name', 'version'],
      },
      primaryKey: ['owner', 'id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      partitionKey: ['owner'],
    });
    protected readonly catalog = new Catalog([this.records]);
    readonly identity: string;
    readonly owner: string;
    constructor(identity: string, owner: string) {
      super();
      this.identity = identity;
      this.owner = owner;
    }
    protected override partitions() {
      return [{ owner: this.owner }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      this.extracted++;
      yield {
        stream: configuration.stream.name,
        data: { owner: this.owner, id: '1', name: this.identity, version: 1 },
      };
    }
  }
  const scenario = async <T extends Target>(
    destination: Destination<T>,
    target: () => T,
    checkpoints: SQLiteCheckpointStore,
    loaded: () => Promise<number>,
  ) => {
    const upsert = (id: string, source: Records) =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            checkpoints,
            steps: [
              new Copy(source.records, target(), {
                id,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
                cursorField: 'version',
              }),
            ],
          }),
        ],
      }).run();
    const other = new Records('b', 'b');
    const late = new Records('late', 'c');

    await upsert('a', new Records('a', 'a'));
    await upsert('a', new Records('a', 'a'));
    await assert.rejects(
      upsert('b', other),
      /Target records is written by \{"copy":"a"\}; \{"copy":"b"\} cannot write it/,
    );
    await assert.rejects(
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source: late,
            destination,
            steps: [new Copy(late.records, target())],
          }),
        ],
      }).run(),
      /\{"source":"late","stream":"records"\} cannot write it/,
    );

    assert.equal(other.extracted + late.extracted, 0);
    assert.equal(await loaded(), 1);
  };

  {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-own-'));
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'out.sqlite'),
    });
    await scenario(
      destination,
      () => destination.table('records'),
      new SQLiteCheckpointStore({ path: join(scratch.path, 'state.sqlite') }),
      async () => {
        using database = new DatabaseSync(destination.path, { readOnly: true });
        return database.prepare('SELECT id FROM records').all().length;
      },
    );
  }
});

test('a writer may change its own mode, and dropping a target releases it', async () => {
  class Records extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer' } },
        required: ['id', 'version'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
    });
    protected readonly catalog = new Catalog([this.records]);
    readonly identity: string;
    constructor(identity: string) {
      super();
      this.identity = identity;
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: this.identity, version: 1 },
      };
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-own-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const first = new Records('first');
  const second = new Records('second');
  const overwrite = (source: Records) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(source.records, destination.table('Records'))],
        }),
      ],
    }).run();

  await overwrite(first);
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: first,
        destination,
        steps: [
          new Copy(first.records, destination.table('records'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
            cursorField: 'version',
          }),
        ],
      }),
    ],
  }).run();
  await assert.rejects(
    overwrite(second),
    /Target Records is written by \{"source":"first","stream":"records"\}; \{"source":"second","stream":"records"\} cannot write it/,
  );
  {
    using database = new DatabaseSync(destination.path);
    database.exec('DROP TABLE records');
  }
  await overwrite(second);

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT id FROM records')
      .all()
      .map((row) => row.id),
    ['second'],
  );
  // A table named like elt's own leaves elt's `_elt_` names.
  assert.equal(
    destination.table('_ELT_writers').name,
    `ELT_writers_${createHash('sha256').update('_ELT_writers').digest('hex').slice(0, 8)}`,
  );
});

test('an explicit column naming a field the stream does not declare fails before any read', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-undeclared-'),
  );
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, 'Order Id': { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });

  await assert.rejects(
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new ScriptedSource([stream], {}),
          destination,
          steps: [
            new Copy(
              stream,
              // Order Id is declared and stored as Order_Id; Missing Field is not.
              destination.table('items', (c) => [
                c.text('id'),
                c.text('Order Id'),
                c.text('Missing Field'),
              ]),
              {
                id: 'items',
                syncMode: 'full_refresh',
                destinationSyncMode: 'overwrite',
              },
            ),
          ],
        }),
      ],
    }).run(),
    /Stream items does not describe field Missing Field/,
  );
});

test('a table refuses two columns of one field, and a reader view SQLite would take for the table', () => {
  const destination = new SQLiteDestination({
    path: '/nonexistent/out.sqlite',
  });

  assert.throws(
    () =>
      destination.table('items', (columns) => [
        columns.text('a'),
        columns.text('a'),
      ]),
    /Two columns hold one field/,
  );
  assert.throws(
    () => destination.table('Items').withReaderView('items'),
    /A reader view needs a name of its own/,
  );
});

test('a pipeline refuses two writers of one target before running any', async () => {
  let extracted = 0;
  class Records extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'records';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer' } },
        required: ['id', 'version'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
    });
    // The same shape under another name: a second stream for one target.
    readonly copies = new Stream({ ...this.records, name: 'copies' });
    protected readonly catalog = new Catalog([this.records, this.copies]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      extracted++;
      yield {
        stream: configuration.stream.name,
        data: { id: 'a', version: 1 },
      };
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-own-'));
  const source = new Records();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.records, destination.table('records'), {
            id: 'upsert',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
          }),
          new Copy(source.copies, destination.table('RECORDS'), {
            id: 'log',
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });

  const upsert = (id: string, stream: Stream) =>
    new Copy(stream, destination.table('records'), {
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    });
  // Two copies with the same key are still two writers.
  const twins = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [upsert('one', source.records), upsert('two', source.copies)],
      }),
    ],
  });
  // One read routes by stream, so a stream is copied once per pipeline.
  const doubled = () =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [upsert('one', source.records), upsert('two', source.records)],
        }),
      ],
    });

  await assert.rejects(
    pipeline.run(),
    /Target \S+#records is written by \{"copy":"upsert"\}; \{"copy":"log"\} cannot write it/,
  );
  await assert.rejects(
    twins.run(),
    /\{"copy":"one"\}; \{"copy":"two"\} cannot write it/,
  );
  await assert.rejects(
    doubled().run(),
    /Connection test copies each stream once/,
  );
  assert.equal(extracted, 0);
});

class Sites extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  readonly identity = 'sites';
  readonly received: [string, unknown][] = [];
  readonly pages = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        path: { type: 'string' },
        views: { type: 'integer' },
      },
      required: ['site', 'path', 'views'],
    },
    primaryKey: ['site', 'path'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
    partitionKey: ['site'],
  });
  protected readonly catalog = new Catalog([this.pages]);
  sites: string[];
  pagesOf: Record<string, Iterable<Record<string, unknown>>>;
  constructor(
    sites: string[],
    pagesOf: Record<string, Iterable<Record<string, unknown>>>,
  ) {
    super();
    this.sites = sites;
    this.pagesOf = pagesOf;
  }
  protected override partitions() {
    return this.sites.map((site) => ({ site }));
  }
  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }
  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
  ) {
    const site = String(partition?.site);
    this.received.push([site, state]);
    const pages = this.pagesOf[site];
    if (pages === undefined) throw new Error(`site ${site} is down`);
    yield* diffSnapshot(configuration.stream, pages, state);
  }
}

test('a partitioned stream resumes each partition from its own state', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const page = (site: string, path: string, views = 1) => ({
    site,
    path,
    views,
  });
  const source = new Sites(['a', 'b'], {
    a: [page('a', '/1'), page('a', '/2')],
    b: [page('b', '/1')],
    c: [page('c', '/1')],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(source.pages, destination.table('pages'), {
    id: 'pages',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy],
      }),
    ],
  });
  const rows = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT site, path, views FROM pages ORDER BY site, path')
      .all()
      .map((row) => `${row.site}${row.path}=${row.views}`);
  };

  assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
  source.sites = ['a', 'c'];
  source.pagesOf.a = [page('a', '/1', 5)];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 1 }]);
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);

  const [a, , , c] = source.received;
  assert.deepEqual([a?.[1], c], [null, ['c', null]]);
  assert.deepEqual(
    source.received.slice(2).map(([site, state]) => [site, state === null]),
    [
      ['a', false],
      ['c', true],
      ['a', false],
      ['c', false],
    ],
  );
  // b left the partition list: its checkpoint is gone, its rows stay.
  assert.deepEqual(rows(), ['a/1=5', 'b/1=1', 'c/1=1']);
  using state = new DatabaseSync(checkpoints.path, { readOnly: true });
  const saved = state.prepare('SELECT state FROM checkpoints').get();
  assert.deepEqual(
    JSON.parse(String(saved?.state)).state.partitions.map(
      (entry: { partition: Partition }) => entry.partition,
    ),
    [{ site: 'a' }, { site: 'c' }],
  );
});

test('a failing partition loads nothing and keeps its checkpoint, while the other partitions commit', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const page = (site: string, path: string, views = 1) => ({
    site,
    path,
    views,
  });
  const source = new Sites(['a', 'b', 'c'], {
    a: [page('a', '/1')],
    b: [page('b', '/1'), page('b', '/2')],
    c: [page('c', '/1')],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const copy = new Copy(source.pages, destination.table('pages'), {
    id: 'pages',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy],
      }),
    ],
  });
  const rows = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT site, path, views FROM pages ORDER BY site, path')
      .all()
      .map((row) => `${row.site}${row.path}=${row.views}`);
  };
  const saved = () => {
    using state = new DatabaseSync(checkpoints.path, { readOnly: true });
    const { partitions } = JSON.parse(
      String(state.prepare('SELECT state FROM checkpoints').get()?.state),
    ).state;
    return new Map<string, unknown>(
      partitions.map((entry: { partition: Partition; state: unknown }) => [
        entry.partition.site,
        entry.state,
      ]),
    );
  };
  await pipeline.run();
  const before = saved();

  // a changes; b's scan breaks after one changed page; c emits a row of a.
  source.pagesOf.a = [page('a', '/1', 2)];
  source.pagesOf.b = (function* () {
    yield page('b', '/1', 9);
    throw new Error('scan of b broke');
  })();
  source.pagesOf.c = [page('a', '/stray')];
  const error = await pipeline.run().then(
    () => assert.fail('run should report the failed partitions'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.match(error.message, /pages \{"site":"b"\}: scan of b broke/);
  assert.match(
    error.message,
    /record for partition \{"site":"c"\} carries site "a"/,
  );
  const [result] = error.results;
  assert.deepEqual([result?.count, result?.deleted], [1, 0]);
  assert.deepEqual(
    result?.failures.map(({ partition }) => partition),
    [{ site: 'b' }, { site: 'c' }],
  );
  // b's half scan neither changed nor deleted anything.
  assert.deepEqual(rows(), ['a/1=2', 'b/1=1', 'b/2=1', 'c/1=1']);
  const after = saved();
  assert.notDeepEqual(after.get('a'), before.get('a'));
  assert.deepEqual(after.get('b'), before.get('b'));
  assert.deepEqual(after.get('c'), before.get('c'));

  source.pagesOf.b = [page('b', '/1', 9)];
  source.pagesOf.c = [page('c', '/1')];
  source.received.length = 0;
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 1 }]);
  assert.deepEqual(
    source.received.map(([site, state]) => [site, state === null]),
    [
      ['a', false],
      ['b', false],
      ['c', false],
    ],
  );
  assert.deepEqual(rows(), ['a/1=2', 'b/1=9', 'c/1=1']);
});

test('clear drops a target with its checkpoint, and a target dropped by hand reloads from no checkpoint', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const source = new Sites(['a'], { a: [{ site: 'a', path: '/', views: 1 }] });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const copy = (id: string) =>
    new Copy(source.pages, destination.table('pages'), {
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy('pages')],
      }),
    ],
  });
  const saved = () => {
    using state = new DatabaseSync(checkpoints.path, { readOnly: true });
    return state.prepare('SELECT id FROM checkpoints').all().length;
  };
  await pipeline.run();

  // Resuming from the checkpoint would load only what changed since it.
  {
    using database = new DatabaseSync(destination.path);
    database.exec('DROP TABLE pages');
  }
  source.received.length = 0;
  await pipeline.run();
  assert.deepEqual(source.received, [['a', null]]);
  const other = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy('other')],
      }),
    ],
  });
  await assert.rejects(other.clear(), TargetOwnedError);
  assert.equal(saved(), 1);

  await pipeline.clear();
  assert.equal(saved(), 0);
  source.received.length = 0;
  await pipeline.run();

  assert.deepEqual(source.received, [['a', null]]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.equal(database.prepare('SELECT * FROM pages').all().length, 1);
});

test('a full refresh whose partition fails keeps the previous table', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const source = new Sites(['a', 'b'], {
    a: [{ site: 'a', path: '/', views: 1 }],
    b: [{ site: 'b', path: '/', views: 1 }],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(source.pages, destination.table('pages'))],
      }),
    ],
  });
  const rows = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT site, views FROM pages ORDER BY site')
      .all()
      .map((row) => `${row.site}=${row.views}`);
  };
  await pipeline.run();

  source.pagesOf.a = [{ site: 'a', path: '/', views: 2 }];
  delete source.pagesOf.b;
  await assert.rejects(pipeline.run(), /pages \{"site":"b"\}: site b is down/);

  assert.deepEqual(rows(), ['a=1', 'b=1']);
});

test('partition declarations are validated before extraction', async () => {
  const stream = (partitionKey: string[]) =>
    new Stream({
      name: 'pages',
      jsonSchema: {
        type: 'object',
        properties: {
          site: { type: ['string', 'null'] },
          path: { type: 'string' },
        },
        required: ['site', 'path'],
      },
      primaryKey: ['site', 'path'],
      supportedSyncModes: ['full_refresh'],
      partitionKey,
    });
  assert.throws(() => stream(['views']), /distinct members of primaryKey/);
  assert.throws(
    () => stream(['site']),
    /requires one non-null scalar schema type/,
  );

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const read = async (sites: string[]) => {
    const source = new Sites(sites, { a: [] });
    return await Array.fromAsync(
      source.read(
        [
          new Copy(source.pages, destination.table('pages'), {
            id: 'pages',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }).configuration,
        ],
        new Map(),
      ),
    );
  };
  await assert.rejects(read([]), /requires at least one partition/);
  await assert.rejects(read(['a', 'a']), /lists partition \["a"\] twice/);

  const partitioned = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: { site: { type: 'string' }, path: { type: 'string' } },
      required: ['site', 'path'],
    },
    primaryKey: ['site', 'path'],
    supportedSyncModes: ['full_refresh'],
    partitionKey: ['site'],
  });
  // The stream's key includes its partition key, and a copy cannot narrow it.
  assert.throws(
    () =>
      new Copy(partitioned, destination.table('pages'), {
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite_dedup',
        dedupPolicy: 'replace',
        primaryKey: ['path'],
      }),
    /defines its own primary key; omit primaryKey/,
  );
});

class FileSource extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  readonly identity = 'file-test';
  readonly staging: string;
  contents: Record<string, { version: number; bytes: Uint8Array }>;
  // Whether records carry their file, which a target that stores none refuses.
  withFiles = true;
  readonly snapshot: boolean;
  readonly files: Stream;
  protected readonly catalog: Catalog;

  constructor(
    staging: string,
    contents: Record<string, { version: number; bytes: Uint8Array }>,
    snapshot = true,
  ) {
    super();
    this.staging = staging;
    this.contents = contents;
    this.snapshot = snapshot;
    this.files = new Stream({
      name: 'files',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer' } },
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
      primaryKey: ['id'],
      supportsFileTransfer: true,
      ...(snapshot ? { sourceDefinedCursor: true, emitsDeletes: true } : {}),
    });
    this.catalog = new Catalog([this.files]);
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ) {
    const scan = Object.entries(this.contents).map(([id, { version }]) => ({
      id,
      version,
    }));
    const messages =
      this.snapshot && configuration.syncMode === 'incremental'
        ? diffSnapshot(configuration.stream, scan, state)
        : scan.map((data) => ({ stream: 'files', data }));
    for await (const message of messages) {
      if ('type' in message || !this.withFiles) {
        yield message;
        continue;
      }
      const path = join(this.staging, `${message.data.id}.bin`);
      await writeFile(path, this.contents[message.data.id]?.bytes ?? '');
      yield { stream: 'files', data: message.data, file: path };
    }
  }
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// A file column's chunk table, by the documented rule: _elt_files_ and the
// first 40 hex digits of SHA-256 over the JSON of [table, column], both in
// ASCII lower case.
const chunkTable = (table: string, column: string) =>
  `"_elt_files_${createHash('sha256')
    .update(JSON.stringify([table.toLowerCase(), column.toLowerCase()]))
    .digest('hex')
    .slice(0, 40)}"`;

// Each loaded file's chunk sizes and reassembled hash, plus chunks no row references.
const storedFiles = (path: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  const chunks = database
    .prepare(
      `SELECT f.id, c.bytes FROM files f JOIN ${chunkTable('files', 'bytes')} c ON c.file = f.bytes ORDER BY f.id, c.n`,
    )
    .all()
    .map(({ id, bytes }) => {
      assert.ok(bytes instanceof Uint8Array);
      return { id: String(id), bytes };
    });
  const files = Object.fromEntries(
    [...Map.groupBy(chunks, (row) => row.id)].map(([id, rows]) => [
      id,
      {
        chunks: rows.map((row) => row.bytes.length),
        sha256: sha256(Buffer.concat(rows.map((row) => row.bytes))),
      },
    ]),
  );
  const orphans = database
    .prepare(
      `SELECT count(*) AS n FROM ${chunkTable('files', 'bytes')} WHERE file NOT IN (SELECT bytes FROM files WHERE bytes IS NOT NULL)`,
    )
    .get()?.n;
  return { files, orphans };
};

const fileTable = (destination: SQLiteDestination, source: FileSource) =>
  destination.table('files', (c) => [
    c.text('id'),
    c.integer('version'),
    c.blob('bytes').from(source.files.file),
  ]);

test('file bytes load as bounded chunks that leave with their row', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-files-'));
  const large = new Uint8Array(9 * 1024 * 1024 + 3).map((_, i) => i % 251);
  const small = Buffer.from('small');
  const source = new FileSource(scratch.path, {
    empty: { version: 1, bytes: new Uint8Array() },
    small: { version: 1, bytes: small },
    large: { version: 1, bytes: large },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'files.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.files, fileTable(destination, source), {
            id: 'files',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });

  await pipeline.run();
  const first = storedFiles(destination.path);
  source.contents = {
    small: { version: 2, bytes: Buffer.from('changed') },
    large: { version: 1, bytes: large },
  };
  await pipeline.run();
  const second = storedFiles(destination.path);

  const mib = 4 * 1024 * 1024;
  assert.deepEqual(first, {
    files: {
      empty: { chunks: [0], sha256: sha256(new Uint8Array()) },
      large: { chunks: [mib, mib, 1024 * 1024 + 3], sha256: sha256(large) },
      small: { chunks: [5], sha256: sha256(small) },
    },
    orphans: 0,
  });
  assert.deepEqual(second, {
    files: {
      large: first.files.large,
      small: { chunks: [7], sha256: sha256(Buffer.from('changed')) },
    },
    orphans: 0,
  });
});

test("an overwrite removes the previous load's files", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-files-'));
  const source = new FileSource(scratch.path, {
    a: { version: 1, bytes: Buffer.from('aye') },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'files.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(source.files, fileTable(destination, source))],
      }),
    ],
  });

  await pipeline.run();
  source.contents = { b: { version: 1, bytes: Buffer.from('bee') } };
  await pipeline.run();

  assert.deepEqual(storedFiles(destination.path), {
    files: { b: { chunks: [3], sha256: sha256(Buffer.from('bee')) } },
    orphans: 0,
  });
});

test('a record the cursor guard rejects leaves no stored file behind', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-files-'));
  const source = new FileSource(
    scratch.path,
    { a: { version: 2, bytes: Buffer.from('two') } },
    false,
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'files.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.files, fileTable(destination, source), {
            id: 'files',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
            dedupPolicy: 'cursor_newer',
          }),
        ],
      }),
    ],
  });

  await pipeline.run();
  source.contents = { a: { version: 1, bytes: Buffer.from('one') } };
  await pipeline.run();

  assert.deepEqual(storedFiles(destination.path), {
    files: { a: { chunks: [3], sha256: sha256(Buffer.from('two')) } },
    orphans: 0,
  });
});

// Each copy's checkpoint binding, its stream shape left out.
const bound = (copies: readonly (readonly [string, object])[]) =>
  new Map(copies.map(([id, copy]) => [id, { copy, shape: {} }]));

test('a checkpoint store keeps each acknowledged state, durable at once, and holds its lock for the run', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const path = join(scratch.path, 'state.sqlite');
  const store = new SQLiteCheckpointStore({ path });
  const bindings = bound([['copy', { source: 'test', target: 'records' }]]);
  const received: unknown[] = [];
  const run = (states: unknown[], fail = false) =>
    store.run(bindings, async (checkpoints) => {
      const state = checkpoints.state('copy');
      received.push(structuredClone(state));
      if (state !== null && typeof state === 'object')
        Reflect.set(state, 'mutated', true);
      for (const next of states) await checkpoints.save('copy', next, false);
      if (fail) throw new Error('source broke');
    });
  const saved = () => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database
      .prepare('SELECT state FROM checkpoints WHERE id = ?')
      .get('copy')?.state;
  };

  await run([{ page: 1 }, { page: 2 }]);
  // No acknowledgement keeps the saved state, even though the input was mutated.
  await run([]);
  // What was acknowledged before a failure stays saved.
  await assert.rejects(run([{ page: 3 }], true), /source broke/);
  await store.run(bindings, async (checkpoints) => {
    assert.deepEqual(checkpoints.state('copy'), { page: 3 });
    await checkpoints.save('copy', { page: 4 }, false);
    assert.equal(
      saved(),
      JSON.stringify({ state: { page: 4 }, reloading: false }),
    );
    await assert.rejects(
      store.run(bindings, async () => {}),
      /Checkpoint copy is in use by another run/,
    );
  });
  await run([]);

  assert.deepEqual(received, [null, { page: 2 }, { page: 2 }, { page: 4 }]);
});

test('replications checkpoint in parallel, and one already running is refused', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const path = join(scratch.path, 'state.sqlite');
  const store = new SQLiteCheckpointStore({ path });
  // A second store on the same file stands in for another process.
  const other = new SQLiteCheckpointStore({ path });
  const { promise: bothStarted, resolve: release } =
    Promise.withResolvers<void>();
  let started = 0;
  const waiting = (runner: SQLiteCheckpointStore, id: string) =>
    runner.run(bound([[id, {}]]), async (checkpoints) => {
      if (++started === 2) release();
      await bothStarted;
      await checkpoints.save(id, { done: true }, false);
    });

  // Both runs wait until the other has started, so both keys are held at once.
  await Promise.all([waiting(store, 'a'), waiting(other, 'b')]);
  const { promise: holding, resolve: held } = Promise.withResolvers<void>();
  const { promise: hold, resolve: finish } = Promise.withResolvers<void>();
  const running = store.run(bound([['b', {}]]), async () => {
    held();
    await hold;
  });
  await holding;
  // A run of a and b fails on b and releases a, which a later run can take.
  await assert.rejects(
    other.run(
      bound([
        ['a', {}],
        ['b', {}],
      ]),
      async () => {},
    ),
    /Checkpoint b is in use by another run/,
  );
  await other.run(bound([['a', {}]]), async () => {});
  finish();
  await running;

  assert.deepEqual(
    await store.run(
      bound([
        ['a', {}],
        ['b', {}],
      ]),
      async (checkpoints) => [checkpoints.state('a'), checkpoints.state('b')],
    ),
    [{ done: true }, { done: true }],
  );
});

test('one checkpoint run holds every copy of a run, each with its own state', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const store = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const bindings = bound([
    ['left', { target: 'left' }],
    ['right', { target: 'right' }],
  ]);

  await store.run(bindings, async (checkpoints) => {
    await checkpoints.save('left', { page: 1 }, false);
    await checkpoints.save('right', { page: 7 }, false);
  });
  const states = await store.run(bindings, async (checkpoints) => [
    checkpoints.state('left'),
    checkpoints.state('right'),
  ]);
  const unknown = store.run(bindings, async (checkpoints) =>
    checkpoints.state('other'),
  );

  assert.deepEqual(states, [{ page: 1 }, { page: 7 }]);
  await assert.rejects(unknown, /Checkpoint other is not part of this run/);
});

test('a changed binding is refused for its copy until the checkpoint is reset', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const store = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const save = (bindings: ReturnType<typeof bound>) =>
    store.run(bindings, async (checkpoints) => {
      for (const id of bindings.keys())
        await checkpoints.save(id, { from: checkpoints.state(id) }, false);
    });

  await save(
    bound([
      ['copy', { target: 'a' }],
      ['other', { target: 'x' }],
    ]),
  );
  const changed = store.run(
    bound([
      ['copy', { target: 'b' }],
      ['other', { target: 'x' }],
    ]),
    async (checkpoints) => {
      assert.deepEqual(checkpoints.state('other'), { from: null });
      return checkpoints.state('copy');
    },
  );

  await assert.rejects(
    changed,
    /Checkpoint binding changed for copy; reset it or use a new copy ID/,
  );
  await store.reset('copy');
  await store.run(bound([['copy', { target: 'b' }]]), async (checkpoints) =>
    assert.equal(checkpoints.state('copy'), null),
  );
});

// A stream of { id, version } rows keyed by id, deletable.
const scripted = (name: string, { snapshot = true } = {}) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: snapshot ? true : undefined,
    emitsDeletes: true,
  });

// Reads what a test scripts for each stream; an Error entry is thrown there.
class ScriptedSource extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  scripts: Record<string, readonly (SourceMessage | Error)[]>;

  constructor(
    streams: readonly Stream[],
    scripts: Record<string, readonly (SourceMessage | Error)[]>,
  ) {
    super();
    this.catalog = new Catalog(streams);
    this.scripts = scripts;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const entry of this.scripts[configuration.stream.name] ?? []) {
      if (entry instanceof Error) throw entry;
      yield entry;
    }
  }
}

const record = (stream: string, id: string, version: number) => ({
  stream,
  data: { id, version },
});
const checkpoint = (stream: string, state: unknown) => ({
  type: 'STATE' as const,
  stream,
  state,
});
const removal = (stream: string, id: string) => ({
  type: 'DELETE' as const,
  stream,
  key: { id },
});

test('the SQLite writer lock spans commits, permits readers and releases after disposal', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-writer-lock-'),
  );
  const stream = scripted('docs');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(stream, destination.table('docs'));
  const load = await destination.load();
  try {
    const stage = await load.prepare(copy.configuration, copy.to, {
      writer: 'writer',
      reloading: false,
    });
    try {
      await stage.apply({ type: 'RECORD', data: { id: 'a', version: 1 } });
      await stage.commit();
      using reader = new DatabaseSync(destination.path, { readOnly: true });
      assert.equal(
        reader.prepare('SELECT count(*) AS n FROM docs').get()?.n,
        1,
      );
      await assert.rejects(destination.load(), /locked/);
      await assert.rejects(
        destination.clear(copy.configuration, copy.to, 'writer'),
        /locked/,
      );
    } finally {
      await stage[Symbol.asyncDispose]();
    }
  } finally {
    await load[Symbol.asyncDispose]();
  }
  await destination.clear(copy.configuration, copy.to, 'writer');
  await using next = await destination.load();
});

// A reader such as an agent's sqlite3 -readonly query, holding the file
// mid-read in another process until it finishes 300 ms after it started.
const readerInAnotherProcess = async (path: string) => {
  const reader = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1], { readOnly: true });
      database.exec('BEGIN');
      database.prepare('SELECT count(*) FROM sqlite_schema').get();
      process.stdout.write('reading');
      setTimeout(() => database.exec('COMMIT'), 300);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(reader.stdout, 'data');
  return { [Symbol.dispose]: () => reader.kill() };
};

test('a commit waits for a reader in another process instead of failing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-busy-reader-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(scripted('docs'), destination.table('docs'));
  await using load = await destination.load();
  const stage = await load.prepare(copy.configuration, copy.to, {
    writer: 'writer',
    reloading: false,
  });
  try {
    await stage.apply({ type: 'RECORD', data: { id: 'a', version: 1 } });
    using _reader = await readerInAnotherProcess(destination.path);

    await stage.commit();

    using after = new DatabaseSync(destination.path, { readOnly: true });
    assert.equal(after.prepare('SELECT count(*) AS n FROM docs').get()?.n, 1);
  } finally {
    await stage[Symbol.asyncDispose]();
  }
});

test('a clear waits for a reader in another process instead of failing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-busy-reader-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(scripted('docs'), destination.table('docs'));
  {
    await using load = await destination.load();
    await using stage = await load.prepare(copy.configuration, copy.to, {
      writer: 'writer',
      reloading: false,
    });
    await stage.apply({ type: 'RECORD', data: { id: 'a', version: 1 } });
    await stage.commit();
  }
  using _reader = await readerInAnotherProcess(destination.path);

  await destination.clear(copy.configuration, copy.to, 'writer');

  using after = new DatabaseSync(destination.path, { readOnly: true });
  assert.equal(after.prepare('SELECT count(*) AS n FROM docs').get()?.n, 0);
});

test('stored file references follow committed SQLite rows, including rejected updates, failures, deletions and clear', async () => {
  const scratch = await mkdtempDisposable(join(tmpdir(), 'elt-local-sqlite-'));
  try {
    const path = join(scratch.path, 'source.txt');
    await writeFile(path, 'original');
    const directory = join(scratch.path, 'files');
    const files = new LocalFiles({ directory });
    const stream = new Stream({
      ...scripted('docs', { snapshot: false }),
      supportsFileTransfer: true,
    });
    const source = new ScriptedSource([stream], {});
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'out.sqlite'),
    });
    const statePath = join(scratch.path, 'state.sqlite');
    assert.throws(
      () =>
        destination.table('invalid', (c) => [
          c.blob('ref').from(stream.file.store(files)),
        ]),
      /stored references require a TEXT column/,
    );
    const copy = new Copy(
      stream,
      destination.table('docs', (c) => [
        c.text('id'),
        c.integer('version'),
        c.text('ref').from(stream.file.store(files)),
      ]),
      {
        id: 'docs',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
      },
    );
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: statePath }),
          steps: [copy],
        }),
      ],
    });
    const loaded = () => {
      using db = new DatabaseSync(destination.path, { readOnly: true });
      return db
        .prepare('SELECT id, version, ref FROM docs ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
    };
    const saved = () => {
      using db = new DatabaseSync(statePath, { readOnly: true });
      return db
        .prepare('SELECT state FROM checkpoints WHERE id = ?')
        .get('docs')?.state;
    };
    const storedFiles = async () =>
      (
        await readdir(directory, { recursive: true, withFileTypes: true })
      ).filter((entry) => entry.isFile());
    const fileRecord = (version: number) => ({
      ...record('docs', 'a', version),
      file: path,
    });
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
    source.scripts = {
      docs: [
        fileRecord(2),
        { ...record('docs', 'b', 1), file: null },
        checkpoint('docs', { at: 1 }),
      ],
    };
    await pipeline.run();
    const original = String(loaded()[0]?.ref);
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.equal(loaded()[1]?.ref, null);
    assert.equal((await storedFiles()).length, 1);

    await pipeline.run();
    assert.equal(loaded()[0]?.ref, original);
    assert.equal((await storedFiles()).length, 1);
    await writeFile(path, 'rejected');
    source.scripts = { docs: [fileRecord(1), checkpoint('docs', { at: 2 })] };
    await pipeline.run();
    assert.equal(loaded()[0]?.ref, original);
    assert.equal((await storedFiles()).length, 1);
    const beforeFailure = saved();
    source.scripts = { docs: [fileRecord(3), new Error('upstream failed')] };
    await assert.rejects(pipeline.run(), PipelineError);
    assert.equal(saved(), beforeFailure);
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.equal((await storedFiles()).length, 1);

    await writeFile(path, 'replacement');
    source.scripts = { docs: [fileRecord(3), checkpoint('docs', { at: 3 })] };
    await pipeline.run();
    const replacement = String(loaded()[0]?.ref);
    assert.equal(await readFile(replacement, 'utf8'), 'replacement');
    await assert.rejects(readFile(original), { code: 'ENOENT' });
    source.scripts = {
      docs: [removal('docs', 'a'), checkpoint('docs', { at: 4 })],
    };
    await pipeline.run();
    await assert.rejects(readFile(replacement), { code: 'ENOENT' });
    assert.equal((await storedFiles()).length, 0);
    source.scripts = { docs: [fileRecord(4), checkpoint('docs', { at: 5 })] };
    await pipeline.run();
    await pipeline.clear();
    assert.deepEqual(loaded(), []);
    assert.equal(saved(), undefined);
    assert.equal((await storedFiles()).length, 0);
  } finally {
    await scratch[Symbol.asyncDispose]();
  }
});

test('stored files recover cleanup failures before checkpointing and isolate copies sharing a directory', async () => {
  const scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-local-recovery-'),
  );
  try {
    const path = join(scratch.path, 'source.bin');
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 42);
    await writeFile(path, content);
    let rejectCleanup = false;
    let savedFile = false;
    let rejectSave = false;
    const files = new (class extends LocalFiles {
      override async save(scope: string, content: FileContent) {
        if (rejectSave) throw new Error('storage unavailable');
        const reference = await super.save(scope, content);
        savedFile = true;
        return reference;
      }
      override async retain(scope: string, references: ReadonlySet<string>) {
        if (rejectCleanup && savedFile) throw new Error('cleanup unavailable');
        await super.retain(scope, references);
      }
    })({ directory: join(scratch.path, 'files') });
    const stream = new Stream({
      ...scripted('docs', { snapshot: false }),
      supportsFileTransfer: true,
    });
    const source = new ScriptedSource([stream], {});
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'out.sqlite'),
    });
    const statePath = join(scratch.path, 'state.sqlite');
    const target = (name: string) =>
      destination.table(name, (c) => [
        c.text('id'),
        c.integer('version'),
        c.text('ref').from(stream.file.store(files)),
      ]);
    const copy = new Copy(stream, target('docs'), {
      id: 'docs',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [copy],
          checkpoints: new SQLiteCheckpointStore({ path: statePath }),
        }),
      ],
    });
    const loaded = (table: string) => {
      using db = new DatabaseSync(destination.path, { readOnly: true });
      return db.prepare(`SELECT ref FROM "${table}"`).get()?.ref;
    };
    const saved = () => {
      using db = new DatabaseSync(statePath, { readOnly: true });
      return db
        .prepare('SELECT state FROM checkpoints WHERE id = ?')
        .get('docs')?.state;
    };
    source.scripts = {
      docs: [
        { ...record('docs', 'a', 1), file: path },
        checkpoint('docs', { at: 1 }),
      ],
    };
    rejectCleanup = true;
    await assert.rejects(pipeline.run(), PipelineError);
    const original = String(loaded('docs'));
    assert.deepEqual(await readFile(original), content);
    assert.equal(saved(), undefined);
    rejectCleanup = false;
    await pipeline.run();
    assert.equal(loaded('docs'), original);
    assert.equal(saved(), '{"state":{"at":1},"reloading":false}');

    rejectSave = true;
    source.scripts = {
      docs: [
        { ...record('docs', 'a', 2), file: path },
        checkpoint('docs', { at: 2 }),
      ],
    };
    await assert.rejects(pipeline.run(), PipelineError);
    assert.equal(loaded('docs'), original);
    assert.equal(saved(), '{"state":{"at":1},"reloading":false}');
    assert.deepEqual(await readFile(original), content);
    rejectSave = false;

    const snapshot = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(stream, target('snapshot'))],
        }),
      ],
    });
    await writeFile(path, '');
    source.scripts = { docs: [{ ...record('docs', 'a', 1), file: path }] };
    await snapshot.run();
    const empty = String(loaded('snapshot'));
    assert.equal((await readFile(empty)).length, 0);
    assert.deepEqual(await readFile(original), content);
    source.scripts = {
      docs: [
        { ...record('docs', 'a', 2), file: path },
        new Error('snapshot failed'),
      ],
    };
    await assert.rejects(snapshot.run(), PipelineError);
    assert.equal(loaded('snapshot'), empty);
    assert.equal((await readFile(empty)).length, 0);
    source.scripts = { docs: [] };
    await snapshot.run();
    assert.equal(loaded('snapshot'), undefined);
    await assert.rejects(readFile(empty), { code: 'ENOENT' });
    assert.deepEqual(await readFile(original), content);
    await pipeline.clear();
    await assert.rejects(readFile(original), { code: 'ENOENT' });
    source.scripts = { docs: [{ ...record('docs', 'a', 1), file: path }] };
    await snapshot.run();
    await rm(String(loaded('snapshot')));
    await assert.rejects(snapshot.run(), PipelineError);
    assert.equal(loaded('snapshot'), empty);
    await snapshot.clear();
  } finally {
    await scratch[Symbol.asyncDispose]();
  }
});

test('a stream that fails publishes none of its staged rows while its sibling commits, and a failing overwrite keeps the old table', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-stage-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
  const broken = scripted('broken');
  const good = scripted('good');
  const snapshot = scripted('snapshot');
  const source = new ScriptedSource([broken, good, snapshot], {
    snapshot: [record('snapshot', 'old', 1)],
  });
  const incremental = (id: string) =>
    ({
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    }) as const;
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: statePath }),
        steps: [
          new Copy(broken, destination.table('broken'), incremental('broken')),
          new Copy(good, destination.table('good'), incremental('good')),
          new Copy(snapshot, destination.table('snapshot')),
        ],
      }),
    ],
  });
  const rows = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(`SELECT id, version FROM ${table} ORDER BY id`)
      .all()
      .map(({ id, version }) => `${id}:${version}`);
  };
  const saved = () => {
    using database = new DatabaseSync(statePath, { readOnly: true });
    return database
      .prepare('SELECT id, state FROM checkpoints ORDER BY id')
      .all()
      .map(({ id, state }) => `${id}=${state}`);
  };
  await pipeline.run();

  source.scripts = {
    broken: [
      record('broken', 'b1', 1),
      record('broken', 'b2', 1),
      new Error('broken upstream'),
    ],
    good: [record('good', 'g1', 1), checkpoint('good', { page: 1 })],
    snapshot: [record('snapshot', 'new', 2), new Error('snapshot upstream')],
  };
  const error = await pipeline.run().then(
    () => assert.fail('the broken streams should fail the run'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.length,
    ]),
    [
      ['broken', 0, 1],
      ['good', 1, 0],
      ['snapshot', 0, 1],
    ],
  );
  assert.deepEqual(rows('broken'), []);
  assert.deepEqual(rows('good'), ['g1:1']);
  assert.deepEqual(rows('snapshot'), ['old:1']);
  assert.deepEqual(saved(), ['good={"state":{"page":1},"reloading":false}']);
});

test('a staged unit merges like its operations applied one at a time, under replace and cursor_newer', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-merge-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const script = (stream: string) => [
    record(stream, 'a', 1),
    removal(stream, 'a'),
    record(stream, 'a', 2),
    record(stream, 'b', 1),
    removal(stream, 'b'),
    record(stream, 'c', 5),
    record(stream, 'c', 3),
    record(stream, 'd', 4),
    record(stream, 'd', 4),
    checkpoint(stream, { page: 1 }),
  ];
  const replacing = scripted('replacing');
  // cursor_newer needs a cursor the copy selects, not a source-defined one.
  const guarded = scripted('guarded', { snapshot: false });
  const source = new ScriptedSource([replacing, guarded], {
    replacing: script('replacing'),
    guarded: script('guarded'),
  });

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(replacing, destination.table('replacing'), {
            id: 'replacing',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
          new Copy(guarded, destination.table('guarded'), {
            id: 'guarded',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
            dedupPolicy: 'cursor_newer',
          }),
        ],
      }),
    ],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const rows = (table: string) =>
    database
      .prepare(`SELECT id, version FROM ${table} ORDER BY id`)
      .all()
      .map(({ id, version }) => `${id}:${version}`);
  // Sequentially: a is deleted then reloaded at 2; b ends deleted; replace
  // keeps each key's last record, cursor_newer its greatest cursor.
  assert.deepEqual(rows('replacing'), ['a:2', 'c:3', 'd:4']);
  assert.deepEqual(rows('guarded'), ['a:2', 'c:5', 'd:4']);
});

test('a key named last merges like its operations applied one at a time', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-last-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const keyed = (name: string, snapshot: boolean) =>
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        properties: { last: { type: 'string' }, version: { type: 'integer' } },
        required: ['last', 'version'],
      },
      primaryKey: ['last'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: snapshot ? true : undefined,
      emitsDeletes: true,
    });
  const script = (stream: string) => {
    const put = (last: string, version: number) => ({
      stream,
      data: { last, version },
    });
    const remove = (last: string) => ({
      type: 'DELETE' as const,
      stream,
      key: { last },
    });
    return [
      put('a', 1),
      remove('a'),
      put('a', 2),
      put('b', 1),
      remove('b'),
      put('c', 5),
      put('c', 3),
      checkpoint(stream, { page: 1 }),
    ];
  };
  const replacing = keyed('replacing', true);
  const guarded = keyed('guarded', false);
  const source = new ScriptedSource([replacing, guarded], {
    replacing: script('replacing'),
    guarded: script('guarded'),
  });

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(replacing, destination.table('replacing'), {
            id: 'replacing',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
          new Copy(guarded, destination.table('guarded'), {
            id: 'guarded',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
            dedupPolicy: 'cursor_newer',
          }),
        ],
      }),
    ],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const rows = (table: string) =>
    database
      .prepare(`SELECT "last", version FROM ${table} ORDER BY "last"`)
      .all()
      .map(({ last, version }) => `${last}:${version}`);
  // a is deleted, then loaded again at 2; b ends deleted.
  assert.deepEqual(rows('replacing'), ['a:2', 'c:3']);
  assert.deepEqual(rows('guarded'), ['a:2', 'c:5']);
});

test('a key and cursor that sanitizing renames merge under their renamed columns', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-renamed-key-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const keyed = (name: string, snapshot: boolean) =>
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        properties: {
          'Line Id': { type: 'string' },
          'Version No': { type: 'integer' },
        },
        required: ['Line Id', 'Version No'],
      },
      primaryKey: ['Line Id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: snapshot ? true : undefined,
      emitsDeletes: true,
    });
  const script = (stream: string) => {
    const put = (line: string, version: number) => ({
      stream,
      data: { 'Line Id': line, 'Version No': version },
    });
    const remove = (line: string) => ({
      type: 'DELETE' as const,
      stream,
      key: { 'Line Id': line },
    });
    return [
      put('a', 1),
      remove('a'),
      put('a', 2),
      put('b', 1),
      remove('b'),
      put('c', 5),
      put('c', 3),
      checkpoint(stream, { page: 1 }),
    ];
  };
  const replacing = keyed('replacing', true);
  const guarded = keyed('guarded', false);

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new ScriptedSource([replacing, guarded], {
          replacing: script('replacing'),
          guarded: script('guarded'),
        }),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(replacing, destination.table('replacing'), {
            id: 'replacing',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
          new Copy(guarded, destination.table('guarded'), {
            id: 'guarded',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'Version No',
            dedupPolicy: 'cursor_newer',
          }),
        ],
      }),
    ],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const rows = (table: string) =>
    database
      .prepare(
        `SELECT Line_Id AS line, Version_No AS version FROM ${table} ORDER BY Line_Id`,
      )
      .all()
      .map(({ line, version }) => `${line}:${version}`);
  // a is deleted, then loaded again at 2; b ends deleted.
  assert.deepEqual(rows('replacing'), ['a:2', 'c:3']);
  assert.deepEqual(rows('guarded'), ['a:2', 'c:5']);
});

test('renamed file columns keep their original bytes and stored files through later commits, in a table and view whose names the rule changes', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-renamed-files-'),
  );
  const path = join(scratch.path, 'source.txt');
  await writeFile(path, 'original');
  const store = new LocalFiles({ directory: join(scratch.path, 'files') });
  const docs = new Stream({
    name: 'docs',
    jsonSchema: {
      type: 'object',
      description: 'One row per document.',
      properties: {
        id: { type: 'string', description: 'Id.' },
        version: { type: 'integer', description: 'Version.' },
      },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
    supportsFileTransfer: true,
  });
  let messages: SourceMessage[] = [];
  class Documents extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'documents';
    protected readonly catalog = new Catalog([docs]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
      yield checkpoint('docs', {});
    }
  }
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Documents(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(
            docs,
            destination
              .table('Été docs', (c) => [
                c.text('id'),
                c.integer('version'),
                c.blob('Original Bytes').from(docs.file),
                c.text('Stored Ref').from(docs.file.store(store)),
              ])
              .withReaderView('Docs View'),
            {
              id: 'docs',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ],
    history,
  });

  messages = [{ stream: 'docs', data: { id: 'a', version: 1 }, file: path }];
  await pipeline.run();
  messages = [{ stream: 'docs', data: { id: 'b', version: 1 }, file: null }];
  await pipeline.run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  // A view name the rule changes keeps a hash of the name asked for.
  const view = `Docs_View_${createHash('sha256').update('Docs View').digest('hex').slice(0, 8)}`;
  // Original bytes are read as the column's catalog entry tells a reader to.
  const entry = database
    .prepare('SELECT description FROM catalog WHERE name = ?')
    .get(`${view}.Original_Bytes`);
  const chunks = /Join ("[^"]+") on file/.exec(String(entry?.description))?.[1];
  assert.ok(chunks, String(entry?.description));
  const original = database
    .prepare(
      `SELECT c.bytes FROM ${view} d JOIN ${chunks} c ON c.file = d.Original_Bytes WHERE d.id = 'a' ORDER BY c.n`,
    )
    .all()
    .map(({ bytes }) => Buffer.from(Object(bytes)).toString());
  assert.equal(original.join(''), 'original');
  const stored = database
    .prepare(`SELECT Stored_Ref AS ref FROM ${view} WHERE id = 'a'`)
    .get();
  assert.equal(await readFile(String(stored?.ref), 'utf8'), 'original');
});

test('a load holds no write transaction while the source reads, and a stream that fails before its first commit leaves nothing while its sibling commits', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-short-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const kept = scripted('kept');
  const failing = scripted('failing');
  // Another writer, between this load's commits, as a second connection.
  const write = () => {
    using other = new DatabaseSync(destination.path, { timeout: 0 });
    other.exec('BEGIN IMMEDIATE');
    other.exec('COMMIT');
  };
  let wroteWhileReading = false;
  class Interleaved extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'interleaved';
    protected readonly catalog = new Catalog([kept, failing]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      const { name } = configuration.stream;
      if (name === 'kept') {
        yield record('kept', 'a', 1);
        yield checkpoint('kept', { page: 1 });
        write();
        wroteWhileReading = true;
        return;
      }
      yield record('failing', 'b', 1);
      throw new Error('source broke');
    }
  }

  const error = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Interleaved(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(kept, destination.table('kept'), {
            id: 'kept',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
          new Copy(failing, destination.table('failing'), {
            id: 'failing',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  })
    .run()
    .then(
      () => assert.fail('the failing stream should fail the run'),
      (error: unknown) => error,
    );

  assert.ok(error instanceof PipelineError, String(error));
  assert.equal(wroteWhileReading, true);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('kept', 'failing') ORDER BY name`,
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(tables, ['kept']);
  assert.deepEqual(
    database
      .prepare('SELECT id FROM kept')
      .all()
      .map(({ id }) => id),
    ['a'],
  );
});

test('deduplicating a table whose history repeats a key is refused before the source is read', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-repeats-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
  });
  const source = new ScriptedSource([items], {
    items: [record('items', 'a', 1), record('items', 'a', 2)],
  });
  // One copy that first keeps a history, then deduplicates it from a reset
  // checkpoint, which a changed copy needs.
  const run = (destinationSyncMode: 'append' | 'append_dedup') =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, `${destinationSyncMode}.sqlite`),
          }),
          steps: [
            new Copy(items, destination.table('items'), {
              id: 'items',
              syncMode: 'incremental',
              cursorField: 'version',
              destinationSyncMode,
            }),
          ],
        }),
      ],
    }).run();
  await run('append');
  source.scripts = { items: [new Error('the source was read')] };

  const error = await run('append_dedup').then(
    () => assert.fail('deduplicating repeated keys should be refused'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.match(
    String(error.results[0]?.failures[0]?.error),
    /Existing rows repeat a deduplication key/,
  );
});

test('two file columns whose table and column names join alike keep their own chunks', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-chunks-'));
  const path = join(scratch.path, 'source.txt');
  await writeFile(path, 'original');
  const described = (name: string) =>
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description: `One row per ${name} file.`,
        properties: { id: { type: 'string', description: 'Id.' } },
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      supportsFileTransfer: true,
    });
  const left = described('left');
  const right = described('right');
  let messages: Record<string, SourceMessage[]> = {};
  class Files extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'files';
    protected readonly catalog = new Catalog([left, right]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      const { name } = configuration.stream;
      yield* messages[name] ?? [];
      yield checkpoint(name, {});
    }
  }
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  const selection = {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  } as const;
  // Table a_b with column c, and table a with column b_c.
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Files(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(
            left,
            destination
              .table('a_b', (c) => [c.text('id'), c.blob('c').from(left.file)])
              .withReaderView('left_files'),
            { id: 'left', ...selection },
          ),
          new Copy(
            right,
            destination
              .table('a', (c) => [c.text('id'), c.blob('b_c').from(right.file)])
              .withReaderView('right_files'),
            { id: 'right', ...selection },
          ),
        ],
      }),
    ],
    history,
  });

  messages = {
    left: [{ stream: 'left', data: { id: 'l' }, file: path }],
    right: [{ stream: 'right', data: { id: 'r' }, file: path }],
  };
  await pipeline.run();
  // A later commit of the left target alone.
  messages = { left: [{ stream: 'left', data: { id: 'l2' }, file: null }] };
  await pipeline.run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  // Each file is read as its column's catalog entry tells a reader to.
  const original = (view: string, column: string, id: string) => {
    const entry = database
      .prepare('SELECT description FROM catalog WHERE name = ?')
      .get(`${view}.${column}`);
    const chunks = /Join ("[^"]+") on file/.exec(
      String(entry?.description),
    )?.[1];
    assert.ok(chunks, String(entry?.description));
    return database
      .prepare(
        `SELECT c.bytes FROM ${view} v JOIN ${chunks} c ON c.file = v.${column} WHERE v.id = ? ORDER BY c.n`,
      )
      .all(id)
      .map(({ bytes }) => Buffer.from(Object(bytes)).toString())
      .join('');
  };
  assert.equal(original('left_files', 'c', 'l'), 'original');
  assert.equal(original('right_files', 'b_c', 'r'), 'original');
});

test('a reset of a partition named by a renamed field replaces only that partition', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-renamed-part-'),
  );
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { 'Account Id': { type: 'string' }, id: { type: 'string' } },
    },
    primaryKey: ['Account Id', 'id'],
    partitionKey: ['Account Id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  let script: Record<string, SourceMessage[]> = {};
  class Accounts extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'accounts';
    protected readonly catalog = new Catalog([items]);
    protected override partitions() {
      return [{ 'Account Id': 'a' }, { 'Account Id': 'b' }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      yield* script[String(partition?.['Account Id'])] ?? [];
    }
  }
  const item = (account: string, id: string) => ({
    stream: 'items',
    data: { 'Account Id': account, id },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Accounts(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });

  script = {
    a: [item('a', '1'), item('a', '2'), checkpoint('items', { pass: 1 })],
    b: [item('b', '1'), checkpoint('items', { pass: 1 })],
  };
  await pipeline.run();
  script = {
    a: [
      { type: 'RESET', stream: 'items' },
      item('a', '3'),
      checkpoint('items', { pass: 2 }),
    ],
    b: [checkpoint('items', { pass: 2 })],
  };
  await pipeline.run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT Account_Id AS account, id FROM items ORDER BY 1, 2')
      .all()
      .map(({ account, id }) => `${account}${id}`),
    ['a3', 'b1'],
  );
});

test('a native transaction rollback retains the original merge error and committed rows', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-rollback-'),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const stream = scripted('items', { snapshot: false });
  const source = new ScriptedSource([stream], {
    items: [record('items', 'old', 1)],
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(stream, destination.table('items'))],
      }),
    ],
  });
  await pipeline.run();
  using database = new DatabaseSync(destination.path);
  // Like SQLITE_FULL, RAISE(ROLLBACK) removes every savepoint itself.
  database.exec(`CREATE TRIGGER fail_merge BEFORE INSERT ON items BEGIN
    SELECT RAISE(ROLLBACK, 'synthetic native rollback'); END`);
  source.scripts = { items: [record('items', 'new', 2)] };
  await assert.rejects(pipeline.run(), (error: unknown) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'synthetic native rollback');
    return true;
  });
  assert.deepEqual(
    database
      .prepare('SELECT id, version FROM items')
      .all()
      .map((row) => ({ ...row })),
    [{ id: 'old', version: 1 }],
  );
});

test('an overwrite_dedup whose key narrows builds its index after the old rows are gone', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-rekey-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  // A keyless stream, so each run's copy selects the key it deduplicates by.
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const source = new ScriptedSource([stream], {
    items: [record('items', 'a', 1), record('items', 'a', 2)],
  });
  const run = (primaryKey: string[]) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [
            new Copy(stream, destination.table('items'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite_dedup',
              dedupPolicy: 'replace',
              primaryKey,
            }),
          ],
        }),
      ],
    }).run();

  await run(['id', 'version']);
  // Under the narrower key the two old rows collide; the new one does not.
  source.scripts = { items: [record('items', 'a', 3)] };
  await run(['id']);

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT id, version FROM items')
      .all()
      .map(({ id, version }) => `${id}:${version}`),
    ['a:3'],
  );
});

test('interleaved streams commit on their own: a checkpoint of one never publishes the other, and each file is read before its stream moves on', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-weave-'));
  const staging = join(scratch.path, 'staging');
  await mkdir(staging);
  const files = (name: string) =>
    new Stream({ ...scripted(name), supportsFileTransfer: true });
  const emitted: string[] = [];
  // The streams take turns, each handing the next turn on once the reader
  // asks it for more, so the order holds under any load.
  const order = ['a1', 'b1', 'a2', 'b2'];
  const turns = order.map(() => Promise.withResolvers<void>());
  turns[0]?.resolve();
  const checkpointed = Promise.withResolvers<void>();
  class Interleaved extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'interleaved';
    readonly a = files('a');
    readonly b = files('b');
    protected readonly catalog = new Catalog([this.a, this.b]);
    protected override readonly concurrency = 2;
    failing = true;

    protected override async open() {
      return new AsyncDisposableStack();
    }

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(configuration: CopyConfiguration) {
      const name = configuration.stream.name;
      for (const n of [1, 2]) {
        const turn = order.indexOf(`${name}${n}`);
        await turns[turn]?.promise;
        const path = join(staging, `${name}${n}.bin`);
        await writeFile(path, `${name}${n} bytes`);
        emitted.push(`${name}${n}`);
        yield {
          stream: name,
          data: { id: `${name}${n}`, version: 1 },
          file: path,
        };
        // The consumer moved on: the staged file is gone at once, so a
        // destination that read it late would find nothing.
        rmSync(path);
        turns[turn + 1]?.resolve();
      }
      if (name === 'b') {
        yield checkpoint('b', { page: 1 });
        checkpointed.resolve();
        return;
      }
      // a still has staged rows and files when b commits.
      await checkpointed.promise;
      if (this.failing) throw new Error('a upstream');
      yield checkpoint('a', { page: 1 });
    }
  }
  const source = new Interleaved();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: statePath }),
        steps: [source.a, source.b].map(
          (stream) =>
            new Copy(
              stream,
              destination.table(stream.name, (c) => [
                c.text('id'),
                c.integer('version'),
                c.blob('bytes').from(stream.file),
              ]),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });
  const loaded = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(
        `SELECT t.id, (SELECT group_concat(CAST(c.bytes AS TEXT), '') FROM ${chunkTable(table, 'bytes')} c WHERE c.file = t.bytes) AS bytes FROM ${table} t ORDER BY t.id`,
      )
      .all()
      .map(({ id, bytes }) => `${id}=${bytes}`);
  };
  const orphans = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(
        `SELECT count(*) AS n FROM ${chunkTable(table, 'bytes')} WHERE file NOT IN (SELECT bytes FROM ${table} WHERE bytes IS NOT NULL)`,
      )
      .get()?.n;
  };
  const saved = () => {
    using database = new DatabaseSync(statePath, { readOnly: true });
    return database
      .prepare('SELECT id FROM checkpoints ORDER BY id')
      .all()
      .map(({ id }) => id);
  };

  const error = await pipeline.run().then(
    () => assert.fail('a should fail the run'),
    (error: unknown) => error,
  );
  const exists = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return (
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`,
        )
        .get(table) !== undefined
    );
  };
  // a failed before its first commit, so it made no table at all.
  const afterFailure = { a: exists('a'), b: loaded('b'), saved: saved() };
  source.failing = false;
  await pipeline.run();

  assert.deepEqual(emitted.slice(0, 4), ['a1', 'b1', 'a2', 'b2']);
  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.length,
    ]),
    [
      ['a', 0, 1],
      ['b', 2, 0],
    ],
  );
  assert.deepEqual(afterFailure, {
    a: false,
    b: ['b1=b1 bytes', 'b2=b2 bytes'],
    saved: ['b'],
  });
  assert.deepEqual(loaded('a'), ['a1=a1 bytes', 'a2=a2 bytes']);
  assert.equal(orphans('a'), 0);
});

const leftBehind: {
  outcome: string;
  next: 'rerun' | 'clear';
  expected: { loaded: string[]; orphans: number };
}[] = [
  {
    outcome: 'its next run loads every file whole',
    next: 'rerun',
    expected: { loaded: ['d1=d1 bytes', 'd2=d2 bytes'], orphans: 0 },
  },
  {
    outcome: 'a clear empties its target',
    next: 'clear',
    expected: { loaded: [], orphans: 0 },
  },
];
for (const { outcome, next, expected } of leftBehind)
  test(`a failed stream's staged files never reach the database while its sibling commits, and ${outcome}`, async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-sweep-'));
    const staging = join(scratch.path, 'staging');
    await mkdir(staging);
    // docs stores its files, notes commits them along with its own rows, and
    // only then does docs fail: its discard never commits, as after a crash.
    // Each gate opens when the consumer asks for a stream's next message, so
    // the order holds without timers.
    class Crossing extends Source {
      override coverage() {
        return { description: 'test', selection: {} };
      }

      readonly identity = 'crossing';
      readonly docs = new Stream({
        ...scripted('docs'),
        supportsFileTransfer: true,
      });
      readonly notes = scripted('notes');
      protected readonly catalog = new Catalog([this.docs, this.notes]);
      protected override readonly concurrency = 2;
      files: string[] = [];
      failing = false;
      // What a reader sees once notes committed, while docs still runs.
      atSiblingCommit: () => unknown = () => undefined;
      seen: unknown;
      #stored = Promise.withResolvers<void>();
      #committed = Promise.withResolvers<void>();

      protected override async open() {
        this.#stored = Promise.withResolvers<void>();
        this.#committed = Promise.withResolvers<void>();
        return new AsyncDisposableStack();
      }

      protected override async *observe({ streams }: SourceWatchOptions) {
        yield streams;
      }

      protected override async *extract(configuration: CopyConfiguration) {
        if (configuration.stream.name === 'notes') {
          await this.#stored.promise;
          yield record('notes', `after-${this.files.join('-')}`, 1);
          yield checkpoint('notes', { files: this.files });
          this.#committed.resolve();
          return;
        }
        for (const id of this.files) {
          const path = join(staging, `${id}.bin`);
          await writeFile(path, `${id} bytes`);
          yield { stream: 'docs', data: { id, version: 1 }, file: path };
        }
        this.#stored.resolve();
        if (this.failing) {
          await this.#committed.promise;
          this.seen = this.atSiblingCommit();
          throw new Error('docs upstream');
        }
        yield checkpoint('docs', { files: this.files });
      }
    }
    const source = new Crossing();
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'out.sqlite'),
    });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(
              source.docs,
              destination.table('docs', (c) => [
                c.text('id'),
                c.integer('version'),
                c.blob('bytes').from(source.docs.file),
              ]),
              {
                id: 'docs',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
            new Copy(source.notes, destination.table('notes'), {
              id: 'notes',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    });
    const stored = () => {
      using database = new DatabaseSync(destination.path, { readOnly: true });
      const loaded = database
        .prepare(
          `SELECT d.id, (SELECT group_concat(CAST(c.bytes AS TEXT), '') FROM ${chunkTable('docs', 'bytes')} c WHERE c.file = d.bytes) AS bytes FROM docs d ORDER BY d.id`,
        )
        .all()
        .map(({ id, bytes }) => `${id}=${bytes}`);
      const orphans = database
        .prepare(
          `SELECT count(*) AS n FROM ${chunkTable('docs', 'bytes')} WHERE file NOT IN (SELECT bytes FROM docs WHERE bytes IS NOT NULL)`,
        )
        .get()?.n;
      return { loaded, orphans };
    };
    source.atSiblingCommit = stored;
    source.files = ['d1'];
    await pipeline.run();
    source.files = ['d2'];
    source.failing = true;
    const error = await pipeline.run().then(
      () => assert.fail('docs should fail the run'),
      (error: unknown) => error,
    );
    const afterFailure = stored();

    source.failing = false;
    if (next === 'rerun') await pipeline.run();
    else await pipeline.clear();

    assert.ok(error instanceof PipelineError, String(error));
    assert.deepEqual(
      error.results.map(({ copy, count, failures }) => [
        copy.from.name,
        count,
        failures.length,
      ]),
      [
        ['docs', 0, 1],
        ['notes', 1, 0],
      ],
    );
    // docs's chunks of d2 stayed in its own TEMP stage when notes committed,
    // and left with it.
    assert.deepEqual(source.seen, { loaded: ['d1=d1 bytes'], orphans: 0 });
    assert.deepEqual(afterFailure, { loaded: ['d1=d1 bytes'], orphans: 0 });
    assert.deepEqual(stored(), expected);
  });

test('clearing a table whose file column was declared after its first load empties it, though no file was ever stored', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-clear-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const plain = scripted('docs');
  const loaded = new ScriptedSource([plain], {
    docs: [record('docs', 'd1', 1)],
  });
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: loaded,
        destination,
        steps: [new Copy(plain, destination.table('docs'))],
      }),
    ],
  }).run();
  const docs = new Stream({ ...scripted('docs'), supportsFileTransfer: true });
  const source = new ScriptedSource([docs], {});
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            docs,
            destination.table('docs', (c) => [
              c.text('id'),
              c.integer('version'),
              c.blob('bytes').from(docs.file),
            ]),
          ),
        ],
      }),
    ],
  });

  await pipeline.clear();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) AS n FROM docs').get()?.n, 0);
});

test('text with a lone surrogate fails its stream instead of loading as a replacement character, while the sibling loads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-text-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const notes = new Stream({
    ...scripted('notes'),
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, body: { type: 'string' } },
      required: ['id', 'body'],
    },
  });
  const good = scripted('good');
  const source = new ScriptedSource([notes, good], {
    notes: [{ stream: 'notes', data: { id: 'n1', body: 'cut \uD83D' } }],
    good: [record('good', 'g1', 1)],
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(notes, destination.table('notes')),
          new Copy(good, destination.table('good')),
        ],
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('the lone surrogate should fail notes'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.map(({ error }) => String(error)),
    ]),
    [
      ['notes', 0, ['TypeError: Record field body has a lone surrogate']],
      ['good', 1, []],
    ],
  );
  using database = new DatabaseSync(destination.path, { readOnly: true });
  // The failed stream never committed, so it left no table at all.
  assert.equal(
    database
      .prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE name = 'notes'`)
      .get()?.n,
    0,
  );
});

test('string formats load exactly into checked columns, and int64 cursors and keys work by value', async () => {
  let messages: SourceMessage[] = [];
  const described = (description: string) => ({ description });
  const ledger = new Stream({
    name: 'ledger',
    jsonSchema: {
      type: 'object',
      description: 'Ledger entries.',
      properties: {
        id: { type: 'string', format: 'int64', ...described('Entry id.') },
        version: {
          type: 'string',
          format: 'int64',
          ...described('Row version.'),
        },
        amount: {
          type: 'string',
          format: 'decimal',
          precision: 19,
          scale: 4,
          ...described('Amount.'),
        },
        at: {
          type: 'string',
          format: 'date-time',
          precision: 7,
          ...described('Instant.'),
        },
        local: {
          type: 'string',
          format: 'date-time-local',
          precision: 7,
          ...described('Wall clock.'),
        },
        clock: {
          type: 'string',
          format: 'time-local',
          precision: 0,
          ...described('Time of day.'),
        },
        bytes: {
          type: 'string',
          contentEncoding: 'base64',
          ...described('Payload.'),
        },
      },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
  });
  class LedgerSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'ledger';
    protected readonly catalog = new Catalog([ledger]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
      yield { type: 'STATE' as const, stream: 'ledger', state: {} };
    }
  }
  const entry = (id: string, version: string, amount: string) => ({
    stream: 'ledger',
    data: {
      id,
      version,
      amount,
      at: '2025-01-02T03:04:05.1234567Z',
      local: '9999-12-31T23:59:59.9999999',
      clock: '23:59:59',
      bytes: 'AAEC/w==',
    },
  });

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-format-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'ledger.sqlite'),
  });
  installSQLiteCatalog(destination);
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'ledger',
        source: new LedgerSource(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(
            ledger,
            destination.table('raw_ledger').withReaderView('ledger'),
            {
              id: 'ledger',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ],
  });
  const read = (sql: string) => {
    using database = new DatabaseSync(destination.path, {
      readOnly: true,
      readBigInts: true,
    });
    return database.prepare(sql).all();
  };

  // As text "9" sorts after "10"; as doubles the second entry's versions tie.
  messages = [
    entry('9223372036854775807', '9', '1.0000'),
    entry('9223372036854775807', '10', '2.0000'),
    entry('9007199254740993', '9007199254740992', '-0.5000'),
    entry('9007199254740993', '9007199254740993', '922337203685477.5807'),
  ];
  await pipeline.run();

  assert.deepEqual(
    read(
      'SELECT id, version, amount, at, local, clock, hex(bytes) AS bytes FROM ledger ORDER BY id',
    ).map((row) => ({ ...row })),
    [
      {
        id: 9007199254740993n,
        version: 9007199254740993n,
        amount: '922337203685477.5807',
        at: '2025-01-02T03:04:05.1234567Z',
        local: '9999-12-31T23:59:59.9999999',
        clock: '23:59:59',
        bytes: '000102FF',
      },
      {
        id: 9223372036854775807n,
        version: 10n,
        amount: '2.0000',
        at: '2025-01-02T03:04:05.1234567Z',
        local: '9999-12-31T23:59:59.9999999',
        clock: '23:59:59',
        bytes: '000102FF',
      },
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      read(
        "SELECT name, data_type FROM catalog WHERE name LIKE 'ledger.%' ORDER BY name",
      ).map(({ name, data_type }) => [name, data_type]),
    ),
    {
      'ledger.amount': 'decimal(19,4)',
      'ledger.at': 'timestamp(7)',
      'ledger.bytes': 'blob',
      'ledger.clock': 'local_time(0)',
      'ledger.id': 'int64',
      'ledger.loaded_at': 'timestamp',
      'ledger.local': 'local_timestamp(7)',
      'ledger.version': 'int64',
    },
  );
  {
    using database = new DatabaseSync(destination.path);
    for (const [column, value] of [
      ['at', '2025-01-02T03:04:05.123Z'],
      ['at', '2025-02-30T03:04:05.1234567Z'],
      ['local', '2025-01-02T03:04:05.1234567Z'],
      ['clock', '23:59:59.0'],
      ['clock', '25:00:00'],
    ] as const)
      assert.throws(
        () =>
          database.prepare(`UPDATE raw_ledger SET "${column}" = ?`).run(value),
        /CHECK constraint failed/,
      );
  }

  messages = [
    { type: 'DELETE', stream: 'ledger', key: { id: '9007199254740993' } },
  ];
  await pipeline.run();
  assert.deepEqual(
    read('SELECT id FROM ledger').map(({ id }) => id),
    [9223372036854775807n],
  );
});

test('a reset replaces only its partition at the next commit, and one a failure dropped never reaches a later commit', async () => {
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { account: { type: 'string' }, id: { type: 'string' } },
    },
    primaryKey: ['account', 'id'],
    partitionKey: ['account'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  // What each partition emits on the next run.
  let script: Record<string, (SourceMessage | Error)[]> = {};
  class Resetting extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'resetting';
    protected readonly catalog = new Catalog([items]);
    protected override partitions() {
      return [{ account: 'a' }, { account: 'b' }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      for (const message of script[String(partition?.account)] ?? []) {
        if (message instanceof Error) throw message;
        yield message;
      }
    }
  }
  const record = (account: string, id: string) => ({
    stream: 'items',
    data: { account, id },
  });
  const reset = { type: 'RESET' as const, stream: 'items' };
  const state = { type: 'STATE' as const, stream: 'items', state: {} };
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reset-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'items.sqlite'),
  });
  const into = destination.table('items');
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT account, id FROM items ORDER BY account, id')
      .all()
      .map(({ account, id }) => `${account}${id}`);
  };
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Resetting(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(items, into, {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });

  script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();
  script = { a: [reset, record('a', '2'), state], b: [state] };
  await pipeline.run();
  assert.deepEqual(await loaded(), ['a2', 'b1']);

  script = {
    a: [reset, record('a', '3'), new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(await loaded(), ['a2', 'b1', 'b2']);
});

// A stream discovered anew each run, as a database source rediscovers its
// tables, diffed as a snapshot into SQLite under a reader view.
function shapeChanges(
  directory: string,
  declaration: Partial<
    Pick<
      ConstructorParameters<typeof Stream>[0],
      'name' | 'emitsDeletes' | 'expiresBy' | 'supportedSyncModes'
    >
  >,
) {
  const destination = new SQLiteDestination({
    path: join(directory, 'items.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const received: unknown[] = [];
  const pipeline = (
    properties: Properties,
    rows: readonly Record<string, unknown>[],
    {
      required = [],
      primaryKey = ['id'],
      horizon,
    }: {
      required?: string[];
      primaryKey?: string[];
      horizon?: string;
    } = {},
  ) => {
    const stream = new Stream({
      jsonSchema: {
        type: 'object',
        description: 'Items.',
        properties,
        required,
      },
      primaryKey,
      sourceDefinedCursor: true,
      ...declaration,
      name: declaration.name ?? 'items',
      supportedSyncModes: declaration.supportedSyncModes ?? ['incremental'],
    });
    class Discovered extends Source {
      override coverage() {
        return { description: 'test', selection: {} };
      }

      protected override async open() {
        return new AsyncDisposableStack();
      }

      readonly identity = 'discovered';
      protected readonly catalog = new Catalog([stream]);
      protected override async *observe({ streams }: SourceWatchOptions) {
        yield streams;
      }
      protected override async *extract(
        configuration: CopyConfiguration,
        state: unknown,
      ) {
        received.push(state);
        yield* diffSnapshot(
          configuration.stream,
          rows,
          state,
          horizon === undefined ? {} : { covers: expiredAfter(horizon) },
        );
      }
    }
    return new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new Discovered(),
          destination,
          checkpoints,
          steps: [
            new Copy(
              stream,
              destination.table('raw_items').withReaderView('items'),
              {
                id: 'items',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
          ],
        }),
      ],
    });
  };
  const run = async (...args: Parameters<typeof pipeline>) =>
    (await pipeline(...args).run()).map(({ count, deleted }) => ({
      count,
      deleted,
    }));
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT * FROM items ORDER BY id')
      .all()
      .map(({ loaded_at: _, ...row }) => ({ ...row }));
  };
  const tables = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(
        `SELECT "name" FROM sqlite_schema WHERE "type" = 'table' ORDER BY "name"`,
      )
      .all()
      .map(({ name }) => String(name));
  };
  const columns = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(`SELECT "name" FROM pragma_table_info('raw_items')`)
      .all()
      .map(({ name }) => String(name));
  };
  // What the copy's checkpoint holds, as the store saved it.
  const saved = () => {
    using database = new DatabaseSync(join(directory, 'state.sqlite'), {
      readOnly: true,
    });
    const row = database
      .prepare('SELECT binding, state FROM checkpoints')
      .get();
    return {
      binding: String(row?.binding),
      state: JSON.parse(String(row?.state)).state,
    };
  };
  return {
    checkpoints,
    received,
    pipeline,
    run,
    loaded,
    tables,
    columns,
    saved,
  };
}

const shape = {
  id: { type: 'string', description: 'Id.' },
  title: { type: 'string', description: 'Title.' },
  nullableTitle: { type: ['string', 'null'], description: 'Title.' },
  added: { type: ['string', 'null'], description: 'Added.' },
  requiredAdded: { type: 'string', description: 'Added.' },
  seenAt: { type: 'string', format: 'date-time', description: 'Seen.' },
} as const;

test('a stream whose upstream forgets records keeps every row when a field is added, removed or made nullable, and its source resumes from its state', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, loaded, received, tables, columns, saved } = shapeChanges(
    scratch.path,
    {},
  );
  await run(
    { id: shape.id, title: shape.title, old: shape.title },
    [
      { id: 'a', title: 'A', old: 'x' },
      { id: 'b', title: 'B', old: 'y' },
    ],
    { required: ['id', 'title', 'old'] },
  );
  const first = saved().state;

  // a left the upstream; b is still there, untitled, with the new field.
  const evolved = await run(
    { id: shape.id, title: shape.nullableTitle, added: shape.added },
    [{ id: 'b', title: null, added: 'z' }],
  );

  assert.deepEqual(evolved, [{ count: 1, deleted: 0 }]);
  assert.deepEqual(loaded(), [
    { id: 'a', title: 'A', added: null },
    { id: 'b', title: null, added: 'z' },
  ]);
  assert.deepEqual(columns(), ['id', 'title', 'added', 'loaded_at']);
  assert.deepEqual(received[1], first);
  assert.equal(
    tables().some((name) => name.startsWith('_elt_next_')),
    false,
  );
});

test('a mirror stream whose shape changes still deletes the rows its upstream deleted meanwhile', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, loaded } = shapeChanges(scratch.path, { emitsDeletes: true });
  await run({ id: shape.id, title: shape.title }, [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ]);

  const evolved = await run(
    { id: shape.id, title: shape.title, added: shape.added },
    [{ id: 'b', title: 'B', added: 'z' }],
  );

  assert.deepEqual(evolved, [{ count: 1, deleted: 1 }]);
  assert.deepEqual(loaded(), [{ id: 'b', title: 'B', added: 'z' }]);
});

test('an expiring stream whose shape changes keeps a row older than the horizon and deletes one its upstream still kept', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, loaded } = shapeChanges(scratch.path, {
    emitsDeletes: true,
    expiresBy: 'seenAt',
  });
  await run(
    { id: shape.id, seenAt: shape.seenAt },
    [
      { id: 'old', seenAt: '2026-01-01T00:00:00.000Z' },
      { id: 'recent', seenAt: '2026-06-01T00:00:00.000Z' },
    ],
    { horizon: '2025-12-01T00:00:00.000Z' },
  );

  // Both vanish while the upstream keeps records from March on: old expired,
  // recent was deleted.
  const evolved = await run(
    { id: shape.id, seenAt: shape.seenAt, added: shape.added },
    [],
    { horizon: '2026-03-01T00:00:00.000Z' },
  );

  assert.deepEqual(evolved, [{ count: 0, deleted: 1 }]);
  assert.deepEqual(loaded(), [
    { id: 'old', seenAt: '2026-01-01T00:00:00.000Z', added: null },
  ]);
});

test('a required field added to a stored stream reads null on rows written before it, and a new record still has to carry it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, loaded } = shapeChanges(scratch.path, {});
  await run({ id: shape.id }, [{ id: 'a' }, { id: 'b' }]);
  const fields = { id: shape.id, added: shape.requiredAdded };
  const required = ['id', 'added'];

  const evolved = await run(fields, [{ id: 'b', added: 'z' }], { required });

  assert.deepEqual(evolved, [{ count: 1, deleted: 0 }]);
  assert.deepEqual(loaded(), [
    { id: 'a', added: null },
    { id: 'b', added: 'z' },
  ]);
  await assert.rejects(run(fields, [{ id: 'c' }], { required }), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.match(String(error.errors[0]), /Record is missing field "added"/);
    return true;
  });
});

test('stored rows the new shape cannot hold fail the copy by column, leave the table and checkpoint as they were, and a clear reloads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, pipeline, loaded, received, saved } = shapeChanges(
    scratch.path,
    { emitsDeletes: true },
  );
  const at = (precision: number) =>
    ({
      type: 'string',
      format: 'date-time',
      precision,
      description: 'When.',
    }) as const;
  await run({ id: shape.id, at: at(3) }, [
    { id: '1', at: '2025-01-02T03:04:05.006Z' },
  ]);
  const wider = { id: shape.id, at: at(7) };
  const rows = [{ id: '1', at: '2025-01-02T03:04:05.1234567Z' }];
  const before = saved();

  // The stored value keeps three digits, which the seven-digit column refuses.
  for (const _ of [1, 2])
    await assert.rejects(run(wider, rows), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.match(String(error.errors[0]), /raw_items/);
      assert.match(String(error.errors[0]), /"at"/);
      return true;
    });
  assert.deepEqual(loaded(), [{ id: '1', at: '2025-01-02T03:04:05.006Z' }]);
  assert.deepEqual(saved(), before);
  await pipeline(wider, rows).clear();
  await run(wider, rows);

  assert.deepEqual(loaded(), rows);
  assert.deepEqual(received.at(-1), null);
});

test('a stale table whose reader view was replaced by another is refused before it evolves, and is left as it was', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, columns } = shapeChanges(scratch.path, {});
  await run({ id: shape.id }, [{ id: 'a' }]);
  // Someone else's view takes the reader view's name.
  {
    using database = new DatabaseSync(join(scratch.path, 'items.sqlite'));
    database.exec('DROP VIEW items; CREATE VIEW items AS SELECT 1 AS one');
  }

  await assert.rejects(
    run({ id: shape.id, added: shape.added }, [{ id: 'a', added: 'z' }]),
    (error) => {
      assert.ok(error instanceof PipelineError);
      assert.match(String(error.errors[0]), /is not a view of exactly/);
      return true;
    },
  );

  assert.deepEqual(columns(), ['id', 'loaded_at']);
  using database = new DatabaseSync(join(scratch.path, 'items.sqlite'), {
    readOnly: true,
  });
  assert.deepEqual(
    database
      .prepare('SELECT * FROM items')
      .all()
      .map((row) => ({ ...row })),
    [{ one: 1 }],
  );
});

test('a changed declaration stops the copy with StreamChangeError naming it, and loads nothing', async () => {
  const fields = { id: shape.id, seenAt: shape.seenAt };
  const changes = [
    [{ emitsDeletes: true }, {}, /emitsDeletes/],
    [
      { emitsDeletes: true },
      { emitsDeletes: true, expiresBy: 'seenAt' },
      /expiresBy/,
    ],
    [
      {},
      { supportedSyncModes: ['full_refresh', 'incremental'] },
      /supportedSyncModes/,
    ],
    [{}, { name: 'things' }, /name/],
  ] as const;

  for (const [before, after, named] of changes) {
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-evolve-'),
    );
    await shapeChanges(scratch.path, before).run(fields, [
      { id: 'a', seenAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const changed = shapeChanges(scratch.path, after);

    await assert.rejects(
      changed.run(fields, [{ id: 'b', seenAt: '2026-06-01T00:00:00.000Z' }], {
        horizon: '2025-01-01T00:00:00.000Z',
      }),
      (error) => {
        assert.ok(error instanceof PipelineError);
        assert.ok(error.errors[0] instanceof StreamChangeError);
        assert.match(String(error.errors[0]), named);
        return true;
      },
    );
    assert.deepEqual(changed.loaded(), [
      { id: 'a', seenAt: '2026-01-01T00:00:00.000Z' },
    ]);
  }
});

test('a changed primary key fails the copy until it is reset, which keeps and re-keys the rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, loaded, checkpoints } = shapeChanges(scratch.path, {
    emitsDeletes: true,
  });
  const fields = { id: shape.id, title: shape.title };
  await run(fields, [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ]);
  const byTitle = { primaryKey: ['title'] };

  await assert.rejects(run(fields, [], byTitle), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.errors[0] instanceof StreamChangeError);
    assert.match(String(error.errors[0]), /primaryKey/);
    assert.match(String(error.errors[0]), /reset/);
    return true;
  });
  await checkpoints.reset('items');
  const rekeyed = await run(fields, [{ id: 'c', title: 'A' }], byTitle);

  assert.deepEqual(rekeyed, [{ count: 1, deleted: 0 }]);
  assert.deepEqual(loaded(), [
    { id: 'b', title: 'B' },
    { id: 'c', title: 'A' },
  ]);
});

test('rows that repeat a new primary key fail its reset loudly, and a clear reloads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const { run, pipeline, loaded, checkpoints } = shapeChanges(scratch.path, {
    emitsDeletes: true,
  });
  const fields = { id: shape.id, title: shape.title };
  await run(fields, [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'A' },
  ]);
  const byTitle = { primaryKey: ['title'] };
  await checkpoints.reset('items');

  await assert.rejects(run(fields, [], byTitle), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.match(String(error.errors[0]), /repeat a deduplication key/);
    return true;
  });
  assert.deepEqual(loaded(), [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'A' },
  ]);
  await pipeline(fields, [], byTitle).clear();
  await run(fields, [{ id: 'e', title: 'E' }], byTitle);

  assert.deepEqual(loaded(), [{ id: 'e', title: 'E' }]);
});

test('an overwrite whose stored table no longer fits reloads it rather than evolving it, so a stored value the new shape refuses is replaced', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'items.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  // Each run discovers its stream anew and replaces every row.
  const run = (properties: Properties, rows: readonly object[]) => {
    const items = new Stream({
      name: 'items',
      jsonSchema: { type: 'object', properties },
      supportedSyncModes: ['full_refresh'],
    });
    class Snapshot extends Source {
      override coverage() {
        return { description: 'test', selection: {} };
      }

      protected override async open() {
        return new AsyncDisposableStack();
      }

      readonly identity = 'snapshot';
      protected readonly catalog = new Catalog([items]);
      protected override async *observe({ streams }: SourceWatchOptions) {
        yield streams;
      }
      protected override async *extract() {
        for (const data of rows) yield { stream: 'items', data };
      }
    }
    return new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new Snapshot(),
          destination,
          checkpoints,
          steps: [
            new Copy(items, destination.table('items'), {
              id: 'items',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
          ],
        }),
      ],
    }).run();
  };
  await run({ size: { type: 'string' } }, [{ size: 'L' }]);

  // An INTEGER column refuses the stored 'L', which this run replaces anyway.
  const [reloaded] = await run({ size: { type: 'integer' } }, [{ size: 3 }]);

  assert.equal(reloaded?.count, 1);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT size FROM items')
      .all()
      .map((row) => ({ ...row })),
    [{ size: 3 }],
  );
});

test('a reset reloads into a hidden table: readers keep the old rows until the stream ends, a failed reload resumes, and a new reset discards it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reload-'));
  const items = new Stream({
    name: 'items',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  // A step that holds the read between two checkpoints until the test lets it go.
  const pause = Symbol('pause');
  let script: (SourceMessage | Error | typeof pause)[] = [];
  const received: unknown[] = [];
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  class Scripted extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'scripted';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      state: unknown,
    ) {
      received.push(state);
      for (const step of script) {
        if (step instanceof Error) throw step;
        if (step === pause) {
          reached.resolve();
          await gate.promise;
          continue;
        }
        yield step;
      }
    }
  }
  const row = (id: string) => ({ stream: 'items', data: { id } });
  const reset = { type: 'RESET' as const, stream: 'items' };
  const state = (at: string) => ({
    type: 'STATE' as const,
    stream: 'items',
    state: { at },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'items.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Scripted(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const visible = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id FROM items ORDER BY id')
      .all()
      .map(({ id }) => id);
  };

  script = [row('a1'), row('a2'), state('a')];
  await pipeline.run();

  // Chunk 1 of the reload committed; a reader still sees the previous rows.
  script = [reset, row('b1'), state('b1'), pause, row('b2'), state('b')];
  const reloading = pipeline.run();
  await reached.promise;
  const during = visible();
  gate.resolve();
  await reloading;
  assert.deepEqual(during, ['a1', 'a2']);
  assert.deepEqual(visible(), ['b1', 'b2']);

  // A reload that fails keeps the previous rows visible and resumes.
  script = [reset, row('c1'), state('c1'), new Error('gone')];
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(visible(), ['b1', 'b2']);
  script = [row('c2'), state('c')];
  await pipeline.run();
  assert.deepEqual(visible(), ['c1', 'c2']);

  // A reset while a reload is open starts it over without the stale rows.
  script = [reset, row('d1'), state('d1'), new Error('gone')];
  await assert.rejects(pipeline.run(), PipelineError);
  script = [reset, row('e1'), state('e')];
  await pipeline.run();
  assert.deepEqual(visible(), ['e1']);
  assert.deepEqual(received.slice(1), [
    { at: 'a' },
    { at: 'b' },
    { at: 'c1' },
    { at: 'c' },
    { at: 'd1' },
  ]);
});

test('a stored table that no longer fits evolves without a reload, keeping every file its rows refer to, and a deleted row drops its file', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-files-'));
  const source = new FileSource(scratch.path, {
    a: { version: 1, bytes: Buffer.from('aye') },
    b: { version: 1, bytes: Buffer.from('bee') },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'files.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.files, fileTable(destination, source), {
            id: 'files',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  await pipeline.run();
  const loaded = storedFiles(destination.path);
  // A column added by hand makes the stored table stale; the next run brings
  // it back to the stream's shape with its rows and their files.
  {
    using database = new DatabaseSync(destination.path);
    database.exec('ALTER TABLE files ADD COLUMN extra TEXT');
  }

  const evolved = (await pipeline.run()).map(({ count }) => count);
  const reloaded = storedFiles(destination.path);
  {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    assert.equal(
      database
        .prepare(
          `SELECT 1 FROM pragma_table_info('files') WHERE "name" = 'extra'`,
        )
        .get(),
      undefined,
    );
  }
  assert.deepEqual(evolved, [0]);
  source.contents = { a: { version: 1, bytes: Buffer.from('aye') } };
  await pipeline.run();

  assert.deepEqual(reloaded, loaded);
  assert.deepEqual(storedFiles(destination.path), {
    files: { a: loaded.files.a },
    orphans: 0,
  });
});

test('a file column the target drops takes its stored chunks with it, whether its table evolves or an overwrite reloads it', async () => {
  for (const modes of [
    { syncMode: 'incremental', destinationSyncMode: 'append_dedup' },
    { syncMode: 'full_refresh', destinationSyncMode: 'overwrite' },
  ] as const) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-files-'));
    const source = new FileSource(scratch.path, {
      a: { version: 1, bytes: Buffer.from('aye') },
    });
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'files.sqlite'),
    });
    const checkpoints = new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    });
    const run = (withBytes: boolean) =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            checkpoints,
            steps: [
              new Copy(
                source.files,
                withBytes
                  ? fileTable(destination, source)
                  : destination.table('files', (c) => [
                      c.text('id'),
                      c.integer('version'),
                    ]),
                { id: 'files', ...modes },
              ),
            ],
          }),
        ],
      }).run();
    const chunkTables = () => {
      using database = new DatabaseSync(destination.path, { readOnly: true });
      return database
        .prepare(
          `SELECT "name" FROM sqlite_schema WHERE "type" = 'table' AND "name" LIKE '\\_elt\\_files\\_%' ESCAPE '\\'`,
        )
        .all()
        .map(({ name }) => String(name));
    };
    await run(true);
    const before = chunkTables();
    // Dropping a column changes the copy, which an incremental copy's reset
    // accepts, keeping its rows; the source stops sending the files.
    await checkpoints.reset('files');
    source.withFiles = false;

    await run(false);

    assert.equal(before.length, 1, modes.destinationSyncMode);
    assert.deepEqual(chunkTables(), [], modes.destinationSyncMode);
    using database = new DatabaseSync(destination.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT id, version FROM files')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'a', version: 1 }],
    );
  }
});

test('a copy that declares its columns from the stream and stores its files keeps its rows, checkpoint and files when a field is added and then removed', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-evolve-'));
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'docs.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const received: unknown[] = [];
  // As an Apple connector that keeps attachments declares its import: a
  // column for each field of the stream, then the stored file's reference.
  const run = async (
    properties: Properties,
    rows: readonly { id: string; [field: string]: unknown }[],
  ) => {
    const stream = new Stream({
      name: 'docs',
      jsonSchema: {
        type: 'object',
        description: 'Docs.',
        properties,
        required: ['id'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      supportsFileTransfer: true,
    });
    class Attachments extends Source {
      override coverage() {
        return { description: 'test', selection: {} };
      }

      protected override async open() {
        return new AsyncDisposableStack();
      }

      readonly identity = 'attachments';
      protected readonly catalog = new Catalog([stream]);
      protected override async *observe({ streams }: SourceWatchOptions) {
        yield streams;
      }
      protected override async *extract(
        configuration: CopyConfiguration,
        state: unknown,
      ) {
        received.push(state);
        for await (const message of diffSnapshot(
          configuration.stream,
          rows,
          state,
        )) {
          if ('type' in message) {
            yield message;
            continue;
          }
          const path = join(scratch.path, `${message.data.id}.txt`);
          await writeFile(path, `attachment of ${message.data.id}`);
          yield { ...message, file: path };
        }
      }
    }
    const copy = new Copy(
      stream,
      destination
        .table('raw_docs', (c) => [
          ...SQLiteColumns.fromSchema(stream.jsonSchema),
          c.text('attachmentRef').from(stream.file.store(files)),
        ])
        .withReaderView('docs'),
      {
        id: 'docs',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      },
    );
    const results = await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: new Attachments(),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    }).run();
    return results.map(({ count, deleted }) => ({ count, deleted }));
  };
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT * FROM docs ORDER BY id')
      .all()
      .map(({ loaded_at: _, ...row }) => ({ ...row }));
  };
  const saved = () => {
    using database = new DatabaseSync(join(scratch.path, 'state.sqlite'), {
      readOnly: true,
    });
    const row = database.prepare('SELECT state FROM checkpoints').get();
    return JSON.parse(String(row?.state)).state;
  };
  const scopes = () => readdir(join(scratch.path, 'files', '.elt-files'));
  await run({ id: shape.id, title: shape.title }, [{ id: 'a', title: 'A' }]);
  const [first] = loaded();
  const firstState = saved();

  const added = await run(
    { id: shape.id, title: shape.title, added: shape.added },
    [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', added: 'z' },
    ],
  );
  const afterAdded = loaded();
  const removed = await run({ id: shape.id, title: shape.title }, [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ]);

  assert.deepEqual(added, [{ count: 1, deleted: 0 }]);
  assert.deepEqual(received[1], firstState);
  assert.deepEqual(afterAdded[0], { ...first, added: null });
  assert.equal(afterAdded[1]?.added, 'z');
  assert.deepEqual(removed, [{ count: 1, deleted: 0 }]);
  assert.deepEqual(
    loaded().map(({ id, attachmentRef }) => ({ id, attachmentRef })),
    afterAdded.map(({ id, attachmentRef }) => ({ id, attachmentRef })),
  );
  assert.equal((await scopes()).length, 1);
  for (const { attachmentRef } of loaded())
    assert.match(
      await readFile(String(attachmentRef), 'utf8'),
      /^attachment of /,
    );
});
