import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  isCalendarDate,
  isTimestamp,
  Pipeline,
  PipelineError,
  Source,
  type SourceWatchOptions,
  SQLiteCheckpointStore,
  SQLiteDestination,
  Stream,
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

  assert.deepEqual(results, [{ copy, count: 1 }]);
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
    { copy, count: 1 },
    { copy: other, count: 1 },
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
  assert.deepEqual((await watching.next()).value, [{ copy, count: 1 }]);
  assert.equal(loadedVersion(), 2);
  assert.deepEqual(savedVersion(), { version: 2 });
  assert.deepEqual(previousStates, [null, null, { version: 1 }]);

  // Changes received while the consumer is handling a result remain pending.
  version = 3;
  changes.emit('change', [source.records]);
  for await (const results of watching) {
    assert.deepEqual(results, [{ copy, count: 1 }]);
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
    { copy, count: 1 },
    { copy: other, count: 1 },
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
