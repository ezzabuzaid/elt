# Recipe: Search the rows of a SQL Server table with Full-Text Search

**Use case.** A host loads a table into SQL Server and wants to search its rows by meaning and by words, with the retrievers of `@zukhruf/retrieval`. Those retrievers read a passage contract: the passages of each source row, the vector of each passage, and a keyword index. Without the vectorizer, the host must cut the passages, embed them, and keep a full-text index in step with each load itself.

**What you need.** A source, an `SqlServerDestination`, an `SqlServerSyncHistory` and an `SqlServerCheckpointStore` of [elt-sqlserver](../../../destinations/sqlserver/README.md), all with one login. A `Vectorizer` of `@eltjs/vectorizer/sqlserver`, and an AI SDK embedding model. The database must be SQL Server 2025 with Full-Text Search, and with `READ_COMMITTED_SNAPSHOT` and `ALLOW_SNAPSHOT_ISOLATION` on (elt-sqlserver README, "Load a stream into SQL Server").

## The steps

1. Start SQL Server 2025 with Full-Text Search, and make a database with row versioning on.
2. Declare a `Vectorizer` over the table of the copy. Give it the `key`, the `loading` columns, the `chunking` sizes, the `embedding` model and the `metadata` columns.
3. Run the pipeline with the vectorizer in `derived`.
4. Give the names of `vectorizer.contract` to `SqlServerPassageStore`, `SqlServerEmbeddingRetriever` and `SqlServerKeywordRetriever`, and search.

## Start the server

The image of Microsoft has no Full-Text Search. These commands add the package `mssql-server-fts` of the same server version, as `new SqlServer({ image, fullTextSearch: true })` of `@zukhruf/testing` does for the tests (`src/sqlserver.test.ts`). SQL Server 2025 runs only where Docker runs amd64 natively. Where an arm64 engine emulates amd64, as on a Mac, the server can crash at start (#5469).

```sh
docker pull --platform linux/amd64 mcr.microsoft.com/mssql/server:2025-latest
version=$(docker inspect --format '{{index .Config.Labels "com.microsoft.version"}}' mcr.microsoft.com/mssql/server:2025-latest)
docker build --platform linux/amd64 -t sqlserver-fts --build-arg SERVER_VERSION="$version" - <<'EOF'
FROM mcr.microsoft.com/mssql/server:2025-latest
ARG SERVER_VERSION
USER root
RUN set -eux; \
    . /etc/os-release; \
    wget -qO /etc/apt/keyrings/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.asc] https://packages.microsoft.com/ubuntu/${VERSION_ID}/mssql-server-2025 ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/mssql-server.list; \
    apt-get update; \
    cd /tmp; \
    apt-get download "mssql-server-fts=${SERVER_VERSION}-*"; \
    dpkg --ignore-depends=mssql-server -i mssql-server-fts_*.deb; \
    rm -f mssql-server-fts_*.deb /etc/apt/sources.list.d/mssql-server.list; \
    rm -rf /var/lib/apt/lists/*
USER mssql
EOF
docker run -d --name tasks-sqlserver -p 127.0.0.1:1433:1433 -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=StrongP@ssw0rd123!' -e MSSQL_PID=Express sqlserver-fts
until docker exec tasks-sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'StrongP@ssw0rd123!' -Q 'SELECT 1' >/dev/null 2>&1; do sleep 3; done
docker exec tasks-sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'StrongP@ssw0rd123!' \
  -Q "CREATE DATABASE tasks; ALTER DATABASE tasks SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE tasks SET READ_COMMITTED_SNAPSHOT ON"
```

## The program

The program loads three tasks that it holds, through an `IterableSource`, and declares a `Vectorizer` over their table. Then it searches the passages by meaning and by words, widens the best passage with `ContextWindow`, and reads the status view. These are the tasks and the calls of the SQLite program of the [README](../../README.md#search-the-rows-of-a-table). The program reads the ADO.NET connection string from `SQLSERVER_LOGIN`. Run it from `packages/vectorizer` after `npx nx build vectorizer`, with `SQLSERVER_LOGIN='Server=localhost,1433;Database=tasks;User Id=sa;Password=StrongP@ssw0rd123!;TrustServerCertificate=true' node search-sql-server-tasks.ts`.

```ts title="search-sql-server-tasks.ts"
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Result,
} from '@ai-sdk/provider';
import { ContextWindow, FusionRetriever } from '@zukhruf/retrieval';
import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  SqlServerPassageStore,
  type SqlServerSession,
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

// A local embedding model with no network: the vector of a text counts each
// letter a to z. Give your own AI SDK embedding model in its place.
class LetterModel implements EmbeddingModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'recipe';
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

// An ADO.NET connection string, such as
// Server=localhost,1433;Database=tasks;User Id=sa;Password=…;TrustServerCertificate=true
const login = process.env.SQLSERVER_LOGIN!;
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

// The retrievers send their SQL through a session that the host writes over
// its own driver, here mssql.
const pool = await new mssql.ConnectionPool(login).connect();
try {
  const session: SqlServerSession = {
    query: async (sql, parameters) => {
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
  const meaning = new SqlServerEmbeddingRetriever({
    store,
    vectors: vectorizer.contract.vectors,
    model,
  });
  const words = new SqlServerKeywordRetriever({
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

  const status = await pool.request().query('SELECT * FROM marts.docs_status');
  console.log({ ...status.recordset[0] });
} finally {
  await pool.close();
}
```

Output on SQL Server 2025 (RTM-CU11, 17.0.5065.9, Express) with Full-Text Search, in Docker on a native amd64 engine (the time of `as_of` changes from run to run):

```
git-multibranch:0 system-administration 0.0328
git-multibranch:1 system-administration 0.0161
fix-git:2 software-engineering 0.0159
"Deploy two git branches\nSet up a git server where a push to main or dev deploys that branch to its own web folder."
{
  state: 'current',
  as_of: 2026-11-25T08:21:54.407Z,
  pending_sources: '0',
  pending_vectors: '0',
  failed_sources: '0',
  failed_vectors: '0'
}
```

## What the output shows

- **The passages and the scores are those of SQLite and Postgres.** The SQLite and Postgres programs of the [README](../../README.md) print the same three passages with the same scores. One `Vectorizer` declaration writes one passage contract on each engine ([ADR 0001](../adr/0001-the-vectorizer-writes-the-passage-contract-of-zukhruf-retrieval-one-subpath-per-engine.md)).
- **The keyword search finds each passage right after `run()`.** A run ends only when the full-text index holds its passages: the keyword index is `current` only when SQL Server shows no population that runs and no change that waits (`TableFulltextPopulateStatus` and `TableFulltextPendingChanges` in `src/sqlserver/keyword-index.ts`).
- **`ContextWindow` gives the whole text of the source row.** The passages of a source row tile its text, so the two passages of `git-multibranch` merge with no gap.
- **The status view is `current`, and it waits for nothing.** mssql reads a `bigint` as a string, so the counts of `docs_status` are text, as they are with postgres.js.

## Things to know

- **`vectorizer.contract` is `{ schema: 'marts', passages, vectors, index: { table } }`.** These are the options of `SqlServerPassageStore`, `SqlServerEmbeddingRetriever` and `SqlServerKeywordRetriever` (README, "Search in SQL Server").
- **The keyword index is a base table in `marts`.** `marts.docs_keywords` has a full-text index on `text` with `STOPLIST = OFF`, `CHANGE_TRACKING AUTO` and the language of `keywords.language`, an LCID: 1033 (English) when absent. `CONTAINSTABLE` reads this table, not a view ([ADR 0002](../adr/0002-the-keyword-index-is-a-member-that-keeps-a-keywords-table-and-its-full-text-index-in-step.md)).
- **A reader needs only `SELECT` on `marts`.** With `GRANT SELECT ON SCHEMA::marts`, a reader searches by keywords and by vectors, and may not read the tables of `_warehouse` (`src/sqlserver.test.ts`).
- **A search compares every vector.** `indexing: { vectors: 'none' }` is the only declaration of the vectors index, and the search uses `VECTOR_DISTANCE`. The DiskANN index of SQL Server 2025 waits for #5475.
- **A passage id has at most 450 characters**, the most that a full-text key of SQL Server holds. A source row whose passage ids are longer is a rule failure of its own, and the other rows go on (README, "Search in SQL Server").
