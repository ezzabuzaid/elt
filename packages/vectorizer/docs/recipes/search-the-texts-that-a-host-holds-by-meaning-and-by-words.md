# Recipe: Search the texts that a host holds by meaning and by words

**Use case.** A host holds short texts in its own memory or store, such as the items of a backlog. No connector reads that store. An agent must find the items by meaning and by words, and a search must give only the items that the host holds now: an item that the host changed must be found by its new text, and an item that the host stopped holding must not be found. Without the package, the host writes and refreshes the passages, the vectors and the keyword index itself, and keeps them in step with each change.

**What you need.** An `IterableSource` of [elt](../../../elt/README.md#load-rows-that-the-host-holds) with `deletions: 'closed-world'`, a `SQLiteDestination` of elt-sqlite, a `Vectorizer` of `@eltjs/vectorizer/sqlite`, an AI SDK embedding model, and the SQLite retrievers of [`@zukhruf/retrieval`](https://github.com/JanuaryLabs/zukhruf/tree/main/packages/retrieval).

## The steps

1. Give the rows that the host holds to an `IterableSource`, with a schema, a key and `snapshot`. Set `deletions: 'closed-world'`, so that a row that the host stops giving is deleted ([elt ADR 0033](../../../elt/docs/adr/0033-a-host-loads-the-rows-it-holds-through-an-iterable-source.md)).
2. Copy the stream into a table of a `SQLiteDestination`.
3. Declare a `Vectorizer` over that table. Give the source key, the columns of the text, `chunking` and the embedding model. List the metadata columns that a search gives beside the text.
4. Give the vectorizer to `derived` of the `Pipeline`, and run the pipeline.
5. Search the passages with a `FusionRetriever` of `SqliteEmbeddingRetriever` and `SqliteBM25Retriever`, over `vectorizer.contract`.
6. When the host's rows change, run the pipeline again.

## The program

The program loads three items that it holds and searches them. Then the host changes the text and the status of `item-1`, stops holding `item-3`, and the program runs the pipeline and searches again. The items are short, so `chunking: 'none'` gives one passage for each item. The embedding model is a local stand-in with no network: the vector of a text counts each letter a to z, in 26 dimensions, and the model records each text that it embeds. Build the packages with `npx nx run-many -t build -p elt elt-sqlite chunking embedding vectorizer`, then run the program from `packages/vectorizer` with `node search-the-texts-of-a-host.ts`.

```ts title="search-the-texts-of-a-host.ts"
import { join } from 'node:path';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { FusionRetriever } from '@zukhruf/retrieval';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { open } from '@zukhruf/sqlite-open';
import { install } from '@zukhruf/vectors/sqlite';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';
import { Vectorizer } from '@eltjs/vectorizer/sqlite';

// A local embedding model with no network: the vector of a text counts each
// letter a to z. It also records each text that it embeds.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;
  readonly embedded: string[] = [];

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
    this.embedded.push(...values);
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

// The items that the host holds. A real host reads them from its own store.
let items = [
  {
    id: 'item-1',
    title: 'The SQLite writer waits on a lock',
    body: 'Two runs open one file, and the second run waits until the first ends.',
    status: 'open',
  },
  {
    id: 'item-2',
    title: 'Embed the passages with a new model',
    body: 'A change of the model makes each vector again.',
    status: 'open',
  },
  {
    id: 'item-3',
    title: 'Deploy the docs site',
    body: 'A push to main publishes the site.',
    status: 'done',
  },
];

await using directory = await new TemporaryFiles().directory('vectorizer-');
const model = new LetterModel();
const source = new IterableSource({
  identity: 'backlog',
  streams: {
    items: {
      description: 'Each item that the host holds now.',
      jsonSchema: {
        type: 'object',
        description: 'An item.',
        properties: {
          id: { type: 'string', description: 'Id of the item.' },
          title: { type: 'string', description: 'Title of the item.' },
          body: { type: 'string', description: 'What the item asks.' },
          status: { type: 'string', description: 'open or done.' },
        },
        required: ['id', 'title', 'body', 'status'],
      },
      primaryKey: ['id'],
      deletions: 'closed-world',
      snapshot: () => items,
    },
  },
});
const destination = new SQLiteDestination({
  path: join(directory.path, 'backlog.sqlite'),
});
const table = destination.table('items');
const vectorizer = new Vectorizer({
  into: destination,
  from: table,
  name: 'items_search',
  description: 'The items of the backlog.',
  key: 'id',
  loading: { columns: ['title', 'body'] },
  chunking: 'none',
  embedding: { model, dimensions: 26, clock: globalThis },
  metadata: ['status'],
});
const pipeline = new Pipeline({
  clock: globalThis,
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'backlog',
      source,
      destination,
      steps: [
        new Copy(source.streams.items, table, {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
        }),
      ],
    }),
  ],
  derived: [vectorizer],
});

async function search(query: string) {
  console.log(JSON.stringify(query));
  using database = open(destination.path, { readOnly: true });
  install(database);
  const store = new SqlitePassageStore({
    database,
    passages: vectorizer.contract.passages,
    metadata: (columns) => columns,
  });
  const fusion = new FusionRetriever({
    retrievers: {
      meaning: {
        retriever: new SqliteEmbeddingRetriever({
          store,
          vectors: vectorizer.contract.vectors,
          model,
        }),
      },
      words: {
        retriever: new SqliteBM25Retriever({
          store,
          index: vectorizer.contract.index,
          matching: { operator: 'AND' },
        }),
      },
    },
  });
  const { passages } = await fusion.retrieve(query, { topK: 2 });
  for (const { passage, score } of passages)
    console.log('  ', passage.id, passage.metadata.status, score.toFixed(4));
}

await pipeline.run();
console.log('first run, embedded', model.embedded.length, 'texts');
await search('sqlite lock');

// The host closes item-1, changes its text, and stops holding item-3.
items = [
  {
    id: 'item-1',
    title: 'The SQLite writer waits on a lock',
    body: 'Fixed: the checkpoint store keeps two runs of one copy apart.',
    status: 'done',
  },
  ...items.filter(({ id }) => id === 'item-2'),
];
model.embedded.length = 0;
await pipeline.run();
console.log('second run, embedded', model.embedded);
await search('sqlite lock');
await search('deploy the docs site');

using database = open(destination.path, { readOnly: true });
console.log({
  ...database.prepare('SELECT * FROM "items_search_status"').get(),
});
```

Output (the time of `as_of` changes from run to run):

```
first run, embedded 3 texts
"sqlite lock"
   item-1:0 open 0.0328
   item-3:0 done 0.0161
second run, embedded [
  'The SQLite writer waits on a lock\n' +
    'Fixed: the checkpoint store keeps two runs of one copy apart.'
]
"sqlite lock"
   item-1:0 done 0.0328
   item-2:0 open 0.0161
"deploy the docs site"
   item-1:0 done 0.0164
   item-2:0 open 0.0161
{
  state: 'current',
  as_of: '2026-11-26T09:00:11.542Z',
  pending_sources: 0,
  pending_vectors: 0,
  failed_sources: 0,
  failed_vectors: 0,
  pending_files: 0,
  failed_files: 0
}
```

## What the output shows

- **The first run embeds each text one time.** The three items give three passages, and the model gets three texts.
- **The second run embeds only the text that changed.** The model gets the new text of `item-1`. The text of `item-2` did not change, so its vector stays and the model does not get it again.
- **A search gives the new metadata.** After the second run, `item-1:0` has the status `done`, the value that the host gives now.
- **An item that the host stopped holding is not found.** After the second run, no search gives `item-3:0`, also for the words of its own title. Its row, its passage, its keywords and its vector are gone ([`src/sqlite.test.ts`](../../src/sqlite.test.ts), "a row that the host stops giving leaves the passages, the keywords and the vectors").
- **The scores are reciprocal rank fusion.** `FusionRetriever` adds `1 / (60 + rank)` of each retriever that finds the passage. `0.0328` is `2 / 61`: both searches rank `item-1:0` first. `0.0164` is `1 / 61`: only the vector search finds `item-1:0` for "deploy the docs site", because no item holds every word of the query now.
- **The status view is `current`.** `pending_sources`, `pending_vectors`, `failed_sources` and `failed_vectors` are 0, as are `pending_files` and `failed_files`, since the items are no files, so each passage has its vector after `run()`.

## Things to know

- **The host writes no `Source` subclass.** An `IterableSource` takes a schema, a key and the rows of each stream. See [Load rows that the host holds](../../../elt/README.md#load-rows-that-the-host-holds) and [elt ADR 0033](../../../elt/docs/adr/0033-a-host-loads-the-rows-it-holds-through-an-iterable-source.md).
- **Without `deletions: 'closed-world'`, a row that the host stops giving stays loaded**, and a search still finds its passage. The sync modes of the copy and `deletions` are the cleanup ([elt README](../../../elt/README.md#load-rows-that-the-host-holds)).
- **An incremental copy with `append_dedup` gives the same passages.** It keeps a snapshot of the rows in the checkpoint store of the connection. `src/sqlite.test.ts` deletes the passages, keywords and vectors of a row that the host stops giving in both sync modes.
- **`chunking: 'none'` gives one passage for each row**, with `seq` 0. For long texts, give the sizes of `@eltjs/chunking` in place of `'none'`, as [Search the rows of a table](../../README.md#search-the-rows-of-a-table) does.
- **The keyword search finds only the passages that hold every word of the query**, because the program gives `matching: { operator: 'AND' }` to `SqliteBM25Retriever`. With no `matching`, it is `{ operator: 'OR', cutoffFrequency: 20_000 }`: the passages that hold any word, ranked by bm25 (`src/sqlite.test.ts`, "a keyword search finds the passages that hold every word, and with OR the passages that hold any word").
- **A watch runs the pipeline when the host's rows change.** Call `source.changed(stream)` after the host changes its rows, and the next check starts a pass ([elt README](../../../elt/README.md#load-rows-that-the-host-holds)).
- **A change of the model makes each vector again.** See [Embed the passages again with a new model](./embed-the-passages-again-with-a-new-model.md).
- **The same declaration writes into Postgres and SQL Server**, through `@eltjs/vectorizer/postgresql` and `@eltjs/vectorizer/sqlserver` (#5401). See [Search in Postgres](../../README.md#search-in-postgres).
