import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, on } from 'node:events';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
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
  type Target,
} from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  type SQLiteTable,
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
    copy.writer(source),
  );
  assert.deepEqual(names(), ['a:A', 'b:B2', 'd:D']);

  const read = (state: unknown) =>
    Array.fromAsync(source.read(copy.configuration, state));
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

test('a target has one writer, even when another loads only its own partitions', async () => {
  class Records extends Source {
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
    protected readonly catalog = new Catalog([this.records]);
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
      new Copy(source.records, destination.table('RECORDS'), {
        id: 'log',
        syncMode: 'full_refresh',
        destinationSyncMode: 'append',
      }),
    ],
  });

  const upsert = (id: string) =>
    new Copy(source.records, destination.table('records'), {
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
      primaryKey: ['id'],
    });
  // Two copies of one stream with the same key are still two writers.
  const twins = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [upsert('one'), upsert('two')],
  });

  await assert.rejects(
    pipeline.run(),
    /Target records is written by \{"copy":"upsert"\}; \{"copy":"log"\} cannot write it/,
  );
  await assert.rejects(
    twins.run(),
    /\{"copy":"one"\}; \{"copy":"two"\} cannot write it/,
  );
  assert.equal(extracted, 0);
});

class Sites extends Source {
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
    public pagesOf: Record<string, Record<string, unknown>[]>,
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

test('a partition failure or foreign row commits nothing for any partition', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-part-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const run = (source: Sites) =>
    new Pipeline({
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(source.pages, destination.table('pages'), {
          id: 'pages',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: ['site', 'path'],
        }),
      ],
    }).run();

  await assert.rejects(
    run(new Sites(['a', 'b'], { a: [{ site: 'a', path: '/', views: 1 }] })),
    /site b is down/,
  );
  await assert.rejects(
    run(
      new Sites(['a', 'b'], {
        a: [{ site: 'a', path: '/', views: 1 }],
        b: [{ site: 'a', path: '/other', views: 1 }],
      }),
    ),
    /record for partition \{"site":"b"\} carries site "a"/,
  );

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'pages'")
      .all(),
    [],
  );
  using state = new DatabaseSync(checkpoints.path, { readOnly: true });
  assert.deepEqual(state.prepare('SELECT * FROM checkpoints').all(), []);
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
  const read = (sites: string[], state: unknown = null) => {
    const source = new Sites(sites, { a: [] });
    return Array.fromAsync(
      source.read(
        new Copy(source.pages, destination.table('pages'), {
          id: 'pages',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: ['site', 'path'],
        }).configuration,
        state,
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

test('a checkpoint store resumes from the last acknowledged state only', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const store = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const binding = { source: 'test', target: 'records' };
  const received: unknown[] = [];
  const write =
    (states: unknown[], fail = false) =>
    async (state: unknown) => {
      received.push(structuredClone(state));
      if (state !== null && typeof state === 'object')
        Reflect.set(state, 'mutated', true);
      if (fail) throw new Error('source broke');
      return {
        count: states.length,
        deleted: 0,
        checkpoints: states.map((state) => ({
          type: 'STATE' as const,
          stream: 'records',
          state,
        })),
      };
    };

  await store.run('copy', binding, write([{ page: 1 }, { page: 2 }]));
  // No acknowledgement keeps the saved state, even though the input was mutated.
  await store.run('copy', binding, write([]));
  await assert.rejects(
    store.run('copy', binding, write([{ page: 9 }], true)),
    /source broke/,
  );
  await store.run('copy', binding, write([]));

  assert.deepEqual(received, [null, { page: 2 }, { page: 2 }, { page: 2 }]);
});

test('a changed binding is refused until the checkpoint is reset', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-state-'));
  const store = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  let called = 0;
  const write = async (state: unknown) => {
    called++;
    return {
      count: 0,
      deleted: 0,
      checkpoints: [
        { type: 'STATE' as const, stream: 'records', state: { from: state } },
      ],
    };
  };

  await store.run('copy', { target: 'a' }, write);
  await assert.rejects(
    store.run('copy', { target: 'b' }, write),
    /Checkpoint binding changed for copy; reset it or use a new copy ID/,
  );
  assert.equal(called, 1);
  await store.reset('copy');
  await store.run('copy', { target: 'b' }, async (state) => {
    assert.equal(state, null);
    return write(state);
  });
  assert.equal(called, 2);
});
