import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  LocalFiles,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
  storedChunkSize,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

// A database of its own for one test, which keeps row versions for readers.
async function scratch() {
  const database = await sqlServer.database();
  const login: SqlServerLogin = {
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    trustServerCertificate: true,
  };
  const admin = await new SqlServerDatabase(login).connect();
  await admin.query(
    `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
  );
  return {
    login,
    admin,
    async [Symbol.asyncDispose]() {
      await admin[Symbol.asyncDispose]();
      await database[Symbol.asyncDispose]();
    },
  };
}

// Gives the messages that a test sets, then a checkpoint for an incremental
// copy.
class Messages extends Source {
  readonly identity = 'files';
  protected readonly catalog: Catalog;
  messages: SourceMessage[] = [];

  constructor(stream: Stream) {
    super();
    this.catalog = new Catalog([stream]);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(configuration: CopyConfiguration) {
    yield* this.messages;
    if (configuration.syncMode === 'incremental')
      yield {
        type: 'STATE' as const,
        stream: configuration.stream.name,
        state: {},
      };
  }
}

class TextParser extends DocumentParser {
  constructor() {
    super('test-text');
  }

  override parse(path: string) {
    return readFile(path, 'utf8');
  }
}

function attachments(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A test record.',
      properties: {
        id: { type: 'string', description: 'Record id.' },
        version: { type: 'integer', description: 'Record version.' },
      },
      required: ['id', 'version'],
    },
    supportedSyncModes: ['full_refresh', 'incremental'],
    primaryKey: ['id'],
    supportsFileTransfer: true,
    emitsDeletes: true,
  });
}

// The relation that the description of a file column tells readers to join.
async function filesView(
  connection: SqlServerConnection,
  view: string,
  column: string,
): Promise<string> {
  const [row] = await connection.query(
    `SELECT CAST(p.[value] AS nvarchar(max)) AS [description] FROM sys.extended_properties AS p
     WHERE p.[class] = 1 AND p.[major_id] = OBJECT_ID(@view) AND p.[minor_id] = COLUMNPROPERTY(OBJECT_ID(@view), @column, 'ColumnId') AND p.[name] = N'MS_Description'`,
    { view, column },
  );
  const named = /\[marts\]\.\[_elt_files_[0-9a-f]{40}\]/.exec(
    String(row?.description),
  );
  assert.ok(named, String(row?.description));
  return named[0];
}

test('a column of an original file holds a UNIQUEIDENTIFIER that joins its chunks, a parsed column holds the text, and the chunks follow replays, replacement, deletion, a failed batch and a clear', async () => {
  await using database = await scratch();
  const { admin } = database;
  await using files = await new TemporaryFiles().directory('elt-sqlserver-');
  const note = join(files.path, 'note.txt');
  const empty = join(files.path, 'empty.txt');
  // Text over one chunk, which no reordering of its chunks keeps.
  const bytes = Buffer.from(
    new Uint8Array(storedChunkSize + 3).map((_, index) => 32 + (index % 95)),
  );
  await writeFile(note, bytes);
  await writeFile(empty, '');
  const stream = attachments('attachments');
  const source = new Messages(stream);
  const destination = new SqlServerDestination({ login: database.login });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login: database.login }),
        steps: [
          new Copy(
            stream,
            destination.table('attachments', (c) => [
              c.text('id'),
              c.integer('version'),
              c.text('content').from(stream.file).parse(new TextParser()),
              c.blob('bytes').from(stream.file),
            ]),
            {
              id: 'attachments',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ],
  });
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 1 }, file: note },
    { stream: stream.name, data: { id: 'empty', version: 1 }, file: empty },
    { stream: stream.name, data: { id: 'missing', version: 1 }, file: null },
  ];

  await pipeline.run();

  const chunksView = await filesView(admin, 'marts.attachments', 'bytes');
  const chunksTable = chunksView.replace('[marts]', '[_warehouse]');
  const [types] = await admin.query(
    `SELECT TYPE_NAME(c.[user_type_id]) AS [bytes], (SELECT TYPE_NAME(t.[user_type_id]) FROM sys.columns AS t WHERE t.[object_id] = OBJECT_ID(N'marts.attachments') AND t.[name] = N'content') AS [content]
     FROM sys.columns AS c WHERE c.[object_id] = OBJECT_ID(N'marts.attachments') AND c.[name] = N'bytes'`,
  );
  assert.deepEqual(
    { ...types },
    { bytes: 'uniqueidentifier', content: 'nvarchar' },
  );
  const initial = await admin.query(
    'SELECT [id], [bytes], [loaded_at] FROM marts.attachments ORDER BY [id]',
  );
  assert.deepEqual(
    (
      await admin.query(
        'SELECT [id], CAST(DATALENGTH([content]) / 2 AS int) AS [length], IIF([bytes] IS NULL, 1, 0) AS [missing] FROM marts.attachments ORDER BY [id]',
      )
    ).map((row) => ({ ...row })),
    [
      { id: 'empty', length: 0, missing: 0 },
      { id: 'missing', length: null, missing: 1 },
      { id: 'note', length: bytes.length, missing: 0 },
    ],
  );
  assert.equal(
    (
      await admin.query(
        `SELECT [content] FROM marts.attachments WHERE [id] = N'note'`,
      )
    )[0]?.content,
    bytes.toString('utf8'),
  );
  const chunksOf = async (id: string) =>
    (
      await admin.query(
        `SELECT c.[n], c.[bytes] FROM ${chunksView} AS c JOIN marts.attachments AS a ON a.[bytes] = c.[file] WHERE a.[id] = @id ORDER BY c.[n]`,
        { id },
      )
    ).map((row) => Buffer.from(Object(row.bytes)));
  const stored = await chunksOf('note');
  assert.deepEqual(
    stored.map((chunk) => chunk.length),
    [storedChunkSize, 3],
  );
  assert.equal(hash('sha256', Buffer.concat(stored)), hash('sha256', bytes));
  assert.deepEqual(
    (await chunksOf('empty')).map((chunk) => chunk.length),
    [0],
  );
  const [history] = await admin.query(
    `SELECT [name] FROM sys.tables WHERE SCHEMA_NAME([schema_id]) = N'_warehouse' AND [name] LIKE N'\\_elt\\_history\\_%' ESCAPE N'\\'`,
  );
  assert.ok(history);
  // Chunks that no row of the table or of its history names.
  const orphans = async () =>
    (
      await admin.query(
        `SELECT COUNT(*) AS [n] FROM ${chunksTable} AS c WHERE NOT EXISTS (SELECT 1 FROM _warehouse.raw_attachments AS a WHERE a.[bytes] = c.[file]) AND NOT EXISTS (SELECT 1 FROM _warehouse.[${String(history.name)}] AS h WHERE h.[bytes] = c.[file])`,
      )
    )[0]?.n;
  const chunkCount = async () =>
    (await admin.query(`SELECT COUNT(*) AS [n] FROM ${chunksTable}`))[0]?.n;
  assert.equal(await orphans(), 0);

  // The cursor guard refuses these replays, and the files they staged go.
  await pipeline.run();
  assert.deepEqual(
    await admin.query(
      'SELECT [id], [bytes], [loaded_at] FROM marts.attachments ORDER BY [id]',
    ),
    initial,
  );
  assert.equal(await orphans(), 0);
  assert.equal(await chunkCount(), 3);

  await writeFile(note, 'updated');
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 2 }, file: note },
    { type: 'DELETE', stream: stream.name, key: { id: 'empty' } },
  ];
  await pipeline.run();
  assert.equal(
    (
      await admin.query(
        `SELECT [content] FROM marts.attachments WHERE [id] = N'note'`,
      )
    )[0]?.content,
    'updated',
  );
  assert.equal(await orphans(), 0);
  // The history keeps the first version of note and the deleted empty, and
  // so their chunks, beside the chunk of the updated note.
  assert.equal(await chunkCount(), 4);

  // A failed record discards the files that its batch staged.
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 3 }, file: empty },
    {
      stream: stream.name,
      data: { id: 'bad', version: 'invalid' },
      file: note,
    },
  ];
  await assert.rejects(pipeline.run(), PipelineError);
  assert.equal(
    (
      await admin.query(
        `SELECT [content] FROM marts.attachments WHERE [id] = N'note'`,
      )
    )[0]?.content,
    'updated',
  );
  assert.equal(await orphans(), 0);
  assert.equal(await chunkCount(), 4);

  await pipeline.clear();
  assert.equal(
    (await admin.query('SELECT COUNT(*) AS [n] FROM marts.attachments'))[0]?.n,
    0,
  );
  assert.equal(await chunkCount(), 0);
});

test('a load that brings the same file again keeps the row it stored and stores the bytes once', async () => {
  await using database = await scratch();
  const { admin } = database;
  await using files = await new TemporaryFiles().directory('elt-sqlserver-');
  const file = join(files.path, 'a.txt');
  await writeFile(file, 'the same bytes');
  const stream = attachments('files');
  const source = new Messages(stream);
  const destination = new SqlServerDestination({ login: database.login });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            stream,
            destination.table('files', (c) => [
              c.text('id'),
              c.integer('version'),
              c.blob('bytes').from(stream.file),
            ]),
          ),
        ],
      }),
    ],
  });
  source.messages = [
    { stream: stream.name, data: { id: 'a', version: 1 }, file },
  ];
  await pipeline.run();
  const before = await admin.query(
    'SELECT [bytes], [loaded_at] FROM marts.files',
  );

  await pipeline.run();

  assert.deepEqual(
    await admin.query('SELECT [bytes], [loaded_at] FROM marts.files'),
    before,
  );
  const chunksView = await filesView(admin, 'marts.files', 'bytes');
  assert.deepEqual(
    (
      await admin.query(
        `SELECT [file], [n], CAST([bytes] AS varchar(max)) AS [text] FROM ${chunksView}`,
      )
    ).map((row) => ({ ...row })),
    [{ file: before[0]?.bytes, n: '0', text: 'the same bytes' }],
  );
});

test('the file of a row that a later pass replaces, and of one that it deletes, reads with its own bytes as of the position before it, through the view of its chunks', async () => {
  await using database = await scratch();
  await using files = await new TemporaryFiles().directory('elt-sqlserver-');
  const first = join(files.path, 'first.txt');
  const gone = join(files.path, 'gone.txt');
  const second = join(files.path, 'second.txt');
  await writeFile(first, 'the first bytes');
  await writeFile(gone, 'bytes of a deleted row');
  await writeFile(second, 'the second bytes');
  const stream = attachments('documents');
  const source = new Messages(stream);
  const destination = new SqlServerDestination({ login: database.login });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login: database.login }),
        steps: [
          new Copy(
            stream,
            destination.table('documents', (c) => [
              c.text('id'),
              c.integer('version'),
              c.blob('bytes').from(stream.file),
            ]),
            {
              id: 'documents',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ],
  });
  source.messages = [
    { stream: stream.name, data: { id: 'kept', version: 1 }, file: first },
    { stream: stream.name, data: { id: 'gone', version: 1 }, file: gone },
  ];
  await pipeline.run();
  const positions = await destination.positions();
  assert.ok(Array.isArray(positions));
  const before = positions.at(-1);
  source.messages = [
    { stream: stream.name, data: { id: 'kept', version: 2 }, file: second },
    { type: 'DELETE', stream: stream.name, key: { id: 'gone' } },
  ];
  await pipeline.run();
  const chunks = await filesView(database.admin, 'marts.documents', 'bytes');
  const texts = `SELECT d.[id], CAST(c.[bytes] AS varchar(max)) AS [text] FROM marts.documents AS d JOIN ${chunks} AS c ON c.[file] = d.[bytes] ORDER BY d.[id], c.[n]`;
  const read = async (position?: string) => {
    const reading = await destination.reading(position);
    if ('expired' in reading) assert.fail(reading.expired);
    await using _reading = reading;
    return (await reading.sql.query(texts)).map((row) => ({ ...row }));
  };

  assert.deepEqual(await read(before), [
    { id: 'gone', text: 'bytes of a deleted row' },
    { id: 'kept', text: 'the first bytes' },
  ]);
  assert.deepEqual(await read(), [{ id: 'kept', text: 'the second bytes' }]);
});

test('a target that stores references to files in a storage reconciles only the files that its rows and the rows of their history keep, and a clear forgets them', async () => {
  await using database = await scratch();
  const { admin } = database;
  await using files = await new TemporaryFiles().directory('elt-sqlserver-');
  const path = join(files.path, 'source.txt');
  await writeFile(path, 'original');
  const directory = join(files.path, 'copies');
  const stream = attachments('docs');
  const source = new Messages(stream);
  const destination = new SqlServerDestination({ login: database.login });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SqlServerCheckpointStore({ login: database.login }),
        steps: [
          new Copy(
            stream,
            destination.table('docs', (c) => [
              c.text('id'),
              c.integer('version'),
              c
                .text('ref')
                .from(stream.file.store(new LocalFiles({ directory }))),
            ]),
            {
              id: 'docs',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            },
          ),
        ],
      }),
    ],
  });
  const reference = async (id: string) =>
    String(
      (
        await admin.query('SELECT [ref] FROM marts.docs WHERE [id] = @id', {
          id,
        })
      )[0]?.ref,
    );
  const storedFiles = async () =>
    (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.isFile(),
    ).length;
  source.messages = [
    { stream: stream.name, data: { id: 'a', version: 1 }, file: path },
  ];
  await pipeline.run();
  const first = await reference('a');
  assert.equal(await readFile(join(directory, first), 'utf8'), 'original');

  // A commit that fails keeps the stored reference and its bytes.
  await admin.query(
    'ALTER TABLE _warehouse.raw_docs ADD CONSTRAINT [reject_two] CHECK ([version] <> 2)',
  );
  await writeFile(path, 'replacement');
  source.messages = [
    { stream: stream.name, data: { id: 'a', version: 2 }, file: path },
  ];
  await assert.rejects(pipeline.run(), PipelineError);
  assert.equal(await reference('a'), first);
  assert.equal(await readFile(join(directory, first), 'utf8'), 'original');
  await admin.query(
    'ALTER TABLE _warehouse.raw_docs DROP CONSTRAINT [reject_two]',
  );

  await pipeline.run();
  const replacement = await reference('a');
  assert.equal(
    await readFile(join(directory, replacement), 'utf8'),
    'replacement',
  );
  // The history keeps the version that the commit replaced, and so its file.
  assert.equal(await readFile(join(directory, first), 'utf8'), 'original');
  assert.equal(await storedFiles(), 2);

  await pipeline.clear();
  assert.equal(await storedFiles(), 0);
});

test('a file column that the target drops takes its chunks with it, whether its table evolves or an overwrite reloads it', async () => {
  for (const modes of [
    { syncMode: 'incremental', destinationSyncMode: 'append_dedup' },
    { syncMode: 'full_refresh', destinationSyncMode: 'overwrite' },
  ] as const) {
    await using database = await scratch();
    const { admin } = database;
    await using files = await new TemporaryFiles().directory('elt-sqlserver-');
    const file = join(files.path, 'a.bin');
    await writeFile(file, 'aye');
    const stream = new Stream({
      name: 'files',
      jsonSchema: {
        type: 'object',
        description: 'A test record.',
        properties: {
          id: { type: 'string', description: 'Record id.' },
          version: { type: 'integer', description: 'Record version.' },
        },
        required: ['id', 'version'],
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
      primaryKey: ['id'],
      supportsFileTransfer: true,
      sourceDefinedCursor: true,
    });
    const source = new Messages(stream);
    const destination = new SqlServerDestination({ login: database.login });
    const checkpoints = new SqlServerCheckpointStore({ login: database.login });
    const history = new SqlServerSyncHistory({ login: database.login });
    const run = (withBytes: boolean) => {
      // A target that stores no file is sent none.
      source.messages = [
        {
          stream: stream.name,
          data: { id: 'a', version: 1 },
          ...(withBytes ? { file } : {}),
        },
      ];
      return new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            checkpoints,
            steps: [
              new Copy(
                stream,
                destination.table('files', (c) => [
                  c.text('id'),
                  c.integer('version'),
                  ...(withBytes ? [c.blob('bytes').from(stream.file)] : []),
                ]),
                { id: 'files', ...modes },
              ),
            ],
          }),
        ],
      }).run();
    };
    const chunkRelations = async () =>
      (
        await admin.query(
          `SELECT CONCAT(SCHEMA_NAME([schema_id]), N'.', [name]) AS [name] FROM sys.objects WHERE [name] LIKE N'\\_elt\\_files\\_%' ESCAPE N'\\' AND [type] IN ('U', 'V')`,
        )
      ).length;
    await run(true);
    const before = await chunkRelations();
    // Dropping a column changes the copy, which an incremental copy's reset
    // accepts, keeping its rows.
    await checkpoints.reset('files');

    await run(false);

    assert.equal(before, 2, modes.destinationSyncMode);
    assert.equal(await chunkRelations(), 0, modes.destinationSyncMode);
    assert.deepEqual(
      (await admin.query('SELECT [id], [version] FROM marts.files')).map(
        (row) => ({ ...row }),
      ),
      [{ id: 'a', version: '1' }],
    );
  }
});
