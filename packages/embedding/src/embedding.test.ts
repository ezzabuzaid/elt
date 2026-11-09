import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { APICallError } from 'ai';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  type PipelineClock,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

import { Embedding } from './embedding.ts';

// The upstream of a test source, which the test fills before it reads: a
// watch finds it changed at its first check and unchanged after.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A model server cannot run in a test, so this stands in for one: a real
// EmbeddingModelV4 whose vector of a text counts each letter a to z. It
// refuses every call while refusing is set.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'test';
  readonly modelId: string;
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly embedded: string[] = [];
  // What the model answers for a text, in place of counting its letters.
  readonly answers = new Map<string, number[]>();
  refusing = false;
  // Each call the model got, and the status it answers a call of these values
  // with, as a model server refuses over HTTP.
  readonly calls: (readonly string[])[] = [];
  answer: (values: readonly string[]) => number | null = () => null;
  // A call of these values never answers, until its signal aborts it.
  hangs: (values: readonly string[]) => boolean = () => false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async doEmbed({
    values,
    abortSignal,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    if (this.hangs(values))
      await new Promise((_, reject) =>
        abortSignal?.addEventListener('abort', () =>
          reject(abortSignal.reason),
        ),
      );
    if (this.refusing) throw new Error('the model server is down');
    this.calls.push(values);
    const status = this.answer(values);
    if (status !== null)
      throw new APICallError({
        message: `The model answered ${status}`,
        url: 'http://model.test/embeddings',
        requestBodyValues: { input: values },
        statusCode: status,
      });
    this.embedded.push(...values);
    return {
      embeddings: values.map((text) => this.answers.get(text) ?? letters(text)),
      warnings: [],
    };
  }
}

const letters = (text: string) =>
  Array.from(
    { length: 26 },
    (_, index) =>
      [...text.toLowerCase()].filter(
        (letter) => letter.charCodeAt(0) - 97 === index,
      ).length,
  );

type Listing = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
};

// Listings, loaded into raw_listings and read through listings; they can
// change between runs.
class Listings extends Source {
  readonly identity = 'listings';
  rows: readonly Listing[] = [];
  readonly listings = new Stream({
    name: 'listings',
    jsonSchema: {
      type: 'object',
      description: 'A listing.',
      properties: {
        id: { type: 'string', description: 'Listing id.' },
        title: { type: 'string', description: 'Title.' },
        description: { type: ['string', 'null'], description: 'Text.' },
      },
      required: ['id', 'title', 'description'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.listings]);

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]) {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const row of this.rows)
      yield { stream: configuration.stream.name, data: row };
  }
}

// The timers of a rule, which a test fires by hand: no real model call waits
// out a limit of minutes in a test.
class HandClock {
  readonly timers = new Map<symbol, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number) {
    const timer = Symbol('timer');
    this.timers.set(timer, { callback, ms });
    return timer;
  }

  clearTimeout(timer: unknown) {
    if (typeof timer === 'symbol') this.timers.delete(timer);
  }

  fire() {
    for (const { callback } of this.timers.values()) callback();
  }
}

function listingsImport(
  directory: string,
  model: () => LetterModel,
  clock:
    | Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
    | HandClock = globalThis,
) {
  const source = new Listings();
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const target = destination.table('raw_listings').withReaderView('listings');
  const pipeline = () =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'listings',
          source,
          destination,
          steps: [new Copy(source.listings, target)],
        }),
      ],
      derived: [
        new ComputedDataset({
          into: destination,
          name: 'listing_vectors',
          description: 'The vector of each listing.',
          from: [target],
          compute: new Embedding({
            model: model(),
            clock,
            key: 'id',
            fields: ['title', 'description'],
          }),
        }),
      ],
    });
  const vectors = () => {
    using database = open(path, { readOnly: true });
    return database
      .prepare(
        'SELECT id, status, rule, error, vector FROM listing_vectors ORDER BY id',
      )
      .all()
      .map(({ id, status, rule, error, vector }) => ({
        id,
        status,
        rule,
        error,
        vector:
          vector instanceof Uint8Array
            ? [...new Float32Array(vector.slice().buffer)]
            : null,
      }));
  };
  return {
    source,
    run: (options?: { signal: AbortSignal }) => pipeline().run(options),
    vectors,
  };
}

const unit = (values: readonly number[]) => {
  const length = Math.hypot(...values);
  return [...Float32Array.from(values, (value) => value / length)];
};

test('each listing with text gets the unit vector of its title and description from the model, and a listing with no text gets none', async () => {
  await using scratch = await new TemporaryFiles().directory('embedding-');
  const model = new LetterModel('letters-1');
  const listings = listingsImport(scratch.path, () => model);
  listings.source.rows = [
    { id: '1', title: 'red car', description: 'fast' },
    { id: '2', title: 'blue bike', description: null },
    { id: '3', title: ' ', description: null },
  ];

  await listings.run();

  assert.deepEqual(listings.vectors(), [
    {
      id: '1',
      status: 'computed',
      rule: 'test/letters-1',
      error: null,
      vector: unit(letters('red car\nfast')),
    },
    {
      id: '2',
      status: 'computed',
      rule: 'test/letters-1',
      error: null,
      vector: unit(letters('blue bike')),
    },
  ]);
});

test('the next run embeds only the listings whose text changed, and another model embeds every listing again', async () => {
  await using scratch = await new TemporaryFiles().directory('embedding-');
  let model = new LetterModel('letters-1');
  const listings = listingsImport(scratch.path, () => model);
  listings.source.rows = [
    { id: '1', title: 'red car', description: 'fast' },
    { id: '2', title: 'blue bike', description: null },
  ];
  await listings.run();
  listings.source.rows = [
    { id: '1', title: 'red car', description: 'fast' },
    { id: '2', title: 'green bike', description: null },
  ];

  await listings.run();
  const changed = model.embedded.slice(2);
  model = new LetterModel('letters-2');
  await listings.run();

  assert.deepEqual(changed, ['green bike']);
  assert.deepEqual(model.embedded.toSorted(), ['green bike', 'red car\nfast']);
  assert.deepEqual(
    listings.vectors().map(({ id, rule }) => ({ id, rule })),
    [
      { id: '1', rule: 'test/letters-2' },
      { id: '2', rule: 'test/letters-2' },
    ],
  );
});

test('a model that refuses a call stores those listings failed with why, the run still succeeds, and the next run embeds them', async () => {
  await using scratch = await new TemporaryFiles().directory('embedding-');
  const model = new LetterModel('letters-1');
  const listings = listingsImport(scratch.path, () => model);
  listings.source.rows = [{ id: '1', title: 'red car', description: null }];
  model.refusing = true;

  await listings.run();
  const failed = listings.vectors();
  model.refusing = false;
  await listings.run();

  assert.deepEqual(failed, [
    {
      id: '1',
      status: 'failed',
      rule: 'test/letters-1',
      error: 'the model server is down',
      vector: null,
    },
  ]);
  assert.deepEqual(
    listings.vectors().map(({ id, status }) => ({ id, status })),
    [{ id: '1', status: 'computed' }],
  );
});

test('a model that answers a vector with no usable length stores that listing failed with why, keeps its neighbour, and asks again at the next refresh', async () => {
  await using scratch = await new TemporaryFiles().directory('embedding-');
  const model = new LetterModel('letters-1');
  const listings = listingsImport(scratch.path, () => model);
  listings.source.rows = [
    { id: '1', title: 'red car', description: null },
    // No letter to count, so the model answers an all-zero vector.
    { id: '2', title: '1234', description: null },
    { id: '3', title: 'blue van', description: null },
    { id: '4', title: 'old bus', description: null },
  ];
  model.answers.set('blue van', [Number.NaN, 1]);
  model.answers.set('old bus', [Number.POSITIVE_INFINITY, 1]);

  await listings.run();
  const first = listings.vectors();
  model.answers.clear();
  await listings.run();

  assert.deepEqual(
    first.map(({ id, status, vector }) => ({
      id,
      status,
      stored: vector !== null,
    })),
    [
      { id: '1', status: 'computed', stored: true },
      { id: '2', status: 'failed', stored: false },
      { id: '3', status: 'failed', stored: false },
      { id: '4', status: 'failed', stored: false },
    ],
  );
  for (const { id, error } of first.filter(({ id }) => id !== '1'))
    assert.match(String(error), /length/, `listing ${String(id)}`);
  assert.deepEqual(
    listings.vectors().map(({ id, status }) => ({ id, status })),
    [
      { id: '1', status: 'computed' },
      { id: '2', status: 'failed' },
      { id: '3', status: 'computed' },
      { id: '4', status: 'computed' },
    ],
  );
  assert.equal(
    model.embedded.filter((text) => text === 'red car').length,
    1,
    'a computed listing is not asked again',
  );
  assert.equal(
    model.embedded.filter((text) => text === '1234').length,
    2,
    'a failed listing is asked again',
  );
});

test('an input the model refuses fails only its own row, and the next run asks again only for it', async () => {
  await using scratch = await new TemporaryFiles().directory('embedding-');
  const model = new LetterModel('letters-1');
  const listings = listingsImport(scratch.path, () => model);
  listings.source.rows = [
    'red car',
    'too long',
    'blue van',
    'old bus',
    'new jeep',
  ].map((title, index) => ({
    id: String(index + 1),
    title,
    description: null,
  }));
  model.answer = (values) => (values.includes('too long') ? 400 : null);

  await listings.run();
  const first = listings.vectors();
  model.embedded.length = 0;
  model.calls.length = 0;
  await listings.run();

  assert.deepEqual(
    first.map(({ id, status, error }) => ({ id, status, error })),
    [
      { id: '1', status: 'computed', error: null },
      { id: '2', status: 'failed', error: 'The model answered 400' },
      { id: '3', status: 'computed', error: null },
      { id: '4', status: 'computed', error: null },
      { id: '5', status: 'computed', error: null },
    ],
  );
  assert.deepEqual(model.calls, [['too long']]);
});

for (const [status, calls] of [
  // A refused API key or model is not tried again.
  [401, 1],
  [403, 1],
  // The AI SDK tries a server failure 3 times, each time with the whole call.
  [500, 3],
] as const)
  test(`a call the model answers with ${status} says nothing about its inputs, so it is not split`, async () => {
    await using scratch = await new TemporaryFiles().directory('embedding-');
    const model = new LetterModel('letters-1');
    const listings = listingsImport(scratch.path, () => model);
    listings.source.rows = ['red car', 'blue van', 'old bus'].map(
      (title, index) => ({ id: String(index + 1), title, description: null }),
    );
    model.answer = () => status;

    await listings.run();

    assert.deepEqual(
      model.calls,
      Array.from({ length: calls }, () => ['red car', 'blue van', 'old bus']),
    );
    assert.deepEqual(
      listings.vectors().map(({ status: stored }) => stored),
      ['failed', 'failed', 'failed'],
    );
  });

test(
  'a call the model never answers fails its rows at the limit, and the next batch still runs',
  { timeout: 30_000 },
  async (t) => {
    await using scratch = await new TemporaryFiles().directory('embedding-');
    const model = new LetterModel('letters-1');
    const clock = new HandClock();
    const listings = listingsImport(scratch.path, () => model, clock);
    // 64 rows are one batch, so the 65th goes in the next call.
    listings.source.rows = [
      'hung car',
      ...Array.from(
        { length: 64 },
        (_, index) => `car ${'a'.repeat(index + 1)}`,
      ),
    ].map((title, index) => ({
      id: String(index).padStart(3, '0'),
      title,
      description: null,
    }));
    model.hangs = (values) => values.includes('hung car');

    const run = listings.run();
    await t.waitFor(() => assert.equal(clock.timers.size, 1));
    const ms = [...clock.timers.values()].map((timer) => timer.ms);
    clock.fire();
    await t.waitFor(() => assert.equal(clock.timers.size, 0), {
      timeout: 5000,
    });
    await run;

    const rows = listings.vectors();
    assert.deepEqual(ms, [120_000]);
    assert.deepEqual(
      new Set(
        rows.slice(0, 64).map(({ status, error }) => `${status}: ${error}`),
      ),
      new Set(['failed: The model did not answer within 120 s.']),
    );
    assert.equal(rows[64]?.status, 'computed');
    assert.equal(clock.timers.size, 0);
  },
);

test(
  'a stop during a call the model never answers fails no row, and the next run computes them',
  { timeout: 30_000 },
  async (t) => {
    await using scratch = await new TemporaryFiles().directory('embedding-');
    const model = new LetterModel('letters-1');
    const clock = new HandClock();
    const listings = listingsImport(scratch.path, () => model, clock);
    listings.source.rows = [{ id: '1', title: 'red car', description: null }];
    model.hangs = () => true;
    const controller = new AbortController();

    const run = listings.run({ signal: controller.signal });
    await t.waitFor(() => assert.equal(clock.timers.size, 1));
    controller.abort();
    await run.catch(() => {});
    const stopped = clock.timers.size;
    const failed = listings
      .vectors()
      .filter(({ status }) => status === 'failed');
    model.hangs = () => false;
    await listings.run();

    assert.equal(stopped, 0);
    assert.deepEqual(failed, []);
    assert.deepEqual(
      listings.vectors().map(({ status }) => status),
      ['computed'],
    );
  },
);
