import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';

import { Embedding } from './embedding.ts';

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
  refusing = false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    if (this.refusing) throw new Error('the model server is down');
    this.embedded.push(...values);
    return { embeddings: values.map(letters), warnings: [] };
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

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const row of this.rows)
      yield { stream: configuration.stream.name, data: row };
  }
}

function listingsImport(directory: string, model: () => LetterModel) {
  const source = new Listings();
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const target = destination.table('raw_listings').withReaderView('listings');
  const pipeline = () =>
    new Pipeline({
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
            key: 'id',
            fields: ['title', 'description'],
          }),
        }),
      ],
    });
  const vectors = () => {
    using database = new DatabaseSync(path, { readOnly: true });
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
  return { source, run: () => pipeline().run(), vectors };
}

const unit = (values: readonly number[]) => {
  const length = Math.hypot(...values);
  return [...Float32Array.from(values, (value) => value / length)];
};

test('each listing with text gets the unit vector of its title and description from the model, and a listing with no text gets none', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'embedding-'));
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'embedding-'));
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'embedding-'));
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
