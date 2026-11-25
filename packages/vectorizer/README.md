# @eltjs/vectorizer

`Vectorizer` is one declaration that keeps the passage contract of [`@zukhruf/retrieval`](https://github.com/JanuaryLabs/zukhruf/tree/main/packages/retrieval) in step with what an elt pipeline loads: the passages of each source row with their metadata, the vector of each passage with the identity of its model, and a keyword index. The retrievers of `@zukhruf/retrieval` then search the rows by meaning and by words. pgai's `create_vectorizer` does the same job in Postgres.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @eltjs/vectorizer @eltjs/elt @eltjs/elt-sqlite @zukhruf/retrieval
```

Each subpath writes through its engine's elt destination: `/sqlite` through `@eltjs/elt-sqlite`, `/postgresql` through `@eltjs/elt-postgresql` and `postgres`, `/sqlserver` through `@eltjs/elt-sqlserver`. These are optional peer dependencies, so a host installs only the one that it uses.

`@eltjs/vectorizer/sqlite` writes the contract into a SQLite file, `@eltjs/vectorizer/postgresql` into a Postgres database ([Search in Postgres](#search-in-postgres)), and `@eltjs/vectorizer/sqlserver` into a SQL Server database ([Search in SQL Server](#search-in-sql-server)). The smallest program is in [Search the rows of a table](#search-the-rows-of-a-table), the next section.

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
  as_of: '2026-11-25T12:49:17.091Z',
  pending_sources: 0,
  pending_vectors: 0,
  failed_sources: 0,
  failed_vectors: 0
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

## Search in Postgres

`@eltjs/vectorizer/postgresql` writes the same contract into the database of a `PostgresDestination` of [elt-postgresql](../destinations/postgresql/README.md), and the Postgres retrievers of `@zukhruf/retrieval` read it. The server needs pgvector, for example the image `pgvector/pgvector:pg18`. The destination creates the extension `vector` when the database has none.

```sh
npm install @eltjs/vectorizer @eltjs/elt @eltjs/elt-postgresql @zukhruf/retrieval postgres
```

The program loads the tasks of "Search the rows of a table" into Postgres, and searches them as that program does. `DATABASE_URL` names the database. It gives the passages and scores of the SQLite program. postgres.js reads a `bigint` as text, so the counts of `docs_status` are text.

```ts
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { ContextWindow, FusionRetriever } from '@zukhruf/retrieval';
import {
  PgvectorEmbeddingRetriever,
  PgvectorKeywordRetriever,
  PostgresPassageStore,
  type PostgresSession,
} from '@zukhruf/retrieval/postgres';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import postgres from 'postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';
import { Vectorizer } from '@eltjs/vectorizer/postgresql';

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

// A database whose server has pgvector, such as the image
// pgvector/pgvector:pg18.
const url = process.env['DATABASE_URL'] ?? 'postgres://localhost/tasks';
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
const destination = new PostgresDestination({ url });
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
  history: new PostgresSyncHistory({ url }),
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

// The retrievers send their SQL through a session that the host writes over
// its own driver, here postgres.js.
const sql = postgres(url, { max: 1 });
try {
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
  const store = new PostgresPassageStore({
    session,
    schema: vectorizer.contract.schema,
    passages: vectorizer.contract.passages,
  });
  const meaning = new PgvectorEmbeddingRetriever({
    store,
    vectors: vectorizer.contract.vectors,
    model,
  });
  const words = new PgvectorKeywordRetriever({
    store,
    index: vectorizer.contract.index,
  });
  const search = new FusionRetriever({ retrievers: [meaning, words] });

  const found = await search.retrieve('deploy git branches', { topK: 3 });
  for (const { passage, score } of found)
    console.log(passage.id, passage.metadata['category'], score.toFixed(4));

  const [widened] = await new ContextWindow({
    store,
    windowSize: 5,
  }).postprocess(found, 'deploy git branches');
  console.log(JSON.stringify(widened?.passage.text));

  console.log({ ...(await sql`SELECT * FROM marts.docs_status`)[0] });
} finally {
  await sql.end();
}
```

The output:

```text
git-multibranch:0 system-administration 0.0328
git-multibranch:1 system-administration 0.0161
fix-git:2 software-engineering 0.0159
"Deploy two git branches\nSet up a git server where a push to main or dev deploys that branch to its own web folder."
{
  state: 'current',
  as_of: 2026-11-24T18:47:45.867Z,
  pending_sources: '0',
  pending_vectors: '0',
  failed_sources: '0',
  failed_vectors: '0'
}
```

- `vectorizer.contract` is `{ schema: 'marts', passages, vectors, index: { column, configuration } }`, the options of `PostgresPassageStore`, `PgvectorEmbeddingRetriever` and `PgvectorKeywordRetriever`. The retrievers send their SQL through a `PostgresSession`, which the host writes over its own driver.
- Every relation of the contract is a view in `marts`, so a reader with `SELECT` on the views of `marts` searches. The views read the raw tables in `_warehouse` with the rights of their owner, and the reader may not read `_warehouse` itself.
- The keyword index is the table `_warehouse.raw_docs_keywords`: `id text COLLATE "C"` (its primary key), `source`, `seq`, `text`, and `keywords`, a `tsvector` that Postgres generates from the text with the text search configuration `keywords.configuration`, `'english'` when absent. A GIN index indexes `keywords`. The passages view gives `keywords`, and the retrievers leave it out of the metadata. A change of the configuration makes the table again at the next refresh. See [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md).
- `indexing: { vectors }` declares the index of the vectors: `hnsw({ m?, efConstruction? })` of elt-postgresql, an HNSW index with `vector_cosine_ops`, when absent, or `'none'`, which compares every vector.
- While another model embeds the vectors again in place, a search with the model of the few vectors not made again yet still gives its `topK`: the retriever sets `hnsw.iterative_scan`, so the scan of the HNSW index goes on until enough vectors of its model pass.
- The views find each row by an index: HNSW for the vectors, GIN for the keywords, the index on `part_hash` of the parts, and the key of the source row in the type of its key column. See [ADR 0001](./docs/adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md).
- postgres.js reads a `bigint` as text, so the source of a key of the columns `site` and an integer `id` is `["s1","7"]`.

## Search in SQL Server

`@eltjs/vectorizer/sqlserver` writes the same contract into the database of an `SqlServerDestination` of [elt-sqlserver](../destinations/sqlserver/README.md), and the SQL Server retrievers of `@zukhruf/retrieval` read it.

```sh
npm install @eltjs/vectorizer @eltjs/elt @eltjs/elt-sqlserver @zukhruf/retrieval mssql
```

The program below does not define `LetterModel` and `tasks`, so it does not run as written. The recipe [Search the rows of a SQL Server table with Full-Text Search](./docs/recipes/search-the-rows-of-a-sql-server-table-with-full-text-search.md) gives the full program.

```ts
import { FusionRetriever } from '@zukhruf/retrieval';
import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  SqlServerPassageStore,
} from '@zukhruf/retrieval/sqlserver';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import mssql from 'mssql';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  SqlServerSyncHistory,
} from '@eltjs/elt-sqlserver';
import { Vectorizer } from '@eltjs/vectorizer/sqlserver';

// The LetterModel class and the tasks array of "Search the rows of a table".
const model = new LetterModel();
const login = {
  server: 'localhost',
  port: 1433,
  database: 'tasks',
  user: 'elt_writer',
  password: '…',
  trustServerCertificate: true,
};
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
const destination = new SqlServerDestination({ login });
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
  keywords: { language: 1033 },
  indexing: { vectors: 'none' },
});

await new Pipeline({
  clock: globalThis,
  history: new SqlServerSyncHistory({ login }),
  connections: [
    new Connection({
      name: 'terminal-bench',
      source,
      destination,
      checkpoints: new SqlServerCheckpointStore({ login }),
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

// A reader needs only SELECT on the schema marts.
const pool = await new mssql.ConnectionPool({
  ...login,
  user: 'reader',
}).connect();
const session = {
  query: async (sql: string, parameters: Readonly<Record<string, unknown>>) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  },
};
const store = new SqlServerPassageStore({
  session,
  schema: vectorizer.contract.schema,
  passages: vectorizer.contract.passages,
});
const search = new FusionRetriever({
  retrievers: [
    new SqlServerEmbeddingRetriever({
      store,
      vectors: vectorizer.contract.vectors,
      model,
    }),
    new SqlServerKeywordRetriever({ store, index: vectorizer.contract.index }),
  ],
});
for (const { passage, score } of await search.retrieve('deploy git branches'))
  console.log(passage.id, passage.metadata.category, score.toFixed(4));
await pool.close();
```

This program did not run when this section was written, so no output is pasted here. SQL Server 2025 runs only where Docker runs amd64 natively, and on the Mac of the build Docker emulates amd64, which Microsoft does not support (the tests skip there, #5469). `src/sqlserver.test.ts` makes the same calls with SQL Server 2025 and Full-Text Search, and CI runs it on amd64. This follows elt-sqlserver, whose recipe of a vector index ran on Azure SQL Database because the container could not run it.

- `vectorizer.contract` is `{ schema: 'marts', passages, vectors, index: { table } }`, the options of `SqlServerPassageStore`, `SqlServerEmbeddingRetriever` and `SqlServerKeywordRetriever`.
- Every relation of the contract is in `marts`, so a reader with `GRANT SELECT ON SCHEMA::marts` searches. The views read the raw tables in `_warehouse` through the ownership chain, and the reader may not read `_warehouse` itself.
- The keyword index is the base table `marts.docs_keywords`: `id NVARCHAR(450) COLLATE Latin1_General_100_BIN2` (its primary key, the full-text key), `source`, `seq` and `text NVARCHAR(MAX)`. A full-text index on `text` has `STOPLIST = OFF`, `CHANGE_TRACKING AUTO` and the language of `keywords.language`, an LCID: 1033 (English) when absent. `CONTAINSTABLE` reads this table, not a view. See [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md).
- A run ends only when the full-text index holds its passages: the keyword index is `current` only when SQL Server shows no population that runs and no change that waits. So a search after `run()` finds each passage.
- Ids and sources compare in binary, so the sources `a` and `A` are two source rows and give the passages `a:0` and `A:0`, also in a database whose collation ignores case.
- `indexing: { vectors: 'none' }` is the only declaration of the vectors index. A search compares every vector with `VECTOR_DISTANCE`. The DiskANN index of SQL Server 2025 waits for zukhruf #5475.
- A server with no Full-Text Search makes the full-text catalog, which is only metadata, and refuses the full-text index with error 7609. The keyword index then drops the table that it made and fails with a `SqlServerSetupError`, of failure type `config`, so the run leaves no keywords table (`src/sqlserver.test.ts`, commit 0b726dd4, #5401). On Linux, install the package `mssql-server-fts`. Azure SQL Database has Full-Text Search.
- A passage id has at most 450 characters, the most that a full-text key of SQL Server holds. A source row whose passage ids would be longer is a rule failure of its own: its row of `docs_chunks` is `failed`, with an error that names the length and the limit, and `derived_status` counts it in `failed`, as `failed_sources` of `docs_status` does. The other rows go on. Give the vectorizer a shorter source key.

## The relations

A vectorizer named `docs` refreshes these members, in this order, where its source is: in the file of its source on SQLite, and in the database of its source on Postgres and SQL Server. Each is a derived dataset of the destination (elt-sqlite, elt-postgresql or elt-sqlserver) with its own row of `derived_status`. On Postgres and SQL Server, each relation that a reader reads is in `marts`, and the views read the raw tables in `_warehouse` (commit f845aef6).

| Relation               | What it holds                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs_text`            | Only with `loading: { file }`: the text of each stored file, a computed dataset of `DocumentText`                                                                                                                                                                                                                  |
| `docs_documents`       | Only with `loading: { file }`: the text of the file of each source row, by the source key                                                                                                                                                                                                                          |
| `docs_chunks`          | The parts of the text of each source row, a computed dataset; its parts are in `docs_chunks_parts`                                                                                                                                                                                                                 |
| `docs_keywords`        | The id, source, seq and text of each passage. On SQLite, the FTS5 table `docs_passages_fts` indexes the text. On Postgres, it is the table `_warehouse.raw_docs_keywords`, whose `keywords` column a GIN index indexes. On SQL Server, it is the base table `marts.docs_keywords`, which a full-text index indexes |
| `docs_passages`        | The passages: `id`, `source`, `seq`, `start`, `end`, `text` and the metadata columns. SQLite also gives `rowid`, the rowid of the passage in the keyword index, and Postgres also gives `keywords`                                                                                                                 |
| `docs_chunk_texts`     | The text of each part, by its part hash                                                                                                                                                                                                                                                                            |
| `docs_chunk_vectors`   | The vector of each part text, a computed dataset of `Embedding`                                                                                                                                                                                                                                                    |
| `docs_passage_vectors` | The vectors: `id`, `vector` and `model`, the identity of the model, for example `openai/text-embedding-3-small (1536 dimensions)`                                                                                                                                                                                  |
| `docs_status`          | One row: `state`, `as_of`, `pending_sources`, `pending_vectors`, `failed_sources` and `failed_vectors`                                                                                                                                                                                                             |

- The id of a passage is `<source>:<seq>`.
- The passages of a source row tile its text: `start` and `end` count code points, and `ContextWindow` merges passages by them with no gap.
- A part text that many passages share is embedded once.
- A vector that the model failed is not in `docs_passage_vectors`, so a vector search never gives its passage. A keyword search still gives it.
- `docs_status` counts the work that failed: `failed_sources` the source rows whose passages failed, which no search finds, and `failed_vectors` the passage texts whose vectors failed, whose passages a search by meaning misses. These are the `failed` counts of `docs_chunks` and `docs_chunk_vectors` in `derived_status`, and the refresh after the next pass tries each such row again. A failed row does not change `state`: `current` says that each relation finished its refresh, as it does in `derived_status`, and `failed` stays the state of a relation whose refresh failed. So a search by meaning finds every passage only when `state` is `current` and `pending_vectors` and `failed_vectors` are 0 (#5660).
- The keywords table, the FTS5 table and its three triggers are one declaration. When one of them differs from the declaration, the next refresh makes all of them again. See [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md).

## One passage for each row

`chunking: 'none'` gives one passage for each source row: its whole text, with `seq` 0, `start` 0 and `end` the count of code points of the text. Use it for short rows, for example a title and a summary.

## A key of several columns

When `key` is a list of two or more columns, the source of a passage is the JSON array of their values, for example `["s1",7]`, and its id is `["s1",7]:0`. A key of one column gives its plain value, for example `7`.

## A new model

When the model changes and its `dimensions` stay the same, the next refresh makes each vector again, in place. On SQLite, a change of `dimensions` also makes each vector again in place, because the vector column is a `BLOB`. On Postgres and SQL Server, a change of `dimensions` changes the declaration of the vector column, `vector(n)` or `VECTOR(n)`, so the next refresh makes the table of the vectors again, and then makes each vector again. During a refresh in place, `docs_status` has the state `refreshing` and counts the texts that wait in `pending_vectors`. A retriever with the new model finds only the passages that it already embedded, and a retriever with the old model finds only the others. When the refresh ends, each vector has the new model.

## Rules and failures

- The constructor refuses, with a `TypeError` that names it, a metadata column that has the name of a column of the passages, in any ASCII case, and a metadata column or a key column that is listed twice. The names of the passage columns are `rowid`, `id`, `source`, `seq`, `start`, `end` and `text` on SQLite; `id`, `source`, `seq`, `start`, `end`, `text` and `keywords` on Postgres; and `id`, `source`, `seq`, `start`, `end` and `text` on SQL Server, so a metadata column `rowid` is allowed there (`src/sqlserver.test.ts`).
- On SQL Server, the constructor refuses with a `RangeError` a `keywords: { language }` that is not an LCID, an integer of 0 or more, such as `1033.5`, `-1` or `NaN` (`src/sqlserver.test.ts`).
- Before it reads, the pipeline refuses a vectorizer whose table no copy loads into its file, and a key, metadata or loading column that the stream or the target does not declare. The run rejects with a `TypeError`.
- The name of the vectorizer and the name of each relation count in the check of distinct names of the pipeline.
- A vectorizer fails as one dataset of the pipeline ([elt ADR 0034](../elt/docs/adr/0034-a-composite-dataset-refreshes-its-members-in-order-as-one-dataset.md)): the first member that fails stops the members after it, the copies and the other datasets go on, and the refresh after the next pass tries it again. A run rejects with the `DerivedDatasetError` of the vectorizer, whose `cause` is the `DerivedDatasetError` of the member. `docs_status` then has the state `failed`.

## Errors

| Error                                  | When                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TypeError`                            | The constructor gets a metadata column with the name of a passage column, or a key or metadata column listed twice. Or the run, before it reads, finds a table that no copy loads, a key, metadata or loading column that the stream or the target does not declare, or a copy that makes the table of the keyword index |
| `RangeError`                           | The constructor of `@eltjs/vectorizer/sqlserver` gets a `keywords: { language }` that is not an integer of 0 or more                                                                                                                                                                                                     |
| `DerivedDatasetError` of elt           | A member fails in a refresh. The run rejects with the `DerivedDatasetError` of the vectorizer, whose `cause` is the `DerivedDatasetError` of the member, and `docs_status` has the state `failed`                                                                                                                        |
| `SqlServerSetupError` of elt-sqlserver | The SQL Server has no Full-Text Search. It is the `cause` of the `DerivedDatasetError` of the member `docs_keywords`, and its failure type is `config` (`src/sqlserver.test.ts`)                                                                                                                                         |

## The same concepts in other systems

| Concept                                                                    | Other systems                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vectorizer`, one declaration that keeps the vectors in step with the rows | pgai [`ai.create_vectorizer`](https://github.com/timescale/pgai/blob/47d74affd8a16d0b7f11c8f5bd6e35f7cd43abc1/docs/vectorizer/api-reference.md#L107-L117), one call that keeps the embeddings of a Postgres table in step with its rows. LlamaIndex [`IngestionPipeline`](https://github.com/run-llama/llama_index/blob/99d7433f6f71888951379ccca9294e272442c832/llama-index-core/llama_index/core/ingestion/pipeline.py#L262), the steps that make nodes and their embeddings from documents, with the strategy [`UPSERTS`](https://github.com/run-llama/llama_index/blob/99d7433f6f71888951379ccca9294e272442c832/llama-index-core/llama_index/core/ingestion/pipeline.py#L240-L259) to replace a changed document |
| `loading: { columns }`                                                     | pgai [`ai.loading_column`](https://github.com/timescale/pgai/blob/47d74affd8a16d0b7f11c8f5bd6e35f7cd43abc1/docs/vectorizer/api-reference.md#L313). The `text_fields` of an Airbyte vector destination ([`ProcessingConfigModel`](https://github.com/airbytehq/airbyte-python-cdk/blob/9b547097da5e8c1eb3fefee4aceafa98cd7f2d39/airbyte_cdk/destinations/vector_db_based/config.py#L105-L111)), which it chunks and embeds on load                                                                                                                                                                                                                                                                                    |
| `loading: { file }`                                                        | pgai [`ai.loading_uri`](https://github.com/timescale/pgai/blob/47d74affd8a16d0b7f11c8f5bd6e35f7cd43abc1/docs/vectorizer/api-reference.md#L339)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `metadata`                                                                 | The `metadata_fields` of an Airbyte vector destination ([`ProcessingConfigModel`](https://github.com/airbytehq/airbyte-python-cdk/blob/9b547097da5e8c1eb3fefee4aceafa98cd7f2d39/airbyte_cdk/destinations/vector_db_based/config.py#L112-L118))                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `indexing: { vectors }`                                                    | pgai [`ai.indexing_hnsw`](https://github.com/timescale/pgai/blob/47d74affd8a16d0b7f11c8f5bd6e35f7cd43abc1/docs/vectorizer/api-reference.md#L1244) and [`ai.indexing_none`](https://github.com/timescale/pgai/blob/47d74affd8a16d0b7f11c8f5bd6e35f7cd43abc1/docs/vectorizer/api-reference.md#L1184)                                                                                                                                                                                                                                                                                                                                                                                                                   |

## API

```ts
// @eltjs/vectorizer/sqlite, /postgresql and /sqlserver each export these four types.
type SourceKey = string | readonly [string, string, ...string[]];

type Loading =
  | { readonly columns: readonly [string, ...string[]] }
  | {
      readonly file: string;
      readonly files: FileStorage; // of @eltjs/elt
      readonly parser: () => DocumentParser; // of @eltjs/elt
    };

type ChunkingOptions =
  | {
      readonly tokenizer: Tokenizer; // of @eltjs/chunking
      readonly maxTokens: number;
      readonly overlapTokens: number;
    }
  | 'none';

type EmbeddingOptions = {
  readonly model: EmbeddingModel; // of ai
  readonly dimensions: number;
  readonly clock: Pick<PipelineClock, 'setTimeout' | 'clearTimeout'>;
};

// @eltjs/vectorizer/sqlite
type SqliteContract = {
  readonly passages: string;
  readonly vectors: string;
  readonly index: string;
};

class Vectorizer extends CompositeDataset<SQLiteTable> {
  constructor(
    options: (
      | { readonly into: SQLiteDestination; readonly from: SQLiteTable }
      | { readonly from: View }
    ) & {
      readonly name: string; // the start of the name of each relation
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[]; // none when absent
    },
  );
  readonly name: string;
  readonly contract: SqliteContract;
  readonly into: SQLiteDestination;
}

// @eltjs/vectorizer/postgresql
type PostgresContract = {
  readonly schema: string; // 'marts'
  readonly passages: string;
  readonly vectors: string;
  readonly index: { readonly column: string; readonly configuration: string };
};

class Vectorizer extends CompositeDataset<PostgresTable> {
  constructor(
    options: (
      | { readonly into: PostgresDestination; readonly from: PostgresTable }
      | { readonly from: View }
    ) & {
      readonly name: string; // the start of the name of each relation
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[]; // none when absent
      readonly keywords?: { readonly configuration?: string }; // 'english' when absent
      readonly indexing?: { readonly vectors: Hnsw | 'none' }; // hnsw() when absent
    },
  );
  readonly name: string;
  readonly contract: PostgresContract;
  readonly into: PostgresDestination;
}

// @eltjs/vectorizer/sqlserver
type SqlServerContract = {
  readonly schema: string; // 'marts'
  readonly passages: string;
  readonly vectors: string;
  readonly index: { readonly table: string };
};

class Vectorizer extends CompositeDataset<SqlServerTable> {
  constructor(
    options: (
      | { readonly into: SqlServerDestination; readonly from: SqlServerTable }
      | { readonly from: View }
    ) & {
      readonly name: string; // the start of the name of each relation
      readonly description: string;
      readonly key: SourceKey;
      readonly loading: Loading;
      readonly chunking: ChunkingOptions;
      readonly embedding: EmbeddingOptions;
      readonly metadata?: readonly string[]; // none when absent
      readonly keywords?: { readonly language?: number }; // an LCID, 1033 when absent
      readonly indexing?: { readonly vectors: 'none' };
    },
  );
  readonly name: string;
  readonly contract: SqlServerContract;
  readonly into: SqlServerDestination;
}
```

## Documentation

**Concepts**

- [How the vectorizer builds on Chunking, the Embedding rule and an AI SDK embedding model](./docs/concepts/how-the-vectorizer-builds-on-chunking-and-embedding.md)

**Recipes**

- [Search the texts that a host holds by meaning and by words](./docs/recipes/search-the-texts-that-a-host-holds-by-meaning-and-by-words.md)
- [Embed the passages again with a new model and read the status view](./docs/recipes/embed-the-passages-again-with-a-new-model.md)
- [Search the rows of a Postgres table with pgvector and a reader that reads only marts](./docs/recipes/search-the-rows-of-a-postgres-table-with-pgvector.md)
- [Search the rows of a SQL Server table with Full-Text Search](./docs/recipes/search-the-rows-of-a-sql-server-table-with-full-text-search.md)

**Decisions**

- [ADR 0001](./docs/adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md): the vectorizer writes the passage contract of `@zukhruf/retrieval`, one subpath per engine.
- [ADR 0002](./docs/adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md): the keyword index is a member that keeps a keywords table and its full-text index in step.

The copies of code that this package keeps are in [docs/copied-code.md](./docs/copied-code.md).

## Development

```sh
npx nx run vectorizer:test        # builds, then runs the tests of each subpath; SQL Server 2025 runs only where Docker runs amd64 natively
npx nx run vectorizer:typecheck   # formats, lints, then type checks
```

```
src/
  sqlite.ts              the subpath /sqlite
  options.ts             SourceKey, Loading, ChunkingOptions, EmbeddingOptions and the checks of the columns
  passage-rules.ts       the rules of the passages: the chunks of Chunking by source, or one part for each row
  sqlite/vectorizer.ts   Vectorizer: the members and the views of SQLite
  sqlite/keyword-index.ts  KeywordIndex: the keywords table, its FTS5 table and its triggers
  postgresql.ts          the subpath /postgresql
  postgresql/vectorizer.ts   Vectorizer: the members and the views of Postgres
  postgresql/keyword-index.ts  KeywordIndex: the keywords table with its generated tsvector and GIN index
  sqlserver.ts           the subpath /sqlserver
  sqlserver/vectorizer.ts   Vectorizer: the members and the views of SQL Server
  sqlserver/keyword-index.ts  KeywordIndex: the keywords table in marts and its full-text index
  copies.ts              the copies of the pipeline into the destination of a vectorizer
  declared-columns.ts    the check that the stream declares each column that the vectorizer reads
  testing/letter-model.ts  LetterModel, the embedding model of the tests
```
