import assert from 'node:assert/strict';
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
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

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

const emulation = await SqlServer.emulation({ environment: process.env });

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
  const admin = await new SqlServerDatabase(login).connect(globalThis);
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

test(
  'a parsed column holds the text of its file, which follows replays, replacement, deletion, a failed batch and a clear',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { admin } = database;
    await using files = await new TemporaryFiles().directory('elt-sqlserver-');
    const note = join(files.path, 'note.txt');
    const empty = join(files.path, 'empty.txt');
    const text = 'note text';
    await writeFile(note, text);
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
    const content = async (id: string) =>
      (
        await admin.query(
          'SELECT [content] FROM marts.attachments WHERE [id] = @id',
          { id },
        )
      )[0]?.content;

    await pipeline.run();

    const [type] = await admin.query(
      `SELECT TYPE_NAME([user_type_id]) AS [content] FROM sys.columns WHERE [object_id] = OBJECT_ID(N'marts.attachments') AND [name] = N'content'`,
    );
    assert.deepEqual({ ...type }, { content: 'nvarchar' });
    const initial = await admin.query(
      'SELECT [id], [content], [loaded_at] FROM marts.attachments ORDER BY [id]',
    );
    assert.deepEqual(
      initial.map(({ id, content }) => ({ id, content })),
      [
        { id: 'empty', content: '' },
        { id: 'missing', content: null },
        { id: 'note', content: text },
      ],
    );

    // The cursor guard refuses these replays.
    await pipeline.run();
    assert.deepEqual(
      await admin.query(
        'SELECT [id], [content], [loaded_at] FROM marts.attachments ORDER BY [id]',
      ),
      initial,
    );

    await writeFile(note, 'updated');
    source.messages = [
      { stream: stream.name, data: { id: 'note', version: 2 }, file: note },
      { type: 'DELETE', stream: stream.name, key: { id: 'empty' } },
    ];
    await pipeline.run();
    assert.equal(await content('note'), 'updated');
    assert.deepEqual(
      (
        await admin.query('SELECT [id] FROM marts.attachments ORDER BY [id]')
      ).map(({ id }) => id),
      ['missing', 'note'],
    );

    // A failed record discards the rows that its batch staged.
    source.messages = [
      { stream: stream.name, data: { id: 'note', version: 3 }, file: empty },
      {
        stream: stream.name,
        data: { id: 'bad', version: 'invalid' },
        file: note,
      },
    ];
    await assert.rejects(pipeline.run(), PipelineError);
    assert.equal(await content('note'), 'updated');

    await pipeline.clear();
    assert.equal(
      (await admin.query('SELECT COUNT(*) AS [n] FROM marts.attachments'))[0]
        ?.n,
      0,
    );
  },
);

test(
  'a target that stores references to files in a storage reconciles only the files that its rows and the rows of their history keep, and a clear forgets them',
  { skip: emulation },
  async () => {
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
      (
        await readdir(directory, { recursive: true, withFileTypes: true })
      ).filter((entry) => entry.isFile()).length;
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
  },
);
