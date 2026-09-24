import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { mkdtempDisposable, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  diffSnapshot,
  isCalendarDate,
  isTimestamp,
  MarkdownDestination,
  type MarkdownFile,
  type MarkdownFolder,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  SQLiteCheckpointStore,
  SQLiteDestination,
  type SQLiteTable,
  Stream,
  validateRecords,
} from './index.ts';

test('the public ELT API copies source records into SQLite', async () => {
  class TestSource extends Source {
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
    source,
    destination,
    steps: [copy],
  }).run();

  assert.deepEqual(results, [{ copy, count: 1, deleted: 0 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const row = database.prepare('SELECT id, name FROM records').get();
  assert.ok(row);
  assert.deepEqual({ ...row }, { id: 'record-1', name: 'Test record' });
});

test('date formats accept only canonical UTC timestamps and real calendar dates', () => {
  assert.equal(isTimestamp('2025-01-02T03:04:05.006Z'), true);
  for (const value of [
    '2025-01-02T03:04:05Z',
    '2025-01-02T03:04:05.006+00:00',
    '2025-02-30T00:00:00.000Z',
    1735787045006,
  ])
    assert.equal(isTimestamp(value), false);
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const value of ['2025-02-29', '2025-1-02', '2025-01-02T00:00:00.000Z'])
    assert.equal(isCalendarDate(value), false);
});

test('record validation enforces every property of the stream schema', () => {
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 0, maximum: 9 },
        ratio: { type: 'number' },
        kind: { type: 'string', enum: ['a', 'b'] },
        done: { type: 'boolean' },
        at: { type: ['string', 'null'], format: 'date-time' },
        on: { type: 'string', format: 'date' },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const valid = {
    id: 'item-1',
    count: 3,
    ratio: 0.5,
    kind: 'a',
    done: false,
    at: null,
    on: '2024-02-29',
  };

  assert.deepEqual(validateRecords(stream, [valid], 'Test'), [valid]);
  const rejects = (records: unknown, message: string) =>
    assert.throws(() => validateRecords(stream, records, 'Test'), { message });
  rejects({}, 'Test returned invalid items records');
  rejects([null], 'Test returned an invalid items record');
  rejects([{ ...valid, extra: 1 }], 'Test returned an invalid items record');
  const { done: _, ...missing } = valid;
  rejects([missing], 'Test returned an invalid items record');
  for (const [field, value] of [
    ['id', ''],
    ['id', null],
    ['count', 1.5],
    ['count', 2 ** 53],
    ['count', -1],
    ['count', 10],
    ['ratio', Number.NaN],
    ['kind', 'c'],
    ['done', 'false'],
    ['at', '2025-01-02T03:04:05Z'],
    ['on', '2025-02-29'],
  ] as const)
    rejects(
      [{ ...valid, [field]: value }],
      `Test returned invalid items.${field}`,
    );
  const unsupported = new Stream({
    name: 'nested',
    jsonSchema: { type: 'object', properties: { tags: { type: 'array' } } },
    supportedSyncModes: ['full_refresh'],
  });
  assert.throws(
    () => validateRecords(unsupported, [], 'Test'),
    /nested\.tags declares an unsupported type/,
  );
});

test('a source accepts only the stream objects from its own catalog', async () => {
  class OwnedSource extends Source {
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
      for await (const [affected] of events)
        yield affected as readonly Stream[];
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
    source,
    destination,
    checkpoints,
    steps: [copy, other],
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
  assert.deepEqual((await watching.next()).value, [
    { copy, count: 1, deleted: 0 },
    { copy: other, count: 1, deleted: 0 },
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
    );
  assert.equal(loadedVersion(), 1);
  assert.deepEqual(savedVersion(), { version: 1 });
  assert.deepEqual((await watching.next()).value, [
    { copy, count: 1, deleted: 0 },
  ]);
  assert.equal(loadedVersion(), 2);
  assert.deepEqual(savedVersion(), { version: 2 });
  assert.deepEqual(previousStates, [null, null, { version: 1 }]);

  // Changes received while the consumer is handling a result remain pending.
  version = 3;
  changes.emit('change', [source.records]);
  for await (const results of watching) {
    assert.deepEqual(results, [{ copy, count: 1, deleted: 0 }]);
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

  const failed = pipeline.watch({ signal: new AbortController().signal });
  await failed.next();
  version = Number.NaN;
  changes.emit('change', [source.records]);
  await assert.rejects(failed.next(), PipelineError);
  assert.equal(loadedVersion(), 3);
  assert.deepEqual(savedVersion(), { version: 3 });
  assert.equal(changes.listenerCount('change'), 0);

  version = 4;
  const broken = pipeline.watch({ signal: new AbortController().signal });
  await broken.next();
  const nativeError = new Error('Native watcher failed');
  changes.emit('error', nativeError);
  await assert.rejects(broken.next(), (error) => error === nativeError);
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
  assert.deepEqual((await inFlight.next()).value, [
    { copy, count: 1, deleted: 0 },
    { copy: other, count: 1, deleted: 0 },
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
    source,
    destination,
    checkpoints,
    steps: [copy, copy],
  });
  await assert.rejects(
    invalid.watch({ signal: new AbortController().signal }).next(),
    /IDs must be distinct/,
  );
  assert.equal(changes.listenerCount('change'), 0);
});

test('a cursor inside the primary key is rejected unless the policy replaces', async () => {
  class MetricsSource extends Source {
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
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(source.metrics, destination.table(name), {
          ...modes,
          id: name,
        }),
      ],
    }).run();

  await assert.rejects(
    validating('guarded', guarded),
    /can never update a conflicting row/,
  );
  await assert.rejects(
    validating('unknown', { ...guarded, dedupPolicy: 'newest' } as never),
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
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [replacing, guarding],
  });

  assert.deepEqual(await pipeline.run(), [
    { copy: replacing, count: 1, deleted: 0 },
    { copy: guarding, count: 1, deleted: 0 },
  ]);
  clicks = 19;
  // The replay is accepted by both copies; only the policy decides the row.
  assert.deepEqual(await pipeline.run(), [
    { copy: replacing, count: 1, deleted: 0 },
    { copy: guarding, count: 1, deleted: 0 },
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

test('Markdown file and folder targets honor the deduplication policy', async () => {
  let clicks = 12;
  class RestatingSource extends Source {
    readonly identity = 'markdown-restating-test';
    readonly metrics = new Stream({
      name: 'metrics',
      jsonSchema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          query: { type: 'string' },
          clicks: { type: 'number' },
        },
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

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-md-'));
  const source = new RestatingSource();
  const destination = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  const targets = [
    destination.file('replacing.md'),
    destination.folder('replacing'),
    destination.file('guarding.md'),
    destination.folder('guarding'),
  ];
  const copies = targets.map(
    (target) =>
      new Copy(source.metrics, target, {
        id: target.name,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'date',
        primaryKey: ['query'],
        dedupPolicy: target.name.startsWith('replacing')
          ? 'replace'
          : 'cursor_newer',
      }),
  );
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: copies,
  });
  const clicksIn = async (name: string) => {
    const path = join(destination.path, name);
    const files = name.endsWith('.md')
      ? [path]
      : (await readdir(path)).map((file) => join(path, file));
    const documents = await Promise.all(
      files.map((file) => readFile(file, 'utf8')),
    );
    return documents.flatMap((document) =>
      Array.from(
        document.matchAll(/^<!-- mac-elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .clicks,
      ),
    );
  };

  await pipeline.run();
  clicks = 19;
  await pipeline.run();

  assert.deepEqual(
    await Promise.all(targets.map((target) => clicksIn(target.name))),
    [[19], [19], [12], [12]],
  );
});

test('deletions remove keyed rows from deduplicating SQLite and Markdown targets', async () => {
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
  const markdown = new MarkdownDestination({ path: join(scratch.path, 'md') });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const selection = {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
  } as const;
  const copy = <Target extends MarkdownFile | MarkdownFolder | SQLiteTable>(
    to: Target,
    id: string,
  ) => new Copy(items, to, { ...selection, id });
  const pipelines = [
    new Pipeline({
      source,
      destination: sqlite,
      checkpoints,
      steps: [copy(sqlite.table('items'), 'sqlite')],
    }),
    new Pipeline({
      source,
      destination: markdown,
      checkpoints,
      steps: [
        copy(markdown.file('items.md'), 'file'),
        copy(markdown.folder('items'), 'folder'),
      ],
    }),
  ];
  const names = async () => {
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    const decode = (document: string) =>
      Array.from(
        document.matchAll(/^<!-- mac-elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .name,
      );
    const folder = join(markdown.path, 'items');
    return [
      database
        .prepare('SELECT name FROM items ORDER BY id')
        .all()
        .map((row) => row.name),
      decode(await readFile(join(markdown.path, 'items.md'), 'utf8')).sort(),
      (
        await Promise.all(
          (
            await readdir(folder)
          ).map(async (file) =>
            decode(await readFile(join(folder, file), 'utf8')),
          ),
        )
      )
        .flat()
        .sort(),
    ];
  };
  const runAll = async () => {
    const results = [];
    for (const pipeline of pipelines) results.push(...(await pipeline.run()));
    return results.map(({ count, deleted }) => ({ count, deleted }));
  };

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
  assert.deepEqual(await runAll(), Array(3).fill({ count: 2, deleted: 3 }));
  assert.deepEqual(await names(), Array(3).fill(['A2']));
  // At-least-once replay of the same operations leaves every target unchanged.
  assert.deepEqual(await runAll(), Array(3).fill({ count: 2, deleted: 3 }));
  assert.deepEqual(await names(), Array(3).fill(['A2']));
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
  const rejects = (options: object, message: RegExp) =>
    assert.throws(
      () =>
        new Copy(items, sqlite.table('items'), {
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: ['id'],
          id: 'items',
          ...options,
        } as ConstructorParameters<typeof Copy>[2]).validate(
          source,
          sqlite,
          checkpoints,
        ),
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
  rejects({ primaryKey: ['rank'] }, /select primaryKey \["id"\]/);
  rejects({ cursorField: 'rank' }, /defines its own cursor; omit cursorField/);
  rejects({ dedupPolicy: 'cursor_newer' }, /no cursor field to compare/);
  const copy = new Copy(items, sqlite.table('items'), {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
    id: 'items',
  });
  assert.equal(copy.configuration.dedupPolicy, 'replace');

  const run = (to = copy) =>
    new Pipeline({
      source,
      destination: sqlite,
      checkpoints,
      steps: [to],
    }).run();
  for (const [key, message] of [
    [{}, /exactly its primary key/],
    [{ id: 'a', rank: 1 }, /exactly its primary key/],
    [{ id: 1 }, /DELETE for items has an invalid id|requires non-null string/],
    [{ id: '\uD800' }, /invalid id/],
  ] as const) {
    messages = [{ type: 'DELETE', stream: 'items', key: key as never }];
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
      source: new PlainSource(),
      destination: sqlite,
      steps: [new Copy(plain, sqlite.table('plain'))],
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
    primaryKey: ['id'],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({ path: statePath }),
    steps: [copy],
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
    );
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
  await destination.write(
    copy.configuration,
    copy.to,
    source.read(copy.configuration, firstState),
  );
  assert.deepEqual(names(), ['a:A', 'b:B2', 'd:D']);

  const read = (state: unknown) =>
    Array.fromAsync(source.read(copy.configuration, state));
  for (const invalid of [
    {},
    { snapshot: [] },
    { snapshot: {}, extra: true },
    { snapshot: { '["a"]': 'short' } },
    { snapshot: { '["a","b"]': 'A'.repeat(43) } },
    { snapshot: { '[1]': 'A'.repeat(43) } },
    { snapshot: { '[ "a" ]': 'A'.repeat(43) } },
    { snapshot: { 'not json': 'A'.repeat(43) } },
  ])
    await assert.rejects(
      read(invalid),
      /Invalid snapshot checkpoint for stream items/,
    );
  rows = [
    { id: 'a', name: 'A' },
    { id: 'a', name: 'again' },
  ];
  await assert.rejects(read(null), /returned key \["a"\] twice in one scan/);
  const plain = new Stream({
    ...items,
    sourceDefinedCursor: undefined,
    emitsDeletes: undefined,
  });
  await assert.rejects(
    Array.fromAsync(diffSnapshot(plain, [], null)),
    /must declare sourceDefinedCursor and emitsDeletes/,
  );
});
