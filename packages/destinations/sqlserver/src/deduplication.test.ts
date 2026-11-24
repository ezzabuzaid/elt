import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  type DedupPolicy,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
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

class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Plays the messages a test gives each stream, then a checkpoint.
class Scripted extends Source {
  readonly identity: string = 'scripted';
  protected readonly catalog: Catalog;
  messages: Record<string, readonly SourceMessage[]> = {};

  constructor(streams: readonly Stream[]) {
    super();
    this.catalog = new Catalog(streams);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
  ): AsyncIterable<SourceMessage> {
    const { name } = configuration.stream;
    yield* this.messages[name] ?? [];
    yield { type: 'STATE', stream: name, state: {} };
  }
}

// A note: its id, its version, and what it says.
const notes = (
  name: string,
  { sourceCursor = true }: { sourceCursor?: boolean } = {},
) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Which note.' },
        version: { type: 'integer', description: 'Its version.' },
        body: { type: 'string', description: 'What it says.' },
      },
      required: ['id', 'version', 'body'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: sourceCursor ? true : undefined,
    emitsDeletes: true,
  });

const note = (stream: string, id: string, version: number, body = id) => ({
  stream,
  data: { id, version, body },
});
// A deletion of a cursor_newer copy carries its cursor; one of a replace
// copy carries none.
const removal = (
  stream: string,
  id: string,
  cursor?: number,
): SourceMessage => ({
  type: 'DELETE',
  stream,
  key: { id },
  ...(cursor === undefined ? {} : { cursor }),
});

// A pipeline of one connection that deduplicates each stream into the
// reader view of its name, by its dedup policy, with the cursor version for a
// stream that defines no cursor of its own.
function deduplicating(
  login: SqlServerLogin,
  streams: readonly { stream: Stream; dedupPolicy: DedupPolicy }[],
) {
  const warehouse = new SqlServerDestination({ login });
  const source = new Scripted(streams.map(({ stream }) => stream));
  return {
    warehouse,
    source,
    pipeline: new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination: warehouse,
          checkpoints: new SqlServerCheckpointStore({ login }),
          steps: streams.map(
            ({ stream, dedupPolicy }) =>
              new Copy(stream, warehouse.table(stream.name), {
                id: `notes:${stream.name}`,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
                dedupPolicy,
                ...(stream.sourceDefinedCursor
                  ? {}
                  : { cursorField: 'version' }),
              }),
          ),
        }),
      ],
    }),
  };
}

// Each row of a reader view as `id:version:body`, in the binary order of the
// id.
async function notesOf(admin: SqlServerConnection, view: string) {
  const rows = await admin.query(
    `SELECT id, version, body FROM marts.${view} ORDER BY CAST(id COLLATE Latin1_General_100_BIN2_UTF8 AS varchar(max))`,
  );
  return rows.map(
    ({ id, version, body }) =>
      `${String(id)}:${String(version)}:${String(body)}`,
  );
}

// The rows that a session reads as of a position, as a reading sets it.
async function asOf(login: SqlServerLogin, position: string, sql: string) {
  await using reader = await new SqlServerDatabase(login).connect(globalThis);
  // A session context value is a sql_variant, which holds no nvarchar(max).
  await reader.query(
    `DECLARE @position bigint = CAST(@number AS bigint); EXEC sp_set_session_context @key = N'elt.position', @value = @position, @read_only = 1`,
    { number: numberOf(position) },
  );
  return await reader.query(sql);
}

async function positionsOf(warehouse: SqlServerDestination) {
  const positions = await warehouse.positions();
  assert.ok(Array.isArray(positions), 'the database has positions');
  return positions;
}

// The number of the commit that a position names.
const numberOf = (position: string | undefined) =>
  String(position?.split(':')[1]);

// The rows that the history of a raw table kept, oldest first.
async function historyOf(admin: SqlServerConnection) {
  const [table] = await admin.query(
    `SELECT name FROM sys.tables WHERE SCHEMA_NAME(schema_id) = N'_warehouse' AND name LIKE N'[_]elt[_]history[_]%'`,
  );
  return admin.query(
    `SELECT id, version, body, CONVERT(nvarchar(20), committed_in) AS committed_in, CONVERT(nvarchar(20), replaced_in) AS replaced_in FROM _warehouse.[${String(table?.name)}] ORDER BY replaced_in, id`,
  );
}

test(
  'a deduplicating copy inserts a new key, updates a key whose values changed, deletes a key that the source deleted, and leaves a row with the same values with its commit; the history keeps each replaced or deleted row with the commit that replaced it, so the position before reads as it was',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { warehouse, source, pipeline } = deduplicating(database.login, [
      { stream: notes('notes'), dedupPolicy: 'replace' },
    ]);
    source.messages = {
      notes: [
        note('notes', 'n1', 1, 'first'),
        note('notes', 'n2', 1),
        note('notes', 'n3', 1),
      ],
    };
    await pipeline.run();
    const [before] = await positionsOf(warehouse);
    const [, firstLoad] = await database.admin.query(
      'SELECT CONVERT(nvarchar(40), loaded_at, 127) AS loaded_at FROM _warehouse.raw_notes ORDER BY id',
    );

    source.messages = {
      notes: [
        note('notes', 'n1', 2, 'second'),
        note('notes', 'n2', 1),
        removal('notes', 'n3'),
        note('notes', 'n4', 1),
      ],
    };
    const [copied] = await pipeline.run();
    const [, after] = await positionsOf(warehouse);

    assert.deepEqual(
      { count: copied?.count, deleted: copied?.deleted },
      { count: 3, deleted: 1 },
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), [
      'n1:2:second',
      'n2:1:n2',
      'n4:1:n4',
    ]);
    assert.deepEqual(
      await database.admin.query(
        'SELECT id, CONVERT(nvarchar(20), committed_in) AS committed_in FROM _warehouse.raw_notes ORDER BY id',
      ),
      [
        { id: 'n1', committed_in: numberOf(after) },
        { id: 'n2', committed_in: numberOf(before) },
        { id: 'n4', committed_in: numberOf(after) },
      ],
    );
    assert.deepEqual(
      await database.admin.query(
        "SELECT CONVERT(nvarchar(40), loaded_at, 127) AS loaded_at FROM _warehouse.raw_notes WHERE id = N'n2'",
      ),
      [firstLoad],
    );
    assert.deepEqual(await historyOf(database.admin), [
      {
        id: 'n1',
        version: '1',
        body: 'first',
        committed_in: numberOf(before),
        replaced_in: numberOf(after),
      },
      {
        id: 'n3',
        version: '1',
        body: 'n3',
        committed_in: numberOf(before),
        replaced_in: numberOf(after),
      },
    ]);
    assert.deepEqual(
      await asOf(
        database.login,
        String(before),
        'SELECT id, body FROM marts.notes ORDER BY id',
      ),
      [
        { id: 'n1', body: 'first' },
        { id: 'n2', body: 'n2' },
        { id: 'n3', body: 'n3' },
      ],
    );
  },
);

test(
  'the operations of one commit merge in source order under replace, and by cursor under cursor_newer, also when a key repeats',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const script = (stream: string, versioned: boolean) => [
      note(stream, 'a', 1),
      removal(stream, 'a', versioned ? 1 : undefined),
      note(stream, 'a', 2),
      note(stream, 'b', 1),
      removal(stream, 'b', versioned ? 2 : undefined),
      note(stream, 'c', 5),
      note(stream, 'c', 3),
      note(stream, 'd', 4),
      note(stream, 'd', 4, 'd again'),
      removal(stream, 'never', versioned ? 1 : undefined),
    ];
    const { source, pipeline } = deduplicating(database.login, [
      { stream: notes('replacing'), dedupPolicy: 'replace' },
      {
        stream: notes('guarded', { sourceCursor: false }),
        dedupPolicy: 'cursor_newer',
      },
    ]);
    source.messages = {
      replacing: script('replacing', false),
      guarded: script('guarded', true),
    };

    await pipeline.run();

    // replace applies them in source order: a is deleted, then loaded again
    // at 2, b ends deleted, and the last record of a key wins. cursor_newer
    // ranks the records and deletions of a key by cursor, the first on ties:
    // a@2 beats the deletion at 1, the deletion at 2 beats b@1, and the first
    // d@4 wins.
    assert.deepEqual(await notesOf(database.admin, 'replacing'), [
      'a:2:a',
      'c:3:c',
      'd:4:d again',
    ]);
    assert.deepEqual(await notesOf(database.admin, 'guarded'), [
      'a:2:a',
      'c:5:c',
      'd:4:d',
    ]);
  },
);

test(
  'in one commit, a deletion newer than the stored row beats an older record of its key that follows it, so no row stays, and the history keeps the stored row',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = deduplicating(database.login, [
      {
        stream: notes('guarded', { sourceCursor: false }),
        dedupPolicy: 'cursor_newer',
      },
    ]);
    source.messages = { guarded: [note('guarded', 'a', 5, 'stored')] };
    await pipeline.run();

    source.messages = {
      guarded: [removal('guarded', 'a', 6), note('guarded', 'a', 1, 'after')],
    };
    await pipeline.run();

    // The deletion's cursor 6 beats the record's 1 in the stage, and then
    // the stored row's 5, so it removes the stored row.
    assert.deepEqual(await notesOf(database.admin, 'guarded'), []);
    assert.deepEqual(
      (await historyOf(database.admin)).map(({ body }) => body),
      ['stored'],
    );
  },
);

// A pipeline that keeps the newest version of each note in marts.notes: a
// cursor_newer copy, whose deletions carry their cursor.
const versioned = (login: SqlServerLogin) =>
  deduplicating(login, [
    {
      stream: notes('notes', { sourceCursor: false }),
      dedupPolicy: 'cursor_newer',
    },
  ]);

const checkpoint = (read: number): SourceMessage => ({
  type: 'STATE',
  stream: 'notes',
  state: { read },
});

// The commit that wrote each stored note. The commit is internal, so only
// the raw table shows it.
const commitsOf = (admin: SqlServerConnection) =>
  admin.query(
    'SELECT id, CONVERT(nvarchar(20), committed_in) AS committed_in FROM _warehouse.raw_notes ORDER BY id',
  );

test(
  'a tombstone older than the stored row deletes nothing: the row keeps its values and its commit, and the history keeps no copy of it',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = { notes: [note('notes', 'a', 5, 'stored')] };
    await pipeline.run();
    const written = await commitsOf(database.admin);

    source.messages = { notes: [removal('notes', 'a', 3)] };
    const [copied] = await pipeline.run();

    // The run counts each deletion it applied, as it counts each record that
    // cursor_newer discards. A refused deletion must not reach the update of
    // the MERGE, whose values would then be the deletion's nulls.
    assert.deepEqual(
      { count: copied?.count, deleted: copied?.deleted },
      { count: 0, deleted: 1 },
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:5:stored']);
    assert.deepEqual(await commitsOf(database.admin), written);
    assert.deepEqual(await historyOf(database.admin), []);
  },
);

test(
  'a tombstone newer than the stored row deletes it, and the history keeps the row',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = { notes: [note('notes', 'a', 5, 'stored')] };
    await pipeline.run();

    source.messages = { notes: [removal('notes', 'a', 7)] };
    const [copied] = await pipeline.run();

    assert.deepEqual(
      { count: copied?.count, deleted: copied?.deleted },
      { count: 0, deleted: 1 },
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), []);
    assert.deepEqual(
      (await historyOf(database.admin)).map(({ id, version, body }) => ({
        id,
        version,
        body,
      })),
      [{ id: 'a', version: '5', body: 'stored' }],
    );
  },
);

test(
  'a tombstone with the cursor of the stored row deletes nothing, as a record with that cursor replaces nothing',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = { notes: [note('notes', 'a', 5, 'stored')] };
    await pipeline.run();

    source.messages = { notes: [removal('notes', 'a', 5)] };
    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:5:stored']);
    assert.deepEqual(await historyOf(database.admin), []);
  },
);

test(
  'in one commit, a tombstone older than a record before it loses to the record',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = {
      notes: [note('notes', 'a', 5), removal('notes', 'a', 3)],
    };

    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:5:a']);
  },
);

test(
  'in one commit, a tombstone newer than the records on both sides of it wins, so neither record loads',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = {
      notes: [
        note('notes', 'a', 1),
        removal('notes', 'a', 6),
        note('notes', 'a', 3),
      ],
    };

    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), []);
  },
);

test(
  'in one commit, of a record and a tombstone with the same cursor the first wins, whichever it is',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = { notes: [note('notes', 'b', 2)] };
    await pipeline.run();

    source.messages = {
      notes: [
        note('notes', 'a', 4),
        removal('notes', 'a', 4),
        removal('notes', 'b', 4),
        note('notes', 'b', 4),
      ],
    };
    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:4:a']);
  },
);

test(
  'in one commit, of two tombstones the greatest cursor wins, whichever comes first',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = { notes: [note('notes', 'a', 5), note('notes', 'b', 5)] };
    await pipeline.run();

    source.messages = {
      notes: [
        removal('notes', 'a', 7),
        removal('notes', 'a', 3),
        removal('notes', 'b', 3),
        removal('notes', 'b', 7),
      ],
    };
    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), []);
  },
);

test(
  'a replay after a reset of the checkpoint changes nothing: its old tombstone keeps the newer row, which keeps its commit, and the history gains no row',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = versioned(database.login);
    source.messages = {
      notes: [
        note('notes', 'a', 1),
        checkpoint(1),
        removal('notes', 'a', 2),
        checkpoint(2),
        note('notes', 'a', 3),
        checkpoint(3),
      ],
    };
    await pipeline.run();
    const written = await commitsOf(database.admin);
    const history = await historyOf(database.admin);

    await new SqlServerCheckpointStore({ login: database.login }).reset(
      'notes:notes',
    );
    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:3:a']);
    assert.deepEqual(await commitsOf(database.admin), written);
    assert.deepEqual(
      history.map(({ id, version }) => ({ id, version })),
      [{ id: 'a', version: '1' }],
    );
    assert.deepEqual(await historyOf(database.admin), history);
  },
);

test(
  'a full refresh that replaces its target ranks tombstones with records by cursor too',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const stream = new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description: 'A note.',
        properties: {
          id: { type: 'string', description: 'Which note.' },
          version: { type: 'integer', description: 'Its version.' },
          body: { type: 'string', description: 'What it says.' },
        },
        required: ['id', 'version', 'body'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      emitsDeletes: true,
    });
    const warehouse = new SqlServerDestination({ login: database.login });
    const source = new Scripted([stream]);
    source.messages = {
      notes: [
        note('notes', 'a', 5),
        removal('notes', 'a', 3),
        note('notes', 'b', 1),
        removal('notes', 'b', 2),
      ],
    };
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login: database.login }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination: warehouse,
          checkpoints: new SqlServerCheckpointStore({ login: database.login }),
          steps: [
            new Copy(stream, warehouse.table('notes'), {
              id: 'notes:notes',
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite_dedup',
              cursorField: 'version',
            }),
          ],
        }),
      ],
    });

    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['a:5:a']);
  },
);

test(
  'cursor_newer keeps the greatest text cursor by the order of its UTF-8 bytes, and replace keeps the newest extraction, across batches',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const versions = (name: string) =>
      new Stream({
        name,
        jsonSchema: {
          type: 'object',
          description: 'A note.',
          properties: {
            id: { type: 'string', description: 'Which note.' },
            version: { type: 'string', description: 'Its version.' },
            body: { type: 'string', description: 'What it says.' },
          },
          required: ['id', 'version', 'body'],
        },
        primaryKey: ['id'],
        supportedSyncModes: ['incremental'],
      });
    const row = (
      stream: string,
      id: string,
      version: string,
      body: string,
    ) => ({
      stream,
      data: { id, version, body },
    });
    const { source, pipeline } = deduplicating(database.login, [
      { stream: versions('newer'), dedupPolicy: 'cursor_newer' },
      { stream: versions('restated'), dedupPolicy: 'replace' },
      { stream: versions('many'), dedupPolicy: 'replace' },
    ]);
    // 'B' sorts before 'a' by bytes, but after it without case. U+FF21 sorts
    // before an emoji in UTF-8, but after it in UTF-16.
    const first = (stream: string) => [
      row(stream, 'x', 'a', 'x-first'),
      row(stream, 'x', 'B', 'x-older'),
      row(stream, 'x', 'a', 'x-tie'),
      row(stream, 'y', 'a', 'y-first'),
      row(stream, 'z', '\uFF21', 'z-first'),
    ];
    source.messages = {
      newer: first('newer'),
      restated: first('restated'),
      many: Array.from({ length: 2500 }, (_, index) =>
        row('many', String(index % 1200), 'v', `row-${index}`),
      ),
    };
    await pipeline.run();
    source.messages = {
      newer: [
        row('newer', 'y', 'b', 'y-second'),
        row('newer', 'x', 'B', 'x-replayed'),
        row('newer', 'z', '😀', 'z-second'),
      ],
      restated: [row('restated', 'y', 'B', 'y-restated')],
    };
    await pipeline.run();

    const bodies = async (view: string) =>
      Object.fromEntries(
        (await database.admin.query(`SELECT id, body FROM marts.${view}`)).map(
          ({ id, body }) => [String(id), String(body)],
        ),
      );
    assert.deepEqual(await bodies('newer'), {
      x: 'x-first',
      y: 'y-second',
      z: 'z-second',
    });
    assert.deepEqual(await bodies('restated'), {
      x: 'x-tie',
      y: 'y-restated',
      z: 'z-first',
    });
    const many = await bodies('many');
    assert.equal(Object.keys(many).length, 1200);
    assert.equal(many['0'], 'row-2400');
    // 1199 comes again at 2399, in the next batch.
    assert.equal(many['1199'], 'row-2399');
  },
);

test(
  'a record that the cursor guard refuses changes nothing and leaves no history, and a pass that changes no row takes no position',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { warehouse, source, pipeline } = deduplicating(database.login, [
      {
        stream: notes('notes', { sourceCursor: false }),
        dedupPolicy: 'cursor_newer',
      },
    ]);
    source.messages = { notes: [note('notes', 'n1', 2, 'newer')] };
    await pipeline.run();
    const before = await positionsOf(warehouse);

    // Each record is alone in its commit, so the guard compares it with the
    // stored row: an older cursor, then the stored row's values.
    source.messages = {
      notes: [
        note('notes', 'n1', 1, 'older'),
        removal('notes', 'never stored', 1),
      ],
    };
    await pipeline.run();
    source.messages = { notes: [note('notes', 'n1', 2, 'newer')] };
    await pipeline.run();

    assert.deepEqual(await notesOf(database.admin, 'notes'), ['n1:2:newer']);
    assert.deepEqual(await historyOf(database.admin), []);
    assert.deepEqual(await positionsOf(warehouse), before);
    assert.deepEqual(
      await database.admin.query(
        'SELECT CONVERT(nvarchar(20), committed_in) AS committed_in FROM _warehouse.raw_notes',
      ),
      [{ committed_in: numberOf(before[0]) }],
    );
  },
);

test(
  'two keys that differ only in case stay two rows, and a deletion of one leaves the other',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const { source, pipeline } = deduplicating(database.login, [
      { stream: notes('notes'), dedupPolicy: 'replace' },
    ]);
    source.messages = {
      notes: [note('notes', 'A', 1, 'upper'), note('notes', 'a', 1, 'lower')],
    };
    await pipeline.run();
    const both = await notesOf(database.admin, 'notes');
    source.messages = {
      notes: [note('notes', 'A', 2, 'upper again'), removal('notes', 'a')],
    };

    await pipeline.run();

    assert.deepEqual(both, ['A:1:upper', 'a:1:lower']);
    assert.deepEqual(await notesOf(database.admin, 'notes'), [
      'A:2:upper again',
    ]);
  },
);

test(
  'a copy whose checkpoint was reset to take a new key fails, since its stored rows are hashed by the old key, and leaves the table as it was',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const keyless = new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description: 'A note.',
        properties: {
          id: { type: 'string', description: 'Which note.' },
          version: { type: 'integer', description: 'Its version.' },
          body: { type: 'string', description: 'What it says.' },
        },
        required: ['id', 'version', 'body'],
      },
      supportedSyncModes: ['incremental'],
      sourceDefinedCursor: true,
    });
    const keyed = (primaryKey: readonly string[]) => {
      const warehouse = new SqlServerDestination({ login: database.login });
      const source = new Scripted([keyless]);
      source.messages = { notes: [note('notes', 'n1', 1, 'first')] };
      return new Pipeline({
        clock: globalThis,
        history: new SqlServerSyncHistory({ login: database.login }),
        connections: [
          new Connection({
            name: 'notes',
            source,
            destination: warehouse,
            checkpoints: new SqlServerCheckpointStore({
              login: database.login,
            }),
            steps: [
              new Copy(keyless, warehouse.table('notes'), {
                id: 'notes:notes',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
                primaryKey,
              }),
            ],
          }),
        ],
      });
    };
    await keyed(['id']).run();
    // A reset keeps the rows, and lets the copy bind its new key.
    await new SqlServerCheckpointStore({ login: database.login }).reset(
      'notes:notes',
    );

    const failure = await keyed(['body'])
      .run()
      .then(
        () => assert.fail('the copy loaded under its new key'),
        (error: unknown) => error,
      );

    assert.match(
      inspect(failure),
      /no longer has the shape of stream notes.*clear the copy to load it again/,
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), ['n1:1:first']);
  },
);

// Notes whose version a record may leave out.
const unversioned = new Stream({
  name: 'notes',
  jsonSchema: {
    type: 'object',
    description: 'A note.',
    properties: {
      id: { type: 'string', description: 'Which note.' },
      version: { type: 'integer', description: 'Its version.' },
      body: { type: 'string', description: 'What it says.' },
    },
    required: ['id', 'body'],
  },
  supportedSyncModes: ['full_refresh', 'incremental'],
});

test(
  'a record of a cursor_newer copy with no cursor fails its commit, which leaves the table and its history as they were',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const warehouse = new SqlServerDestination({ login: database.login });
    const source = new Scripted([unversioned]);
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SqlServerSyncHistory({ login: database.login }),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination: warehouse,
          checkpoints: new SqlServerCheckpointStore({ login: database.login }),
          steps: [
            new Copy(unversioned, warehouse.table('notes'), {
              id: 'notes:notes',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              primaryKey: ['id'],
              cursorField: 'version',
            }),
          ],
        }),
      ],
    });
    source.messages = { notes: [note('notes', 'n1', 1, 'first')] };
    await pipeline.run();

    source.messages = {
      notes: [
        note('notes', 'n1', 2, 'second'),
        { stream: 'notes', data: { id: 'n2', body: 'no version' } },
      ],
    };
    const failure = await pipeline.run().then(
      () => assert.fail('a record with no cursor loaded'),
      (error: unknown) => error,
    );

    assert.match(
      inspect(failure),
      /Record is missing key\/cursor field version/,
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), ['n1:1:first']);
    assert.deepEqual(await historyOf(database.admin), []);
  },
);

test(
  'a stored row with no cursor fails a cursor_newer load, since the guard could never replace it',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const run = (
      destinationSyncMode: 'append' | 'append_dedup',
      data: readonly object[],
    ) => {
      const warehouse = new SqlServerDestination({ login: database.login });
      const source = new Scripted([unversioned]);
      source.messages = {
        notes: data.map((row) => ({ stream: 'notes', data: row })),
      };
      return new Pipeline({
        clock: globalThis,
        history: new SqlServerSyncHistory({ login: database.login }),
        connections: [
          new Connection({
            name: 'notes',
            source,
            destination: warehouse,
            checkpoints: new SqlServerCheckpointStore({
              login: database.login,
            }),
            steps: [
              new Copy(
                unversioned,
                warehouse.table('notes', (columns) => [
                  columns.text('id').primaryKey(),
                  columns.integer('version'),
                  columns.text('body'),
                ]),
                {
                  id: 'notes:notes',
                  syncMode: 'incremental',
                  destinationSyncMode,
                  cursorField: 'version',
                  ...(destinationSyncMode === 'append_dedup'
                    ? { primaryKey: ['id'] }
                    : {}),
                },
              ),
            ],
          }),
        ],
      }).run();
    };
    await run('append', [{ id: 'n1', version: null, body: 'no version' }]);
    // A reset keeps the rows, and lets the copy bind its new mode.
    await new SqlServerCheckpointStore({ login: database.login }).reset(
      'notes:notes',
    );

    const failure = await run('append_dedup', [
      { id: 'n1', version: 1, body: 'versioned' },
    ]).then(
      () => assert.fail('the copy loaded over a row with no cursor'),
      (error: unknown) => error,
    );

    assert.match(
      inspect(failure),
      /Existing deduplication keys and cursors must be non-null/,
    );
    assert.deepEqual(await notesOf(database.admin, 'notes'), [
      'n1:null:no version',
    ]);
  },
);
