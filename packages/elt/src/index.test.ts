import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Catalog,
  type CheckpointSession,
  CheckpointStore,
  Copy,
  type CopyConfiguration,
  Destination,
  isCalendarDate,
  isTimestamp,
  type Load,
  type Partition,
  Pipeline,
  PipelineError,
  Source,
  type SourceWatchOptions,
  type StoredCheckpoint,
  Stream,
  Target,
  validateRecords,
  type WriteOperation,
  Writer,
} from './index.ts';

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

class SessionSource extends Source<AsyncDisposable & { readonly id: number }> {
  readonly identity = 'session-test';
  readonly opened: number[] = [];
  readonly closed: number[] = [];
  readonly readers: { stream: string; session: number }[] = [];
  readonly left = new Stream({
    name: 'left',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });
  readonly right = new Stream({
    name: 'right',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.left, this.right]);

  constructor(readonly failing?: string) {
    super();
  }

  readonly sessionStreams: string[][] = [];

  override async session(streams: readonly Stream[]) {
    const id = this.opened.length + 1;
    this.opened.push(id);
    this.sessionStreams.push(streams.map((stream) => stream.name));
    return {
      id,
      [Symbol.asyncDispose]: async () => {
        this.closed.push(id);
      },
    };
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
    yield [this.right];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
    _partition: null,
    session: AsyncDisposable & { readonly id: number },
  ) {
    const stream = configuration.stream.name;
    this.readers.push({ stream, session: session.id });
    if (stream === this.failing) throw new Error(`${stream} failed`);
    yield { stream, data: { id: `${stream}-${session.id}` } };
  }
}

class NamedTarget extends Target {
  constructor(readonly name: string) {
    super();
  }
}

// Logs each step of the load protocol and keeps no rows, so these tests
// observe only what the engine asks of a destination.
class RecordingWriter extends Writer {
  constructor(
    stream: Stream,
    readonly log: string[],
  ) {
    super(stream);
  }

  protected override async open(): Promise<Load> {
    const { log } = this;
    log.push('open');
    return {
      apply: async (operation: WriteOperation) => {
        log.push(
          operation.type === 'RECORD'
            ? `apply ${JSON.stringify(operation.data)}`
            : 'delete',
        );
      },
      commit: async () => {
        log.push('commit');
      },
      discard: async () => {
        log.push('discard');
      },
      [Symbol.asyncDispose]: async () => {
        log.push('close');
      },
    };
  }

  override async clear(): Promise<void> {
    this.log.push('clear');
  }
}

class DrainingDestination extends Destination<NamedTarget> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
  ] as const);
  readonly log: string[] = [];

  override identity(target: NamedTarget): string {
    return target.name;
  }

  override location(target: NamedTarget): string {
    return target.name;
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: NamedTarget,
  ): Writer {
    this.validateConfiguration(configuration, target);
    return new RecordingWriter(configuration.stream, this.log);
  }
}

const sessionPipeline = (source: SessionSource) =>
  new Pipeline({
    source,
    destination: new DrainingDestination(),
    steps: [
      new Copy(source.left, new NamedTarget('left')),
      new Copy(source.right, new NamedTarget('right')),
    ],
  });

test('every copy in a pipeline run reads through one session, closed after the run', async () => {
  const source = new SessionSource();
  const pipeline = sessionPipeline(source);

  await pipeline.run();
  await pipeline.run();

  assert.deepEqual(source.readers, [
    { stream: 'left', session: 1 },
    { stream: 'right', session: 1 },
    { stream: 'left', session: 2 },
    { stream: 'right', session: 2 },
  ]);
  assert.deepEqual(source.closed, [1, 2]);
  assert.deepEqual(source.sessionStreams, [
    ['left', 'right'],
    ['left', 'right'],
  ]);
});

test('a failed copy does not stop later copies, and the run reports it at the end', async () => {
  const source = new SessionSource('left');
  const pipeline = sessionPipeline(source);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the failed copy'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.match(error.message, /did not load completely: left: left failed/);
  assert.equal((error.cause as Error).message, 'left failed');
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.map(({ partition }) => partition),
    ]),
    [
      ['left', 0, [null]],
      ['right', 1, []],
    ],
  );
  assert.deepEqual(source.readers, [
    { stream: 'left', session: 1 },
    { stream: 'right', session: 1 },
  ]);
  assert.deepEqual(source.closed, [1]);
});

class MemoryCheckpoints extends CheckpointStore {
  readonly saved = new Map<string, StoredCheckpoint>();

  constructor(readonly log: string[]) {
    super();
  }

  protected override async session<T>(
    id: string,
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    return work({
      read: async () => this.saved.get(id),
      save: async (checkpoint) => {
        this.log.push(`save ${checkpoint.state}`);
        this.saved.set(id, checkpoint);
      },
      remove: async () => {
        this.saved.delete(id);
      },
    });
  }
}

// Reads one record per site, then a checkpoint naming the run; sites listed
// in down fail after emitting their record.
class Sites extends Source {
  readonly identity = 'sites';
  readonly down = new Set<string>();
  readonly received: [string, unknown][] = [];
  readonly pages = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: { site: { type: 'string' }, run: { type: 'integer' } },
    },
    primaryKey: ['site'],
    partitionKey: ['site'],
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  protected readonly catalog = new Catalog([this.pages]);
  run = 1;

  override async session() {
    return new AsyncDisposableStack();
  }

  protected override partitions() {
    return ['a', 'b', 'c'].map((site) => ({ site }));
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
    yield { stream: 'pages', data: { site, run: this.run } };
    if (this.down.has(site)) throw new Error(`${site} is down`);
    yield { type: 'STATE' as const, stream: 'pages', state: { run: this.run } };
  }
}

test('each checkpoint commits its partition, and a failing partition keeps its last checkpoint while the others load', async () => {
  const source = new Sites();
  const destination = new DrainingDestination();
  const checkpoints = new MemoryCheckpoints(destination.log);
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [
      new Copy(source.pages, new NamedTarget('pages'), {
        id: 'pages',
        syncMode: 'incremental',
        destinationSyncMode: 'append',
      }),
    ],
  });
  source.down.add('b');

  const error = await pipeline.run().then(
    () => assert.fail('run should report the failed partition'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.match(error.message, /pages \{"site":"b"\}: b is down/);
  const [result] = error.results;
  assert.equal(result?.count, 2);
  assert.deepEqual(
    result?.failures.map(({ partition }) => partition),
    [{ site: 'b' }],
  );
  const a = { partition: { site: 'a' }, state: { run: 1 } };
  const c = { partition: { site: 'c' }, state: { run: 1 } };
  assert.deepEqual(destination.log, [
    'open',
    'apply {"site":"a","run":1}',
    'commit',
    `save ${JSON.stringify({ partitions: [a] })}`,
    'apply {"site":"b","run":1}',
    'discard',
    'apply {"site":"c","run":1}',
    'commit',
    `save ${JSON.stringify({ partitions: [a, c] })}`,
    'close',
  ]);

  source.down.clear();
  source.run = 2;
  source.received.length = 0;
  await pipeline.run();

  assert.deepEqual(source.received, [
    ['a', { run: 1 }],
    ['b', null],
    ['c', { run: 1 }],
  ]);
  assert.deepEqual(JSON.parse(checkpoints.saved.get('pages')?.state ?? ''), {
    partitions: ['a', 'b', 'c'].map((site) => ({
      partition: { site },
      state: { run: 2 },
    })),
  });
});

test('a full refresh commits once, and a failing partition commits nothing', async () => {
  const source = new Sites();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    source,
    destination,
    steps: [new Copy(source.pages, new NamedTarget('pages'))],
  });

  await pipeline.run();
  assert.deepEqual(destination.log, [
    'open',
    'apply {"site":"a","run":1}',
    'apply {"site":"b","run":1}',
    'apply {"site":"c","run":1}',
    'commit',
    'close',
  ]);

  destination.log.length = 0;
  source.down.add('b');
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(destination.log, [
    'open',
    'apply {"site":"a","run":1}',
    'apply {"site":"b","run":1}',
    'discard',
    'close',
  ]);
});

test('a watch opens one session per batch and holds none while idle', async () => {
  const source = new SessionSource();
  const pipeline = sessionPipeline(source);
  const held: number[] = [];

  for await (const _ of pipeline.watch({ signal: AbortSignal.timeout(5000) }))
    held.push(source.opened.length - source.closed.length);

  assert.deepEqual(held, [0, 0]);
  assert.deepEqual(source.sessionStreams, [['left', 'right'], ['right']]);
  assert.deepEqual(source.readers, [
    { stream: 'left', session: 1 },
    { stream: 'right', session: 1 },
    { stream: 'right', session: 2 },
  ]);
});
