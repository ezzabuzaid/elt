# Recipe: Search the rows of a Postgres table with pgvector and a reader that reads only marts

**Use case.** A host loads its rows into Postgres with the role that owns the database, and an agent searches them by meaning and by words with a role that may read only `marts`, such as `agent_reader`. The search must work with no grant on `_warehouse`. When the host changes its embedding model, the next refresh makes each vector again, and a search with the new model must still give its `topK` before the refresh ends. Without the package, the host writes the passages, their vectors and a keyword index by hand, and keeps them in step with each load.

**What you need.** A Postgres server with pgvector, the loading role's URL, and a reader role. A `PostgresDestination` and a `PostgresSyncHistory` of [elt-postgresql](../../../destinations/postgresql/README.md), a `Vectorizer` of `@eltjs/vectorizer/postgresql`, an AI SDK embedding model, and the Postgres retrievers of `@zukhruf/retrieval`.

## The steps

1. Give the reader role its grants on `marts`, as a grant of the database: `USAGE` on `marts`, and `SELECT` on its relations through default privileges. The pipeline does not give them.
2. Declare a `Vectorizer` with `into: destination` and `from` the table of a copy.
3. Run the pipeline with the loading role's URL.
4. Write a `PostgresSession` over a driver that connects with the reader's URL.
5. Give `vectorizer.contract` to `PostgresPassageStore`, `PgvectorEmbeddingRetriever` and `PgvectorKeywordRetriever`, and search.

## The program

The program makes the reader role `search_reader`, loads 1000 tasks, and searches them as `search_reader`. Then it embeds the tasks again with a new model, and stops that run after the first 64 vectors. While the vectors of both models are in the table, it searches with the new model, with and without the iterative scan of HNSW.

Start a Postgres server with pgvector, the image that the tests of the package use:

```sh
docker run -d --name vectorizer-recipe -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 pgvector/pgvector:pg18
```

The program needs a fresh database, because it makes the role and the schema `marts`. Set `POSTGRES_URL` to use another server.

```ts title="search-as-a-reader.ts"
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { FusionRetriever } from '@zukhruf/retrieval';
import {
  PgvectorEmbeddingRetriever,
  PgvectorKeywordRetriever,
  PostgresPassageStore,
  type PostgresSession,
} from '@zukhruf/retrieval/postgres';
import postgres from 'postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';
import { Vectorizer } from '@eltjs/vectorizer/postgresql';

// A local embedding model with no network: the vector of a text is 26 bytes
// of the SHA-256 hash of the model id and the text, so each text has a
// direction of its own. Give your own AI SDK embedding model in its place.
// A slow model answers its first call, and each call after it waits until the
// run stops, as a model does in the middle of a new embedding.
class HashModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly modelId: string;
  readonly #slow: boolean;
  #calls = 0;

  constructor(modelId: string, { slow = false } = {}) {
    this.modelId = modelId;
    this.#slow = slow;
  }

  async doEmbed({
    values,
    abortSignal,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    if (this.#slow && ++this.#calls > 1)
      await new Promise((_, reject) =>
        abortSignal?.addEventListener('abort', () =>
          reject(abortSignal.reason),
        ),
      );
    return {
      embeddings: values.map((text) =>
        [
          ...createHash('sha256')
            .update(`${this.modelId}\n${text}`)
            .digest()
            .subarray(0, 26),
        ].map((byte) => byte - 127.5),
      ),
      warnings: [],
    };
  }
}

// The loading role, which owns the database.
const url =
  process.env.POSTGRES_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

// The reader role: it reads marts and nothing else. Its grants on marts are
// grants of the database, which the pipeline does not give.
const owner = postgres(url, { max: 1, onnotice: () => {} });
await owner.unsafe(`
  CREATE ROLE search_reader LOGIN PASSWORD 'reader';
  CREATE SCHEMA marts;
  GRANT USAGE ON SCHEMA marts TO search_reader;
  ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO search_reader;
`);
await owner.end();
const readerUrl = new URL(url);
readerUrl.username = 'search_reader';
readerUrl.password = 'reader';

// 1000 tasks that the host holds. A real host reads them from its own store.
const tasks = Array.from({ length: 1000 }, (_, index) => ({
  name: `t${String(index).padStart(4, '0')}`,
  title: `task ${index}`,
}));

// The pipeline that loads the tasks and keeps the passage contract of the
// vectorizer docs in step with them, with the model that the host gives.
function tasksPipeline(model: EmbeddingModelV4) {
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the host holds.',
        jsonSchema: {
          type: 'object',
          description: 'A task.',
          properties: {
            name: { type: 'string', description: 'The name of the task.' },
            title: { type: 'string', description: 'Its title.' },
          },
          required: ['name', 'title'],
        },
        primaryKey: ['name'],
        snapshot: () => tasks,
      },
    },
  });
  const destination = new PostgresDestination({ url });
  const table = destination.table('tasks');
  const vectorizer = new Vectorizer({
    into: destination,
    from: table,
    name: 'docs',
    description: 'The tasks that the host holds.',
    key: 'name',
    loading: { columns: ['title'] },
    chunking: 'none',
    embedding: { model, dimensions: 26, clock: globalThis },
    metadata: [],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, table, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
    derived: [vectorizer],
  });
  return { pipeline, vectorizer };
}

// A session of search_reader for the retrievers, over postgres.js. Its
// settings are run-time parameters of the session.
function readerSession(settings: Record<string, string> = {}) {
  const sql = postgres(readerUrl.href, {
    max: 1,
    onnotice: () => {},
    connection: settings,
  });
  const session: PostgresSession = {
    query: async (text, parameters) => [
      ...(await sql.unsafe(
        text,
        parameters.map((value) =>
          typeof value === 'number' ? value : String(value),
        ),
      )),
    ],
  };
  return { sql, session };
}

await using clients = new AsyncDisposableStack();

// 1. Load the tasks with the model hash-1, and search them as search_reader.
const first = tasksPipeline(new HashModel('hash-1'));
await first.pipeline.run();

const reader = readerSession();
clients.defer(() => reader.sql.end());
const store = new PostgresPassageStore({
  session: reader.session,
  schema: first.vectorizer.contract.schema,
  passages: first.vectorizer.contract.passages,
  metadata: (columns) => columns,
});
const search = new FusionRetriever({
  retrievers: {
    meaning: {
      retriever: new PgvectorEmbeddingRetriever({
        store,
        vectors: first.vectorizer.contract.vectors,
        model: new HashModel('hash-1'),
      }),
    },
    words: {
      retriever: new PgvectorKeywordRetriever({
        store,
        index: first.vectorizer.contract.index,
        matching: { strategy: 'all' },
      }),
    },
  },
});
const { passages } = await search.retrieve('task 7', { topK: 3 });
for (const { passage, score } of passages)
  console.log(passage.id, JSON.stringify(passage.text), score.toFixed(4));

// search_reader has no grant on the raw tables in _warehouse.
console.log(
  await reader.sql`SELECT 1 FROM _warehouse.raw_docs_keywords`.catch(
    (error: Error) => error.message,
  ),
);

// 2. Embed the tasks again with the model hash-2. The run stops after the
// first call of the model, which embeds 64 texts.
const second = tasksPipeline(new HashModel('hash-2', { slow: true }));
const controller = new AbortController();
const running = second.pipeline.run({ signal: controller.signal });
clients.defer(async () => {
  await running.catch(() => {});
});
clients.defer(() => controller.abort());

const status = async () =>
  (
    await reader.sql`
      SELECT "state", "pending_vectors"::int AS "pending_vectors",
        (SELECT count(*)::int FROM marts.docs_passage_vectors
          WHERE "model" = 'recipe/hash-2 (26 dimensions)') AS "hash_2_vectors"
      FROM marts.docs_status`
  )[0];
while ((await status())?.hash_2_vectors !== 64) await setTimeout(100);
console.log({ ...(await status()) });

// On 1000 rows the planner reads the 64 vectors of hash-2 in full and sorts
// them. This session forbids the full read and the sort, as on a table whose
// statistics say that the model passes most rows, so the search goes through
// the HNSW index of the vectors.
const planned = readerSession({ enable_seqscan: 'off', enable_sort: 'off' });
clients.defer(() => planned.sql.end());
const meaning = new PgvectorEmbeddingRetriever({
  store: new PostgresPassageStore({
    session: planned.session,
    schema: second.vectorizer.contract.schema,
    passages: second.vectorizer.contract.passages,
    metadata: (columns) => columns,
  }),
  vectors: second.vectorizer.contract.vectors,
  model: new HashModel('hash-2'),
});
const found = await meaning.retrieve('a new query', { topK: 10 });
console.log(
  'hnsw.iterative_scan = strict_order:',
  found.passages.length,
  'passages',
);

// The same search with no iterative scan: HNSW gives its 40 nearest vectors
// (hnsw.ef_search), and the filter on the model drops each one of hash-1.
const [query] = (
  await new HashModel('hash-2').doEmbed({ values: ['a new query'] })
).embeddings;
await planned.sql`SET hnsw.iterative_scan = off`;
const [plain] = await planned.sql`
  SELECT count(*)::int AS "passages" FROM (
    SELECT "id" FROM marts.docs_passage_vectors
    WHERE "model" = 'recipe/hash-2 (26 dimensions)'
    ORDER BY "vector" <=> ${JSON.stringify(query)}::vector
    LIMIT 10
  )`;
console.log('hnsw.iterative_scan = off:', plain?.passages, 'passages');
```

Output on Postgres 18.7 with pgvector, in the container of the command above (the last count can change from run to run, because HNSW gives each vector a random level in its graph):

```
t0007:0 "task 7" 0.0328
t0205:0 "task 205" 0.0161
t0090:0 "task 90" 0.0159
permission denied for schema _warehouse
{ state: 'refreshing', pending_vectors: 936, hash_2_vectors: 64 }
hnsw.iterative_scan = strict_order: 10 passages
hnsw.iterative_scan = off: 2 passages
```

## What the output shows

- **The reader searches by meaning and by words.** `search_reader` has only `USAGE` on `marts` and `SELECT` on its relations. The fusion of the embedding retriever and the keyword retriever gives `t0007:0` first, because both retrievers rank it first. The test `a reader that may only read marts searches the passages by meaning and by words` of `src/postgresql.test.ts` proves the same.
- **The reader reads nothing of `_warehouse`.** Every relation of the contract is a view in `marts`. The views read the raw tables in `_warehouse` with the rights of their owner, so `search_reader` gets `permission denied` for `_warehouse` itself. See [Search in Postgres](../../README.md#search-in-postgres) and [ADR 0001](../adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md).
- **A new model makes the vectors again in place.** In the middle of the second run, `docs_status` has the state `refreshing`, 64 vectors have the model `recipe/hash-2 (26 dimensions)`, and 936 texts wait in `pending_vectors`. See [A new model](../../README.md#a-new-model).
- **The iterative scan gives the `topK` of the new model.** An HNSW index gives its nearest vectors before the filter on the model runs. Without the iterative scan, HNSW gives its 40 nearest vectors (`hnsw.ef_search`), and the filter drops each one of `hash-1`, so the search gives fewer than 10. `PgvectorEmbeddingRetriever` sets `hnsw.iterative_scan` to `strict_order` for each statement, so the scan goes on until 10 vectors of `hash-2` pass ([pgvector-embedding-retriever.ts](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/retrieval/src/postgres/pgvector-embedding-retriever.ts), zukhruf retrieval ADR 0003). The test `while another model embeds the passages again, a search with the model of the few vectors made again gives its topK through the HNSW index of the vectors` of `src/postgresql.test.ts` shows in the plan that the search goes through the HNSW index.

## Things to know

- **Who may read `marts` stays a grant of the database.** Give it with default privileges before the first run, as step 1 does. Then the views that a refresh makes again keep the grant. The recipe [Read the warehouse as of a position as a reader role](../../../destinations/postgresql/docs/recipes/read-the-warehouse-as-of-a-position-as-a-reader-role.md) of elt-postgresql gives the same grants, and the grants of a reading as of a position.
- **The keyword search finds only the passages that hold every word**, because the program gives `matching: { strategy: 'all' }` to `PgvectorKeywordRetriever`. With no `matching`, it is `{ strategy: 'frequency', dropTokensThreshold: 10 }`, which drops the most frequent word while fewer than 10 passages match. Postgres has no OR (README, "Search in Postgres").
- **The retrievers send their SQL through the host's driver.** `PostgresSession` has one method, `query(text, parameters)`. This program writes it over postgres.js. The run-time parameters of the session, such as `enable_seqscan`, are the host's choice.
- **The program forbids the full read and the sort only to show the index.** On 1000 rows the planner reads the 64 vectors of the new model in full and sorts them, with no index. On a table whose statistics say that the model passes most rows, the planner uses HNSW.
- **`indexing: { vectors }` declares the index of the vectors.** When it is absent, the index is HNSW with `vector_cosine_ops`. `'none'` compares every vector. See [Search in Postgres](../../README.md#search-in-postgres).
- **A retriever finds only the vectors of its own model.** A retriever with the old model finds only the passages that the new model did not embed yet. When the refresh ends, each vector has the new model. See [A new model](../../README.md#a-new-model).
- **The subpath came in `f845aef6`** (#5401, #5608), with `@eltjs/vectorizer/sqlserver`.
