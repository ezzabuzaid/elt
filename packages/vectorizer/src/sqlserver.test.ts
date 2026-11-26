// The vectorizer through a real Pipeline and a real SQL Server 2025 database,
// read back through the store and the retrievers of @zukhruf/retrieval, as a
// host reads it. The embedding model is the one stand-in (LetterModel).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { FusionRetriever } from '@zukhruf/retrieval';
import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  type SqlServerMatching,
  SqlServerPassageStore,
  type SqlServerSession,
} from '@zukhruf/retrieval/sqlserver';
import { SqlServer } from '@zukhruf/testing/sqlserver';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import mssql from 'mssql';

import {
  Connection,
  Copy,
  DerivedDatasetError,
  IterableSource,
  Pipeline,
} from '@eltjs/elt';
import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSetupError,
  SqlServerSyncHistory,
} from '@eltjs/elt-sqlserver';

import { type ChunkingOptions, Vectorizer } from './sqlserver.ts';
import { LetterModel } from './testing/letter-model.ts';

const image = 'mcr.microsoft.com/mssql/server:2025-latest';

// The server of the tests, with Full-Text Search, which the keyword index
// needs.
const fullText = new SqlServer({
  environment: process.env,
  image,
  fullTextSearch: true,
});

// SQL Server 2025 crashes at start about once in 41 starts when an arm64
// engine emulates amd64 (#5469), so a test that runs it runs only where the
// engine runs amd64 natively, as on CI.
const emulation = await SqlServer.emulation({ environment: process.env });

// A database of its own for one test on server, which keeps row versions for
// readers (elt-sqlserver README), and a pool of it for the reads of the
// test.
async function scratch(server: SqlServer) {
  const database = await server.database();
  const login: SqlServerLogin = {
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    trustServerCertificate: true,
  };
  // ROLLBACK IMMEDIATE ends every other session of the database, so the
  // change runs on a session of its own, before the pool of the test opens.
  const admin = new mssql.ConnectionPool({
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    pool: { min: 1, max: 1 },
    options: { trustServerCertificate: true },
  });
  try {
    await admin.connect();
    await admin
      .request()
      .batch(
        `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
      );
  } finally {
    await admin.close();
  }
  const pool = await database.pool();
  return {
    login,
    pool,
    async rows(sql: string): Promise<Record<string, unknown>[]> {
      return (await pool.request().query(sql)).recordset;
    },
    async [Symbol.asyncDispose]() {
      await database[Symbol.asyncDispose]();
    },
  };
}

// The session a host writes over mssql, as the README of
// @zukhruf/retrieval shows.
const session = (pool: mssql.ConnectionPool): SqlServerSession => ({
  query: async (sql, parameters) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  },
});

type Task = {
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
};

const task = (name: string, title: string, body = '', category = 'easy') => ({
  name,
  title,
  body,
  category,
});

const tasksSchema = {
  type: 'object',
  description: 'A task.',
  properties: {
    name: { type: 'string', description: 'Name of the task.' },
    title: { type: 'string', description: 'Title of the task.' },
    body: { type: 'string', description: 'What the task asks.' },
    category: { type: 'string', description: 'Kind of task.' },
  },
  required: ['name', 'title', 'body', 'category'],
} as const;

// The vocabulary of OpenAI's text-embedding-3-small, with chunks large
// enough that each task is one passage.
const sizes: ChunkingOptions = {
  tokenizer: { name: 'cl100k_base', count: countTokens },
  maxTokens: 200,
  overlapTokens: 0,
};

// A pipeline that copies the tasks the host holds into one database, and a
// vectorizer named docs over them.
function tasksPipeline({
  login,
  rows,
  model = new LetterModel(),
  language,
}: {
  readonly login: SqlServerLogin;
  readonly rows: () => readonly Task[];
  readonly model?: LetterModel;
  readonly language?: number;
}) {
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        snapshot: () => rows(),
      },
    },
  });
  const destination = new SqlServerDestination({ login });
  const target = destination.table('tasks');
  const vectorizer = new Vectorizer({
    into: destination,
    from: target,
    name: 'docs',
    description: 'The tasks.',
    key: 'name',
    loading: { columns: ['title', 'body'] },
    chunking: sizes,
    embedding: { model, dimensions: 26, clock: globalThis },
    metadata: ['category'],
    ...(language === undefined ? {} : { keywords: { language } }),
    indexing: { vectors: 'none' },
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login }),
        steps: [
          new Copy(source.streams.tasks, target, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
    derived: [vectorizer],
  });
  return { pipeline, vectorizer, destination };
}

// The store and the retrievers of @zukhruf/retrieval over the contract.
function retrieval(
  pool: mssql.ConnectionPool,
  vectorizer: Vectorizer,
  model: LetterModel,
) {
  const store = new SqlServerPassageStore({
    session: session(pool),
    schema: vectorizer.contract.schema,
    passages: vectorizer.contract.passages,
    metadata: (columns) => columns,
  });
  return {
    store,
    meaning: new SqlServerEmbeddingRetriever({
      store,
      vectors: vectorizer.contract.vectors,
      model,
    }),
    words: (
      matching: SqlServerMatching = { predicate: 'CONTAINS', operator: 'AND' },
    ) =>
      new SqlServerKeywordRetriever({
        store,
        index: vectorizer.contract.index,
        matching,
      }),
  };
}

const ids = ({
  passages,
}: {
  readonly passages: readonly { readonly passage: { readonly id: string } }[];
}) => passages.map(({ passage }) => passage.id);

const deploy = task(
  'a',
  'Deploy git branches',
  'Push to main deploys the site',
  'ops',
);
const build = task('b', 'Fix a broken build', 'A package is missing', 'dev');
const notes = task(
  'c',
  'Write the release notes',
  'Notes for the git tag',
  'docs',
);

test(
  'a vector search, a keyword search and their fusion through @zukhruf/retrieval/sqlserver give the passages of the contract, with their id, source, seq, offsets, text and metadata',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    const model = new LetterModel();
    const { pipeline, vectorizer } = tasksPipeline({
      login: database.login,
      rows: () => [deploy, build, notes],
      model,
    });

    await pipeline.run();

    const { store, meaning, words } = retrieval(
      database.pool,
      vectorizer,
      model,
    );
    const text = 'Deploy git branches\nPush to main deploys the site';
    const {
      passages: [best],
    } = await meaning.retrieve(text, { topK: 1 });
    const fused = await new FusionRetriever({
      retrievers: {
        meaning: { retriever: meaning },
        words: { retriever: words() },
      },
    }).retrieve('git notes tag');
    assert.deepEqual(
      {
        best: best?.passage,
        all: ids(await words().retrieve('git')).toSorted(),
        any: ids(
          await words({ predicate: 'CONTAINS', operator: 'OR' }).retrieve(
            'broken release',
          ),
        ).toSorted(),
        first: ids(fused)[0],
        fused: ids(fused).toSorted(),
        metadata: [...(await store.get(['a:0', 'b:0', 'c:0'])).values()]
          .map(({ id, metadata }) => [id, metadata['category']])
          .toSorted(),
      },
      {
        best: {
          id: 'a:0',
          source: 'a',
          seq: 0,
          start: 0,
          end: [...text].length,
          text,
          metadata: { category: 'ops' },
        },
        all: ['a:0', 'c:0'],
        any: ['b:0', 'c:0'],
        // Only c holds every word, so it leads; one id in both relations
        // merges the two lists into the three passages.
        first: 'c:0',
        fused: ['a:0', 'b:0', 'c:0'],
        metadata: [
          ['a:0', 'ops'],
          ['b:0', 'dev'],
          ['c:0', 'docs'],
        ],
      },
    );
  },
);

test(
  'a reader that may only SELECT on the schema marts searches by keywords and by vectors, and may not read the tables of _warehouse',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    const model = new LetterModel();
    const { pipeline, vectorizer } = tasksPipeline({
      login: database.login,
      rows: () => [deploy, build, notes],
      model,
    });
    await pipeline.run();
    // Logins belong to the whole server, which other tests share.
    const name = `reader_${randomUUID().replaceAll('-', '')}`;
    const password = `${randomUUID()}A!`;
    await database.pool
      .request()
      .batch(
        `CREATE LOGIN [${name}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF; CREATE USER [${name}] FOR LOGIN [${name}]; GRANT SELECT ON SCHEMA::marts TO [${name}];`,
      );
    const reader = new mssql.ConnectionPool({
      server: database.login.server,
      port: database.login.port,
      database: database.login.database,
      user: name,
      password,
      options: { trustServerCertificate: true },
    });
    try {
      await reader.connect();

      const { meaning, words } = retrieval(reader, vectorizer, model);
      const text = 'Write the release notes\nNotes for the git tag';
      const {
        passages: [best],
      } = await meaning.retrieve(text, { topK: 1 });
      const denied = await reader
        .request()
        .query('SELECT COUNT(*) AS [rows] FROM _warehouse.raw_tasks')
        .then(
          () => undefined,
          (error: unknown) =>
            Error.isError(error) && 'number' in error ? error.number : error,
        );

      assert.deepEqual(
        {
          words: ids(await words().retrieve('git')).toSorted(),
          best: best?.passage.id,
          denied,
        },
        { words: ['a:0', 'c:0'], best: 'c:0', denied: 229 },
      );
    } finally {
      await reader.close();
      await database.pool
        .request()
        .batch(`DROP USER [${name}]; DROP LOGIN [${name}];`);
    }
  },
);

test(
  'the sources a and A are two source rows, so a:0 and A:0 are two passages, each with its own text and metadata, under the case-insensitive collation of the database',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    const model = new LetterModel();
    const { pipeline, vectorizer } = tasksPipeline({
      login: database.login,
      rows: () => [
        task('a', 'alpha words', '', 'lower'),
        task('A', 'bravo words', '', 'upper'),
      ],
      model,
    });

    await pipeline.run();

    const { store, meaning, words } = retrieval(
      database.pool,
      vectorizer,
      model,
    );
    const passages = await store.get(['a:0', 'A:0']);
    const brief = (result: {
      readonly passages: readonly {
        readonly passage: {
          readonly id: string;
          readonly text: string;
          readonly metadata: Readonly<Record<string, unknown>>;
        };
      }[];
    }) =>
      result.passages.map(({ passage }) => [
        passage.id,
        passage.text,
        passage.metadata['category'],
      ]);
    assert.deepEqual(
      {
        alpha: brief(await words().retrieve('alpha')),
        bravo: brief(await words().retrieve('bravo')),
        both: brief(await words().retrieve('words')).toSorted(),
        nearest: ids(await meaning.retrieve('bravo words', { topK: 1 })),
        stored: [...passages.values()]
          .map(({ id, source, text }) => [id, source, text])
          .toSorted(),
      },
      {
        alpha: [['a:0', 'alpha words', 'lower']],
        bravo: [['A:0', 'bravo words', 'upper']],
        both: [
          ['A:0', 'bravo words', 'upper'],
          ['a:0', 'alpha words', 'lower'],
        ],
        nearest: ['A:0'],
        stored: [
          ['A:0', 'A', 'bravo words'],
          ['a:0', 'a', 'alpha words'],
        ],
      },
    );
  },
);

test(
  'a run ends only once the full-text index holds its passages, so docs_status is current and a keyword search finds the passages of each run at once',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    let rows = [task('a', 'alpha first'), task('b', 'bravo first')];
    const model = new LetterModel();
    const { pipeline, vectorizer } = tasksPipeline({
      login: database.login,
      rows: () => rows,
      model,
    });
    const { words } = retrieval(database.pool, vectorizer, model);
    const state = async () =>
      (await database.rows('SELECT [state] FROM marts.docs_status'))[0]?.state;

    await pipeline.run();
    const first = {
      state: await state(),
      found: ids(
        await words({ predicate: 'CONTAINS', operator: 'OR' }).retrieve(
          'alpha bravo',
        ),
      ).toSorted(),
    };
    rows = [task('a', 'alpha first'), task('b', 'zebra second')];
    await pipeline.run();
    const second = {
      state: await state(),
      zebra: ids(await words().retrieve('zebra')),
      bravo: ids(await words().retrieve('bravo')),
    };

    assert.deepEqual(
      { first, second },
      {
        first: { state: 'current', found: ['a:0', 'b:0'] },
        second: { state: 'current', zebra: ['b:0'], bravo: [] },
      },
    );
  },
);

test(
  'a source row whose passage id would be longer than 450 characters fails alone, as a rule failure that names the limit and the length, and the other rows get their keyword rows',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    const model = new LetterModel();
    // 449 characters, a colon and the seq 0: 451 characters.
    const long = 'k'.repeat(449);
    const { pipeline, vectorizer } = tasksPipeline({
      login: database.login,
      rows: () => [task(long, 'a long key'), task('b', 'a normal key')],
      model,
    });

    await pipeline.run();

    const { words } = retrieval(database.pool, vectorizer, model);
    const [failed] = await database.rows(
      `SELECT [status], [error] FROM marts.docs_chunks WHERE [source] = N'${long}'`,
    );
    assert.equal(failed?.status, 'failed');
    assert.match(String(failed?.error), /up to 451 characters, more than 450/);
    assert.deepEqual(
      {
        found: ids(await words().retrieve('key')),
        keywords: await database.rows(
          'SELECT [id] FROM marts.docs_keywords ORDER BY [id]',
        ),
        chunks: await database.rows(
          "SELECT CAST([failed] AS int) AS [failed] FROM marts.derived_status WHERE [dataset] = N'marts.docs_chunks'",
        ),
        keywordIndex: await database.rows(
          "SELECT [state] FROM marts.derived_status WHERE [dataset] = N'marts.docs_keywords'",
        ),
        status: await database.rows(
          'SELECT [state], CAST([failed_sources] AS int) AS [failed_sources], CAST([failed_vectors] AS int) AS [failed_vectors], CAST([pending_files] AS int) AS [pending_files], CAST([failed_files] AS int) AS [failed_files] FROM marts.docs_status',
        ),
      },
      {
        found: ['b:0'],
        keywords: [{ id: 'b:0' }],
        chunks: [{ failed: 1 }],
        keywordIndex: [{ state: 'current' }],
        status: [
          {
            state: 'current',
            failed_sources: 1,
            failed_vectors: 0,
            pending_files: 0,
            failed_files: 0,
          },
        ],
      },
    );
  },
);

test(
  'another language of the keyword index makes the table and its full-text index again in that language, and a search finds each passage after the run',
  { skip: emulation },
  async () => {
    await using database = await scratch(fullText);
    const model = new LetterModel();
    const rows = () => [deploy, build, notes];
    await tasksPipeline({ login: database.login, rows, model }).pipeline.run();
    const german = tasksPipeline({
      login: database.login,
      rows,
      model,
      language: 1031,
    });

    await german.pipeline.run();

    const { words } = retrieval(database.pool, german.vectorizer, model);
    assert.deepEqual(
      {
        language: await database.rows(
          "SELECT c.[language_id] AS [language] FROM sys.fulltext_index_columns AS c WHERE c.[object_id] = OBJECT_ID(N'marts.docs_keywords')",
        ),
        found: ids(await words().retrieve('git')).toSorted(),
      },
      { language: [{ language: 1031 }], found: ['a:0', 'c:0'] },
    );
  },
);

test(
  'a server with no Full-Text Search fails the keyword index with a SqlServerSetupError of failure type config, and makes no keywords table',
  { skip: emulation },
  async () => {
    await using database = await scratch(
      new SqlServer({ environment: process.env, image }),
    );
    const { pipeline, destination } = tasksPipeline({
      login: database.login,
      rows: () => [deploy],
    });

    const error = await pipeline.run().then(
      () =>
        assert.fail('a server with no Full-Text Search should fail the run'),
      (failure: unknown) => failure,
    );

    assert.ok(error instanceof DerivedDatasetError, String(error));
    assert.equal(error.dataset, 'docs');
    assert.ok(error.cause instanceof DerivedDatasetError);
    assert.equal(error.cause.dataset, 'docs_keywords');
    const cause = error.cause.cause;
    assert.ok(cause instanceof SqlServerSetupError, String(cause));
    assert.deepEqual(
      {
        failureType: destination.failureType(cause),
        table: await database.rows(
          "SELECT OBJECT_ID(N'marts.docs_keywords') AS [table]",
        ),
      },
      { failureType: 'config', table: [{ table: null }] },
    );
  },
);

test('the vectorizer refuses a metadata column that has the name of a passage column of SQL Server, in any case, and takes rowid, which SQL Server passages do not have', () => {
  const destination = new SqlServerDestination({
    login: {
      server: 'localhost',
      database: 'none',
      user: 'none',
      password: 'none',
    },
  });
  const declare = (metadata: readonly string[]) =>
    new Vectorizer({
      into: destination,
      from: destination.table('tasks'),
      name: 'docs',
      description: 'The tasks.',
      key: 'name',
      loading: { columns: ['title'] },
      chunking: 'none',
      embedding: {
        model: new LetterModel(),
        dimensions: 26,
        clock: globalThis,
      },
      metadata,
    });
  for (const named of ['ID', 'Source', 'seq', 'start', 'END', 'text'])
    assert.throws(() => declare([named]), {
      name: 'TypeError',
      message: new RegExp(`metadata column ${named}\\b`),
    });
  assert.equal(declare(['rowid']).name, 'docs');
});

test('the vectorizer refuses a language of the keyword index that is not the LCID of a language, an integer of 0 or more', () => {
  const destination = new SqlServerDestination({
    login: {
      server: 'localhost',
      database: 'none',
      user: 'none',
      password: 'none',
    },
  });
  const declare = (language: number) =>
    new Vectorizer({
      into: destination,
      from: destination.table('tasks'),
      name: 'docs',
      description: 'The tasks.',
      key: 'name',
      loading: { columns: ['title'] },
      chunking: 'none',
      embedding: {
        model: new LetterModel(),
        dimensions: 26,
        clock: globalThis,
      },
      keywords: { language },
    });
  for (const language of [1033.5, -1, Number.NaN])
    assert.throws(() => declare(language), {
      name: 'RangeError',
      message: new RegExp(`LCID of a language.*${String(language)}$`),
    });
  assert.equal(declare(1031).name, 'docs');
});

test('the declaration of the vectors index takes only none, so no vector index of SQL Server can be declared yet (zukhruf #5475), and the language of the keyword index is an LCID', () => {
  const destination = new SqlServerDestination({
    login: {
      server: 'localhost',
      database: 'none',
      user: 'none',
      password: 'none',
    },
  });
  const options = {
    into: destination,
    from: destination.table('tasks'),
    name: 'docs',
    description: 'The tasks.',
    key: 'name',
    loading: { columns: ['title'] },
    chunking: 'none',
    embedding: { model: new LetterModel(), dimensions: 26, clock: globalThis },
  } as const;
  assert.equal(
    new Vectorizer({ ...options, indexing: { vectors: 'none' } }).name,
    'docs',
  );
  type Options = ConstructorParameters<typeof Vectorizer>[0];
  // @ts-expect-error a DiskANN index is not a value of the declaration.
  const diskann: Options['indexing'] = { vectors: 'diskann' };
  // @ts-expect-error the language is an LCID, not its name.
  const named: Options['keywords'] = { language: 'English' };
  void [diskann, named];
});
