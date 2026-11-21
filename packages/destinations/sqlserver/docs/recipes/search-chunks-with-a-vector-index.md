# Recipe: Chunk documents, embed each chunk and search them with a vector index

**Use case.** A user keeps proposals in a folder. A search must find the part of a proposal that matches a question. Each document is cut into chunks, each chunk gets a vector, and Azure SQL finds the nearest chunks through a DiskANN index.

**What you need.** Azure SQL Database (the probe ran on General Purpose), because SQL Server 2025 in a container refuses a vector index on the `bigint` key of a raw table ([ADR 0013](../adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md)). `Chunking` of [`@eltjs/chunking`](../../../../chunking/README.md), a `View` of the chunk texts by part hash, and `Embedding` of [`@eltjs/embedding`](../../../../embedding/README.md) with a declared vector index.

## The steps

1. Declare the computed dataset `document_chunks` with `Chunking`.
2. Declare the view `document_chunk_texts`, which gives the part hash of each chunk as its `id`. A computed dataset reads a table or a view, never another computed dataset ([ADR 0027 of elt](../../../../elt/docs/adr/0027-a-dataset-reads-the-parts-of-a-computed-dataset-through-a-view.md)).
3. Declare the computed dataset `document_chunk_vectors` with `Embedding`, keyed by `id`, and `indexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }]`.
4. Run the pipeline. The refresh makes the index `ix_elt_<hash>` on `_warehouse.raw_document_chunk_vectors`, and its search function `marts.document_chunk_vectors_nearest`.
5. Embed the question with the same model, and call the function. Then join the nearest rows to `marts.document_chunks_parts` on `part_hash = id`.

## The program

The embedding model is a local stand-in with no network: the vector of a text counts each letter a to z, in 26 dimensions. A real host gives a model such as `openai.embedding('text-embedding-3-small')` with `dimensions: 1536`. The program reads the ADO.NET connection string from `SQLSERVER_LOGIN`. It ran on Azure SQL Database (a scratch server in Ezz's own subscription), General Purpose serverless, with `PREVIEW_FEATURES` off. Run from `packages/destinations/sqlserver` after `nx run-many -t build -p elt-sqlserver,chunking,embedding`, with `SQLSERVER_LOGIN='Server=tcp:…database.windows.net,1433;Database=…;User Id=…;Password=…;Encrypt=true' node search-chunks-with-a-vector-index.ts`.

```ts title="search-chunks-with-a-vector-index.ts"
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { UnitVector, Vector } from '@zukhruf/vectors';
import { toSql } from '@zukhruf/vectors/sqlserver';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import { Chunking } from '@eltjs/chunking';
import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SqlServerDestination,
  SqlServerSyncHistory,
  View,
} from '@eltjs/elt-sqlserver';
import { Embedding } from '@eltjs/embedding';

// The documents of a folder, each with its text.
class Folder extends Source {
  readonly identity = 'folder';
  readonly documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document of the folder.',
      properties: {
        name: { type: 'string', description: 'File name.' },
        text: { type: 'string', description: 'The text of the document.' },
      },
      required: ['name'],
    },
    primaryKey: ['name'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.documents]);

  override coverage() {
    return { description: 'Every document of the folder.', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // This program only runs and never watches.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(configuration: CopyConfiguration) {
    yield {
      stream: configuration.stream.name,
      data: {
        name: 'cold-store.txt',
        text: [
          'A cold store for the north farm.',
          'The farm loses a fifth of its fruit each summer, because the barn is too warm. A cold store keeps the fruit at four degrees until the trucks come.',
          'The store needs a slab of concrete, insulated panels and one compressor.',
        ].join('\n\n'),
      },
    };
    yield {
      stream: configuration.stream.name,
      data: {
        name: 'solar-roof.txt',
        text: 'A solar roof for the school.\n\nThe school pays too much for power in the winter. Panels on the roof give power in the day, and a battery keeps it for the evening.',
      },
    };
  }
}

// A local embedding model with no network: the vector of a text counts each
// letter a to z.
const letters = (text: string) =>
  Array.from(
    { length: 26 },
    (_, letter) =>
      [...text.toLowerCase()].filter(
        (character) => character.charCodeAt(0) - 97 === letter,
      ).length,
  );

class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    return { embeddings: values.map(letters), warnings: [] };
  }
}

const login = process.env.SQLSERVER_LOGIN!;
const source = new Folder();
const warehouse = new SqlServerDestination({ login });
const documents = warehouse.table('documents');

const chunks = new ComputedDataset({
  into: warehouse,
  name: 'document_chunks',
  description: 'The chunks of the text of each document.',
  from: [documents],
  compute: new Chunking({
    tokenizer: { name: 'cl100k_base', count: countTokens },
    maxTokens: 40,
    overlapTokens: 10,
    key: 'name',
    fields: ['text'],
  }),
});
const chunkTexts = new View({
  into: warehouse,
  name: 'document_chunk_texts',
  description: 'The text of each chunk, by its part hash.',
  columns: {
    id: 'The part hash of the chunk.',
    text: 'The text of the chunk.',
  },
  sql: 'SELECT part_hash AS id, text FROM document_chunks_parts',
});
const vectors = new ComputedDataset({
  into: warehouse,
  name: 'document_chunk_vectors',
  description: 'The vector of each chunk text.',
  from: [chunkTexts],
  compute: new Embedding({
    model: new LetterModel(),
    dimensions: 26,
    clock: globalThis,
    key: 'id',
    fields: ['text'],
  }),
  indexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }],
});

await new Pipeline({
  clock: globalThis,
  history: new SqlServerSyncHistory({ login }),
  connections: [
    new Connection({
      name: 'folder',
      source,
      destination: warehouse,
      steps: [new Copy(source.documents, documents)],
    }),
  ],
  derived: [chunks, chunkTexts, vectors],
}).run();

const reading = await warehouse.reading();
if ('expired' in reading) throw new Error(reading.expired);
await using _ = reading;

console.table(
  await reading.sql.query(
    `SELECT [name], [type_desc], [vector_index_type], [distance_metric]
     FROM sys.vector_indexes
     WHERE [object_id] = OBJECT_ID(N'_warehouse.raw_document_chunk_vectors')`,
  ),
);

// The question goes through the same model as the chunks.
const question = toSql(
  UnitVector.normalize(Vector.from(letters('fruit at four degrees'))),
);
console.table(
  await reading.sql.query(
    `SELECT p.name, p.seq, ROUND(n.distance, 4) AS distance, p.text
     FROM marts.document_chunk_vectors_nearest(CAST(@question AS VECTOR(26)), 3) AS n
     JOIN marts.document_chunks_parts AS p ON p.part_hash = n.id
     ORDER BY n.distance, p.name, p.seq`,
    { question },
  ),
);
```

Output:

```
┌─────────┬───────────────────────────┬───────────┬───────────────────┬─────────────────┐
│ (index) │ name                      │ type_desc │ vector_index_type │ distance_metric │
├─────────┼───────────────────────────┼───────────┼───────────────────┼─────────────────┤
│ 0       │ 'ix_elt_fce22617d3a2992d' │ 'VECTOR'  │ 'DiskANN'         │ 'COSINE'        │
└─────────┴───────────────────────────┴───────────┴───────────────────┴─────────────────┘
┌─────────┬──────────────────┬─────┬──────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ (index) │ name             │ seq │ distance │ text                                                                                                                                                                                     │
├─────────┼──────────────────┼─────┼──────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 'cold-store.txt' │ 0   │ 0.1229   │ 'A cold store for the north farm.\n\nThe farm loses a fifth of its fruit each summer, because the barn is too warm. A cold store keeps the fruit at four degrees until the trucks come.' │
│ 1       │ 'solar-roof.txt' │ 0   │ 0.25     │ 'A solar roof for the school.\n\nThe school pays too much for power in the winter. Panels on the roof give power in the day, and a battery keeps it for the evening.'                    │
│ 2       │ 'cold-store.txt' │ 1   │ 0.2863   │ 'The store needs a slab of concrete, insulated panels and one compressor.'                                                                                                               │
└─────────┴──────────────────┴─────┴──────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why it works

`Chunking` keeps one part for each chunk in `marts.document_chunks_parts`, and `Embedding` keeps one vector for each part hash in `_warehouse.raw_document_chunk_vectors`, a `VECTOR(26)` column ([ADR 0007](../adr/0007-a-rule-column-can-be-a-vector-with-a-fixed-number-of-dimensions.md)). Before the refresh writes a row, it reads the indexes of the raw table from `sys.indexes` and makes the declared one: `CREATE VECTOR INDEX [ix_elt_fce22617d3a2992d] ON [_warehouse].[raw_document_chunk_vectors] ([vector]) WITH (METRIC = 'cosine', TYPE = 'DiskANN')`, outside a transaction ([ADR 0013](../adr/0013-a-computed-dataset-declares-its-indexes-and-the-destination-reconciles-them.md)). The name comes from the declaration, so another dataset with the same declaration has an index of the same name on its own table.

`VECTOR_SEARCH` uses the index only on a table: through the reader view `marts.document_chunk_vectors`, a `UNION ALL` of the raw table and its history, the plan is an exact scan. Thus, after the index, the refresh makes `marts.document_chunk_vectors_nearest(@query VECTOR(26), @k INT)`, an inline table-valued function that runs `SELECT TOP (@k) WITH APPROXIMATE id, distance` over `VECTOR_SEARCH` on the raw table with the metric of the index ([ADR 0014](../adr/0014-each-vector-index-has-a-search-function-in-marts.md)). The `TOP` keeps the search in a query block of its own, so the join to the parts can be in the same query, and the plan keeps the index. A chunk with no vector, such as a failed one, is not in the result. The probe of ADR 0014 shows each plan.

## Things to know

- **The search reads the dataset as it is now.** The function reads the raw table, which holds the current rows, also inside a reading as of an older position. To search as of a position, read `marts.document_chunk_vectors` in that reading with `VECTOR_DISTANCE`, which is exact and uses no index.
- **A reader needs `SELECT` on `marts` only.** The function and the raw table have one owner, so `GRANT SELECT ON SCHEMA::marts` lets a reader call it, and the reader may still not read `_warehouse.raw_document_chunk_vectors`.
- **A small table is searched exactly.** An index made on an empty table, or on a few rows, has `"State":"KNN"` in `build_parameters` of `sys.vector_indexes`, and the optimizer also picks an exact scan for a small table. After more rows come, Azure SQL builds the graph; in the probes, 1,200 rows of 26 dimensions were enough. The three chunks of this program are searched exactly.
- **A change of the metric does not compute again.** A declaration with `metric: 'euclidean'` is an index of another name: the next refresh drops the old index, makes the new one on the filled table, and makes the function again with the new metric. Each row keeps its vector and its commit.
