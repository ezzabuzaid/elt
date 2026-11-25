# Recipe: Embed the passages again with a new model and read the status view

**Use case.** A host searches its tasks by meaning with one embedding model. Then the host changes to a new model, or gives the same model other `dimensions`. Each vector of the old model is now wrong for a search with the new model. The host must not drop the relations and start again, and a search must not compare a vector of one model with a query vector of the other model. While the new model embeds, the host wants to know how far the refresh is.

**What you need.** A pipeline with a `Vectorizer` of `@eltjs/vectorizer/sqlite`, and two AI SDK embedding models with different model identities. The basic search is in [Search the texts that a host holds by meaning and by words](./search-the-texts-that-a-host-holds-by-meaning-and-by-words.md); this recipe does not repeat it.

## The steps

1. Run the pipeline with the first model. Each vector has the model identity of that model, for example `recipe/letters-1 (26 dimensions)`.
2. Give the vectorizer the new model in `embedding.model`, and keep the other options.
3. Run the pipeline again. The refresh makes each vector again, in place.
4. While the refresh runs, read the state and `pending_vectors` from the status view `docs_status`.
5. Search with the retriever of the new model. It finds only the passages that the new model embedded.

## The program

The program loads 70 tasks and embeds them with the model `letters-1`. Then it runs the same pipeline with the model `letters-2`. The rule sends 64 texts in each call, so the new model gets two calls. The program holds the second call, reads the status view and searches with each model, and then lets the call answer. Both models count the letters a to z of a text, so they need no network.

```ts title="new-model.ts"
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import {
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { open } from '@zukhruf/sqlite-open';
import { install } from '@zukhruf/vectors/sqlite';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';
import { Vectorizer } from '@eltjs/vectorizer/sqlite';

// A local embedding model with no network: the vector of a text counts each
// letter a to z. Two instances with two ids are two models.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly modelId: string;
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  calls = 0;
  // The second call waits for this promise, so that the program can look at
  // the file while the refresh runs.
  hold: Promise<void> = Promise.resolve();

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    if (++this.calls === 2) await this.hold;
    return {
      embeddings: values.map((text) =>
        Array.from(
          { length: 26 },
          (_, letter) =>
            [...text.toLowerCase()].filter(
              (character) => character.charCodeAt(0) - 97 === letter,
            ).length,
        ),
      ),
      warnings: [],
    };
  }
}

// 70 tasks: the rule sends 64 texts in each call, so a refresh makes 2 calls.
const tasks = Array.from({ length: 70 }, (_, index) => ({
  name: `t${String(index).padStart(2, '0')}`,
  title: `task number ${index}`,
}));

await using directory = await new TemporaryFiles().directory('new-model-');
const path = join(directory.path, 'tasks.sqlite');

// The same pipeline each time; only the model of the vectorizer changes.
function pipelineWith(model: LetterModel) {
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the program holds.',
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
  const destination = new SQLiteDestination({ path });
  const table = destination.table('tasks');
  const vectorizer = new Vectorizer({
    into: destination,
    from: table,
    name: 'docs',
    description: 'The tasks.',
    key: 'name',
    loading: { columns: ['title'] },
    chunking: 'none',
    embedding: { model, dimensions: 26, clock: globalThis },
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
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

const query = (sql: string) => {
  using database = open(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};
const status = () =>
  query('SELECT "state", "pending_vectors" FROM "docs_status"')[0];
const models = () =>
  query(
    'SELECT "model", count(*) AS "vectors" FROM "docs_passage_vectors" GROUP BY "model" ORDER BY "model"',
  );
// How many passages a vector search with this model finds.
async function found(vectorizer: Vectorizer, model: LetterModel) {
  using database = open(path, { readOnly: true });
  install(database);
  const store = new SqlitePassageStore({
    database,
    passages: vectorizer.contract.passages,
  });
  const retriever = new SqliteEmbeddingRetriever({
    store,
    vectors: vectorizer.contract.vectors,
    model,
  });
  return (await retriever.retrieve('task number', { topK: 70 })).length;
}

const first = new LetterModel('letters-1');
await pipelineWith(first).pipeline.run();
console.log('After the first run:', status(), models());

const second = new LetterModel('letters-2');
const held = Promise.withResolvers<void>();
second.hold = held.promise;
const { pipeline, vectorizer } = pipelineWith(second);
const running = pipeline.run();

// Wait until the vectors of the first call of the new model are in the file.
while (!models().some(({ vectors }) => vectors === 64)) await setTimeout(10);
console.log('While the new model embeds:', status(), models());
console.log({
  foundWithLetters1: await found(vectorizer, first),
  foundWithLetters2: await found(vectorizer, second),
});

held.resolve();
await running;
console.log('After the second run:', status(), models());
console.log({ foundWithLetters2: await found(vectorizer, second) });
```

Output:

```
After the first run: { state: 'current', pending_vectors: 0 } [ { model: 'recipe/letters-1 (26 dimensions)', vectors: 70 } ]
While the new model embeds: { state: 'refreshing', pending_vectors: 6 } [
  { model: 'recipe/letters-1 (26 dimensions)', vectors: 6 },
  { model: 'recipe/letters-2 (26 dimensions)', vectors: 64 }
]
{ foundWithLetters1: 6, foundWithLetters2: 64 }
After the second run: { state: 'current', pending_vectors: 0 } [ { model: 'recipe/letters-2 (26 dimensions)', vectors: 70 } ]
{ foundWithLetters2: 70 }
```

## What the output shows

- **After the first run, each of the 70 vectors has the model identity of `letters-1`.** The model identity is the provider, the model id and the dimensions, as the `model` column of `docs_passage_vectors` holds it.
- **While the new model embeds, the status view has the state `refreshing`.** The first call of `letters-2` wrote 64 vectors in place of the old ones. `pending_vectors` counts the 6 texts that wait for the second call.
- **Each model finds only its own vectors.** The retriever of `letters-2` finds the 64 passages that `letters-2` embedded. The retriever of `letters-1` finds the 6 passages that still have an old vector. No search compares the vectors of two models.
- **When the refresh ends, each vector has the new model.** The state is `current` again, `pending_vectors` is 0, and the retriever of `letters-2` finds all 70 passages.

The test `another model embeds the passages again in place` in `src/sqlite.test.ts` proves the same facts, and that a run which stops during the refresh leaves the rest to the next run.

## Things to know

- **A change of `dimensions` is a new model too.** The model identity names the dimensions, so the next refresh makes each vector again. See [the identity of a row of Embedding](../../../embedding/README.md).
- **Give a wrapped model its own model id.** A model with the same provider, model id and dimensions has the same model identity, so the refresh does not embed again. A new prompt through `wrapEmbeddingModel` needs a new `modelId` ([Embedding](../../../embedding/README.md)).
- **A keyword search does not use the model.** `SqliteBM25Retriever` reads the keyword index, so it finds each passage during the refresh.
- **The vectors are made again in place.** The vectorizer keeps one `docs_passage_vectors`, and no second set of relations waits for the new model. This is the rule of [ADR 0005 of elt](../../../elt/docs/adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md): an output is made again when its rule identity changes. See the test `another model embeds the passages again in place` in `src/sqlite.test.ts`, and #5401.
- **Read `docs_status` to know when a search finds all passages.** Only the state `current` with `pending_vectors` 0 says that each vector has the model of the declaration. See [A new model](../../README.md#a-new-model).
