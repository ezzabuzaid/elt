import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  Destination,
  isCalendarDate,
  isTimestamp,
  Pipeline,
  Source,
  type SourceWatchOptions,
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

  protected override async open(streams: readonly Stream[]) {
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

class DrainingWriter extends Writer {
  protected override async writeRecords(
    operations: AsyncIterable<WriteOperation>,
  ) {
    return { count: (await Array.fromAsync(operations)).length, deleted: 0 };
  }
}

// Consumes every record and keeps none, so these tests observe only the pipeline.
class DrainingDestination extends Destination<NamedTarget> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
  ] as const);

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
    return new DrainingWriter(configuration.stream);
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

test('a failed copy still closes the run session', async () => {
  const source = new SessionSource('right');
  const pipeline = sessionPipeline(source);

  await assert.rejects(pipeline.run(), { name: 'PipelineError' });

  assert.deepEqual(source.opened, [1]);
  assert.deepEqual(source.closed, [1]);
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

test('a read without a session opens its own and closes it', async () => {
  const source = new SessionSource();
  const copy = new Copy(source.left, new NamedTarget('unused'));

  await Array.fromAsync(source.read(copy.configuration, null));

  assert.deepEqual(source.opened, [1]);
  assert.deepEqual(source.closed, [1]);
  assert.deepEqual(source.sessionStreams, [['left']]);
});
