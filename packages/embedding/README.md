# Embedding

`Embedding` is a rule of a computed dataset. It gives each loaded row a vector of its text, made by an AI SDK embedding model, so that a vector search can find rows by meaning.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { ComputedDataset } from '@workspace/elt-sqlite';
import { Embedding } from '@workspace/embedding';

const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
}).embeddingModel('embeddinggemma-2');

new ComputedDataset({
  into: destination,
  name: 'listing_vectors',
  description: 'The vector of each listing.',
  from: [listings],
  compute: new Embedding({
    model,
    key: 'id',
    fields: ['title', 'description'],
  }),
});
```

- `key` is the column that identifies a row. It is the key of the output row.
- `fields` are the columns whose text makes the vector. The rule joins their text with line breaks. A row with no text in these columns has no vector.
- The output column `vector` holds a unit vector of float32 values in the byte order of the platform. This is the form that `VectorSearch` of `@zukhruf/embeddings` reads, so the cosine similarity of two vectors is their dot product.
- The identity of each row is the provider and the id of the model. When you change the model, the next refresh makes every vector again.
- The rule sends 64 rows to `embedMany` at a time. When the model refuses a call, each row of that call is stored as `failed` with the error, and the next refresh asks again. The load does not fail.
- To search, declare a view that gives `id` and `vector`, and give its name to `VectorSearch`. A search by publish date, such as `nearest`, also needs `published_at`. A query without a date range does not.

## Give the model its prompts

Some models want a prompt before each text, and a different prompt for a document and for a search text. EmbeddingGemma wants `title: none | text: …` before a document and `task: search result | query: …` before a search text. The rule does not know the model, so it adds no prompt. Wrap the model with `wrapEmbeddingModel` of the AI SDK, one time for documents and one time for search texts:

```ts
import { embed, wrapEmbeddingModel } from 'ai';

const gemma = local.embeddingModel('embeddinggemma-2');
const prompted = (modelId: string, prompt: string) =>
  wrapEmbeddingModel({
    model: gemma,
    modelId,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        values: params.values.map((text) => `${prompt}${text}`),
      }),
    },
  });

const documents = prompted('embeddinggemma-2/document', 'title: none | text: ');
const searches = prompted(
  'embeddinggemma-2/query',
  'task: search result | query: ',
);

new Embedding({
  model: documents,
  key: 'id',
  fields: ['title', 'description'],
});

const { embedding } = await embed({ model: searches, value: 'family sedan' });
new VectorSearch({ database, table: 'listing_vectors' }).query(embedding);
```

Give each wrapped model its own `modelId`. The identity of a row is the provider and the id of the model, so a new prompt with a new `modelId` makes every vector again.

On 2026-10-27, 42 OpenSooq listings that `source-opensooq-web` crawled got their vectors from EmbeddingGemma 2 in one run. `nearest` of a bicycle listing gave other bicycle listings first. A second run made no vector again.

The package does not start a model or a server. Give it a model that is ready. See [when the pipeline refreshes](../elt/README.md#when-the-pipeline-refreshes) for how a pipeline refreshes the rows.
