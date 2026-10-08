import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Catalog,
  type CheckpointSession,
  CheckpointStore,
  Connection,
  Copy,
  CopyConfiguration,
  type DeclaredCopy,
  Destination,
  DocumentParser,
  FileRead,
  FileStorage,
  type Load,
  LocalFiles,
  type Partition,
  Pipeline,
  PipelineError,
  type ReadMessage,
  type RecordedPass,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stage,
  type StoredCheckpoint,
  Stream,
  StreamStatus,
  SyncHistory,
  Target,
  type WriteOperation,
  Writer,
  isCalendarDate,
  isTimestamp,
  passStatus,
  validateRecords,
} from './index.ts';

test('file storage declarations validate identities and keep parsing separate without doing I/O', () => {
  const stream = new Stream({
    name: 'files',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  const storage = new (class extends FileStorage {
    override identity = 'test-store';
    override reference = 'A test reference.';
    override async save(): Promise<string> {
      throw new Error('unexpected save');
    }
    override async retain(): Promise<void> {
      throw new Error('unexpected cleanup');
    }
  })();
  const parser = new (class extends DocumentParser {
    override async parse(): Promise<string> {
      throw new Error('unexpected parse');
    }
  })('test-parser');
  const stored = stream.file.store(storage);
  const read = new FileRead('reference', stored);
  read.validate(stream);
  assert.equal(read.outputType, 'text');
  assert.equal(new FileRead('bytes', stream.file).outputType, 'bytes');
  assert.equal(stream.file.storage, undefined);
  assert.equal(JSON.parse(JSON.stringify(read)).storage, storage.identity);
  assert.throws(
    () => new FileRead('reference', stored, parser),
    /separate file fields/,
  );
  storage.identity = 'another-store';
  assert.throws(() => read.validate(stream), /identity changed/);
  storage.identity = '';
  assert.throws(() => stream.file.store(storage), /stable text identity/);
  for (const directory of ['', 'bad\0path', '\ud800'])
    assert.throws(() => new LocalFiles({ directory }), /requires a directory/);
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
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        seen: {
          type: ['array', 'null'],
          items: { type: 'string', format: 'date-time' },
        },
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
    tags: ['x', 'y'],
    seen: null,
  };

  assert.deepEqual(validateRecords(stream, [valid], 'Test'), [valid]);
  const listed = { ...valid, tags: [], seen: ['2025-01-02T03:04:05.000Z'] };
  assert.deepEqual(validateRecords(stream, [listed], 'Test'), [listed]);
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
    ['tags', 'x'],
    ['tags', null],
    ['tags', ['']],
    ['tags', ['x', 1]],
    ['seen', ['2025-01-02T03:04:05Z']],
    ['seen', [null]],
  ] as const)
    rejects(
      [{ ...valid, [field]: value }],
      `Test returned invalid items.${field}`,
    );
  for (const tags of [
    { type: 'array' },
    { type: 'array', items: { type: 'null' } },
    { type: ['array', 'string'], items: { type: 'string' } },
    { type: 'string', items: { type: 'string' } },
    { type: 'array', minLength: 1, items: { type: 'string' } },
  ]) {
    const unsupported = new Stream({
      name: 'nested',
      // @ts-expect-error -- some of these schemas are invalid FieldSchemas; the check must reject them at run time too
      jsonSchema: { type: 'object', properties: { tags } },
      supportedSyncModes: ['full_refresh'],
    });
    assert.throws(
      () => validateRecords(unsupported, [], 'Test'),
      /nested\.tags declares an unsupported type/,
    );
  }
});

test('string formats accept exactly one canonical spelling of each value', () => {
  const stream = new Stream({
    name: 'values',
    jsonSchema: {
      type: 'object',
      properties: {
        legacy: { type: 'string', format: 'date-time' },
        instant: { type: 'string', format: 'date-time', precision: 7 },
        whole: { type: 'string', format: 'date-time', precision: 0 },
        local: { type: 'string', format: 'date-time-local', precision: 7 },
        clock: { type: 'string', format: 'time-local', precision: 3 },
        count: { type: 'string', format: 'int64' },
        money: { type: 'string', format: 'decimal', precision: 19, scale: 4 },
        ratio: { type: ['string', 'null'], format: 'decimal' },
        bytes: { type: 'string', contentEncoding: 'base64' },
        ids: { type: 'array', items: { type: 'string', format: 'int64' } },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const valid = {
    legacy: '2025-01-02T03:04:05.006Z',
    instant: '2025-01-02T03:04:05.1234567Z',
    whole: '2025-01-02T03:04:05Z',
    local: '9999-12-31T23:59:59.9999999',
    clock: '23:59:59.999',
    count: '-9223372036854775808',
    money: '922337203685477.5807',
    ratio: '-0.5',
    bytes: 'AAEC/w==',
    ids: ['9223372036854775807', '0'],
  };

  assert.deepEqual(validateRecords(stream, [valid], 'Test'), [valid]);
  for (const [field, value] of [
    ['legacy', '2025-01-02T03:04:05.1234567Z'],
    ['instant', '2025-01-02T03:04:05.123Z'],
    ['instant', '2025-02-30T03:04:05.1234567Z'],
    ['whole', '2025-01-02T03:04:05.000Z'],
    ['local', '2025-01-02T03:04:05.1234567Z'],
    ['clock', '23:59:59'],
    ['clock', '24:00:00.000'],
    ['count', '9223372036854775808'],
    ['count', '-9223372036854775809'],
    ['count', '007'],
    ['count', '-0'],
    ['count', 7],
    ['money', '1.5'],
    ['money', '12345678901234567.0000'],
    ['money', '-0.0000'],
    ['ratio', '0.50'],
    ['ratio', '1e3'],
    ['ratio', '+1'],
    ['bytes', 'AAEC/w'],
    ['bytes', 'AAEC_w=='],
    ['bytes', 'AAEC/x=='],
    ['ids', ['01']],
  ] as const)
    assert.throws(
      () => validateRecords(stream, [{ ...valid, [field]: value }], 'Test'),
      { message: `Test returned invalid values.${field}` },
    );
  for (const value of [
    { type: 'integer', format: 'int64' },
    { type: 'string', precision: 3 },
    { type: 'string', format: 'date', precision: 3 },
    { type: 'string', format: 'int64', precision: 3 },
    { type: 'string', format: 'date-time', scale: 2 },
    { type: 'string', format: 'date-time', precision: 10 },
    { type: 'string', format: 'date-time-local', precision: 1.5 },
    { type: 'string', format: 'decimal', scale: 2 },
    { type: 'string', format: 'decimal', precision: 2, scale: 3 },
    { type: 'string', format: 'int64', contentEncoding: 'base64' },
    { type: 'string', contentEncoding: 'hex' },
    {
      type: 'array',
      precision: 3,
      items: { type: 'string', format: 'date-time' },
    },
  ]) {
    const declared = new Stream({
      name: 'declared',
      // @ts-expect-error -- some of these schemas are invalid FieldSchemas; the check must reject them at run time too
      jsonSchema: { type: 'object', properties: { value } },
      supportedSyncModes: ['full_refresh'],
    });
    assert.throws(
      () => validateRecords(declared, [], 'Test'),
      /declared\.value declares an unsupported type/,
    );
  }
});

test('expiry keeps millisecond timestamps, and decimal or base64 fields cannot be cursors', () => {
  const properties = {
    id: { type: 'string', format: 'int64' },
    amount: { type: 'string', format: 'decimal' },
    hash: { type: 'string', contentEncoding: 'base64' },
    at: { type: 'string', format: 'date-time', precision: 7 },
  } as const;
  const stream = new Stream({
    name: 'ledger',
    jsonSchema: { type: 'object', properties },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
  });

  assert.throws(
    () =>
      new Stream({
        name: 'expiring',
        jsonSchema: { type: 'object', properties },
        primaryKey: ['id'],
        supportedSyncModes: ['incremental'],
        emitsDeletes: true,
        expiresBy: 'at',
      }),
    { message: 'expiresBy at must keep milliseconds; it declares precision 7' },
  );
  for (const [cursorField, format] of [
    ['amount', 'decimal'],
    ['hash', 'base64'],
  ] as const)
    assert.throws(
      () =>
        new CopyConfiguration(stream, {
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          cursorField,
        }).validateSelection(),
      {
        message: `Deduplication cursor ${cursorField} cannot order ${format} values`,
      },
    );
});

type ReadContext = AsyncDisposable & { readonly id: number };

// One scripted extract step: a message to emit or an error to throw. A
// StreamStatus plays a connector that reports status itself, which only
// Source.read may do.
type Step = SourceMessage | StreamStatus | Error;

const idStream = (name: string) =>
  new Stream({
    name,
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });

const record = (stream: string, id: string): SourceMessage => ({
  stream,
  data: { id },
});

const checkpoint = (stream: string, at: number): SourceMessage => ({
  type: 'STATE',
  stream,
  state: { at },
});

class ContextSource extends Source<ReadContext> {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  readonly identity = 'context-test';
  readonly opened: number[] = [];
  readonly closed: number[] = [];
  readonly contextStreams: string[][] = [];
  readonly readers: { stream: string; context: number }[] = [];
  readonly left = idStream('left');
  readonly middle = idStream('middle');
  readonly right = idStream('right');
  protected readonly catalog = new Catalog([
    this.left,
    this.middle,
    this.right,
  ]);

  // A stream without a script emits one record naming the read context.
  readonly scripts: Readonly<Record<string, readonly Step[]>>;

  constructor(scripts: Readonly<Record<string, readonly Step[]>> = {}) {
    super();
    this.scripts = scripts;
  }

  protected override async open(
    streams: readonly Stream[],
  ): Promise<ReadContext> {
    const id = this.opened.length + 1;
    this.opened.push(id);
    this.contextStreams.push(streams.map((stream) => stream.name));
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
    context: ReadContext,
  ): AsyncIterable<SourceMessage> {
    const stream = configuration.stream.name;
    this.readers.push({ stream, context: context.id });
    for (const step of this.scripts[stream] ?? [
      record(stream, `${stream}-${context.id}`),
    ]) {
      if (step instanceof Error) throw step;
      // @ts-expect-error -- a scripted StreamStatus plays a connector that reports status itself, which Source.read must reject
      yield step;
    }
  }
}

class LockedSource extends ContextSource {
  readonly refusal: Error;

  constructor(refusal: Error) {
    super();
    this.refusal = refusal;
  }

  protected override async open(): Promise<ReadContext> {
    throw this.refusal;
  }
}

class NamedTarget extends Target {
  readonly name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }
}

// Logs each step of the load protocol and keeps no rows, so these tests
// observe only what the engine asks of a destination.
class RecordingWriter extends Writer {
  readonly log: string[];
  readonly refusal?: Error;

  constructor(stream: Stream, log: string[], refusal?: Error) {
    super(stream);
    this.log = log;
    this.refusal = refusal;
  }

  async open(): Promise<Stage> {
    const { log, refusal } = this;
    log.push('open');
    return {
      fresh: false,
      reloading: false,
      complete: async () => {
        log.push('complete');
      },
      values: async function* () {},
      apply: async (operation: WriteOperation) => {
        log.push(
          operation.type === 'RECORD'
            ? `apply ${JSON.stringify(operation.data)}`
            : 'delete',
        );
      },
      commit: async () => {
        log.push('commit');
        if (refusal !== undefined) throw refusal;
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
  // Targets whose stage commit throws the mapped error.
  readonly refusing = new Map<string, Error>();

  override identity(target: NamedTarget): string {
    return target.name;
  }

  override location(target: NamedTarget): string {
    return target.name;
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: NamedTarget,
  ): RecordingWriter {
    this.validateConfiguration(configuration, target);
    return new RecordingWriter(
      configuration.stream,
      this.log,
      this.refusing.get(target.name),
    );
  }

  override async load(): Promise<Load<NamedTarget>> {
    return {
      prepare: (configuration, target) =>
        this.createWriter(configuration, target).open(),
      [Symbol.asyncDispose]: async () => {},
    };
  }
}

const contextPipeline = (
  source: ContextSource,
  destination = new DrainingDestination(),
) =>
  new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.left, new NamedTarget('left')),
          new Copy(source.right, new NamedTarget('right')),
        ],
      }),
    ],
  });

test('one read per run covers every copy inside one source context, closed after the run', async () => {
  const source = new ContextSource();
  const pipeline = contextPipeline(source);

  await pipeline.run();
  await pipeline.run();

  assert.deepEqual(source.readers, [
    { stream: 'left', context: 1 },
    { stream: 'right', context: 1 },
    { stream: 'left', context: 2 },
    { stream: 'right', context: 2 },
  ]);
  assert.deepEqual(source.closed, [1, 2]);
  assert.deepEqual(source.contextStreams, [
    ['left', 'right'],
    ['left', 'right'],
  ]);
});

test('closing a read releases every active extract before its shared context', async () => {
  const released: string[] = [];
  class ClosingSource extends ContextSource {
    protected override readonly concurrency = 2;

    protected override async open(streams: readonly Stream[]) {
      const context = await super.open(streams);
      return {
        id: context.id,
        [Symbol.asyncDispose]: async () => {
          released.push('context');
          await context[Symbol.asyncDispose]();
        },
      };
    }

    protected override async *extract(configuration: CopyConfiguration) {
      const name = configuration.stream.name;
      try {
        yield record(name, `${name}-1`);
      } finally {
        released.push(name);
      }
    }
  }
  const source = new ClosingSource();
  const read = source.read(
    [source.left, source.right].map(
      (stream) => new Copy(stream, new NamedTarget(stream.name)).configuration,
    ),
    new Map(),
  );

  try {
    for await (const message of read) {
      if (message instanceof StreamStatus) continue;
      break;
    }
    assert.deepEqual(released.slice(0, -1).sort(), ['left', 'right']);
    assert.equal(released.at(-1), 'context');
  } finally {
    await read.return(undefined);
  }
});

test('a failed copy does not stop later copies, and the run reports it at the end', async () => {
  const source = new ContextSource({ left: [new Error('left failed')] });
  const pipeline = contextPipeline(source);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the failed copy'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.match(error.message, /did not load completely: left: left failed/);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.message, 'left failed');
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
    { stream: 'left', context: 1 },
    { stream: 'right', context: 1 },
  ]);
  assert.deepEqual(source.closed, [1]);
});

class MemoryCheckpoints extends CheckpointStore {
  readonly saved = new Map<string, StoredCheckpoint>();
  // Ids whose save throws the mapped error.
  readonly refusing = new Map<string, Error>();
  readonly log: string[];

  constructor(log: string[]) {
    super();
    this.log = log;
  }

  protected override async session<T>(
    _ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    return work({
      read: async (id) => this.saved.get(id),
      save: async (id, checkpoint) => {
        const refusal = this.refusing.get(id);
        if (refusal !== undefined) throw refusal;
        this.log.push(`save ${checkpoint.state}`);
        this.saved.set(id, checkpoint);
      },
      remove: async (id) => {
        this.saved.delete(id);
      },
    });
  }
}

// Reads one record per site, then a checkpoint naming the run; sites listed
// in down fail after emitting their record.
class Sites extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

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

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override partitions() {
    return ['a', 'b', 'c'].map((site) => ({ site }));
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(
    _configuration: CopyConfiguration,
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
    connections: [
      new Connection({
        name: 'test',
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
    `save ${JSON.stringify({ state: { partitions: [a] }, reloading: false })}`,
    'apply {"site":"b","run":1}',
    'discard',
    'apply {"site":"c","run":1}',
    'commit',
    `save ${JSON.stringify({ state: { partitions: [a, c] }, reloading: false })}`,
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
    state: {
      partitions: ['a', 'b', 'c'].map((site) => ({
        partition: { site },
        state: { run: 2 },
      })),
    },
    reloading: false,
  });
});

test('a full refresh commits once, and a failing partition commits nothing', async () => {
  const source = new Sites();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(source.pages, new NamedTarget('pages'))],
      }),
    ],
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

test('a watch opens one read context per batch and holds none while idle', async () => {
  const source = new ContextSource();
  const pipeline = contextPipeline(source);
  const held: number[] = [];

  for await (const _ of pipeline.watch({ signal: AbortSignal.timeout(5000) }))
    held.push(source.opened.length - source.closed.length);

  assert.deepEqual(held, [0, 0]);
  assert.deepEqual(source.contextStreams, [['left', 'right'], ['right']]);
  assert.deepEqual(source.readers, [
    { stream: 'left', context: 1 },
    { stream: 'right', context: 1 },
    { stream: 'right', context: 2 },
  ]);
});

test('an empty full refresh still commits, so an overwrite clears its target', async () => {
  const source = new ContextSource({ left: [] });
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.left, new NamedTarget('left'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
        ],
      }),
    ],
  });

  const results = await pipeline.run();

  assert.deepEqual(
    results.map(({ count, deleted }) => [count, deleted]),
    [[0, 0]],
  );
  assert.deepEqual(destination.log, ['open', 'commit', 'close']);
});

test('a read context that does not open fails every copy with its error, and nothing is read or committed', async () => {
  const refusal = new Error('upstream is locked');
  const source = new LockedSource(refusal);
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.left, new NamedTarget('left')),
          new Copy(source.right, new NamedTarget('right')),
        ],
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('run should report the unopened read'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.equal(error.cause, refusal);
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures,
    ]),
    [
      ['left', 0, [{ partition: null, error: refusal }]],
      ['right', 0, [{ partition: null, error: refusal }]],
    ],
  );
  assert.deepEqual(source.readers, []);
  assert.deepEqual(destination.log, ['open', 'open', 'close', 'close']);
});

test('a connection that copies one stream twice is refused before anything is prepared or read', async () => {
  const source = new ContextSource();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.left, new NamedTarget('left')),
          new Copy(source.left, new NamedTarget('left-again')),
        ],
      }),
    ],
  });

  await assert.rejects(pipeline.run(), {
    name: 'TypeError',
    message: 'Connection test copies each stream once',
  });

  assert.deepEqual(source.opened, []);
  assert.deepEqual(destination.log, []);
});

const incrementalPipeline = (
  source: ContextSource,
  destination: DrainingDestination,
  checkpoints: MemoryCheckpoints,
) =>
  new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [source.left, source.right].map(
          (stream) =>
            new Copy(stream, new NamedTarget(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append',
            }),
        ),
      }),
    ],
  });

test('a stage that fails to commit fails only its stream: its later messages are ignored while the sibling commits and saves its checkpoint', async () => {
  const refusal = new Error('left target is read-only');
  const source = new ContextSource({
    left: [
      record('left', 'left-1'),
      checkpoint('left', 1),
      record('left', 'left-2'),
      checkpoint('left', 2),
    ],
    right: [record('right', 'right-1'), checkpoint('right', 1)],
  });
  const destination = new DrainingDestination();
  destination.refusing.set('left', refusal);
  const checkpoints = new MemoryCheckpoints(destination.log);
  const pipeline = incrementalPipeline(source, destination, checkpoints);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the failed commit'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.id,
      count,
      failures,
    ]),
    [
      ['left', 0, [{ partition: null, error: refusal }]],
      ['right', 1, []],
    ],
  );
  assert.deepEqual(destination.log, [
    'open',
    'open',
    'apply {"id":"left-1"}',
    'commit',
    'close',
    'apply {"id":"right-1"}',
    'commit',
    'save {"state":{"at":1},"reloading":false}',
    'close',
  ]);
  assert.deepEqual([...checkpoints.saved.keys()], ['right']);
});

test('a checkpoint that fails to save fails only its stream, which keeps what it committed, while the sibling loads', async () => {
  const refusal = new Error('checkpoint store is offline');
  const source = new ContextSource({
    left: [
      record('left', 'left-1'),
      checkpoint('left', 1),
      record('left', 'left-2'),
      checkpoint('left', 2),
    ],
    right: [record('right', 'right-1'), checkpoint('right', 1)],
  });
  const destination = new DrainingDestination();
  const checkpoints = new MemoryCheckpoints(destination.log);
  checkpoints.refusing.set('left', refusal);
  const pipeline = incrementalPipeline(source, destination, checkpoints);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the unsaved checkpoint'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  const [left, right] = error.results;
  assert.equal(left?.count, 1);
  assert.equal(left?.failures.length, 1);
  const failure = left?.failures[0]?.error;
  assert.ok(failure instanceof Error, String(failure));
  assert.match(failure.message, /Checkpoint left was not saved/);
  assert.equal(failure.cause, refusal);
  assert.deepEqual([right?.count, right?.failures], [1, []]);
  assert.deepEqual(destination.log, [
    'open',
    'open',
    'apply {"id":"left-1"}',
    'commit',
    'close',
    'apply {"id":"right-1"}',
    'commit',
    'save {"state":{"at":1},"reloading":false}',
    'close',
  ]);
  assert.deepEqual([...checkpoints.saved.keys()], ['right']);
});

test('a checkpoint whose state has a lone surrogate fails its stream before anything since the last one commits', async () => {
  const source = new ContextSource({
    left: [
      record('left', 'left-1'),
      checkpoint('left', 1),
      record('left', 'left-2'),
      { type: 'STATE', stream: 'left', state: { cursor: 'cut \uD83D' } },
    ],
    right: [record('right', 'right-1'), checkpoint('right', 1)],
  });
  const destination = new DrainingDestination();
  const checkpoints = new MemoryCheckpoints(destination.log);
  const pipeline = incrementalPipeline(source, destination, checkpoints);

  const error = await pipeline.run().then(
    () => assert.fail('run should refuse the malformed state'),
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
      [
        'left',
        1,
        ['TypeError: Checkpoint state field cursor has a lone surrogate'],
      ],
      ['right', 1, []],
    ],
  );
  assert.deepEqual(
    [...checkpoints.saved].map(([id, { state }]) => [id, state]),
    [
      ['left', '{"state":{"at":1},"reloading":false}'],
      ['right', '{"state":{"at":1},"reloading":false}'],
    ],
  );
});

test("an extract that emits another stream's message fails only its own stream, and the sibling's target never sees it", async () => {
  const source = new ContextSource({
    middle: [record('right', 'stray'), record('middle', 'middle-1')],
  });
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [source.left, source.middle, source.right].map(
          (stream) => new Copy(stream, new NamedTarget(stream.name)),
        ),
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('run should report the stray message'),
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
      ['left', 1, []],
      ['middle', 0, ['TypeError: Extract for middle emitted right']],
      ['right', 1, []],
    ],
  );
  assert.deepEqual(destination.log, [
    'open',
    'open',
    'open',
    'apply {"id":"left-1"}',
    'commit',
    'close',
    'discard',
    'close',
    'apply {"id":"right-1"}',
    'commit',
    'close',
  ]);
});

test('a read that breaks fails every stream it had not ended, while a stream that ended keeps its commit', async () => {
  // The read itself fails between streams, outside any one stream's extract.
  class BreakingSource extends ContextSource {
    override async *read(
      catalog: readonly CopyConfiguration[],
      states: ReadonlyMap<string, unknown>,
    ): AsyncGenerator<ReadMessage> {
      for await (const message of super.read(catalog, states)) {
        yield message;
        if (message instanceof StreamStatus && message.stream === 'middle')
          throw new Error('read broke');
      }
    }
  }
  const source = new BreakingSource();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [source.left, source.middle, source.right].map(
          (stream) => new Copy(stream, new NamedTarget(stream.name)),
        ),
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('run should report the broken read'),
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
      ['left', 1, []],
      ['middle', 0, ['Error: read broke']],
      ['right', 0, ['Error: read broke']],
    ],
  );
  assert.deepEqual(source.readers, [{ stream: 'left', context: 1 }]);
  assert.deepEqual(source.closed, [1]);
  assert.deepEqual(destination.log, [
    'open',
    'open',
    'open',
    'apply {"id":"left-1"}',
    'commit',
    'close',
    'close',
    'close',
  ]);
});

test('a connector that reports its own stream status fails that stream, not its sibling', async () => {
  const source = new ContextSource({
    left: [record('left', 'left-1'), new StreamStatus('left', 'ENDED')],
  });
  const destination = new DrainingDestination();
  const pipeline = contextPipeline(source, destination);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the misbehaving connector'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  const [left, right] = error.results;
  assert.equal(left?.count, 0);
  assert.equal(left?.failures.length, 1);
  const failure = left?.failures[0];
  assert.equal(failure?.partition, null);
  assert.ok(failure?.error instanceof TypeError, String(failure?.error));
  assert.match(
    failure.error.message,
    /Only Source\.read reports stream status/,
  );
  assert.deepEqual([right?.count, right?.failures], [1, []]);
  assert.deepEqual(destination.log, [
    'open',
    'open',
    'apply {"id":"left-1"}',
    'discard',
    'close',
    'apply {"id":"right-1"}',
    'commit',
    'close',
  ]);
});

// Keeps each pass as it is recorded, so tests see what readers of sync history would.
class MemoryHistory extends SyncHistory<NamedTarget> {
  readonly log: string[] = [];
  readonly #finished = new Map<string, PromiseWithResolvers<void>>();

  finished(connection: string): Promise<void> {
    return this.#pass(connection).promise;
  }

  override async begin(
    connection: Connection<NamedTarget>,
    copies: readonly DeclaredCopy<NamedTarget>[],
  ): Promise<RecordedPass<NamedTarget>> {
    this.log.push(
      `begin ${connection.name} ${copies.map(({ copy, coverage }) => `${copy.from.name}:${coverage.description}`).join(',')}`,
    );
    return {
      finish: async (outcomes) => {
        this.log.push(`finish ${connection.name} ${passStatus(outcomes)}`);
        this.#pass(connection.name).resolve();
      },
      fail: async (error) => {
        this.log.push(
          `fail ${connection.name} ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    };
  }

  #pass(connection: string): PromiseWithResolvers<void> {
    let pass = this.#finished.get(connection);
    if (pass === undefined) {
      pass = Promise.withResolvers<void>();
      this.#finished.set(connection, pass);
    }
    return pass;
  }
}

const leftOnly = (name: string, source: ContextSource) =>
  new Connection({
    name,
    source,
    destination: new DrainingDestination(),
    steps: [new Copy(source.left, new NamedTarget(`${name}-left`))],
  });

test('one connection failing leaves the others loaded, and every pass is recorded', async () => {
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    history,
    connections: [
      leftOnly('steady', new ContextSource()),
      leftOnly(
        'broken',
        new ContextSource({ left: [new Error('upstream down')] }),
      ),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('the broken connection must fail the run'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError);
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.to.name,
      count,
      failures.length,
    ]),
    [
      ['steady-left', 1, 0],
      ['broken-left', 0, 1],
    ],
  );
  assert.match(error.message, /left: upstream down/);
  assert.deepEqual(history.log.toSorted(), [
    'begin broken left:test',
    'begin steady left:test',
    'finish broken failed',
    'finish steady succeeded',
  ]);
});

test('a run its signal stops keeps each commit and checkpoint, drops what was staged, is recorded cancelled and rejects with the reason, which the extract sees', async () => {
  const waiting = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  class Waiting extends ContextSource {
    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      _partition: null,
      _context: ReadContext,
      signal?: AbortSignal,
    ) {
      const stream = configuration.stream.name;
      yield record(stream, 'committed');
      yield checkpoint(stream, 1);
      yield record(stream, 'staged');
      waiting.resolve();
      await new Promise((resolve) =>
        signal?.addEventListener('abort', resolve, { once: true }),
      );
      seen.push(signal?.reason);
    }
  }
  const source = new Waiting();
  const destination = new DrainingDestination();
  const checkpoints = new MemoryCheckpoints(destination.log);
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.left, new NamedTarget('left'), {
            id: 'left',
            syncMode: 'incremental',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });
  const controller = new AbortController();
  const reason = new Error('the user removed this connector');

  const run = pipeline.run({ signal: controller.signal });
  await waiting.promise;
  controller.abort(reason);
  const error = await run.then(
    () => assert.fail('a cancelled run must reject'),
    (error: unknown) => error,
  );

  assert.equal(error, reason);
  assert.deepEqual(seen, [reason]);
  assert.deepEqual(destination.log, [
    'open',
    'apply {"id":"committed"}',
    'commit',
    `save ${JSON.stringify({ state: { at: 1 }, reloading: false })}`,
    'apply {"id":"staged"}',
    'close',
  ]);
  assert.deepEqual(history.log, [
    'begin test left:test',
    'finish test cancelled',
  ]);
  assert.deepEqual(source.closed, [1]);
});

test("connections read side by side, so one connection's pass never waits for another's", async () => {
  const history = new MemoryHistory();
  class Slow extends ContextSource {
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
      partition: null,
      context: ReadContext,
    ) {
      await Promise.race([
        history.finished('fast'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('slow held back fast')), 2000),
        ),
      ]);
      yield* super.extract(configuration, state, partition, context);
    }
  }
  const pipeline = new Pipeline({
    history,
    connections: [
      leftOnly('slow', new Slow()),
      leftOnly('fast', new ContextSource()),
    ],
  });

  const results = await pipeline.run();

  assert.deepEqual(
    results.map(({ copy, count }) => [copy.to.name, count]),
    [
      ['slow-left', 1],
      ['fast-left', 1],
    ],
  );
  assert.deepEqual(history.log.slice(-2), [
    'finish fast succeeded',
    'finish slow succeeded',
  ]);
});

test("a recorded pass sees each copy's progress: what the source emitted, what committed, and how it ended", async () => {
  const progress: string[] = [];
  const history = new (class extends SyncHistory<NamedTarget> {
    override async begin(): Promise<RecordedPass<NamedTarget>> {
      return {
        progress: ({ copy, status, emitted, committed }) =>
          progress.push(
            `${copy.from.name} ${status} emitted ${emitted.count} committed ${committed.count}`,
          ),
        finish: async () => {},
        fail: async () => {},
      };
    }
  })();
  const source = new ContextSource({
    left: [record('left', 'a'), record('left', 'b')],
    right: [record('right', 'x'), new Error('right lost')],
  });
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination: new DrainingDestination(),
        steps: [
          new Copy(source.left, new NamedTarget('left')),
          new Copy(source.right, new NamedTarget('right')),
        ],
      }),
    ],
  });

  await pipeline.run().catch(() => {});

  assert.deepEqual(
    progress.filter((entry) => entry.startsWith('left')),
    [
      'left running emitted 0 committed 0',
      'left running emitted 1 committed 0',
      'left running emitted 2 committed 0',
      'left running emitted 2 committed 2',
      'left complete emitted 2 committed 2',
    ],
  );
  assert.deepEqual(
    progress.filter((entry) => entry.startsWith('right')),
    [
      'right running emitted 0 committed 0',
      'right running emitted 1 committed 0',
      'right running emitted 1 committed 0',
      'right incomplete emitted 1 committed 0',
    ],
  );
});

test('a copy that fails before reading still reports how it ended', async () => {
  const progress: string[] = [];
  const history = new (class extends SyncHistory<NamedTarget> {
    override async begin(): Promise<RecordedPass<NamedTarget>> {
      return {
        progress: ({ copy, status }) =>
          progress.push(`${copy.from.name} ${status}`),
        finish: async () => {},
        fail: async () => {},
      };
    }
  })();
  const source = new LockedSource(new Error('store locked'));
  const pipeline = new Pipeline({
    history,
    connections: [leftOnly('locked', source)],
  });

  await pipeline.run().catch(() => {});

  assert.deepEqual(progress, ['left incomplete']);
});

test('a progress observer that throws never changes what loads', async () => {
  const history = new (class extends SyncHistory<NamedTarget> {
    override async begin(): Promise<RecordedPass<NamedTarget>> {
      return {
        progress: () => {
          throw new Error('renderer broke');
        },
        finish: async () => {},
        fail: async () => {},
      };
    }
  })();
  const source = new ContextSource({
    left: [record('left', 'a'), record('left', 'b')],
  });
  const pipeline = new Pipeline({
    history,
    connections: [leftOnly('steady', source)],
  });

  const results = await pipeline.run();

  assert.deepEqual(
    results.map(({ copy, count }) => [copy.to.name, count]),
    [['steady-left', 2]],
  );
});

test('a connection whose watcher fails stops alone and is recorded; the others keep watching', async () => {
  const history = new MemoryHistory();
  class Lost extends ContextSource {
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
      throw new Error('watcher lost');
    }
  }
  const steady = new ContextSource();
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'steady',
        source: steady,
        destination: new DrainingDestination(),
        steps: [
          new Copy(steady.left, new NamedTarget('steady-left')),
          new Copy(steady.right, new NamedTarget('steady-right')),
        ],
      }),
      leftOnly('lost', new Lost()),
    ],
  });
  const passes: string[] = [];

  const error = await (async () => {
    for await (const { connection, outcomes } of pipeline.watch({
      signal: AbortSignal.timeout(5000),
    }))
      passes.push(
        `${connection.name}:${outcomes.map(({ copy }) => copy.from.name).join(',')}`,
      );
  })().then(
    () => assert.fail('the lost watcher must be reported'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'Connection lost: watcher lost');
  assert.deepEqual(passes.toSorted(), [
    'lost:left',
    'steady:left,right',
    'steady:right',
  ]);
  assert.ok(history.log.includes('fail lost watcher lost'));
  assert.equal(
    history.log.filter((entry) => entry === 'finish steady succeeded').length,
    2,
  );
});

test('an invalid connection stops the whole pipeline before any read, and is recorded against that connection', async () => {
  const history = new MemoryHistory();
  const valid = new ContextSource();
  const invalid = new ContextSource();
  const pipeline = new Pipeline({
    history,
    connections: [
      leftOnly('valid', valid),
      new Connection({
        name: 'invalid',
        source: invalid,
        destination: new DrainingDestination(),
        steps: [
          new Copy(invalid.left, new NamedTarget('invalid-left'), {
            syncMode: 'incremental',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });

  await assert.rejects(pipeline.run(), {
    message: 'Incremental copies require a stable id and checkpoint store',
  });

  assert.deepEqual(valid.opened, []);
  assert.deepEqual(invalid.opened, []);
  assert.deepEqual(history.log, [
    'begin invalid left:test',
    'fail invalid Incremental copies require a stable id and checkpoint store',
  ]);
});
