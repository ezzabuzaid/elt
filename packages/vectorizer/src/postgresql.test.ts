// The vectorizer through a real Pipeline and a real Postgres with pgvector,
// read back through the store and the retrievers of @zukhruf/retrieval, as a
// host reads it. The embedding model is the one stand-in (LetterModel).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import {
  ContextWindow,
  FusionRetriever,
  type Retriever,
} from '@zukhruf/retrieval';
import {
  PgvectorEmbeddingRetriever,
  PgvectorKeywordRetriever,
  PostgresPassageStore,
  type PostgresSession,
} from '@zukhruf/retrieval/postgres';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  Gauge,
  IterableSource,
  LocalFiles,
  Pipeline,
  type SnapshotStreamDeclaration,
  Source,
  Stream,
  type StreamSchema,
} from '@eltjs/elt';
import {
  type Hnsw,
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import { type ChunkingOptions, Vectorizer } from './postgresql.ts';
import { LetterModel } from './testing/letter-model.ts';

// The server of every test: the default image of the fixture has no pgvector.
const databases = new Postgres({
  environment: process.env,
  image: 'pgvector/pgvector:pg18',
});

type Task = {
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
};

const task = (name: string, title: string, body = '', category = 'easy') => ({
  name,
  title,
  body,
  category,
});

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

// A pipeline that copies the rows that the host holds into one Postgres
// database, and a vectorizer named docs over them, one passage for each row.
function rowsPipeline<Schema extends StreamSchema>({
  url,
  stream,
  key,
  columns,
  metadata,
  model = new LetterModel(),
  incremental = false,
  keywords,
  indexing,
  chunking = 'none',
}: {
  readonly url: string;
  readonly stream: SnapshotStreamDeclaration<Schema>;
  readonly key: string | readonly [string, string, ...string[]];
  readonly columns: readonly [string, ...string[]];
  readonly metadata: readonly string[];
  readonly model?: LetterModel;
  // An incremental copy with append_dedup, in place of a full refresh with
  // overwrite_dedup.
  readonly incremental?: boolean;
  readonly keywords?: { readonly configuration?: string };
  readonly indexing?: { readonly vectors: Hnsw | 'none' };
  readonly chunking?: ChunkingOptions;
}) {
  const source = new IterableSource({
    identity: 'rows',
    streams: { rows: stream },
  });
  const destination = new PostgresDestination({ url });
  const target = destination.table('rows');
  const vectorizer = new Vectorizer({
    into: destination,
    from: target,
    name: 'docs',
    description: 'The rows.',
    key,
    loading: { columns },
    chunking,
    embedding: { model, dimensions: 26, clock: globalThis },
    metadata,
    ...(keywords === undefined ? {} : { keywords }),
    ...(indexing === undefined ? {} : { indexing }),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'rows',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({ url }),
        steps: [
          new Copy(
            source.streams.rows,
            target,
            incremental
              ? {
                  id: 'rows',
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
    derived: [vectorizer],
  });
  return { pipeline, vectorizer };
}

// The tasks that the host holds, keyed by name, with their category as
// metadata.
function tasksPipeline({
  url,
  rows,
  closedWorld = false,
  ...options
}: {
  readonly url: string;
  readonly rows: () => readonly Task[];
  readonly closedWorld?: boolean;
  readonly model?: LetterModel;
  readonly incremental?: boolean;
  readonly keywords?: { readonly configuration?: string };
  readonly indexing?: { readonly vectors: Hnsw | 'none' };
  readonly chunking?: ChunkingOptions;
}) {
  return rowsPipeline({
    url,
    stream: {
      description: 'The tasks that the test gives.',
      jsonSchema: tasksSchema,
      primaryKey: ['name'],
      ...(closedWorld ? { deletions: 'closed-world' as const } : {}),
      snapshot: () => rows(),
    },
    key: 'name',
    columns: ['title', 'body'],
    metadata: ['category'],
    ...options,
  });
}

// A parameter of the retrievers' SQL, which binds only text and numbers.
function parameter(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new TypeError(`A retriever bound ${String(value)}`);
}

// The retrievers of @zukhruf/retrieval over the contract, on a session of
// its own whose run-time parameters are settings.
function retrieval(
  url: string,
  vectorizer: Vectorizer,
  model: LetterModel,
  settings: Readonly<Record<string, string>> = {},
) {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: settings,
  });
  let last: { text: string; parameters: (string | number)[] } | undefined;
  const session: PostgresSession = {
    query: async (text, parameters) => {
      last = { text, parameters: parameters.map(parameter) };
      return [...(await sql.unsafe(last.text, last.parameters))];
    },
  };
  const { contract } = vectorizer;
  const store = new PostgresPassageStore({
    session,
    schema: contract.schema,
    passages: contract.passages,
  });
  return {
    store,
    // The plan of the last statement that a retriever sent, on its session.
    plan: async () => {
      if (last === undefined) assert.fail('no retriever sent a statement');
      return (
        await sql.unsafe(`EXPLAIN (COSTS OFF) ${last.text}`, last.parameters)
      ).map((row) => String(row['QUERY PLAN']));
    },
    embedding: new PgvectorEmbeddingRetriever({
      store,
      vectors: contract.vectors,
      model,
    }),
    keywords: (
      options: {
        readonly operator?: 'AND' | 'OR';
        readonly configuration?: string;
      } = {},
    ) =>
      new PgvectorKeywordRetriever({
        store,
        index: {
          ...contract.index,
          ...(options.configuration === undefined
            ? {}
            : { configuration: options.configuration }),
        },
        ...(options.operator === undefined
          ? {}
          : { operator: options.operator }),
      }),
    [Symbol.asyncDispose]: () => sql.end(),
  };
}

async function rowsOf(url: string, query: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return [...(await sql.unsafe(query))];
  } finally {
    await sql.end();
  }
}

const ids = (
  passages: readonly { readonly passage: { readonly id: string } }[],
) => passages.map(({ passage }) => passage.id);

test('a vector search through the contract gives the passage with its id, source, seq, offsets, text and metadata, and not its keywords, and each member keeps its own derived status', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  const tasks = tasksPipeline({
    url,
    rows: () => [
      task('a', 'red car', 'drives fast', 'cars'),
      task('b', 'blue bike', 'rides slow', 'bikes'),
    ],
    model,
  });

  await tasks.pipeline.run();

  await using search = retrieval(url, tasks.vectorizer, model);
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
    (
      await rowsOf(
        url,
        `SELECT "dataset", "kind", "state" FROM _warehouse.derived_status WHERE "dataset" LIKE '%docs%' ORDER BY "dataset" COLLATE "C"`,
      )
    ).map((row) => ({ ...row })),
    [
      {
        dataset: '_warehouse.raw_docs_keywords',
        kind: 'computed',
        state: 'current',
      },
      { dataset: 'marts.docs_chunk_texts', kind: 'view', state: 'current' },
      {
        dataset: 'marts.docs_chunk_vectors',
        kind: 'computed',
        state: 'current',
      },
      { dataset: 'marts.docs_chunks', kind: 'computed', state: 'current' },
      { dataset: 'marts.docs_passage_vectors', kind: 'view', state: 'current' },
      { dataset: 'marts.docs_passages', kind: 'view', state: 'current' },
      { dataset: 'marts.docs_status', kind: 'view', state: 'current' },
    ],
  );
  assert.deepEqual(
    (
      await rowsOf(
        url,
        'SELECT "state", "as_of" IS NOT NULL AS "as_of", "pending_sources"::int AS "pending_sources", "pending_vectors"::int AS "pending_vectors" FROM marts.docs_status',
      )
    ).map((row) => ({ ...row })),
    [{ state: 'current', as_of: true, pending_sources: 0, pending_vectors: 0 }],
  );
});

test('a keyword search finds the passages that hold every word, and with OR the passages that hold any word', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  const tasks = tasksPipeline({
    url,
    rows: () => [
      task('a', 'merge git branches'),
      task('b', 'rebase git history'),
      task('c', 'paint the fence'),
    ],
    model,
  });

  await tasks.pipeline.run();

  await using search = retrieval(url, tasks.vectorizer, model);
  assert.deepEqual(ids(await search.keywords().retrieve('git history')), [
    'b:0',
  ]);
  assert.deepEqual(
    ids(
      await search.keywords({ operator: 'OR' }).retrieve('history fence'),
    ).toSorted(),
    ['b:0', 'c:0'],
  );
  assert.deepEqual(
    (
      await rowsOf(
        url,
        `SELECT pg_get_indexdef(i.indexrelid) AS "definition" FROM pg_index i WHERE i.indrelid = '_warehouse.raw_docs_keywords'::regclass AND NOT i.indisprimary AND NOT i.indisunique`,
      )
    ).map(({ definition }) =>
      String(definition).replace(/^CREATE INDEX \S+ /, 'CREATE INDEX <name> '),
    ),
    [
      'CREATE INDEX <name> ON _warehouse.raw_docs_keywords USING gin (keywords)',
    ],
  );
});

test('a fusion of the vector and keyword searches ranks first the passage that both rank second, above the first of each', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  const tasks = tasksPipeline({
    url,
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

  await using search = retrieval(url, tasks.vectorizer, model);
  const ranked = async (retriever: Retriever) =>
    ids(await retriever.retrieve('zebra zone')).slice(0, 2);
  const first = async (retriever: Retriever) => (await ranked(retriever))[0];
  assert.deepEqual(await ranked(search.embedding), ['c:0', 'b:0']);
  assert.deepEqual(await ranked(search.keywords()), ['a:0', 'b:0']);
  assert.equal(
    await first(
      new FusionRetriever({
        retrievers: [search.embedding, search.keywords()],
      }),
    ),
    'b:0',
  );
});

test('while another model embeds the passages again, a search with the model of the few vectors made again gives its topK through the HNSW index of the vectors', async (t) => {
  await using database = await databases.database();
  const url = database.connectionString;
  const rows = Array.from({ length: 1000 }, (_, index) =>
    task(`t${String(index).padStart(4, '0')}`, `task ${index}`),
  );
  // Each vector is a direction of its own, from a seeded generator, so the
  // graph of HNSW links the vectors of both models. 64 of 1000 vectors are
  // of the new model, so of the 40 nearest that HNSW gives first
  // (hnsw.ef_search) about 3 are of it, and its filter on the model drops the
  // rest.
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31 - 0.5;
  };
  const direction = () => Array.from({ length: 26 }, random);
  const before = new LetterModel('letters-1');
  const after = new LetterModel('letters-2');
  for (const { title } of rows) {
    before.answers.set(title, direction());
    after.answers.set(title, direction());
  }
  after.answers.set('the query', direction());
  await tasksPipeline({ url, rows: () => rows, model: before }).pipeline.run();
  // Embedding sends 64 texts in a call, so the new model makes the vectors
  // of its first call, and each call of the run after it hangs until the run
  // stops. The search embeds its query with no wait.
  let calls = 0;
  const hanging = Promise.withResolvers<void>();
  after.hangs = (values) => {
    if (values.includes('the query') || ++calls < 2) return false;
    hanging.resolve();
    return true;
  };
  const tasks = tasksPipeline({ url, rows: () => rows, model: after });
  const controller = new AbortController();

  const running = tasks.pipeline.run({ signal: controller.signal });
  try {
    await Promise.race([
      hanging.promise,
      running.then(() =>
        assert.fail('the run ended before the new model embedded again'),
      ),
    ]);
    const vectors = async (identity: string) =>
      Number(
        (
          await rowsOf(
            url,
            `SELECT count(*) AS "n" FROM marts.docs_passage_vectors WHERE "model" = 'test/${identity} (26 dimensions)'`,
          )
        )[0]?.n,
      );
    await waitFor(async () => assert.equal(await vectors('letters-2'), 64), {
      signal: t.signal,
    });
    assert.deepEqual(
      (
        await rowsOf(
          url,
          'SELECT "state", "pending_vectors"::int AS "pending_vectors" FROM marts.docs_status',
        )
      ).map((row) => ({ ...row })),
      [{ state: 'refreshing', pending_vectors: 936 }],
    );
    // A planner that knows how few vectors the new model has reads them in
    // full and sorts them. The reader session forbids the full read and the
    // sort, as on a table whose statistics say that the model passes most
    // rows, so the search goes through HNSW, which the plan shows.
    await using search = retrieval(url, tasks.vectorizer, after, {
      enable_seqscan: 'off',
      enable_sort: 'off',
    });

    const found = await search.embedding.retrieve('the query', { topK: 10 });

    assert.deepEqual(
      {
        found: found.length,
        hnsw: (await search.plan()).some((line) =>
          /Index Scan using ix_elt_[0-9a-f]{16} on raw_docs_chunk_vectors/.test(
            line,
          ),
        ),
      },
      { found: 10, hnsw: true },
    );
  } finally {
    controller.abort();
    await running.catch(() => {});
  }
});

test('the vectors have an HNSW index with vector_cosine_ops when the vectorizer declares no indexing', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const tasks = tasksPipeline({ url, rows: () => [task('a', 'near search')] });

  await tasks.pipeline.run();

  assert.deepEqual(
    (
      await rowsOf(
        url,
        `SELECT pg_get_indexdef(i.indexrelid) AS "definition" FROM pg_index i WHERE i.indrelid = '_warehouse.raw_docs_chunk_vectors'::regclass AND NOT i.indisprimary`,
      )
    ).map(({ definition }) =>
      String(definition).replace(/ix_elt_[0-9a-f]{16}/, 'ix_elt_<hash>'),
    ),
    [
      'CREATE INDEX ix_elt_<hash> ON _warehouse.raw_docs_chunk_vectors USING hnsw (vector vector_cosine_ops)',
    ],
  );
});

test('with indexing none the vectors have no vector index', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'exact search')],
    indexing: { vectors: 'none' },
  });

  await tasks.pipeline.run();

  assert.deepEqual(
    await rowsOf(
      url,
      `SELECT 1 FROM pg_index i WHERE i.indrelid = '_warehouse.raw_docs_chunk_vectors'::regclass AND NOT i.indisprimary`,
    ),
    [],
  );
});

for (const incremental of [false, true])
  test(`a row that the host stops giving leaves the passages, the keywords and the vectors, and a vector that another row shares stays (${incremental ? 'incremental with append_dedup' : 'full refresh with overwrite_dedup'})`, async () => {
    await using database = await databases.database();
    const url = database.connectionString;
    let rows = [
      task('a', 'same text'),
      task('b', 'same text'),
      task('c', 'lonely text'),
    ];
    const tasks = tasksPipeline({
      url,
      rows: () => rows,
      closedWorld: true,
      incremental,
    });
    await tasks.pipeline.run();

    rows = [task('b', 'same text')];
    await tasks.pipeline.run();

    const column = async (query: string) =>
      (await rowsOf(url, query)).map((row) => Object.values(row)[0]);
    assert.deepEqual(await column('SELECT "name" FROM marts.rows'), ['b']);
    assert.deepEqual(
      await column('SELECT "source" FROM marts.docs_chunks_parts'),
      ['b'],
    );
    for (const relation of [
      'marts.docs_passages',
      '_warehouse.raw_docs_keywords',
      'marts.docs_passage_vectors',
    ])
      assert.deepEqual(
        await column(`SELECT "id" FROM ${relation}`),
        ['b:0'],
        relation,
      );
    assert.deepEqual(
      await column('SELECT count(*)::int FROM marts.docs_chunk_vectors'),
      [1],
    );
  });

test('a key of one integer column gives its plain value as the source, and joins the row it comes from', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const pages = rowsPipeline({
    url,
    stream: {
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
    key: 'id',
    columns: ['text'],
    metadata: ['owner'],
  });

  await pages.pipeline.run();

  assert.deepEqual(
    (
      await rowsOf(
        url,
        'SELECT "id", "source", "owner" FROM marts.docs_passages ORDER BY "id"',
      )
    ).map((row) => ({ ...row })),
    [
      { id: '12:0', source: '12', owner: 'bob' },
      { id: '7:0', source: '7', owner: 'ann' },
    ],
  );
});

test('a key of two columns gives the JSON array of their values as the source, and the metadata of that row', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const pages = rowsPipeline({
    url,
    stream: {
      description: 'Pages of sites.',
      jsonSchema: {
        type: 'object',
        description: 'A page of a site.',
        properties: {
          site: { type: 'string', description: 'Site.' },
          id: { type: 'integer', description: 'Page id in the site.' },
          text: { type: 'string', description: 'Text.' },
          owner: { type: 'string', description: 'Owner.' },
        },
        required: ['site', 'id', 'text', 'owner'],
      },
      primaryKey: ['site', 'id'],
      snapshot: () => [
        { site: 's1', id: 7, text: 'first site', owner: 'ann' },
        { site: 's2', id: 7, text: 'second site', owner: 'bob' },
      ],
    },
    key: ['site', 'id'],
    columns: ['text'],
    metadata: ['owner'],
  });

  await pages.pipeline.run();

  // The driver reads a bigint as text, so the id is a string in the array.
  assert.deepEqual(
    (
      await rowsOf(
        url,
        'SELECT "id", "source", "owner" FROM marts.docs_passages ORDER BY "id"',
      )
    ).map((row) => ({ ...row })),
    [
      { id: '["s1","7"]:0', source: '["s1","7"]', owner: 'ann' },
      { id: '["s2","7"]:0', source: '["s2","7"]', owner: 'bob' },
    ],
  );
});

test('another text search configuration makes the keywords again in it, so a search in it finds a word that the one before dropped', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  const rows = () => [task('a', 'to be or not to be')];
  // No configuration: the keywords are in english.
  const english = tasksPipeline({ url, rows, model });
  await english.pipeline.run();
  const dropped = async () => {
    await using search = retrieval(url, english.vectorizer, model);
    return ids(
      await search.keywords({ configuration: 'simple' }).retrieve('be'),
    );
  };
  const before = await dropped();

  const simple = tasksPipeline({
    url,
    rows,
    model,
    keywords: { configuration: 'simple' },
  });
  await simple.pipeline.run();

  await using search = retrieval(url, simple.vectorizer, model);
  assert.deepEqual(
    {
      before,
      after: ids(await search.keywords().retrieve('be')),
      configurations: [english, simple].map(
        ({ vectorizer }) => vectorizer.contract.index.configuration,
      ),
    },
    { before: [], after: ['a:0'], configurations: ['english', 'simple'] },
  );
});

test('a passage whose vector the model failed never reaches a vector search, and still reaches a keyword search', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  model.answers.set(
    'broken text',
    Array.from({ length: 26 }, () => 0),
  );
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'broken text'), task('b', 'brown fox')],
    model,
  });

  await tasks.pipeline.run();

  await using search = retrieval(url, tasks.vectorizer, model);
  assert.deepEqual(ids(await search.embedding.retrieve('brown fox')), ['b:0']);
  assert.deepEqual(ids(await search.keywords().retrieve('broken')), ['a:0']);
});

test('the status view counts the passage texts whose vectors the model refused, and the next refresh with a model that answers counts none', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const rows = () => [task('a', 'red fox'), task('b', 'brown dog')];
  const refusing = new (class extends LetterModel {
    override async doEmbed(): Promise<never> {
      throw new Error('the model is down');
    }
  })();
  const status = () =>
    rowsOf(
      url,
      'SELECT "state", "pending_vectors"::int AS "pending_vectors", "failed_sources"::int AS "failed_sources", "failed_vectors"::int AS "failed_vectors" FROM marts.docs_status',
    );

  await tasksPipeline({ url, rows, model: refusing }).pipeline.run();

  assert.deepEqual(await status(), [
    {
      state: 'current',
      pending_vectors: 0,
      failed_sources: 0,
      failed_vectors: 2,
    },
  ]);

  await tasksPipeline({ url, rows }).pipeline.run();

  assert.deepEqual(await status(), [
    {
      state: 'current',
      pending_vectors: 0,
      failed_sources: 0,
      failed_vectors: 0,
    },
  ]);
});

test('the status view counts the source rows whose passages failed', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'red fox'), task('b', 'brown dog')],
    chunking: {
      tokenizer: {
        name: 'cl100k_base',
        count: () => {
          throw new Error('the tokenizer refuses');
        },
      },
      maxTokens: 200,
      overlapTokens: 0,
    },
  });

  await tasks.pipeline.run();

  assert.deepEqual(
    await rowsOf(
      url,
      'SELECT "state", "failed_sources"::int AS "failed_sources", "failed_vectors"::int AS "failed_vectors", "pending_files", "failed_files" FROM marts.docs_status',
    ),
    // A vectorizer that loads columns reads no file, so it counts none,
    // bigint as the other counts, which postgres.js reads as text.
    [
      {
        state: 'current',
        failed_sources: 2,
        failed_vectors: 0,
        pending_files: '0',
        failed_files: '0',
      },
    ],
  );
});

test('with no chunking each row is one passage whose end counts code points', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'apple 🍎', 'pie')],
  });

  await tasks.pipeline.run();

  assert.deepEqual(
    (
      await rowsOf(
        url,
        'SELECT "id", "seq", "start"::int AS "start", "end"::int AS "end", "text" FROM marts.docs_passages',
      )
    ).map((row) => ({ ...row })),
    [{ id: 'a:0', seq: 0, start: 0, end: 11, text: 'apple 🍎\npie' }],
  );
});

test('the context window of a passage of a source cut into many chunks gives the exact text of the source, with no gap', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const body = [
    'The farm loses a fifth of its fruit each summer.\r\nThe barn is too warm.',
    'A cold store keeps the fruit cold 🍎 until the trucks come.',
    'Each   truck   takes the fruit to the market in town, and needle sits here.',
  ].join('\n\n');
  const model = new LetterModel();
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'Cold store', body)],
    model,
    chunking: {
      tokenizer: { name: 'cl100k_base', count: countTokens },
      maxTokens: 12,
      overlapTokens: 4,
    },
  });

  await tasks.pipeline.run();

  await using search = retrieval(url, tasks.vectorizer, model);
  const found = await search.keywords().retrieve('needle');
  const [widened] = await new ContextWindow({
    store: search.store,
    windowSize: 99,
  }).postprocess(found, 'needle');
  const text = `Cold store\n${body}`;
  assert.ok(ids(found)[0] !== 'a:0', ids(found).join());
  assert.deepEqual(
    {
      text: widened?.passage.text,
      start: widened?.passage.start,
      end: widened?.passage.end,
    },
    { text, start: 0, end: [...text].length },
  );
});

test('a reader that may only read marts searches the passages by meaning and by words', async () => {
  await using database = await databases.database();
  const url = database.connectionString;
  const model = new LetterModel();
  const tasks = tasksPipeline({
    url,
    rows: () => [task('a', 'red car'), task('b', 'blue bike')],
    model,
  });
  await tasks.pipeline.run();
  // A role is of the whole server, which the databases of the tests share.
  const role = `reader_${randomUUID().replaceAll('-', '')}`;
  await rowsOf(
    url,
    `CREATE ROLE "${role}" LOGIN PASSWORD 'reader'; GRANT USAGE ON SCHEMA marts TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA marts TO "${role}"`,
  );
  try {
    const reader = new URL(url);
    reader.username = role;
    reader.password = 'reader';

    await using search = retrieval(reader.href, tasks.vectorizer, model);

    assert.deepEqual(
      {
        meaning: ids(await search.embedding.retrieve('red car', { topK: 1 })),
        words: ids(await search.keywords().retrieve('bike')),
        warehouse: await rowsOf(
          reader.href,
          'SELECT 1 FROM _warehouse.raw_docs_keywords',
        ).then(
          () => 'read',
          (error: unknown) =>
            error instanceof postgres.PostgresError ? error.code : error,
        ),
      },
      { meaning: ['a:0'], words: ['b:0'], warehouse: '42501' },
    );
  } finally {
    await rowsOf(url, `DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
  }
});

test('the vectorizer refuses a metadata column named keywords, the tsvector column of the passages', () => {
  const destination = new PostgresDestination({
    url: 'postgres://localhost/none',
  });
  assert.throws(
    () =>
      new Vectorizer({
        into: destination,
        from: destination.table('rows'),
        name: 'docs',
        description: 'The rows.',
        key: 'name',
        loading: { columns: ['title'] },
        chunking: 'none',
        embedding: {
          model: new LetterModel(),
          dimensions: 26,
          clock: globalThis,
        },
        metadata: ['keywords'],
      }),
    {
      name: 'TypeError',
      message:
        /^Vectorizer docs cannot give the metadata column keywords: the passages have a column of that name/,
    },
  );
});

// Copied from src/sqlite.test.ts (docs/copied-test-helpers.md): the text of
// a plain text file.
class TextParser extends DocumentParser {
  constructor() {
    super('text/plain');
  }

  override async parse(path: string) {
    return readFile(path, 'utf8');
  }
}

// Copied from src/sqlite.test.ts (docs/copied-test-helpers.md): files of a
// folder, each with the name the test gives it.
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

test('the status view counts the files whose text the parser failed, and the next refresh with a parser that reads them counts none', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('vectorizer-');
  const url = database.connectionString;
  const folder = join(scratch.path, 'notes');
  await mkdir(folder);
  await writeFile(join(folder, 'good.txt'), 'call the cooperative');
  await writeFile(join(folder, 'bad.txt'), 'renew the lease');
  const refusing = new (class extends TextParser {
    override async parse(path: string) {
      const text = await super.parse(path);
      if (text.includes('lease')) throw new Error('the parser refuses');
      return text;
    }
  })();
  const run = (parser: DocumentParser) => {
    const source = new Notes();
    source.rows = [
      { name: 'good', file: join(folder, 'good.txt') },
      { name: 'bad', file: join(folder, 'bad.txt') },
    ];
    const files = new LocalFiles({ directory: join(scratch.path, 'files') });
    const destination = new PostgresDestination({ url });
    const notes = destination.table('notes', (c) => [
      c.text('name').primaryKey(),
      c.text('noteRef').from(source.notes.file.store(files)),
    ]);
    return new Pipeline({
      clock: globalThis,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          checkpoints: new PostgresCheckpointStore({ url }),
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
          loading: { file: 'noteRef', files, parser: () => parser },
          chunking: 'none',
          embedding: {
            model: new LetterModel(),
            dimensions: 26,
            clock: globalThis,
          },
        }),
      ],
    }).run();
  };
  const status = () =>
    rowsOf(
      url,
      'SELECT "state", "pending_files"::int AS "pending_files", "failed_files"::int AS "failed_files", "failed_sources"::int AS "failed_sources" FROM marts.docs_status',
    );

  await run(refusing);

  assert.deepEqual(await status(), [
    { state: 'current', pending_files: 0, failed_files: 1, failed_sources: 0 },
  ]);

  await run(new TextParser());

  assert.deepEqual(await status(), [
    { state: 'current', pending_files: 0, failed_files: 0, failed_sources: 0 },
  ]);
});
