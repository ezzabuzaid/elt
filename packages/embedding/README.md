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

The package does not start a model or a server. Give it a model that is ready. See [derived datasets](../../docs/reference.md#derived-datasets) for how a pipeline refreshes the rows.
