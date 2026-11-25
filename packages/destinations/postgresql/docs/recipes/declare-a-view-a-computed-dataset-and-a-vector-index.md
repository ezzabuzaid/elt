# Recipe: Declare a view, a computed dataset and a pgvector index on Postgres

**Use case.** A host loads the messages of its chats into Postgres. A reader wants two things that the raw rows do not give: how many messages each chat has that the user did not read, and the messages whose text is near a search text. The count must stay current with each load. The search must read a vector for each message, and Postgres must find the nearest vectors through an index, not by a read of each row. Without derived datasets, the host keeps the SQL and the vectors in its own code, and makes the index by hand on a table that a reload can make again.

**What you need.** A `PostgresDestination`, a `View`, a `ComputedDataset` with a rule that gives a `vector` column, such as `Embedding` of `@eltjs/embedding`, and `hnsw()`. The server needs [pgvector](https://github.com/pgvector/pgvector). The image `pgvector/pgvector:pg18` has it, and the tests of the package use that image.

## The steps

1. Declare the copy: `destination.table('messages')` gives the reader view `marts.messages` of the raw table `_warehouse.raw_messages`.
2. Declare a `View` with its `name`, `description`, a description of each of its `columns`, and its `sql`. The bare names of the SQL, such as `messages`, are found in `marts`, so the SQL reads the reader views.
3. Declare a `ComputedDataset` with the rule in `compute`, the copy target in `from`, and the declared indexes of its raw table in `indexes`: `{ type: 'vector', column, metric, build: hnsw() }` for the vector column, and `{ type: 'btree', columns }` for key columns.
4. Give both to the pipeline in `derived`, and run it. After the passes, the pipeline refreshes the view and the computed dataset.
5. Query `marts.unread_count`, and search `marts.message_vectors` with the operator of the metric: `<=>` for `cosine`.

## The program

The program loads four messages, then reads the view, the output rows, the declared indexes, the two messages nearest to the text "invoice", and the plan of the search. The embedding model is a local stand-in with no network: the vector of a text counts each letter a to z, in 26 dimensions. Build the packages with `npx nx run-many -t build -p elt elt-postgresql embedding`, then run the program from `packages/destinations/postgresql` as `DATABASE_URL=<url> node declare-derived-datasets.ts`.

Start a Postgres server with pgvector first:

```sh
docker run -d --name elt-recipe -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 pgvector/pgvector:pg18
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
```

```ts title="declare-derived-datasets.ts"
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { toSql } from 'pgvector';
import postgres from 'postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  ComputedDataset,
  PostgresDestination,
  PostgresSyncHistory,
  View,
  hnsw,
} from '@eltjs/elt-postgresql';
import { Embedding } from '@eltjs/embedding';

const url = process.env['DATABASE_URL'];
if (url === undefined) throw new Error('Set DATABASE_URL');

// A local embedding model with no network: the vector of a text counts each
// letter a to z.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;

  static vector(text: string) {
    return Array.from(
      { length: 26 },
      (_, letter) =>
        [...text.toLowerCase()].filter(
          (character) => character.charCodeAt(0) - 97 === letter,
        ).length,
    );
  }

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    return { embeddings: values.map(LetterModel.vector), warnings: [] };
  }
}

// The messages that a host holds, loaded with no Source subclass.
const source = new IterableSource({
  identity: 'chats',
  streams: {
    messages: {
      description: 'Every message of every chat.',
      jsonSchema: {
        type: 'object',
        description: 'A message.',
        properties: {
          id: { type: 'string', description: 'Message id.' },
          chat: { type: 'string', description: 'The chat.' },
          body: { type: 'string', description: 'The text of the message.' },
          read: {
            type: 'boolean',
            description: 'Whether the user read the message.',
          },
        },
        required: ['id', 'chat', 'body', 'read'],
      },
      primaryKey: ['id'],
      snapshot: () => [
        { id: '1', chat: 'family', body: 'Dinner at eight?', read: false },
        { id: '2', chat: 'family', body: 'Bring bread home', read: false },
        { id: '3', chat: 'work', body: 'The March invoice', read: true },
        { id: '4', chat: 'work', body: 'Send the invoice', read: false },
      ],
    },
  },
});

const destination = new PostgresDestination({ url });
const messages = destination.table('messages');

const unread = new View({
  into: destination,
  name: 'unread_count',
  description: 'How many messages each chat has that the user did not read.',
  columns: {
    chat: 'The chat.',
    n: 'Number of messages that the user did not read.',
  },
  sql: 'SELECT chat, count(*) AS n FROM messages WHERE NOT read GROUP BY chat',
});

const vectors = new ComputedDataset({
  into: destination,
  name: 'message_vectors',
  description: 'The vector of the text of each message.',
  from: [messages],
  compute: new Embedding({
    model: new LetterModel(),
    dimensions: 26,
    clock: globalThis,
    key: 'id',
    fields: ['body'],
  }),
  indexes: [
    { type: 'vector', column: 'vector', metric: 'cosine', build: hnsw() },
    { type: 'btree', columns: ['committed_in'] },
  ],
});

const pipeline = new Pipeline({
  clock: globalThis,
  history: new PostgresSyncHistory({ url }),
  connections: [
    new Connection({
      name: 'chats',
      source,
      destination,
      steps: [new Copy(source.streams.messages, messages)],
    }),
  ],
  derived: [unread, vectors],
});

await pipeline.run();

const sql = postgres(url, { onnotice: () => {} });
try {
  console.log('marts.unread_count', [
    ...(await sql`SELECT chat, n FROM marts.unread_count ORDER BY chat`),
  ]);
  console.log('marts.message_vectors', [
    ...(await sql`SELECT id, status, vector_dims(vector) AS dims
                    FROM marts.message_vectors ORDER BY id`),
  ]);
  console.log(
    'indexes',
    (
      await sql`SELECT indexdef FROM pg_indexes
                WHERE schemaname = '_warehouse'
                  AND tablename = 'raw_message_vectors'
                ORDER BY indexname`
    ).map(({ indexdef }) => indexdef),
  );
  const query = toSql(LetterModel.vector('invoice'));
  console.log('nearest to "invoice"', [
    ...(await sql`SELECT m.body, round((v.vector <=> ${query}::vector)::numeric, 3) AS distance
                    FROM marts.message_vectors v JOIN marts.messages m ON m.id = v.id
                    ORDER BY v.vector <=> ${query}::vector LIMIT 2`),
  ]);
  const plan = await sql.begin(async (transaction) => {
    await transaction`SET LOCAL enable_seqscan = off`;
    return transaction`EXPLAIN (COSTS OFF)
      SELECT id FROM _warehouse.raw_message_vectors
      ORDER BY vector <=> ${query}::vector LIMIT 2`;
  });
  console.log(
    'plan',
    plan.map((row) => row['QUERY PLAN']),
  );
} finally {
  await sql.end();
}
```

Output (PostgreSQL 18.7 with pgvector, from the image `pgvector/pgvector:pg18`):

```
marts.unread_count [ { chat: 'family', n: '2' }, { chat: 'work', n: '1' } ]
marts.message_vectors [
  { id: '1', status: 'computed', dims: 26 },
  { id: '2', status: 'computed', dims: 26 },
  { id: '3', status: 'computed', dims: 26 },
  { id: '4', status: 'computed', dims: 26 }
]
indexes [
  'CREATE INDEX ix_elt_19bbe7848818b61d ON _warehouse.raw_message_vectors USING hnsw (vector vector_cosine_ops)',
  'CREATE INDEX ix_elt_9fa0a0393d5b458d ON _warehouse.raw_message_vectors USING btree (committed_in)',
  'CREATE UNIQUE INDEX raw_message_vectors_pkey ON _warehouse.raw_message_vectors USING btree (id)'
]
nearest to "invoice" [
  { body: 'Send the invoice', distance: '0.184' },
  { body: 'The March invoice', distance: '0.235' }
]
plan [
  'Limit',
  '  ->  Index Scan using ix_elt_19bbe7848818b61d on raw_message_vectors',
  "        Order By: (vector <=> '[0,0,1,0,1,0,0,0,2,0,0,0,0,1,1,0,0,0,0,0,0,1,0,0,0,0]'::vector)"
]
```

## What the output shows

- **The view counts the unread messages of each chat.** `marts.unread_count` reads the reader view `marts.messages`. Postgres computes it on each read, so it shows each load with no refresh of its rows. `n` is a string, because the driver `postgres` gives a `BIGINT` as a string by default ([README](../../README.md#declare-a-computed-dataset)).
- **The computed dataset keeps one output row for each message.** Each row of `marts.message_vectors` has the status `computed` and a `vector(26)` of pgvector, with the dimensions that the rule gives. The table is `_warehouse.raw_message_vectors`, and readers query the view `marts.message_vectors` ([ADR 0008](../adr/0008-derived-datasets-follow-elt-sqlite.md)).
- **The refresh made each declared index.** The destination names each one `ix_elt_` and the first 16 hex digits of the SHA-256 of its statement after the name (`src/postgres-indexes.ts`). The statement holds the table and each option, so the same declaration gives the same name on each run. The primary key is the index of the key, which each computed dataset has.
- **The metric gives the operator class and the operator.** `cosine` is `vector_cosine_ops`, so the search orders by `<=>`. The two messages that hold "invoice" are the nearest.
- **The search reads the HNSW index.** The plan is an `Index Scan` of `ix_elt_19bbe7848818b61d`. With four rows, the planner picks a read of the whole table, so the program turns off `enable_seqscan` for the `EXPLAIN` only.

## Things to know

- **A view appears when its query compiles.** While its SQL reads a reader view that a copy of the pipeline has not made yet, the view waits, and `marts` has no view of its name. Any other error of the query is a dataset failure ([README](../../README.md#declare-a-view), `src/view.test.ts`).
- **A changed declaration of `indexes` changes the indexes in place.** Each refresh drops each `ix_elt_` index that is no longer declared and makes each declared index that is missing. No row is computed again, and an index of another name, such as one that a person made, stays (`src/computed-dataset.test.ts`, [ADR 0011](../adr/0011-a-vector-column-is-a-pgvector-vector-with-declared-indexes.md), commit `55bb5503`, #5403).
- **A change of the dimensions makes the table again.** The same refresh makes its declared indexes on the new table (`src/computed-dataset.test.ts`).
- **The destination creates the extension `vector` when the database does not have it.** Construct it with `createExtension: false` to keep the extensions in the hands of a person. Then a database with no type `vector` fails the dataset with a `PostgresSetupError` ([README](../../README.md#store-vectors)).
- **`hnsw()` with no options takes the defaults of pgvector.** Give `hnsw({ m, efConstruction })` to set them. The statement then has `WITH (m = …, ef_construction = …)`, and the index gets another name.
- **A real model replaces the stand-in.** Give `Embedding` an `EmbeddingModel` of the AI SDK and its `dimensions`, as the [chunking recipe](../../../../chunking/docs/recipes/cut-documents-into-chunks-and-embed-each-chunk.md) does on SQLite.
