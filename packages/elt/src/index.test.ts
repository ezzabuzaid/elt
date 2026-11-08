import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { type Check, Gauge, Latch, untilAborted } from '@zukhruf/async';
import { settleWithin } from '@zukhruf/testing/async';

import {
  Catalog,
  type ChangeSignal,
  type CheckpointSession,
  CheckpointStore,
  Connection,
  Copy,
  CopyConfiguration,
  CopyProgress,
  type DeclaredCopy,
  DerivedDataset,
  Destination,
  DocumentParser,
  type FailureType,
  FileRead,
  FileStorage,
  type Load,
  LocalFiles,
  type Partition,
  PassFailed,
  PassFinished,
  PassStarted,
  Pipeline,
  PipelineError,
  type ReadMessage,
  type RecordedPass,
  Source,
  type SourceMessage,
  type SourceReadOptions,
  type Stage,
  type StoredCheckpoint,
  Stream,
  StreamStatus,
  SyncHistory,
  Target,
  type Upkeep,
  type WriteOperation,
  Writer,
  isCalendarDate,
  isTimestamp,
  passChannels,
  passStatus,
  validateRecords,
} from './index.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

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
    override async flush(): Promise<void> {
      throw new Error('unexpected flush');
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

test('record validation checks an array of objects: each item has exactly its declared scalar fields, each one valid', () => {
  // A page's language copies, as a web page declares them.
  const stream = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: {
        copies: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              language: { type: 'string', minLength: 1 },
              url: { type: 'string' },
              checked: { type: ['string', 'null'], format: 'date-time' },
            },
            required: ['language', 'url', 'checked'],
          },
        },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const copy = {
    language: 'de',
    url: 'https://example.com/de/',
    checked: null,
  };
  const valid = { copies: [copy] };

  assert.deepEqual(validateRecords(stream, [valid], 'Test'), [valid]);
  assert.deepEqual(validateRecords(stream, [{ copies: [] }], 'Test'), [
    { copies: [] },
  ]);
  assert.deepEqual(validateRecords(stream, [{ copies: null }], 'Test'), [
    { copies: null },
  ]);
  for (const copies of [
    [null],
    ['de'],
    [[copy]],
    [{ language: 'de', url: 'https://example.com/de/' }],
    [{ ...copy, extra: 1 }],
    [{ ...copy, language: '' }],
    [{ ...copy, url: null }],
    [{ ...copy, checked: '2025-01-02T03:04:05Z' }],
  ])
    assert.throws(() => validateRecords(stream, [{ copies }], 'Test'), {
      message: 'Test returned invalid pages.copies',
    });
  for (const copies of [
    { type: 'array', items: { type: 'object', properties: {}, required: [] } },
    {
      type: 'array',
      items: {
        type: 'object',
        properties: { language: { type: 'string' } },
        required: [],
      },
    },
    {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          languages: { type: 'array', items: { type: 'string' } },
        },
        required: ['languages'],
      },
    },
  ]) {
    const unsupported = new Stream({
      name: 'nested',
      // @ts-expect-error -- some of these schemas are invalid FieldSchemas; the check must reject them at run time too
      jsonSchema: { type: 'object', properties: { copies } },
      supportedSyncModes: ['full_refresh'],
    });
    assert.throws(
      () => validateRecords(unsupported, [], 'Test'),
      /nested\.copies declares an unsupported type/,
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

test('an incremental copy refuses a cursor field its stream does not describe, appending or deduplicating', () => {
  // A stream whose cursor field was dropped upstream since the copy chose it.
  const stream = new Stream({
    name: 'items',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
  });

  for (const destinationSyncMode of ['append', 'append_dedup'] as const)
    assert.throws(
      () =>
        new CopyConfiguration(stream, {
          syncMode: 'incremental',
          destinationSyncMode,
          cursorField: 'updatedAt',
        }).validateSelection(),
      { message: 'Stream items does not describe cursor field updatedAt' },
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

// A store of an upstream that a watch reads at each check: answer gives its
// version, or throws as a store that cannot be read does. It counts its reads
// and its disposals.
class Upstream extends Gauge<number> implements Disposable {
  readonly reads: number[] = [];
  readonly disposals: number[] = [];
  readonly #answer: () => number;

  constructor(answer: () => number) {
    super();
    this.#answer = answer;
  }

  protected async read(): Promise<number> {
    this.reads.push(this.reads.length);
    return this.#answer();
  }

  [Symbol.dispose](): void {
    this.disposals.push(this.disposals.length);
  }
}

class ContextSource extends LiveSource<ReadContext> {
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
    _signal: AbortSignal | undefined,
    _states: { get(stream: string): unknown },
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

  // left and middle never change; right changes one time, after the first
  // check, as a store that one commit changes.
  override changeSignals(streams: readonly Stream[]): Iterable<ChangeSignal> {
    const unchanged = new Upstream(() => 0);
    const right: Upstream = new Upstream(() =>
      right.reads.length > 1 ? 1 : 0,
    );
    return streams.map((stream) => ({
      gauge: stream === this.right ? right : unchanged,
      streams: [stream],
      interval: 5,
      timeout: 5,
    }));
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
    clock: globalThis,
    history: new MemoryHistory(),
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

    protected override async open(
      streams: readonly Stream[],
      signal: AbortSignal | undefined,
      states: { get(stream: string): unknown },
    ) {
      const context = await super.open(streams, signal, states);
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
    { clock: globalThis },
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

test('a stream that fails outside its extract ends the read, also while another stream of the read waits for it', async () => {
  const unreadable = new Error('the saved state of left is unreadable');
  // right waits for what left would give it, as a routes stream waits for
  // its web stream, and stops only once its signal aborts.
  class WaitingSource extends ContextSource {
    protected override readonly concurrency = 2;

    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      _partition: null,
      _context: ReadContext,
      signal?: AbortSignal,
    ): AsyncIterable<SourceMessage> {
      await untilAborted(new Latch().wait(), signal);
      yield record(configuration.stream.name, 'never');
    }
  }
  const source = new WaitingSource();
  const read = source.read(
    [source.left, source.right].map(
      (stream) => new Copy(stream, new NamedTarget(stream.name)).configuration,
    ),
    {
      get: async (stream: string) => {
        if (stream === 'left') throw unreadable;
        return null;
      },
    },
    { clock: globalThis },
  );

  const outcome = await settleWithin(
    Array.fromAsync(read).then(
      () => 'ended without the failure',
      (error: unknown) => error,
    ),
    'the read to end with the failure of left',
  );

  assert.equal(outcome, unreadable);
});

test("a source's open reads the read's saved states, so a context can depend on a stream's checkpoint", async () => {
  const seen: unknown[] = [];
  class StatefulSource extends ContextSource {
    protected override async open(
      streams: readonly Stream[],
      signal: AbortSignal | undefined,
      states: { get(stream: string): unknown },
    ) {
      seen.push(await states.get('right'));
      return super.open(streams, signal, states);
    }
  }
  const source = new StatefulSource();
  const read = source.read(
    [source.left].map(
      (stream) => new Copy(stream, new NamedTarget(stream.name)).configuration,
    ),
    new Map([['right', { offset: 7 }]]),
    { clock: globalThis },
  );

  for await (const message of read) void message;

  assert.deepEqual(seen, [{ offset: 7 }]);
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
  readonly saved = new Map<
    string,
    StoredCheckpoint & { readonly state: string }
  >();
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
      state: async (id) => this.saved.get(id)?.state,
      save: async (id, checkpoint) => {
        const refusal = this.refusing.get(id);
        if (refusal !== undefined) throw refusal;
        this.log.push(`save ${checkpoint.state}`);
        this.saved.set(id, checkpoint);
      },
      reloaded: async (id) => {
        const saved = this.saved.get(id);
        if (saved !== undefined)
          this.saved.set(id, { ...saved, reloading: false });
      },
      remove: async (id) => {
        this.saved.delete(id);
      },
    });
  }
}

// Reads one record per site, then a checkpoint naming the run; sites listed
// in down fail after emitting their record.
class Sites extends LiveSource {
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

  // The sites that the source reads, as a host lists them.
  readonly sites = ['a', 'b', 'c'];

  protected override partitions() {
    return this.sites.map((site) => ({ site }));
  }

  // The sites never change after the first check.
  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Upstream(() => 0), streams, interval: 5, timeout: 5 }];
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
    clock: globalThis,
    history: new MemoryHistory(),
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
    clock: globalThis,
    history: new MemoryHistory(),
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
  const controller = new AbortController();
  const held: number[] = [];

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })) {
    held.push(source.opened.length - source.closed.length);
    if (held.length === 2) controller.abort();
  }

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
    clock: globalThis,
    history: new MemoryHistory(),
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
    clock: globalThis,
    history: new MemoryHistory(),
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
      ['left', 0, [{ partition: null, error: refusal, failureType: 'system' }]],
      [
        'right',
        0,
        [{ partition: null, error: refusal, failureType: 'system' }],
      ],
    ],
  );
  assert.deepEqual(source.readers, []);
  assert.deepEqual(destination.log, ['open', 'open', 'close', 'close']);
});

test('a connection that copies one stream twice is refused before anything is prepared or read', async () => {
  const source = new ContextSource();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
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
    clock: globalThis,
    history: new MemoryHistory(),
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
      ['left', 0, [{ partition: null, error: refusal, failureType: 'system' }]],
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
    'save {"at":1}',
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
    'save {"at":1}',
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
      ['left', '{"at":1}'],
      ['right', '{"at":1}'],
    ],
  );
});

test('a checkpoint whose state JSON would not carry exactly fails its stream before anything since the last one commits', async () => {
  const symbol = Symbol('cursor');
  // Each loses or changes something on its way through JSON.
  const states: Record<string, unknown> = {
    'an undefined field': { cursor: undefined },
    'a NaN': { cursor: Number.NaN },
    'a negative zero': { cursor: -0 },
    'a Date': { cursor: new Date(0) },
    'a Map': { cursor: new Map([['page', 1]]) },
    // Index 1 of two is never set.
    'a hole in an array': { pages: Object.assign(new Array(2), [1]) },
    'a named field on an array': { pages: Object.assign([1], { last: 1 }) },
    'an object with no prototype': Object.assign(Object.create(null), {
      cursor: 1,
    }),
    'a symbol key': { cursor: 1, [symbol]: 1 },
  };

  for (const [kind, state] of Object.entries(states)) {
    const source = new ContextSource({
      left: [
        record('left', 'left-1'),
        checkpoint('left', 1),
        record('left', 'left-2'),
        { type: 'STATE', stream: 'left', state },
      ],
      right: [record('right', 'right-1'), checkpoint('right', 1)],
    });
    const destination = new DrainingDestination();
    const checkpoints = new MemoryCheckpoints(destination.log);
    const pipeline = incrementalPipeline(source, destination, checkpoints);

    const error = await pipeline.run().then(
      () => assert.fail(`run should refuse a state with ${kind}`),
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
          ['TypeError: Checkpoint state must be losslessly JSON serializable'],
        ],
        ['right', 1, []],
      ],
      kind,
    );
    assert.deepEqual(
      [...checkpoints.saved].map(([id, { state }]) => [id, state]),
      [
        ['left', '{"at":1}'],
        ['right', '{"at":1}'],
      ],
      kind,
    );
  }
});

test("an extract that emits another stream's message fails only its own stream, and the sibling's target never sees it", async () => {
  const source = new ContextSource({
    middle: [record('right', 'stray'), record('middle', 'middle-1')],
  });
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
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
      options: SourceReadOptions,
    ): AsyncGenerator<ReadMessage> {
      for await (const message of super.read(catalog, states, options)) {
        yield message;
        if (message instanceof StreamStatus && message.stream === 'middle')
          throw new Error('read broke');
      }
    }
  }
  const source = new BreakingSource();
  const destination = new DrainingDestination();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
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
  readonly #finished = new Map<string, Latch>();

  // The tests that use it read passes; checks and installs are the SQLite and
  // Postgres histories' tests.
  protected override async recordChecks(): Promise<void> {}

  override async install(): Promise<void> {}

  finished(connection: string): Promise<void> {
    return this.#pass(connection).wait();
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
        this.#pass(connection.name).open();
      },
      fail: async (error) => {
        this.log.push(
          `fail ${connection.name} ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    };
  }

  #pass(connection: string): Latch {
    return this.#finished.getOrInsertComputed(connection, () => new Latch());
  }
}

const leftOnly = (name: string, source: ContextSource) =>
  new Connection({
    name,
    source,
    destination: new DrainingDestination(),
    steps: [new Copy(source.left, new NamedTarget(`${name}-left`))],
  });

// A source whose streams never change after the first check, so it keeps
// watching until the watch stops it.
class Watching extends ContextSource {
  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Upstream(() => 0), streams, interval: 5, timeout: 5 }];
  }
}

// A source whose change signal fails once its first pass began, for a reason
// only the user can fix. Not the default, so a test sees what the source
// decided.
class Lost extends ContextSource {
  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    const lost: Upstream = new Upstream(() => {
      if (lost.reads.length > 1) throw new Error('left store lost');
      return 0;
    });
    return [{ gauge: lost, streams, interval: 5, timeout: 5 }];
  }

  override failureType(): FailureType {
    return 'config';
  }
}

test('one connection failing leaves the others loaded, and every pass is recorded', async () => {
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    clock: globalThis,
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
    clock: globalThis,
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
    'save {"at":1}',
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
      await settleWithin(
        history.finished('fast'),
        'fast to finish while slow waits: slow held back fast',
        2000,
      );
      yield* super.extract(configuration, state, partition, context);
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
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

// What the pass channels publish of the connection named name while the
// returned object is in scope; tests of one file run one at a time.
function listen(name: string) {
  const heard: (PassStarted | CopyProgress | PassFinished | PassFailed)[] = [];
  const hear = (message: unknown) => {
    if (
      (message instanceof PassStarted ||
        message instanceof CopyProgress ||
        message instanceof PassFinished ||
        message instanceof PassFailed) &&
      message.connection.name === name
    )
      heard.push(message);
  };
  const channels = Object.values(passChannels);
  for (const channel of channels) channel.subscribe(hear);
  return {
    heard,
    [Symbol.dispose]() {
      for (const channel of channels) channel.unsubscribe(hear);
    },
  };
}

test("a pass publishes each copy's progress: what the source emitted, what committed, and how it ended", async () => {
  using listened = listen('test');
  const source = new ContextSource({
    left: [record('left', 'a'), record('left', 'b')],
    right: [record('right', 'x'), new Error('right lost')],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
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

  const progress = listened.heard.flatMap((message) =>
    message instanceof CopyProgress
      ? [
          `${message.copy.from.name} ${message.status} emitted ${message.emitted.count} committed ${message.committed.count}`,
        ]
      : [],
  );
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

test("a store that a subscriber binds to a pass's start holds the pass while the pass publishes, such as each copy's progress", async () => {
  const pass = new AsyncLocalStorage<PassStarted>();
  const progressIn: (PassStarted | undefined)[] = [];
  const hear = (message: unknown) => {
    if (message instanceof CopyProgress && message.connection.name === 'stored')
      progressIn.push(pass.getStore());
  };
  const source = new ContextSource({
    left: [record('left', 'a'), record('left', 'b')],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [leftOnly('stored', source)],
  });
  passChannels.start.bindStore(pass);
  passChannels.progress.subscribe(hear);

  try {
    await pipeline.run();
  } finally {
    passChannels.progress.unsubscribe(hear);
    passChannels.start.unbindStore(pass);
  }

  assert.ok(progressIn.length > 0);
  assert.ok(
    progressIn.every(
      (started) =>
        started instanceof PassStarted && started.connection.name === 'stored',
    ),
  );
  assert.equal(pass.getStore(), undefined);
});

test('a copy that fails before reading still reports how it ended', async () => {
  using listened = listen('locked');
  const source = new LockedSource(new Error('store locked'));
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [leftOnly('locked', source)],
  });

  await pipeline.run().catch(() => {});

  assert.deepEqual(
    listened.heard.flatMap((message) =>
      message instanceof CopyProgress
        ? [`${message.copy.from.name} ${message.status}`]
        : [],
    ),
    ['left incomplete'],
  );
});

test('a pass publishes its end once its history recorded it, and a failed change signal as a failed pass with whose failure it is', async () => {
  const history = new MemoryHistory();
  const controller = new AbortController();
  // Logged as the message arrives, so the log shows it after what the history recorded.
  const hear = (message: unknown) => {
    if (message instanceof PassFinished)
      history.log.push(
        `observed finish ${message.connection.name} ${passStatus(message.outcomes)}`,
      );
    if (message instanceof PassFailed) {
      history.log.push(
        `observed fail ${message.connection.name} ${message.error instanceof Error ? message.error.message : String(message.error)} ${message.failureType}`,
      );
      controller.abort();
    }
  };
  passChannels.finish.subscribe(hear);
  passChannels.failure.subscribe(hear);
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [leftOnly('lost', new Lost())],
  });

  try {
    for await (const _ of pipeline.watch({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    }));
  } finally {
    passChannels.finish.unsubscribe(hear);
    passChannels.failure.unsubscribe(hear);
  }

  assert.deepEqual(history.log, [
    'begin lost left:test',
    'finish lost succeeded',
    'observed finish lost succeeded',
    'begin lost left:test',
    'fail lost left store lost',
    'observed fail lost left store lost config',
  ]);
});

test('a failure is config when the source lists its class in configErrors, and system when it does not', async (t) => {
  class StoreDeniedError extends Error {}
  // Each change signal reads once, then fails with its own error.
  class Failing extends ContextSource {
    protected override readonly configErrors = [StoreDeniedError];
    readonly #error: Error;

    constructor(error: Error) {
      super();
      this.#error = error;
    }

    override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
      const failing: Upstream = new Upstream(() => {
        if (failing.reads.length > 1) throw this.#error;
        return 0;
      });
      return [{ gauge: failing, streams, interval: 5, timeout: 5 }];
    }
  }
  using denied = listen('denied');
  using lost = listen('lost');
  // Watches until the failed pass that records the failure is published.
  const watchUntilFailed = async (
    name: string,
    source: ContextSource,
    heard: readonly unknown[],
  ) => {
    const controller = new AbortController();
    const watching = (async () => {
      for await (const _ of new Pipeline({
        clock: globalThis,
        history: new MemoryHistory(),
        connections: [leftOnly(name, source)],
      }).watch({
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      }));
    })();
    await t.waitFor(
      () => assert.ok(heard.some((message) => message instanceof PassFailed)),
      { interval: 1, timeout: 5000 },
    );
    controller.abort();
    await watching;
  };

  await watchUntilFailed(
    'denied',
    new Failing(new StoreDeniedError('store denied')),
    denied.heard,
  );
  await watchUntilFailed(
    'lost',
    new Failing(new Error('store lost')),
    lost.heard,
  );

  assert.deepEqual(
    [...denied.heard, ...lost.heard].flatMap((message) =>
      message instanceof PassFailed
        ? [`${message.connection.name} ${message.failureType}`]
        : [],
    ),
    ['denied config', 'lost system'],
  );
});

test('a connection whose change signals break the contract stops alone and is recorded; the others keep watching', async () => {
  const history = new MemoryHistory();
  const steady = new ContextSource();
  const pipeline = new Pipeline({
    clock: globalThis,
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
      // Declares no change signal, so nothing tells about its stream.
      leftOnly('broken', new Signalled(() => [])),
    ],
  });
  const controller = new AbortController();
  const passes: string[] = [];

  const error = await (async () => {
    for await (const { connection, outcomes } of pipeline.watch({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })) {
      passes.push(
        `${connection.name}:${outcomes.map(({ copy }) => copy.from.name).join(',')}`,
      );
      if (passes.length === 2) controller.abort();
    }
  })().then(
    () => assert.fail('the broken connection must be reported'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof AggregateError);
  assert.equal(
    error.message,
    'Connection broken: No change signal tells about stream left',
  );
  assert.deepEqual(passes, ['steady:left,right', 'steady:right']);
  assert.ok(
    history.log.includes(
      'fail broken No change signal tells about stream left',
    ),
  );
  assert.equal(
    history.log.filter((entry) => entry === 'finish steady succeeded').length,
    2,
  );
});

// Watches its streams through the change signals that the test gives.
class Signalled extends ContextSource {
  readonly #signals: (source: Signalled) => ChangeSignal[];

  constructor(signals: (source: Signalled) => ChangeSignal[]) {
    super();
    this.#signals = signals;
  }

  override changeSignals(): ChangeSignal[] {
    return this.#signals(this);
  }
}

const leftAndRight = (name: string, source: ContextSource) =>
  new Connection({
    name,
    source,
    destination: new DrainingDestination(),
    steps: [
      new Copy(source.left, new NamedTarget(`${name}-left`)),
      new Copy(source.right, new NamedTarget(`${name}-right`)),
    ],
  });

test('a watch keeps loading the streams of its other change signals after one change signal fails', async () => {
  let leftFails = false;
  let rightVersion = 0;
  const left = new Upstream(() => {
    if (leftFails) throw new Error('left store cannot be read');
    return 0;
  });
  const right = new Upstream(() => rightVersion);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftAndRight(
        'books',
        new Signalled((source) => [
          { gauge: left, streams: [source.left], interval: 5, timeout: 5 },
          { gauge: right, streams: [source.right], interval: 5, timeout: 5 },
        ]),
      ),
    ],
  });
  const controller = new AbortController();
  const passes: string[][] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })) {
    passes.push(outcomes.map(({ copy }) => copy.from.name));
    if (passes.length === 1) {
      leftFails = true;
      rightVersion = 1;
    } else controller.abort();
  }

  assert.deepEqual(passes, [['left', 'right'], ['right']]);
});

test('a change signal that fails for a system reason is recorded one time for each run of failures, as a failed pass of its stream, and its stream loads again once a check reads a new value', async () => {
  const history = new MemoryHistory();
  let failure: Error | undefined;
  let leftVersion = 0;
  const failedReads: number[] = [];
  let failedThrice = new Latch();
  const left = new Upstream(() => {
    if (failure === undefined) return leftVersion;
    failedReads.push(failedReads.length);
    if (failedReads.length === 3) failedThrice.open();
    throw failure;
  });
  const right = new Upstream(() => 0);
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [
      leftAndRight(
        'books',
        new Signalled((source) => [
          { gauge: left, streams: [source.left], interval: 5, timeout: 5 },
          { gauge: right, streams: [source.right], interval: 5, timeout: 5 },
        ]),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);
  const passes: string[][] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    passes.push(outcomes.map(({ copy }) => copy.from.name));
    // Two runs of failures, each ended by a new version of the store.
    if (passes.length < 3) {
      failedReads.length = 0;
      failedThrice = new Latch();
      failure = new Error('left store cannot be read');
      await untilAborted(failedThrice.wait(), deadline);
      failure = undefined;
      leftVersion = passes.length;
    } else controller.abort();
  }

  assert.deepEqual(passes, [['left', 'right'], ['left'], ['left']]);
  assert.deepEqual(
    history.log.filter((entry) => !entry.startsWith('finish')),
    [
      'begin books left:test,right:test',
      'begin books left:test',
      'fail books left store cannot be read',
      'begin books left:test',
      'begin books left:test',
      'fail books left store cannot be read',
      'begin books left:test',
    ],
  );
});

// A watch on a clock whose timers run a hundred times faster than its Date,
// as a timer runs after the wall clock was set back. It reports the failure
// types of its failed pass and of its retry, and whether the retry came
// before the Date of the retry. It waits for the retry only after a timer of
// the process fired. A watch that spins on its retry starves every timer of
// the process, node:test's own timeout too, so the scenario runs in a child
// process that the test kills.
const lateDateWatch = `
const { Catalog, Connection, Copy, Destination, Gauge, Pipeline, Source, Stream, SyncHistory, Target, Writer } = await import(process.env.ELT);
const start = Date.now();
let now = start;
const clock = {
  Date: { now: () => now },
  performance,
  setTimeout: (callback, ms) => setTimeout(callback, ms / 100),
  clearTimeout: (timer) => clearTimeout(timer),
};
class Unchanged extends Gauge {
  async read() { return 0; }
}
class Notes extends Source {
  identity = 'notes';
  stream = new Stream({ name: 'notes', jsonSchema: { type: 'object', properties: { id: { type: 'string' } } }, supportedSyncModes: ['full_refresh'] });
  catalog = new Catalog([this.stream]);
  failing = true;
  coverage() { return { description: 'test', selection: {} }; }
  async currentAsOf() { return null; }
  async open() { return new AsyncDisposableStack(); }
  changeSignals(streams) {
    return [{ gauge: new Unchanged(), streams, interval: 1000, timeout: 1000 }];
  }
  async *extract() {
    if (this.failing) throw new Error('notes store is busy');
    yield { stream: 'notes', data: { id: '1' } };
  }
}
class Named extends Target {}
class Dropping extends Writer {
  async clear() {}
}
class Discarding extends Destination {
  supportedDestinationSyncModes = ['overwrite'];
  location() { return 'notes'; }
  createWriter(configuration) { return new Dropping(configuration.stream); }
  async load() {
    return {
      prepare: async () => ({
        fresh: false,
        reloading: false,
        values: async function* () {},
        apply: async () => {},
        complete: async () => {},
        commit: async () => {},
        discard: async () => {},
        [Symbol.asyncDispose]: async () => {},
      }),
      [Symbol.asyncDispose]: async () => {},
    };
  }
}
class Forgetful extends SyncHistory {
  async install() {}
  async recordChecks() {}
  async begin() { return { finish: async () => {}, fail: async () => {} }; }
}
const source = new Notes();
const pipeline = new Pipeline({
  clock,
  history: new Forgetful(),
  connections: [new Connection({ name: 'notes', source, destination: new Discarding(), steps: [new Copy(source.stream, new Named())] })],
});
const controller = new AbortController();
const watching = pipeline.watch({ signal: controller.signal });
const failures = (pass) => pass.value.outcomes.map(({ failures }) => failures.map(({ failureType }) => failureType));
const failed = await watching.next();
source.failing = false;
const retried = watching.next();
let early = false;
retried.then(() => { early = now === start; });
// A timer of the process, after five rounds of the retry timer, all before
// the Date of the retry.
await new Promise((resolve) => setTimeout(resolve, 500));
now += 10_000;
const loaded = await retried;
controller.abort();
await watching.return(undefined);
console.log(JSON.stringify({ failed: failures(failed), early, loaded: failures(loaded) }));
`;

test('a watch whose stream failed for a system reason keeps yielding to the process while its timers fire before its Date reaches the retry, and loads the stream again once the Date does', () => {
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', lateDateWatch],
    {
      env: {
        ...process.env,
        ELT: pathToFileURL(join(import.meta.dirname, 'index.ts')).href,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  assert.equal(
    run.status,
    0,
    `${run.signal ?? ''} ${run.error?.message ?? ''}\n${run.stderr.slice(0, 1000)}`,
  );
  assert.deepEqual(JSON.parse(run.stdout), {
    failed: [['system']],
    early: false,
    loaded: [[]],
  });
});

test('a change signal that fails for a config reason is not read again in that watch, while the streams of the other change signals keep loading', async () => {
  class StoreLockedError extends Error {}
  class Locking extends Signalled {
    protected override readonly configErrors = [StoreLockedError];
  }
  let locked = false;
  // The count of reads of right when left locked.
  let lockedAt = Number.POSITIVE_INFINITY;
  let rightVersion = 0;
  const lockedReads: number[] = [];
  const checkedOn = new Latch();
  const left = new Upstream(() => {
    if (!locked) return 0;
    lockedReads.push(lockedReads.length);
    throw new StoreLockedError('left store refused the login');
  });
  // Ten more checks after left locked.
  const right = new Upstream(() => {
    if (right.reads.length >= lockedAt + 10) checkedOn.open();
    return rightVersion;
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftAndRight(
        'warehouse',
        new Locking((source) => [
          { gauge: left, streams: [source.left], interval: 5, timeout: 5 },
          { gauge: right, streams: [source.right], interval: 5, timeout: 5 },
        ]),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);
  const passes: string[][] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    passes.push(outcomes.map(({ copy }) => copy.from.name));
    if (passes.length === 1) {
      locked = true;
      lockedAt = right.reads.length;
      await untilAborted(checkedOn.wait(), deadline);
      rightVersion = 1;
    } else controller.abort();
  }

  assert.deepEqual(passes, [['left', 'right'], ['right']]);
  assert.deepEqual(lockedReads, [0]);
});

test('each interval has its own checks: a change signal with a long interval is not read at each check of one with a short interval', async () => {
  const quickChecks = new Latch();
  const quick = new Upstream(() => {
    if (quick.reads.length >= 6) quickChecks.open();
    return 0;
  });
  const slow = new Upstream(() => 0);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftAndRight(
        'search',
        new Signalled((source) => [
          { gauge: quick, streams: [source.left], interval: 5, timeout: 5 },
          {
            gauge: slow,
            streams: [source.right],
            interval: 60_000,
            timeout: 60_000,
          },
        ]),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    await untilAborted(quickChecks.wait(), deadline);
    controller.abort();
  }

  assert.equal(slow.reads.length, 1);
});

test('the first pass of a watch waits for the first check of every change signal, so it reads every stream, also when one interval answers first', async () => {
  const quickChecked = new Latch();
  const quick = new Upstream(() => {
    if (quick.reads.length >= 2) quickChecked.open();
    return 0;
  });
  // Its first read ends only after the quick change signal was checked two
  // times, as a network probe answers after a memory read.
  class Slow extends Gauge<number> {
    protected async read({ signal }: Check): Promise<number> {
      await untilAborted(quickChecked.wait(), signal);
      return 0;
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftAndRight(
        'search',
        new Signalled((source) => [
          { gauge: quick, streams: [source.left], interval: 5, timeout: 5 },
          {
            gauge: new Slow(),
            streams: [source.right],
            interval: 60_000,
            timeout: 5000,
          },
        ]),
      ),
    ],
  });
  const passes: string[][] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: AbortSignal.timeout(5000),
  })) {
    passes.push(outcomes.map(({ copy }) => copy.from.name));
    break;
  }

  assert.deepEqual(passes, [['left', 'right']]);
});

test('the pipeline disposes each gauge of the change signals one time when the watch stops', async () => {
  const shared = new Upstream(() => 0);
  const own = new Upstream(() => 0);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftAndRight(
        'books',
        new Signalled((source) => [
          { gauge: shared, streams: [source.left], interval: 5, timeout: 5 },
          { gauge: shared, streams: [source.right], interval: 5, timeout: 5 },
          { gauge: own, streams: [source.right], interval: 5, timeout: 5 },
        ]),
      ),
    ],
  });
  const controller = new AbortController();

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  }))
    controller.abort();

  assert.deepEqual(
    { shared: shared.disposals, own: own.disposals },
    { shared: [0], own: [0] },
  );
});

test('a source whose change signals throw after it gave a gauge stops its connection, records the failure and leaves that gauge disposed', async () => {
  const given = new Upstream(() => 0);
  class Breaking extends ContextSource {
    override *changeSignals(
      streams: readonly Stream[],
    ): Generator<ChangeSignal> {
      yield { gauge: given, streams, interval: 5, timeout: 5 };
      throw new Error('the second store has no path');
    }
  }
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [leftOnly('broken', new Breaking())],
  });

  const error = await (async () => {
    for await (const _ of pipeline.watch({
      signal: AbortSignal.timeout(5000),
    }));
  })().then(
    () => assert.fail('the broken connection must be reported'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof AggregateError);
  assert.equal(
    error.message,
    'Connection broken: the second store has no path',
  );
  assert.deepEqual(given.disposals, [0]);
  assert.ok(history.log.includes('fail broken the second store has no path'));
});

test('change signals that name an unselected stream, miss a selected stream or give one stream two intervals stop their connection before any pass, as a broken contract', async () => {
  const constant = () => new Upstream(() => 0);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftOnly(
        'unselected',
        new Signalled((source) => [
          {
            gauge: constant(),
            streams: [source.left, source.right],
            interval: 5,
            timeout: 5,
          },
        ]),
      ),
      leftAndRight(
        'missing',
        new Signalled((source) => [
          {
            gauge: constant(),
            streams: [source.left],
            interval: 5,
            timeout: 5,
          },
        ]),
      ),
      leftOnly(
        'intervals',
        new Signalled((source) => [
          {
            gauge: constant(),
            streams: [source.left],
            interval: 5,
            timeout: 5,
          },
          {
            gauge: constant(),
            streams: [source.left],
            interval: 6,
            timeout: 5,
          },
        ]),
      ),
    ],
  });
  const passes: string[] = [];

  const error = await (async () => {
    for await (const { connection } of pipeline.watch({
      signal: AbortSignal.timeout(5000),
    }))
      passes.push(connection.name);
  })().then(
    () => assert.fail('the broken declarations must be reported'),
    (error: unknown) => error,
  );

  assert.deepEqual(passes, []);
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.message.split('; ').toSorted(), [
    'Connection intervals: The change signals of stream left have two intervals',
    'Connection missing: No change signal tells about stream right',
    'Connection unselected: A change signal names an unselected stream: right',
  ]);
});

// A source that keeps an upkeep while its streams hold still.
class Kept extends Watching {
  readonly #upkeep: Upkeep;

  constructor(upkeep: Upkeep) {
    super();
    this.#upkeep = upkeep;
  }

  override upkeep(): Upkeep[] {
    return [this.#upkeep];
  }
}

test('an upkeep runs when the watch starts and then at each interval, and runs no more once the watch stops', async () => {
  const interval = 20;
  // The time from the start of each run to the start of the next, on the
  // clock of the pipeline.
  const gaps: number[] = [];
  let previous = performance.now();
  const thrice = new Latch();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftOnly(
        'notes',
        new Kept({
          interval,
          run: async () => {
            const now = performance.now();
            gaps.push(now - previous);
            previous = now;
            if (gaps.length === 3) thrice.open();
          },
        }),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    await untilAborted(thrice.wait(), deadline);
    controller.abort();
  }
  const stopped = gaps.length;
  // Five intervals later.
  await sleep(5 * interval);

  assert.ok(stopped >= 3, `runs: ${stopped}`);
  assert.equal(gaps.length, stopped);
  // The first gap is from before the watch. A timer can end up to one
  // millisecond before its time on this clock.
  assert.ok(
    gaps.slice(1).every((gap) => gap >= interval - 1),
    `gaps: ${gaps.join(', ')}`,
  );
});

test('an upkeep that fails for a system reason is recorded one time for each run of failures, and runs again at its next interval', async () => {
  const history = new MemoryHistory();
  let failure: Error | undefined;
  const failedRuns: number[] = [];
  let thrice = new Latch();
  let recovered = new Latch();
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [
      leftOnly(
        'notes',
        new Kept({
          interval: 5,
          run: async () => {
            if (failure === undefined) {
              recovered.open();
              return;
            }
            failedRuns.push(failedRuns.length);
            if (failedRuns.length === 3) thrice.open();
            throw failure;
          },
        }),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    // Two runs of failures, each ended by a run that succeeds.
    for (const run of ['first', 'second']) {
      failedRuns.length = 0;
      thrice = new Latch();
      failure = new Error(`Notes could not start, ${run} time`);
      await untilAborted(thrice.wait(), deadline);
      recovered = new Latch();
      failure = undefined;
      await untilAborted(recovered.wait(), deadline);
    }
    controller.abort();
  }

  assert.deepEqual(
    history.log.filter((entry) => entry.startsWith('fail')),
    [
      'fail notes Notes could not start, first time',
      'fail notes Notes could not start, second time',
    ],
  );
});

test('a watch whose sync history cannot record a check rejects with that error, also while an upkeep runs', async () => {
  const refused = new Error('the history refused the check');
  // Records passes, but no check.
  class Refusing extends MemoryHistory {
    protected override async recordChecks(): Promise<void> {
      throw refused;
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new Refusing(),
    connections: [
      leftOnly('notes', new Kept({ interval: 5, run: async () => {} })),
    ],
  });

  const outcome = await settleWithin(
    (async () => {
      // Stops a watch that hangs, after the deadline below failed the test.
      for await (const _ of pipeline.watch({
        signal: AbortSignal.timeout(10_000),
      }));
    })().then(
      () => 'ended without the failure',
      (error: unknown) => error,
    ),
    'the watch to reject with the failure of the history',
  );

  assert.equal(outcome, refused);
});

test('an upkeep that fails for a config reason runs no more in that watch, while its change signals are still read', async () => {
  class LaunchDeniedError extends Error {}
  class Denied extends Kept {
    protected override readonly configErrors = [LaunchDeniedError];
  }
  const runs: number[] = [];
  const checked = new Latch();
  const store = new Upstream(() => {
    if (store.reads.length >= 10) checked.open();
    return 0;
  });
  class Watched extends Denied {
    override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
      return [{ gauge: store, streams, interval: 5, timeout: 5 }];
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [
      leftOnly(
        'notes',
        new Watched({
          interval: 1,
          run: async () => {
            runs.push(runs.length);
            throw new LaunchDeniedError('macOS refused to start Notes');
          },
        }),
      ),
    ],
  });
  const controller = new AbortController();
  // A wait that never ends fails the test at this deadline.
  const deadline = AbortSignal.timeout(5000);

  for await (const _ of pipeline.watch({
    signal: AbortSignal.any([controller.signal, deadline]),
  })) {
    await untilAborted(checked.wait(), deadline);
    controller.abort();
  }

  assert.deepEqual(runs, [0]);
});

// The test's own timeout fails a watch that outlives its abort.
test(
  'a watch ends when its signal aborts, also while the read of a gauge ignores the signal',
  { timeout: 5_000 },
  async () => {
    // A gauge that answers one time, then never settles and never looks at
    // the signal of its check, as a read of a stuck store can.
    class Stuck extends Gauge<number> {
      readonly #reads: number[] = [];

      protected read(): Promise<number> {
        this.#reads.push(this.#reads.length);
        return this.#reads.length === 1
          ? Promise.resolve(0)
          : new Promise<never>(() => {});
      }
    }
    class Deaf extends ContextSource {
      override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
        return [{ gauge: new Stuck(), streams, interval: 5, timeout: 60_000 }];
      }
    }
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new MemoryHistory(),
      connections: [leftOnly('deaf', new Deaf())],
    });
    const controller = new AbortController();
    const passes: string[] = [];

    for await (const { connection } of pipeline.watch({
      signal: controller.signal,
    })) {
      passes.push(connection.name);
      controller.abort();
    }

    assert.deepEqual(passes, ['deaf']);
  },
);

test('a stopping watch waits for the gauges of its change signals to finish stopping', async () => {
  let stopped = false;
  // A gauge whose stop takes a moment, as ending a helper process does.
  class Helper extends Gauge<number> implements AsyncDisposable {
    protected async read(): Promise<number> {
      return 0;
    }

    async [Symbol.asyncDispose](): Promise<void> {
      await sleep(50);
      stopped = true;
    }
  }
  class Slow extends ContextSource {
    override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
      return [{ gauge: new Helper(), streams, interval: 5, timeout: 5 }];
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [leftOnly('slow', new Slow())],
  });
  const controller = new AbortController();

  for await (const _ of pipeline.watch({ signal: controller.signal }))
    controller.abort();

  assert.equal(stopped, true);
});

test('under a watch, a derived dataset whose refresh fails stops the watch, which rejects with that failure', async () => {
  const refused = new Error('the store refused the derived SQL');
  class Refused extends DerivedDataset<NamedTarget> {
    readonly name = 'refused';
    override async refresh(): Promise<void> {
      throw refused;
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [leftOnly('watching', new Watching())],
    derived: [new Refused()],
  });

  const outcome = await settleWithin(
    Array.fromAsync(
      pipeline.watch({ signal: new AbortController().signal }),
    ).then(
      () => 'ended without the failure',
      (error: unknown) => error,
    ),
    'the watch to stop on the failed refresh',
  );

  assert.equal(outcome, refused);
});

test('a stopped watch ends only once the derived refresh it started has ended', async () => {
  const started = new Latch();
  const events: string[] = [];
  class Held extends DerivedDataset<NamedTarget> {
    readonly name = 'held';
    override async refresh(): Promise<void> {
      started.open();
      await sleep(200);
      events.push('refresh ended');
    }
  }
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
    connections: [leftOnly('reading', new Watching())],
    derived: [new Held()],
  });
  const controller = new AbortController();

  for await (const _ of pipeline.watch({ signal: controller.signal })) {
    await started.wait();
    controller.abort();
  }
  events.push('watch ended');

  assert.deepEqual(events, ['refresh ended', 'watch ended']);
});

test('a stopping watch ends the pass it is running, which the extract sees and the history records cancelled', async () => {
  const reading = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  class Reading extends Watching {
    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      _partition: null,
      _context: ReadContext,
      signal?: AbortSignal,
    ) {
      reading.resolve();
      // A long read, as a scan of a large store is: it ends when the run's
      // signal stops it, or after 5 s.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      seen.push(signal?.reason);
      yield record(configuration.stream.name, 'late');
    }
  }
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [leftOnly('reading', new Reading())],
  });
  const controller = new AbortController();
  const removed = new Error('the user removed this connector');

  const watching = Array.fromAsync(
    pipeline.watch({ signal: controller.signal }),
  );
  await reading.promise;
  controller.abort(removed);
  const outcome = await Promise.race([
    watching.then(
      () => 'ended',
      (error: unknown) => error,
    ),
    sleep(2_000, 'still in its pass'),
  ]);

  assert.equal(outcome, 'ended');
  assert.deepEqual(seen, [removed]);
  assert.ok(
    history.log.includes('finish reading cancelled'),
    history.log.join('\n'),
  );
});

test("breaking a watch's loop ends the pass another connection is running, recorded cancelled", async () => {
  const reading = Promise.withResolvers<void>();
  class Quick extends Watching {}
  class Reading extends Quick {
    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      _partition: null,
      _context: ReadContext,
      signal?: AbortSignal,
    ) {
      reading.resolve();
      // A long read: it ends when the run's signal stops it, or after 5 s.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      yield record(configuration.stream.name, 'late');
    }
  }
  const history = new MemoryHistory();
  const pipeline = new Pipeline({
    clock: globalThis,
    history,
    connections: [
      leftOnly('quick', new Quick()),
      leftOnly('reading', new Reading()),
    ],
  });

  const consumed = (async () => {
    for await (const _ of pipeline.watch({
      signal: new AbortController().signal,
    })) {
      await reading.promise;
      break;
    }
  })();
  const outcome = await Promise.race([
    consumed.then(() => 'ended'),
    sleep(2_000, 'still in its pass'),
  ]);

  assert.equal(outcome, 'ended');
  assert.ok(
    history.log.includes('finish reading cancelled'),
    history.log.join('\n'),
  );
});

test('an invalid connection stops the whole pipeline before any read, and is recorded against that connection', async () => {
  const history = new MemoryHistory();
  const valid = new ContextSource();
  const invalid = new ContextSource();
  const pipeline = new Pipeline({
    clock: globalThis,
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

test('a partitioned stream that lists no partitions reads nothing, and a later read reads a partition that its source lists by then from its start', async () => {
  const source = new Sites();
  source.sites.splice(0);
  const destination = new DrainingDestination();
  const checkpoints = new MemoryCheckpoints(destination.log);
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new MemoryHistory(),
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

  await pipeline.run();
  const empty = source.received.splice(0);
  source.sites.push('a');
  await pipeline.run();

  assert.deepEqual(empty, []);
  assert.deepEqual(source.received, [['a', null]]);
});
