// The vectorizer through a real Pipeline and a real SQLite file, read back
// through the store and the retrievers of @zukhruf/retrieval, as a host reads
// it. The embedding model is the one stand-in (LetterModel).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import {
  ContextWindow,
  FusionRetriever,
  type Retriever,
} from '@zukhruf/retrieval';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { install } from '@zukhruf/vectors/sqlite';
import { customProvider } from 'ai';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import type { Tokenizer } from '@eltjs/chunking';
import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DerivedDatasetError,
  DocumentParser,
  Gauge,
  IterableSource,
  LocalFiles,
  Pipeline,
  PipelineError,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  View,
} from '@eltjs/elt-sqlite';

import { type ChunkingOptions, Vectorizer } from './sqlite.ts';

// The vocabulary of OpenAI's text-embedding-3-small.
const cl100k: Tokenizer = { name: 'cl100k_base', count: countTokens };

// Copied from packages/embedding/src/embedding.test.ts (docs/copied-test-helpers.md):
// a real EmbeddingModelV4 whose vector of a text counts each letter a to z.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'test';
  readonly modelId: string;
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly embedded: string[] = [];
  // What the model answers for a text, in place of counting its letters.
  readonly answers = new Map<string, number[]>();
  // A call of these values never answers, until its signal aborts it.
  hangs: (values: readonly string[]) => boolean = () => false;

  constructor(modelId = 'letters') {
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

type Task = {
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
};

const tasksSchema = {
  type: 'object',
  description: 'A task.',
  properties: {
    name: { type: 'string', description: 'Name of the task.' },
    title: { type: 'string', description: 'Title of the task.' },
    body: { type: 'string', description: 'What the task asks.' },
    category: { type: 'string', description: 'Kind of task.' },
  },
  required: ['name', 'title', 'body', 'category'],
} as const;

const sizes = (maxTokens = 200, overlapTokens = 0): ChunkingOptions => ({
  tokenizer: cl100k,
  maxTokens,
  overlapTokens,
});

// A pipeline that copies the tasks the host holds into one SQLite file, and a
// vectorizer named docs over them; derived lists what comes before and after
// the vectorizer.
function tasksPipeline({
  directory,
  rows,
  model = new LetterModel(),
  chunking = sizes(),
  metadata = ['category'],
  key = 'name',
  columns = ['title', 'body'],
  closedWorld = false,
  incremental = false,
  after = () => [],
}: {
  readonly directory: string;
  readonly rows: () => readonly Task[];
  readonly model?: LetterModel | string;
  readonly chunking?: ChunkingOptions;
  readonly metadata?: readonly string[];
  readonly key?: string;
  readonly columns?: readonly [string, ...string[]];
  readonly closedWorld?: boolean;
  // An incremental copy with append_dedup, in place of a full refresh with
  // overwrite_dedup.
  readonly incremental?: boolean;
  readonly after?: (
    destination: SQLiteDestination,
  ) => readonly (View | Vectorizer)[];
}) {
  const path = join(directory, 'tasks.sqlite');
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        ...(closedWorld ? { deletions: 'closed-world' as const } : {}),
        snapshot: () => rows(),
      },
    },
  });
  const destination = new SQLiteDestination({ path });
  const target = destination.table('tasks');
  const vectorizer = new Vectorizer({
    into: destination,
    from: target,
    name: 'docs',
    description: 'The tasks.',
    key,
    loading: { columns },
    chunking,
    embedding: { model, dimensions: 26, clock: globalThis },
    metadata,
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: [
          new Copy(
            source.streams.tasks,
            target,
            incremental
              ? {
                  id: 'tasks',
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                }
              : {
                  syncMode: 'full_refresh',
                  destinationSyncMode: 'overwrite_dedup',
                },
          ),
        ],
      }),
    ],
    derived: [vectorizer, ...after(destination)],
  });
  return { path, pipeline, vectorizer, destination, target };
}

// The retrievers of @zukhruf/retrieval over the contract, on a read-only
// connection that can compute vec_distance_cosine.
function retrieval(path: string, vectorizer: Vectorizer, model: LetterModel) {
  const database = open(path, { readOnly: true });
  install(database);
  const store = new SqlitePassageStore({
    database,
    passages: vectorizer.contract.passages,
  });
  return {
    database,
    store,
    embedding: new SqliteEmbeddingRetriever({
      store,
      vectors: vectorizer.contract.vectors,
      model,
    }),
    keywords: (operator?: 'AND' | 'OR') =>
      new SqliteBM25Retriever({
        store,
        index: vectorizer.contract.index,
        operator,
      }),
    [Symbol.dispose]: () => database.close(),
  };
}

function rowsOf(path: string, sql: string) {
  using database = open(path, { readOnly: true });
  return database.prepare(sql).all();
}

// FTS5's own check of an external-content index against its content table.
function integrityCheck(path: string): void {
  using database = open(path);
  database
    .prepare(
      `INSERT INTO "docs_passages_fts" ("docs_passages_fts") VALUES ('integrity-check')`,
    )
    .run();
}

const task = (name: string, title: string, body = '', category = 'easy') => ({
  name,
  title,
  body,
  category,
});

test('a member that the store refuses fails only the vectorizer: the run rejects naming the vectorizer and the member, the members after it wait, the copy and a later view still refresh, and the index keeps the rows of the pass before', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  let rows = [task('a', 'fix git history'), task('c', 'boom stays')];
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => rows,
    model,
    after: (destination) => [
      new View({
        into: destination,
        name: 'task_names',
        description: 'The name of each task.',
        columns: { name: 'Name of the task.' },
        sql: 'SELECT "name" FROM "tasks"',
      }),
    ],
  });
  await tasks.pipeline.run();
  {
    // The store refuses to remove the keywords of c, after the refresh
    // already wrote the new text of a.
    using database = open(tasks.path);
    database.exec(
      `CREATE TRIGGER "boom" BEFORE DELETE ON "docs_keywords" WHEN old."text" LIKE '%boom%' BEGIN SELECT RAISE(ABORT, 'the store refuses to remove boom'); END`,
    );
  }
  const refreshedAt = () =>
    rowsOf(
      tasks.path,
      `SELECT "refreshed_at" FROM "derived_status" WHERE "dataset" = 'task_names'`,
    )[0]?.refreshed_at;
  const before = refreshedAt();
  rows = [task('a', 'fix git branches')];

  const error = await tasks.pipeline.run().then(
    () => assert.fail('the refused member should fail the run'),
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof DerivedDatasetError);
  assert.equal(error.dataset, 'docs');
  assert.ok(error.cause instanceof DerivedDatasetError);
  assert.equal(error.cause.dataset, 'docs_keywords');
  assert.deepEqual(
    rowsOf(tasks.path, 'SELECT "name" FROM "tasks" ORDER BY "name"').map(
      ({ name }) => name,
    ),
    ['a'],
  );
  assert.ok(String(refreshedAt()) > String(before));
  assert.deepEqual(
    rowsOf(
      tasks.path,
      `SELECT "dataset", "state" FROM "derived_status" WHERE "dataset" IN ('task_names', 'docs_keywords') ORDER BY "dataset"`,
    ).map(({ dataset, state }) => ({ dataset, state })),
    [
      { dataset: 'docs_keywords', state: 'failed' },
      { dataset: 'task_names', state: 'current' },
    ],
  );
  assert.equal(
    rowsOf(tasks.path, 'SELECT "state" FROM "docs_status"')[0]?.state,
    'failed',
  );
  assert.deepEqual(
    rowsOf(
      tasks.path,
      'SELECT "id", "text" FROM "docs_keywords" ORDER BY "id"',
    ).map((row) => ({ ...row })),
    [
      { id: 'a:0', text: 'fix git history' },
      { id: 'c:0', text: 'boom stays' },
    ],
  );
  assert.equal(model.embedded.includes('fix git branches'), false);
  integrityCheck(tasks.path);

  {
    using database = open(tasks.path);
    database.exec('DROP TRIGGER "boom"');
  }
  await tasks.pipeline.run();
  using search = retrieval(tasks.path, tasks.vectorizer, model);
  assert.deepEqual(
    (await search.keywords().retrieve('branches')).map(
      ({ passage }) => passage.id,
    ),
    ['a:0'],
  );
  assert.deepEqual(
    rowsOf(tasks.path, 'SELECT "id" FROM "docs_keywords"').map(({ id }) => id),
    ['a:0'],
  );
});

for (const name of ['docs', 'docs_passages'])
  test(`the name of the vectorizer and the names of its members count in the check of distinct names: a view named ${name} stops the run before any pass`, async () => {
    await using scratch = await new TemporaryFiles().directory('vectorizer-');
    const tasks = tasksPipeline({
      directory: scratch.path,
      rows: () => [task('a', 'one')],
      after: (destination) => [
        new View({
          into: destination,
          name,
          description: 'A host view.',
          columns: { name: 'Name.' },
          sql: 'SELECT "name" FROM "tasks"',
        }),
      ],
    });

    await assert.rejects(tasks.pipeline.run(), {
      name: 'TypeError',
      message: 'Pipeline derived dataset names must be distinct',
    });
    assert.equal(existsSync(tasks.path), false);
  });

test('a view after the vectorizer that reads its passages waits while the passages wait', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => {
      throw new Error('the host cannot give its rows');
    },
    after: (destination) => [
      new View({
        into: destination,
        name: 'passage_ids',
        description: 'The id of each passage.',
        columns: { id: 'Id of the passage.' },
        sql: 'SELECT "id" FROM "docs_passages"',
      }),
    ],
  });

  await assert.rejects(tasks.pipeline.run(), PipelineError);
  assert.equal(
    rowsOf(
      tasks.path,
      `SELECT "state" FROM "derived_status" WHERE "dataset" = 'passage_ids'`,
    )[0]?.state,
    'waiting',
  );
});

test('a vector search through the contract gives the passage with its id, source, seq, offsets, text and metadata, and each member keeps its own derived status', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [
      task('a', 'red car', 'drives fast', 'cars'),
      task('b', 'blue bike', 'rides slow', 'bikes'),
    ],
    model,
  });

  await tasks.pipeline.run();

  using search = retrieval(tasks.path, tasks.vectorizer, model);
  const [best] = await search.embedding.retrieve('red car drives fast', {
    topK: 1,
  });
  assert.deepEqual(best?.passage, {
    id: 'a:0',
    source: 'a',
    seq: 0,
    start: 0,
    end: [...'red car\ndrives fast'].length,
    text: 'red car\ndrives fast',
    metadata: { category: 'cars' },
  });
  assert.deepEqual(
    rowsOf(
      tasks.path,
      `SELECT "dataset", "kind", "state" FROM "derived_status" WHERE "dataset" LIKE 'docs%' ORDER BY "dataset"`,
    ).map((row) => ({ ...row })),
    [
      { dataset: 'docs_chunk_texts', kind: 'view', state: 'current' },
      { dataset: 'docs_chunk_vectors', kind: 'computed', state: 'current' },
      { dataset: 'docs_chunks', kind: 'computed', state: 'current' },
      { dataset: 'docs_keywords', kind: 'computed', state: 'current' },
      { dataset: 'docs_passage_vectors', kind: 'view', state: 'current' },
      { dataset: 'docs_passages', kind: 'view', state: 'current' },
      { dataset: 'docs_status', kind: 'view', state: 'current' },
    ],
  );
});

test('a keyword search finds the passages that hold every word, and with OR the passages that hold any word', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [
      task('a', 'merge git branches'),
      task('b', 'rebase git history'),
      task('c', 'paint the fence'),
    ],
    model,
  });

  await tasks.pipeline.run();

  using search = retrieval(tasks.path, tasks.vectorizer, model);
  assert.deepEqual(
    (await search.keywords().retrieve('git history')).map(
      ({ passage }) => passage.id,
    ),
    ['b:0'],
  );
  assert.deepEqual(
    (await search.keywords('OR').retrieve('history fence'))
      .map(({ passage }) => passage.id)
      .toSorted(),
    ['b:0', 'c:0'],
  );
});

test('a fusion of the vector and keyword searches ranks first the passage that both rank second, above the first of each', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [
      // The words of the query, often: the first of the keyword search.
      task('a', 'zebra zone zebra zone mmmm kkkk'),
      task('b', 'zebra zone t'),
      // The letters of the query, with none of its words: the first of the
      // vector search.
      task('c', 'bonze raze'),
      task('d', 'zebrazonett'),
    ],
    model,
  });

  await tasks.pipeline.run();

  using search = retrieval(tasks.path, tasks.vectorizer, model);
  const first = async (retriever: Retriever) =>
    (await retriever.retrieve('zebra zone'))[0]?.passage.id;
  assert.equal(await first(search.embedding), 'c:0');
  assert.equal(await first(search.keywords()), 'a:0');
  assert.equal(
    await first(
      new FusionRetriever({
        retrievers: [search.embedding, search.keywords()],
      }),
    ),
    'b:0',
  );
});

test('a passage whose vector the model failed never reaches a vector search, and still reaches a keyword search', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  model.answers.set(
    'broken text',
    Array.from({ length: 26 }, () => 0),
  );
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [task('a', 'broken text'), task('b', 'brown fox')],
    model,
  });

  await tasks.pipeline.run();

  using search = retrieval(tasks.path, tasks.vectorizer, model);
  assert.deepEqual(
    (await search.embedding.retrieve('brown fox')).map(
      ({ passage }) => passage.id,
    ),
    ['b:0'],
  );
  assert.deepEqual(
    (await search.keywords().retrieve('broken')).map(
      ({ passage }) => passage.id,
    ),
    ['a:0'],
  );
});

test('the context window of a passage of a source cut into many chunks gives the exact text of the source, with no gap', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const body = [
    'The farm loses a fifth of its fruit each summer.\r\nThe barn is too warm.',
    'A cold store keeps the fruit cold 🍎 until the trucks come.',
    'Each   truck   takes the fruit to the market in town, and needle sits here.',
  ].join('\n\n');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [task('a', 'Cold store', body)],
    model,
    chunking: sizes(12, 4),
  });

  await tasks.pipeline.run();

  using search = retrieval(tasks.path, tasks.vectorizer, model);
  const found = await search.keywords().retrieve('needle');
  const [widened] = await new ContextWindow({
    store: search.store,
    windowSize: 99,
  }).postprocess(found, 'needle');
  const text = `Cold store\n${body}`;
  assert.ok(
    Number(
      rowsOf(tasks.path, 'SELECT count(*) AS "n" FROM "docs_passages"')[0]?.n,
    ) > 2,
  );
  assert.equal(widened?.passage.text, text);
  assert.equal(widened?.passage.start, 0);
  assert.equal(widened?.passage.end, [...text].length);
});

test('with no chunking each row is one passage whose end counts code points', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [task('a', 'apple 🍎', 'pie')],
    model,
    chunking: 'none',
  });

  await tasks.pipeline.run();

  assert.deepEqual(
    rowsOf(
      tasks.path,
      'SELECT "id", "seq", "start", "end", "text" FROM "docs_passages"',
    ).map((row) => ({ ...row })),
    [{ id: 'a:0', seq: 0, start: 0, end: 11, text: 'apple 🍎\npie' }],
  );
});

test('a key of two columns gives the JSON array of their values as the source, and the metadata of that row', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const path = join(scratch.path, 'pages.sqlite');
  const source = new IterableSource({
    identity: 'pages',
    streams: {
      pages: {
        description: 'Pages of sites.',
        jsonSchema: {
          type: 'object',
          description: 'A page.',
          properties: {
            site: { type: 'string', description: 'Site.' },
            id: { type: 'integer', description: 'Page id.' },
            text: { type: 'string', description: 'Text.' },
            owner: { type: 'string', description: 'Owner.' },
          },
          required: ['site', 'id', 'text', 'owner'],
        },
        primaryKey: ['site', 'id'],
        snapshot: () => [
          { site: 's1', id: 7, text: 'seven of one', owner: 'ann' },
          { site: 's2', id: 7, text: 'seven of two', owner: 'bob' },
        ],
      },
    },
  });
  const destination = new SQLiteDestination({ path });
  const target = destination.table('pages');
  const vectorizer = new Vectorizer({
    into: destination,
    from: target,
    name: 'docs',
    description: 'The pages.',
    key: ['site', 'id'],
    loading: { columns: ['text'] },
    chunking: 'none',
    embedding: { model: new LetterModel(), dimensions: 26, clock: globalThis },
    metadata: ['owner'],
  });
  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'pages',
        source,
        destination,
        steps: [
          new Copy(source.streams.pages, target, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
    derived: [vectorizer],
  }).run();

  assert.deepEqual(
    rowsOf(
      path,
      'SELECT "id", "source", "owner" FROM "docs_passages" ORDER BY "id"',
    ).map((row) => ({ ...row })),
    [
      { id: '["s1",7]:0', source: '["s1",7]', owner: 'ann' },
      { id: '["s2",7]:0', source: '["s2",7]', owner: 'bob' },
    ],
  );
});

test('a key of one integer column gives its plain value as the source, and joins the row it comes from', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const path = join(scratch.path, 'pages.sqlite');
  const source = new IterableSource({
    identity: 'pages',
    streams: {
      pages: {
        description: 'Pages.',
        jsonSchema: {
          type: 'object',
          description: 'A page.',
          properties: {
            id: { type: 'integer', description: 'Page id.' },
            text: { type: 'string', description: 'Text.' },
            owner: { type: 'string', description: 'Owner.' },
          },
          required: ['id', 'text', 'owner'],
        },
        primaryKey: ['id'],
        snapshot: () => [
          { id: 7, text: 'page seven', owner: 'ann' },
          { id: 12, text: 'page twelve', owner: 'bob' },
        ],
      },
    },
  });
  const destination = new SQLiteDestination({ path });
  const target = destination.table('pages');
  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'pages',
        source,
        destination,
        steps: [
          new Copy(source.streams.pages, target, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
    derived: [
      new Vectorizer({
        into: destination,
        from: target,
        name: 'docs',
        description: 'The pages.',
        key: 'id',
        loading: { columns: ['text'] },
        chunking: 'none',
        embedding: {
          model: new LetterModel(),
          dimensions: 26,
          clock: globalThis,
        },
        metadata: ['owner'],
      }),
    ],
  }).run();

  assert.deepEqual(
    rowsOf(
      path,
      'SELECT "id", "source", "owner" FROM "docs_passages" ORDER BY "id"',
    ).map((row) => ({ ...row })),
    [
      { id: '12:0', source: '12', owner: 'bob' },
      { id: '7:0', source: '7', owner: 'ann' },
    ],
  );
});

for (const incremental of [false, true])
  test(`a row that the host stops giving leaves the passages, the keywords and the vectors, and a vector that another row shares stays (${incremental ? 'incremental with append_dedup' : 'full refresh with overwrite_dedup'})`, async () => {
    await using scratch = await new TemporaryFiles().directory('vectorizer-');
    let rows = [
      task('a', 'same text'),
      task('b', 'same text'),
      task('c', 'lonely text'),
    ];
    const tasks = tasksPipeline({
      directory: scratch.path,
      rows: () => rows,
      closedWorld: true,
      incremental,
    });
    await tasks.pipeline.run();

    rows = [task('b', 'same text')];
    await tasks.pipeline.run();

    assert.deepEqual(
      rowsOf(tasks.path, 'SELECT "name" FROM "tasks"').map(({ name }) => name),
      ['b'],
    );
    assert.deepEqual(
      rowsOf(tasks.path, 'SELECT "source" FROM "docs_chunks_parts"').map(
        ({ source }) => source,
      ),
      ['b'],
    );
    for (const relation of [
      'docs_passages',
      'docs_keywords',
      'docs_passage_vectors',
    ])
      assert.deepEqual(
        rowsOf(tasks.path, `SELECT "id" FROM "${relation}"`).map(
          ({ id }) => id,
        ),
        ['b:0'],
        relation,
      );
    assert.equal(
      rowsOf(tasks.path, 'SELECT count(*) AS "n" FROM "docs_chunk_vectors"')[0]
        ?.n,
      1,
    );
  });

test('after a remake of the keyword index its FTS5 index checks and a keyword search finds the passages', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => [task('a', 'merge git branches'), task('b', 'paint the fence')],
    model,
  });
  await tasks.pipeline.run();
  {
    // A later version declares a trigger in another way, and the index is
    // empty: only a remake and its refill find the passages again.
    using database = open(tasks.path);
    database.exec(
      `DROP TRIGGER "docs_keywords_au"; CREATE TRIGGER "docs_keywords_au" AFTER UPDATE ON "docs_keywords" BEGIN SELECT 1; END; INSERT INTO "docs_passages_fts" ("docs_passages_fts") VALUES ('delete-all')`,
    );
  }

  await tasks.pipeline.run();

  integrityCheck(tasks.path);
  assert.match(
    String(
      rowsOf(
        tasks.path,
        `SELECT "sql" FROM "sqlite_schema" WHERE "name" = 'docs_keywords_au'`,
      )[0]?.sql,
    ),
    /'delete'/,
  );
  using search = retrieval(tasks.path, tasks.vectorizer, model);
  assert.deepEqual(
    (await search.keywords().retrieve('fence')).map(
      ({ passage }) => passage.id,
    ),
    ['b:0'],
  );
});

test('another model embeds the passages again in place: while it embeds, the status shows the vectors that wait and each model finds only its own vectors', async (t) => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const rows = Array.from({ length: 70 }, (_, index) =>
    task(`t${String(index).padStart(2, '0')}`, `task number ${index}`),
  );
  const before = new LetterModel('letters-1');
  await tasksPipeline({
    directory: scratch.path,
    rows: () => rows,
    model: before,
  }).pipeline.run();
  const after = new LetterModel('letters-2');
  // Embedding sends 64 texts in a call, so the second call holds the last 6
  // texts, and it hangs until the run stops.
  let calls = 0;
  const hanging = Promise.withResolvers<void>();
  after.hangs = () => {
    if (++calls !== 2) return false;
    hanging.resolve();
    return true;
  };
  const tasks = tasksPipeline({
    directory: scratch.path,
    rows: () => rows,
    model: after,
  });
  const controller = new AbortController();

  const running = tasks.pipeline.run({ signal: controller.signal });
  try {
    await Promise.race([
      hanging.promise,
      running.then(() =>
        assert.fail('the run ended before the new model embedded again'),
      ),
    ]);
    const vectors = (model: string) =>
      Number(
        rowsOf(
          tasks.path,
          `SELECT count(*) AS "n" FROM "docs_passage_vectors" WHERE "model" = 'test/${model} (26 dimensions)'`,
        )[0]?.n,
      );
    await waitFor(() => assert.equal(vectors('letters-2'), 64), {
      signal: t.signal,
    });
    assert.deepEqual(
      rowsOf(
        tasks.path,
        'SELECT "state", "pending_vectors" FROM "docs_status"',
      ).map((row) => ({ ...row })),
      [{ state: 'refreshing', pending_vectors: 6 }],
    );
    {
      using search = retrieval(tasks.path, tasks.vectorizer, after);
      assert.equal(
        (await search.embedding.retrieve('task number', { topK: 70 })).length,
        64,
      );
    }
    using search = retrieval(tasks.path, tasks.vectorizer, before);
    assert.equal(
      (await search.embedding.retrieve('task number', { topK: 70 })).length,
      6,
    );
  } finally {
    controller.abort();
    await running.catch(() => {});
  }

  await tasksPipeline({
    directory: scratch.path,
    rows: () => rows,
    model: new LetterModel('letters-2'),
  }).pipeline.run();
  assert.deepEqual(
    rowsOf(
      tasks.path,
      'SELECT "state", "pending_vectors" FROM "docs_status"',
    ).map((row) => ({ ...row })),
    [{ state: 'current', pending_vectors: 0 }],
  );
  assert.deepEqual(
    rowsOf(
      tasks.path,
      'SELECT DISTINCT "model" FROM "docs_passage_vectors"',
    ).map(({ model }) => model),
    ['test/letters-2 (26 dimensions)'],
  );
});

test('a string model id and the provider model write one model identity, which a search with the provider model reads', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const model = new LetterModel('letters');
  const saved = globalThis.AI_SDK_DEFAULT_PROVIDER;
  globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
    embeddingModels: { 'test/letters': model },
  });
  try {
    const tasks = tasksPipeline({
      directory: scratch.path,
      rows: () => [task('a', 'string model')],
      model: 'test/letters',
    });
    await tasks.pipeline.run();

    assert.deepEqual(
      rowsOf(
        tasks.path,
        'SELECT DISTINCT "model" FROM "docs_passage_vectors"',
      ).map(({ model: identity }) => identity),
      ['test/letters (26 dimensions)'],
    );
    using search = retrieval(tasks.path, tasks.vectorizer, model);
    assert.deepEqual(
      (await search.embedding.retrieve('string model')).map(
        ({ passage }) => passage.id,
      ),
      ['a:0'],
    );
  } finally {
    globalThis.AI_SDK_DEFAULT_PROVIDER = saved;
  }
});

test('the vectorizer refuses a metadata column that has the name of a passage column, a metadata column listed twice and a key column listed twice', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  for (const [metadata, named] of [
    [['rowid'], 'rowid'],
    [['ID'], 'ID'],
    [['Source'], 'Source'],
    [['seq'], 'seq'],
    [['start'], 'start'],
    [['END'], 'END'],
    [['text'], 'text'],
    [['category', 'category'], 'category'],
  ] as const)
    assert.throws(
      () =>
        tasksPipeline({
          directory: scratch.path,
          rows: () => [],
          metadata,
        }),
      (error: unknown) =>
        error instanceof TypeError && error.message.includes(named),
    );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'keys.sqlite'),
  });
  for (const [first, second] of [
    ['name', 'name'],
    ['name', 'Name'],
  ] as const)
    assert.throws(
      () =>
        new Vectorizer({
          into: destination,
          from: destination.table('tasks'),
          name: 'docs',
          description: 'The tasks.',
          key: [first, second],
          loading: { columns: ['title'] },
          chunking: 'none',
          embedding: {
            model: new LetterModel(),
            dimensions: 26,
            clock: globalThis,
          },
        }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.includes(`key column ${second}`),
    );
});

for (const declaration of [
  { metadata: ['owner'] },
  { key: 'owner' },
  { columns: ['title', 'owner'] },
] as const)
  test(`a run refuses a vectorizer that reads a column the stream does not declare, before it reads: ${JSON.stringify(declaration)}`, async () => {
    await using scratch = await new TemporaryFiles().directory('vectorizer-');
    let read = false;
    const tasks = tasksPipeline({
      directory: scratch.path,
      rows: () => {
        read = true;
        return [];
      },
      ...declaration,
    });

    await assert.rejects(tasks.pipeline.run(), {
      name: 'TypeError',
      message: /the column owner of tasks/,
    });
    assert.equal(read, false);
  });

// The text of a plain text file.
class TextParser extends DocumentParser {
  constructor() {
    super('text/plain');
  }

  override async parse(path: string) {
    return readFile(path, 'utf8');
  }
}

// Files of a folder, each with the name the test gives it.
class Notes extends Source {
  readonly identity = 'notes';
  rows: readonly { readonly name: string; readonly file: string }[] = [];
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: { name: { type: 'string', description: 'Name.' } },
      required: ['name'],
    },
    primaryKey: ['name'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.notes]);

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
    const gauge = new (class extends Gauge<number> {
      protected async read() {
        return 0;
      }
    })();
    return [{ gauge, streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const { name, file } of this.rows)
      yield { stream: configuration.stream.name, data: { name }, file };
  }
}

test('two rows that share one stored file give two sources with the text of the file, keyed by the row key', async () => {
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const folder = join(scratch.path, 'notes');
  await mkdir(folder);
  const file = join(folder, 'shared.txt');
  await writeFile(file, 'call the cooperative');
  const source = new Notes();
  source.rows = [
    { name: 'first', file },
    { name: 'second', file },
  ];
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const notes: SQLiteTable = destination.table('notes', (c) => [
    c.text('name').primaryKey(),
    c.text('noteRef').from(source.notes.file.store(files)),
  ]);
  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, notes)],
      }),
    ],
    derived: [
      new Vectorizer({
        into: destination,
        from: notes,
        name: 'docs',
        description: 'The notes.',
        key: 'name',
        loading: { file: 'noteRef', files, parser: () => new TextParser() },
        chunking: 'none',
        embedding: {
          model: new LetterModel(),
          dimensions: 26,
          clock: globalThis,
        },
      }),
    ],
  }).run();

  assert.deepEqual(
    rowsOf(
      join(scratch.path, 'notes.sqlite'),
      'SELECT "id", "source", "text" FROM "docs_passages" ORDER BY "id"',
    ).map((row) => ({ ...row })),
    [
      { id: 'first:0', source: 'first', text: 'call the cooperative' },
      { id: 'second:0', source: 'second', text: 'call the cooperative' },
    ],
  );
});
