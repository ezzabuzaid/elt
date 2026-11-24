# Vectorizer

`Vectorizer` is one declaration that keeps the passage contract of [`@zukhruf/retrieval`](https://github.com/JanuaryLabs/zukhruf/tree/main/packages/retrieval) in step with what an elt pipeline loads: the passages of each source row with their metadata, the vector of each passage with the identity of its model, and a keyword index. The retrievers of `@zukhruf/retrieval` then search the rows by meaning and by words. pgai's `create_vectorizer` does the same job in Postgres. The words of this package are in its [glossary](./CONTEXT.md).

```sh
npm install @eltjs/vectorizer @eltjs/elt @eltjs/elt-sqlite @zukhruf/retrieval
```

`@eltjs/vectorizer/sqlite` writes the contract into a SQLite file. Postgres and SQL Server come later, each in its own subpath.

## Search the rows of a table

The program loads three tasks that it holds, through an `IterableSource`, and declares a `Vectorizer` over their table. Then it searches the passages with the retrievers of `@zukhruf/retrieval`, widens the best passage with `ContextWindow`, and reads the status view.

```ts
import { join } from 'node:path';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { ContextWindow, FusionRetriever } from '@zukhruf/retrieval';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { open } from '@zukhruf/sqlite-open';
import { install } from '@zukhruf/vectors/sqlite';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';
import { Vectorizer } from '@eltjs/vectorizer/sqlite';

// A local embedding model with no network: the vector of a text counts each
// letter a to z. Give your own AI SDK embedding model in its place.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'readme';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
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

const tasks = [
  {
    name: 'fix-git',
    title: 'Fix a broken git history',
    body: 'A rebase went wrong and two commits are lost. Find them in the reflog and put them back on main.',
    category: 'software-engineering',
  },
  {
    name: 'train-fasttext',
    title: 'Train a fastText model',
    body: 'Train a text classifier on the reviews in the data folder, and save a model of less than 150 MB.',
    category: 'model-training',
  },
  {
    name: 'git-multibranch',
    title: 'Deploy two git branches',
    body: 'Set up a git server where a push to main or dev deploys that branch to its own web folder.',
    category: 'system-administration',
  },
];

await using directory = await new TemporaryFiles().directory('vectorizer-');
const model = new LetterModel();
const source = new IterableSource({
  identity: 'terminal-bench',
  streams: {
    tasks: {
      description: 'The tasks of Terminal-Bench 2.',
      jsonSchema: {
        type: 'object',
        description: 'A task.',
        properties: {
          name: { type: 'string', description: 'The name of the task.' },
          title: { type: 'string', description: 'Its title.' },
          body: { type: 'string', description: 'What it asks.' },
          category: { type: 'string', description: 'Its category.' },
        },
        required: ['name', 'title', 'body', 'category'],
      },
      primaryKey: ['name'],
      snapshot: () => tasks,
    },
  },
});
const destination = new SQLiteDestination({
  path: join(directory.path, 'tasks.sqlite'),
});
const table = destination.table('tasks');
const vectorizer = new Vectorizer({
  into: destination,
  from: table,
  name: 'docs',
  description: 'The tasks of Terminal-Bench 2.',
  key: 'name',
  loading: { columns: ['title', 'body'] },
  chunking: {
    tokenizer: { name: 'cl100k_base', count: countTokens },
    maxTokens: 16,
    overlapTokens: 0,
  },
  embedding: { model, dimensions: 26, clock: globalThis },
  metadata: ['category'],
});

await new Pipeline({
  clock: globalThis,
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'terminal-bench',
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
}).run();

using database = open(destination.path, { readOnly: true });
install(database);
const store = new SqlitePassageStore({
  database,
  passages: vectorizer.contract.passages,
});
const meaning = new SqliteEmbeddingRetriever({
  store,
  vectors: vectorizer.contract.vectors,
  model,
});
const words = new SqliteBM25Retriever({
  store,
  index: vectorizer.contract.index,
});
const search = new FusionRetriever({ retrievers: [meaning, words] });

const found = await search.retrieve('deploy git branches', { topK: 3 });
for (const { passage, score } of found)
  console.log(passage.id, passage.metadata.category, score.toFixed(4));

const [widened] = await new ContextWindow({ store, windowSize: 5 }).postprocess(
  found,
  'deploy git branches',
);
console.log(JSON.stringify(widened?.passage.text));

console.log({ ...database.prepare('SELECT * FROM "docs_status"').get() });
```

The output:

```text
git-multibranch:0 system-administration 0.0328
git-multibranch:1 system-administration 0.0161
fix-git:2 software-engineering 0.0159
"Deploy two git branches\nSet up a git server where a push to main or dev deploys that branch to its own web folder."
{
  state: 'current',
  as_of: '2026-11-24T17:30:59.962Z',
  pending_sources: 0,
  pending_vectors: 0
}
```

- `from` is the table of a copy, and `into` is its file. A `View` can be `from` too: it names its own file, so the vectorizer then takes no `into`.
- `key` is the column, or the columns, that identify a source row.
- `loading: { columns }` gives the text of these columns, with a line break between them.
- `chunking` gives the sizes of [`@eltjs/chunking`](../chunking/README.md): the tokenizer of the embedding model, `maxTokens` and `overlapTokens`.
- `embedding` gives the options of [`@eltjs/embedding`](../embedding/README.md) without `key` and `fields`: the AI SDK embedding model, its `dimensions` and the `clock` of its calls.
- `metadata` lists the columns of the source row that each passage gives beside its text. With no `metadata`, a passage has none.
- `vectorizer.contract` gives the names that the store and the retrievers take: `{ passages, vectors, index }`.

## Search the text of stored files

With `loading: { file }`, the passages cut the text of the file that a column names. The vectorizer reads each file once with a `DocumentParser`, as `DocumentText` of elt does, and keys the passages by the source key, so two rows that share one file each have their passages.

```ts
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import {
  SqliteBM25Retriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  Gauge,
  LocalFiles,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import { SQLiteDestination, SQLiteSyncHistory } from '@eltjs/elt-sqlite';
import { Vectorizer } from '@eltjs/vectorizer/sqlite';

// A local embedding model with no network, as in the first example.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'readme';
  readonly modelId = 'letters';
  readonly maxEmbeddingsPerCall = undefined;
  readonly supportsParallelCalls = true;

  async doEmbed({
    values,
  }: EmbeddingModelV4CallOptions): Promise<EmbeddingModelV4Result> {
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

// The notes a user keeps in one folder. Each file is one record.
class NotesFolder extends Source {
  readonly identity = 'notes-folder';
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A file in the folder.',
      properties: { name: { type: 'string', description: 'File name.' } },
      required: ['name'],
    },
    primaryKey: ['name'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.notes]);
  readonly #folder: string;

  constructor(folder: string) {
    super();
    this.#folder = folder;
  }

  override coverage() {
    return { description: 'Every file in the folder.', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  // This program only runs and never watches, so no watch reads this gauge.
  override changeSignals(streams: readonly Stream[]) {
    const gauge = new (class extends Gauge<number> {
      protected async read() {
        return 0;
      }
    })();
    return [{ gauge, streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const name of await readdir(this.#folder))
      yield {
        stream: configuration.stream.name,
        data: { name },
        file: join(this.#folder, name),
      };
  }
}

// The text of a plain text file.
class TextParser extends DocumentParser {
  constructor() {
    super('text/plain');
  }

  override async parse(path: string) {
    return readFile(path, 'utf8');
  }
}

await using directory = await new TemporaryFiles().directory('vectorizer-');
const folder = join(directory.path, 'Notes');
await mkdir(folder);
await writeFile(
  join(folder, 'monday.txt'),
  'Call the cooperative about the cold store.',
);
await writeFile(join(folder, 'tuesday.txt'), 'Order panels for the barn roof.');

const source = new NotesFolder(folder);
const files = new LocalFiles({ directory: join(directory.path, 'files') });
const destination = new SQLiteDestination({
  path: join(directory.path, 'notes.sqlite'),
});
const notes = destination.table('notes', (c) => [
  c.text('name').primaryKey(),
  c.text('noteRef').from(source.notes.file.store(files)),
]);
const vectorizer = new Vectorizer({
  into: destination,
  from: notes,
  name: 'notes_search',
  description: 'The notes in the folder.',
  key: 'name',
  loading: { file: 'noteRef', files, parser: () => new TextParser() },
  chunking: 'none',
  embedding: { model: new LetterModel(), dimensions: 26, clock: globalThis },
});

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
  derived: [vectorizer],
}).run();

using database = open(destination.path, { readOnly: true });
const store = new SqlitePassageStore({
  database,
  passages: vectorizer.contract.passages,
});
const words = new SqliteBM25Retriever({
  store,
  index: vectorizer.contract.index,
});
for (const { passage } of await words.retrieve('cold store'))
  console.log(
    passage.id,
    JSON.stringify(passage.text),
    passage.start,
    passage.end,
  );
```

The output:

```text
monday.txt:0 "Call the cooperative about the cold store." 0 42
```

## The relations

A vectorizer named `docs` refreshes these members, in this order, in the file of its source. Each is a derived dataset of elt-sqlite with its own row of `derived_status`.

| Relation               | What it holds                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs_text`            | Only with `loading: { file }`: the text of each stored file, a computed dataset of `DocumentText`                                 |
| `docs_documents`       | Only with `loading: { file }`: the text of the file of each source row, by the source key                                         |
| `docs_chunks`          | The parts of the text of each source row, a computed dataset; its parts are in `docs_chunks_parts`                                |
| `docs_keywords`        | The id, source, seq and text of each passage. The FTS5 table `docs_passages_fts` indexes the text                                 |
| `docs_passages`        | The passages: `rowid`, `id`, `source`, `seq`, `start`, `end`, `text` and the metadata columns                                     |
| `docs_chunk_texts`     | The text of each part, by its part hash                                                                                           |
| `docs_chunk_vectors`   | The vector of each part text, a computed dataset of `Embedding`                                                                   |
| `docs_passage_vectors` | The vectors: `id`, `vector` and `model`, the identity of the model, for example `openai/text-embedding-3-small (1536 dimensions)` |
| `docs_status`          | One row: `state`, `as_of`, `pending_sources` and `pending_vectors`                                                                |

- The id of a passage is `<source>:<seq>`.
- The passages of a source row tile its text: `start` and `end` count code points, and `ContextWindow` merges passages by them with no gap.
- A part text that many passages share is embedded once.
- A vector that the model failed is not in `docs_passage_vectors`, so a vector search never gives its passage. A keyword search still gives it.
- The keywords table, the FTS5 table and its three triggers are one declaration. When one of them differs from the declaration, the next refresh makes all of them again. See [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md).

## One passage for each row

`chunking: 'none'` gives one passage for each source row: its whole text, with `seq` 0, `start` 0 and `end` the count of code points of the text. Use it for short rows, for example a title and a summary.

## A key of several columns

When `key` is a list of two or more columns, the source of a passage is the JSON array of their values, for example `["s1",7]`, and its id is `["s1",7]:0`. A key of one column gives its plain value, for example `7`.

## A new model

When the model or its `dimensions` change, the next refresh makes each vector again, in place. While it runs, `docs_status` has the state `refreshing` and counts the texts that wait in `pending_vectors`. A retriever with the new model finds only the passages that it already embedded, and a retriever with the old model finds only the others. When the refresh ends, each vector has the new model.

## Rules and failures

- The constructor refuses, with a `TypeError` that names it, a metadata column that has the name of a column of the passages (`rowid`, `id`, `source`, `seq`, `start`, `end` or `text`, in any ASCII case), and a metadata column or a key column that is listed twice.
- Before it reads, the pipeline refuses a vectorizer whose table no copy loads into its file, and a key, metadata or loading column that the stream or the target does not declare. The run rejects with a `TypeError`.
- The name of the vectorizer and the name of each relation count in the check of distinct names of the pipeline.
- A vectorizer fails as one dataset of the pipeline ([elt ADR 0034](../elt/docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md)): the first member that fails stops the members after it, the copies and the other datasets go on, and the refresh after the next pass tries it again. A run rejects with the `DerivedDatasetError` of the vectorizer, whose `cause` is the `DerivedDatasetError` of the member. `docs_status` then has the state `failed`.

## The same in other systems

| System                         | What it is                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------- |
| pgai `create_vectorizer`       | One call that keeps the embeddings of a Postgres table in step with its rows     |
| Airbyte vector destinations    | `text_fields` and `metadata_fields` of each record, chunked and embedded on load |
| LlamaIndex `IngestionPipeline` | The steps that make nodes and their embeddings from documents                    |

## Decisions

- [ADR 0001](./docs/adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md): the vectorizer writes the passage contract of `@zukhruf/retrieval`, one subpath per engine.
- [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md): the keyword index is a member that keeps a keywords table and its full-text index in step.

## Development

```sh
npx nx run vectorizer:test        # builds, then runs src/sqlite.test.ts
npx nx run vectorizer:typecheck   # formats, lints, then type checks
```

```
src/
  sqlite.ts              the subpath /sqlite
  options.ts             SourceKey, Loading, ChunkingOptions, EmbeddingOptions and the checks of the columns
  passage-rules.ts       the rules of the passages: the chunks of Chunking by source, or one part for each row
  sqlite/vectorizer.ts   Vectorizer: the members and the views of SQLite
  sqlite/keyword-index.ts  KeywordIndex: the keywords table, its FTS5 table and its triggers
```
