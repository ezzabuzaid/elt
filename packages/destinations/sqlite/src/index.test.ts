import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, on } from 'node:events';
import { rmSync } from 'node:fs';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  type Destination,
  diffSnapshot,
  type Partition,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
  StreamStatus,
  type Target,
  TargetOwnedError,
} from 'elt';
import { SQLiteCheckpointStore, SQLiteDestination } from './index.ts';

test('the public ELT API copies source records into SQLite', async () => {
  class TestSource extends Source {
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

test('a source accepts only the stream objects from its own catalog', async () => {
  class OwnedSource extends Source {
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
    { copy, count: 1, deleted: 0, failures: [] },
    { copy: other, count: 1, deleted: 0, failures: [] },
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
    { copy, count: 1, deleted: 0, failures: [] },
  ]);
  assert.equal(loadedVersion(), 2);
  assert.deepEqual(savedVersion(), { version: 2 });
  assert.deepEqual(previousStates, [null, null, { version: 1 }]);

  // Changes received while the consumer is handling a result remain pending.
  version = 3;
  changes.emit('change', [source.records]);
  for await (const results of watching) {
    assert.deepEqual(results, [{ copy, count: 1, deleted: 0, failures: [] }]);
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
    incomplete.value.some(({ failures }) => failures.length > 0),
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
    recovered.value.map(({ failures }) => failures),
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
    { copy, count: 1, deleted: 0, failures: [] },
    { copy: other, count: 1, deleted: 0, failures: [] },
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
          source,
          destination,
          checkpoints,
          steps: [copy],
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
        primaryKey: ['id'],
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
    /must declare sourceDefinedCursor and emitsDeletes/,
  );
});

test('a target has one writer, even when another loads only its own partitions', async () => {
  class Records extends Source {
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
    constructor(
      readonly identity: string,
      readonly owner: string,
    ) {
      super();
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
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.records, target(), {
            id,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
            primaryKey: ['owner', 'id'],
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
        source: late,
        destination,
        steps: [new Copy(late.records, target())],
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
    constructor(readonly identity: string) {
      super();
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
      source,
      destination,
      steps: [new Copy(source.records, destination.table('Records'))],
    }).run();

  await overwrite(first);
  await new Pipeline({
    source: first,
    destination,
    steps: [
      new Copy(first.records, destination.table('records'), {
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite_dedup',
        cursorField: 'version',
        primaryKey: ['id'],
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
  assert.throws(() => destination.table('_MAC_ELT_writers'), /reserved/);
});

test('a pipeline refuses two writers of one target before running any', async () => {
  let extracted = 0;
  class Records extends Source {
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
        primaryKey: ['id'],
      }),
      new Copy(source.copies, destination.table('RECORDS'), {
        id: 'log',
        syncMode: 'full_refresh',
        destinationSyncMode: 'append',
      }),
    ],
  });

  const upsert = (id: string, stream: Stream) =>
    new Copy(stream, destination.table('records'), {
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
      primaryKey: ['id'],
    });
  // Two copies with the same key are still two writers.
  const twins = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [upsert('one', source.records), upsert('two', source.copies)],
  });
  // One read routes by stream, so a stream is copied once per pipeline.
  const doubled = () =>
    new Pipeline({
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(scratch.path, 'state.sqlite'),
      }),
      steps: [upsert('one', source.records), upsert('two', source.records)],
    });

  await assert.rejects(
    pipeline.run(),
    /Target records is written by \{"copy":"upsert"\}; \{"copy":"log"\} cannot write it/,
  );
  await assert.rejects(
    twins.run(),
    /\{"copy":"one"\}; \{"copy":"two"\} cannot write it/,
  );
  await assert.rejects(doubled().run(), /A pipeline copies each stream once/);
  assert.equal(extracted, 0);
});

class Sites extends Source {
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
  constructor(
    public sites: string[],
    public pagesOf: Record<string, Iterable<Record<string, unknown>>>,
  ) {
    super();
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
    primaryKey: ['site', 'path'],
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
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
    JSON.parse(String(saved?.state)).partitions.map(
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
    primaryKey: ['site', 'path'],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
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
    );
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

test('clear drops a target with its checkpoint, and a target dropped by hand is refused until cleared', async () => {
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
      primaryKey: ['site', 'path'],
    });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy('pages')],
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
  await assert.rejects(
    pipeline.run(),
    /Target pages was dropped, but \{"copy":"pages"\} still has a checkpoint; clear the copy/,
  );
  assert.deepEqual(source.received, []);
  const other = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy('other')],
  });
  await assert.rejects(other.clear(), TargetOwnedError);
  assert.equal(saved(), 1);

  await pipeline.clear();
  assert.equal(saved(), 0);
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
    source,
    destination,
    steps: [new Copy(source.pages, destination.table('pages'))],
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
            primaryKey: ['site', 'path'],
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
  assert.throws(
    () =>
      new Copy(partitioned, destination.table('pages'), {
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite_dedup',
        dedupPolicy: 'replace',
        primaryKey: ['path'],
      }).configuration.validateSelection(),
    /partitioned by \["site"\]; select a primaryKey that includes them/,
  );
});

class FileSource extends Source {
  protected override async open() {
    return new AsyncDisposableStack();
  }

  readonly identity = 'file-test';
  readonly files: Stream;
  protected readonly catalog: Catalog;

  constructor(
    readonly staging: string,
    public contents: Record<string, { version: number; bytes: Uint8Array }>,
    readonly snapshot = true,
  ) {
    super();
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
      if ('type' in message) {
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

// Each loaded file's chunk sizes and reassembled hash, plus chunks no row references.
const storedFiles = (path: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  const chunks = database
    .prepare(
      'SELECT f.id, c.bytes FROM files f JOIN "_mac_elt_files_files_bytes" c ON c.file = f.bytes ORDER BY f.id, c.n',
    )
    .all()
    .map((row) => ({ id: String(row.id), bytes: row.bytes as Uint8Array }));
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
      'SELECT count(*) AS n FROM "_mac_elt_files_files_bytes" WHERE file NOT IN (SELECT bytes FROM files WHERE bytes IS NOT NULL)',
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
        primaryKey: ['id'],
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
    source,
    destination,
    steps: [new Copy(source.files, fileTable(destination, source))],
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
        primaryKey: ['id'],
        cursorField: 'version',
        dedupPolicy: 'cursor_newer',
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

test('a checkpoint store keeps each acknowledged state, durable at once, and holds its lock for the run', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const path = join(scratch.path, 'state.sqlite');
  const store = new SQLiteCheckpointStore({ path });
  const bindings = new Map([['copy', { source: 'test', target: 'records' }]]);
  const received: unknown[] = [];
  const run = (states: unknown[], fail = false) =>
    store.run(bindings, async (checkpoints) => {
      const state = checkpoints.state('copy');
      received.push(structuredClone(state));
      if (state !== null && typeof state === 'object')
        Reflect.set(state, 'mutated', true);
      for (const next of states) await checkpoints.save('copy', next);
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
    await checkpoints.save('copy', { page: 4 });
    assert.equal(saved(), JSON.stringify({ page: 4 }));
    await assert.rejects(
      store.run(bindings, async () => {}),
      /database is locked/,
    );
  });
  await run([]);

  assert.deepEqual(received, [null, { page: 2 }, { page: 2 }, { page: 4 }]);
});

test('one checkpoint run holds every copy of a run, each with its own state', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const store = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const bindings = new Map([
    ['left', { target: 'left' }],
    ['right', { target: 'right' }],
  ]);

  await store.run(bindings, async (checkpoints) => {
    await checkpoints.save('left', { page: 1 });
    await checkpoints.save('right', { page: 7 });
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
  const save = (bindings: Map<string, object>) =>
    store.run(bindings, async (checkpoints) => {
      for (const id of bindings.keys())
        await checkpoints.save(id, { from: checkpoints.state(id) });
    });

  await save(
    new Map([
      ['copy', { target: 'a' }],
      ['other', { target: 'x' }],
    ]),
  );
  const changed = store.run(
    new Map([
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
  await store.run(new Map([['copy', { target: 'b' }]]), async (checkpoints) =>
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
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;

  constructor(
    streams: readonly Stream[],
    public scripts: Record<string, readonly (SourceMessage | Error)[]>,
  ) {
    super();
    this.catalog = new Catalog(streams);
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
      primaryKey: ['id'],
    }) as const;
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({ path: statePath }),
    steps: [
      new Copy(broken, destination.table('broken'), incremental('broken')),
      new Copy(good, destination.table('good'), incremental('good')),
      new Copy(snapshot, destination.table('snapshot')),
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
  assert.deepEqual(saved(), ['good={"page":1}']);
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
    source,
    destination,
    checkpoints,
    steps: [
      new Copy(replacing, destination.table('replacing'), {
        id: 'replacing',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        primaryKey: ['id'],
      }),
      new Copy(guarded, destination.table('guarded'), {
        id: 'guarded',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        primaryKey: ['id'],
        cursorField: 'version',
        dedupPolicy: 'cursor_newer',
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
    source,
    destination,
    steps: [new Copy(stream, destination.table('items'))],
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
  const stream = scripted('items', { snapshot: false });
  const source = new ScriptedSource([stream], {
    items: [record('items', 'a', 1), record('items', 'a', 2)],
  });
  const run = (primaryKey: string[]) =>
    new Pipeline({
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
  class Interleaved extends Source {
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
        await setTimeout(name === 'a' ? 3 : 5);
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
      }
      if (name === 'b') {
        yield checkpoint('b', { page: 1 });
        return;
      }
      // a still has staged rows and files when b commits.
      await setTimeout(40);
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
            primaryKey: ['id'],
          },
        ),
    ),
  });
  const loaded = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(
        `SELECT t.id, (SELECT group_concat(CAST(c.bytes AS TEXT), '') FROM "_mac_elt_files_${table}_bytes" c WHERE c.file = t.bytes) AS bytes FROM ${table} t ORDER BY t.id`,
      )
      .all()
      .map(({ id, bytes }) => `${id}=${bytes}`);
  };
  const orphans = (table: string) => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare(
        `SELECT count(*) AS n FROM "_mac_elt_files_${table}_bytes" WHERE file NOT IN (SELECT bytes FROM ${table} WHERE bytes IS NOT NULL)`,
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
  const afterFailure = { a: loaded('a'), b: loaded('b'), saved: saved() };
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
    a: [],
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
    outcome:
      'swept when its target is next prepared, and loaded files stay intact',
    next: 'rerun',
    expected: { loaded: ['d1=d1 bytes', 'd2=d2 bytes'], orphans: 0 },
  },
  {
    outcome: 'removed when its target is cleared',
    next: 'clear',
    expected: { loaded: [], orphans: 0 },
  },
];
for (const { outcome, next, expected } of leftBehind)
  test(`chunks a failed stream left behind in a sibling's commit are ${outcome}`, async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-sweep-'));
    const staging = join(scratch.path, 'staging');
    await mkdir(staging);
    // docs stores its files, notes commits them along with its own rows, and
    // only then does docs fail: its discard never commits, as after a crash.
    // Each gate opens when the consumer asks for a stream's next message, so
    // the order holds without timers.
    class Crossing extends Source {
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
            primaryKey: ['id'],
          },
        ),
        new Copy(source.notes, destination.table('notes'), {
          id: 'notes',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: ['id'],
        }),
      ],
    });
    const stored = () => {
      using database = new DatabaseSync(destination.path, { readOnly: true });
      const loaded = database
        .prepare(
          `SELECT d.id, (SELECT group_concat(CAST(c.bytes AS TEXT), '') FROM "_mac_elt_files_docs_bytes" c WHERE c.file = d.bytes) AS bytes FROM docs d ORDER BY d.id`,
        )
        .all()
        .map(({ id, bytes }) => `${id}=${bytes}`);
      const orphans = database
        .prepare(
          'SELECT count(*) AS n FROM "_mac_elt_files_docs_bytes" WHERE file NOT IN (SELECT bytes FROM docs WHERE bytes IS NOT NULL)',
        )
        .get()?.n;
      return { loaded, orphans };
    };
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
    // The arrange really left d2's chunk behind, unreferenced.
    assert.deepEqual(afterFailure, { loaded: ['d1=d1 bytes'], orphans: 1 });
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
    source: loaded,
    destination,
    steps: [new Copy(plain, destination.table('docs'))],
  }).run();
  const docs = new Stream({ ...scripted('docs'), supportsFileTransfer: true });
  const source = new ScriptedSource([docs], {});
  const pipeline = new Pipeline({
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
    source,
    destination,
    steps: [
      new Copy(notes, destination.table('notes')),
      new Copy(good, destination.table('good')),
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
  assert.equal(database.prepare('SELECT count(*) AS n FROM notes').get()?.n, 0);
});
