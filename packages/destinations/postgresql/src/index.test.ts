import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import postgres from 'postgres';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  DocumentParser,
  LocalFiles,
  type Partition,
  Pipeline,
  PipelineError,
  type Properties,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
  type StreamSchema,
  diffSnapshot,
} from '@workspace/elt';

import {
  PostgresCheckpointStore,
  PostgresColumns,
  PostgresDestination,
  PostgresSyncHistory,
  publishPostgresViews,
} from './index.ts';
import { PostgresFileStore } from './postgres-file-store.ts';

/**
 * A database of its own on `server` for one test, dropped when the test ends.
 * `sql` is an administrator session there; `as` names the same database for
 * another role.
 */
async function scratchDatabase(
  server: string,
  options?: postgres.Options<Record<string, postgres.PostgresType>>,
) {
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  const name = `elt_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(server).host} is unavailable. Start it with: npx nx run infra:up`,
      { cause },
    );
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  const as = (username: string, password: string) => {
    const role = new URL(url);
    role.username = username;
    role.password = password;
    return role.href;
  };
  const sql = postgres(url.href, { max: 2, onnotice: () => {}, ...options });
  return {
    name,
    url: url.href,
    sql,
    as,
    async [Symbol.asyncDispose]() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

const server =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

// Emits whatever the test sets on `messages`, then an empty checkpoint.
class Messages extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  messages: SourceMessage[] = [];
  extracted = 0;
  readonly stream: Stream;
  readonly identity: string;
  protected readonly catalog: Catalog;
  constructor(stream: Stream, identity = 'test') {
    super();
    this.stream = stream;
    this.identity = identity;
    this.catalog = new Catalog([stream]);
  }
  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }
  protected override async *extract(configuration: CopyConfiguration) {
    this.extracted++;
    yield* this.messages;
    if (configuration.syncMode === 'incremental')
      yield { type: 'STATE' as const, stream: this.stream.name, state: {} };
  }
}

const rows = (stream: Stream, data: readonly object[]): SourceMessage[] =>
  data.map((row) => ({ stream: stream.name, data: row }));

test('documented views expose live data and replace atomically without dropping outside dependents', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  await sql`CREATE TABLE source_notes (id integer PRIMARY KEY, title text)`;
  await sql`INSERT INTO source_notes VALUES (1, 'First')`;
  const schema = 'read"ing';
  const notes = {
    name: 'note"s',
    query: 'SELECT id, title FROM source_notes',
    description: "One row per note. Quotes: ' and \\; DROP TABLE source_notes;",
    columns: { id: 'Source note ID.', title: "The note's title." },
  };
  const titles = {
    name: 'titles',
    query: 'SELECT title FROM "read""ing"."note""s"',
    description: 'One title per note.',
    columns: { title: 'Note title.' },
  };
  await sql.begin((transaction) =>
    publishPostgresViews(transaction, { schema, views: [notes, titles] }),
  );
  const metadata = () => sql`
    SELECT obj_description(c.oid, 'pg_class') AS description,
      a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      col_description(c.oid, a.attnum) AS column_description
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = ${schema} AND c.relname = ${notes.name}
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  assert.deepEqual(
    [...(await metadata())],
    [
      {
        description: notes.description,
        name: 'id',
        type: 'integer',
        column_description: notes.columns.id,
      },
      {
        description: notes.description,
        name: 'title',
        type: 'text',
        column_description: notes.columns.title,
      },
    ],
  );
  assert.deepEqual(
    [...(await sql`SELECT * FROM "read""ing".titles`)],
    [{ title: 'First' }],
  );
  await sql`UPDATE source_notes SET title = 'Changed' WHERE id = 1`;
  assert.deepEqual(
    [...(await sql`SELECT * FROM "read""ing".titles`)],
    [{ title: 'Changed' }],
  );

  const revised = {
    ...notes,
    query: 'SELECT id::text AS id, title FROM source_notes',
    description: 'One note, with its ID represented as text.',
    columns: { id: 'Text note ID.', title: 'Current title.' },
  };
  await sql.begin((transaction) =>
    publishPostgresViews(transaction, { schema, views: [revised, titles] }),
  );
  const revisedMetadata = [...(await metadata())];
  assert.equal(revisedMetadata[0]?.type, 'text');
  assert.equal(revisedMetadata[0]?.description, revised.description);
  assert.equal(revisedMetadata[0]?.column_description, revised.columns.id);

  // Even a caller that handles a failed publication cannot commit half of it.
  await sql.begin(async (transaction) => {
    const incomplete: Record<string, string>[] = [
      {},
      { title: 'Title.', missing: 'No such column.' },
    ];
    for (const columns of incomplete)
      await assert.rejects(
        publishPostgresViews(transaction, {
          schema,
          views: [notes, { ...titles, columns }],
        }),
        /must describe exactly its output columns/,
      );
    await assert.rejects(
      publishPostgresViews(transaction, {
        schema,
        views: [
          notes,
          { ...titles, query: `${titles.query}; DROP TABLE source_notes` },
        ],
      }),
      /multiple commands.*prepared statement/,
    );
    await assert.rejects(
      publishPostgresViews(transaction, { schema, views: [notes, notes] }),
      /Duplicate view names/,
    );
    await assert.rejects(
      publishPostgresViews(transaction, {
        schema,
        views: [{ ...notes, description: '\0' }],
      }),
      /Invalid view description/,
    );
    assert.deepEqual(
      [...(await transaction`SELECT id FROM source_notes`)],
      [{ id: 1 }],
    );
  });
  assert.deepEqual([...(await metadata())], revisedMetadata);
  await sql`CREATE VIEW outside AS SELECT id FROM "read""ing"."note""s"`;
  await assert.rejects(
    sql.begin((transaction) =>
      publishPostgresViews(transaction, { schema, views: [notes, titles] }),
    ),
    /other objects depend on it/,
  );
  assert.deepEqual([...(await sql`SELECT * FROM outside`)], [{ id: '1' }]);
  assert.deepEqual(
    [...(await sql`SELECT * FROM "read""ing".titles`)],
    [{ title: 'Changed' }],
  );
  assert.deepEqual([...(await metadata())], revisedMetadata);
});

test("a competing load cannot reconcile pending files between another load's commits", async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'docs',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const copy = new Copy(stream, destination.table('docs'));
  const load = await destination.load();
  let acquired = false;
  let contender: Promise<void> | undefined;
  try {
    const stage = await load.prepare(copy.configuration, copy.to, {
      writer: 'writer',
      restart: false,
      reloading: false,
    });
    try {
      await stage.apply({ type: 'RECORD', data: { id: 'a' } });
      contender = destination.load().then(async (other) => {
        acquired = true;
        await other[Symbol.asyncDispose]();
      });
      // Wait until the real server has queued the contender, without racing
      // connection startup against this load's commit.
      let queued = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] = await database.sql`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        if (row?.n > 0) {
          queued = true;
          break;
        }
        await delay(10);
      }
      assert.equal(queued, true);
      await stage.commit();
      assert.equal(acquired, false);
    } finally {
      await stage[Symbol.asyncDispose]();
    }
  } finally {
    await load[Symbol.asyncDispose]();
    await contender;
  }
  assert.equal(acquired, true);
});

test('Postgres stores per-field attachment references and reconciles only the files its committed rows retain', async () => {
  const scratch = await mkdtempDisposable(join(tmpdir(), 'elt-local-pg-'));
  try {
    await using database = await scratchDatabase(server);
    const path = join(scratch.path, 'source.txt');
    await writeFile(path, 'original');
    const directories = [
      join(scratch.path, 'originals'),
      join(scratch.path, 'copies'),
    ] as const;
    const files = directories.map((directory) => new LocalFiles({ directory }));
    const stream = new Stream({
      name: 'docs',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, version: { type: 'integer' } },
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      emitsDeletes: true,
      supportsFileTransfer: true,
    });
    const source = new Messages(stream);
    const destination = new PostgresDestination({
      url: database.url,
      schema: 'raw',
    });
    const copy = new Copy(
      stream,
      destination.table('docs', (c) => [
        c.text('id'),
        c.integer('version'),
        ...files.map((store, i) =>
          c.text(`ref${i}`).from(stream.file.store(store)),
        ),
      ]),
      {
        id: 'docs',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
      },
    );
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [copy],
          checkpoints: new PostgresCheckpointStore({
            url: database.url,
            schema: 'raw',
          }),
        }),
      ],
    });
    const loaded = async () => [
      ...(await database.sql.unsafe(
        'SELECT id, ref0, ref1 FROM raw.docs ORDER BY id',
      )),
    ];
    const storedFiles = async (directory: string) =>
      (
        await readdir(directory, { recursive: true, withFileTypes: true })
      ).filter((entry) => entry.isFile());
    const fileRecord = (version: number): SourceMessage => ({
      stream: 'docs',
      data: { id: 'a', version },
      file: path,
    });
    source.messages = [
      fileRecord(2),
      { stream: 'docs', data: { id: 'b', version: 1 }, file: null },
    ];
    await pipeline.run();
    const [first, unavailable] = await loaded();
    assert.ok(first);
    assert.equal(unavailable?.ref0, null);
    assert.equal(unavailable?.ref1, null);
    for (const i of [0, 1] as const) {
      assert.equal(await readFile(first[`ref${i}`], 'utf8'), 'original');
      assert.equal((await storedFiles(directories[i])).length, 1);
    }
    assert.notEqual(first.ref0, first.ref1);
    assert.equal(
      (
        await database.sql.unsafe(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'raw' AND table_name LIKE '_elt_files_%'",
        )
      )[0]?.n,
      0,
    );

    await pipeline.run();
    assert.deepEqual(await loaded(), [first, unavailable]);
    await writeFile(path, 'rejected');
    source.messages = [fileRecord(1)];
    await pipeline.run();
    assert.deepEqual(await loaded(), [first, unavailable]);
    for (const directory of directories)
      assert.equal((await storedFiles(directory)).length, 1);
    // A database failure must preserve both prior references and their bytes.
    await database.sql.unsafe(
      'ALTER TABLE raw.docs ADD CONSTRAINT reject_three CHECK (version <> 3)',
    );
    source.messages = [fileRecord(3)];
    await assert.rejects(pipeline.run(), PipelineError);
    for (const i of [0, 1])
      assert.equal(await readFile(first[`ref${i}`], 'utf8'), 'original');
    await database.sql.unsafe(
      'ALTER TABLE raw.docs DROP CONSTRAINT reject_three',
    );
    await writeFile(path, 'replacement');
    await pipeline.run();
    const [replacement] = await loaded();
    assert.ok(replacement);
    for (const i of [0, 1] as const) {
      assert.equal(
        await readFile(replacement[`ref${i}`], 'utf8'),
        'replacement',
      );
      await assert.rejects(readFile(first[`ref${i}`]), { code: 'ENOENT' });
      assert.equal((await storedFiles(directories[i])).length, 1);
    }
    source.messages = [{ type: 'DELETE', stream: 'docs', key: { id: 'a' } }];
    await pipeline.run();
    for (const directory of directories)
      assert.equal((await storedFiles(directory)).length, 0);
    source.messages = [fileRecord(4)];
    await pipeline.run();
    await pipeline.clear();
    assert.equal((await loaded()).length, 0);
    for (const directory of directories)
      assert.equal((await storedFiles(directory)).length, 0);
  } finally {
    await scratch[Symbol.asyncDispose]();
  }
});

test('schema annotations follow each copy, including projections, append history and removed descriptions', async () => {
  await using database = await scratchDatabase(server);
  const titleDescription =
    "The owner's title.\nLiteral \\paths and '; DROP TABLE notes; -- stay text.";
  const schema = {
    type: 'object',
    description: 'A source record represents one note.',
    properties: {
      id: { type: 'string', description: 'The source note identifier.' },
      title: { type: 'string', description: titleDescription },
      body: { type: 'string' },
    },
    required: ['id', 'title', 'body'],
  } satisfies StreamSchema;
  const stream = new Stream({
    name: 'notes',
    jsonSchema: schema,
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  const source = new Messages(stream);
  const record = { id: 'note-1', title: 'A note', body: 'Its body' };
  source.messages = rows(stream, [record]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'note"data',
  });
  const titles = destination.table('note"titles', (c) => [
    c.text('id').notNull(),
    c.text('title'),
  ]);
  const full = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(stream, destination.table('notes'))],
      }),
    ],
  });
  const history = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(stream, titles, {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });
  await full.run();
  await history.run();
  await history.run();
  const comments = async (table: string) => {
    const found = await database.sql`
      SELECT obj_description(c.oid, 'pg_class') AS relation, a.attname AS name,
        col_description(c.oid, a.attnum) AS description
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = ${destination.schema} AND c.relname = ${table}`;
    return {
      relation: found[0]?.relation,
      columns: Object.fromEntries(
        found.map((row) => [row.name, row.description]),
      ),
    };
  };
  const allComments = await comments('notes');
  const titleComments = await comments(titles.name);
  assert.ok(allComments.relation.includes(schema.description));
  assert.match(allComments.relation, /overwrite/);
  assert.match(titleComments.relation, /append/);
  assert.match(titleComments.relation, /source keys may repeat/);
  assert.equal(allComments.columns.id, schema.properties.id.description);
  assert.equal(allComments.columns.title, titleDescription);
  assert.equal(allComments.columns.body, null);
  assert.equal(titleComments.columns.id, schema.properties.id.description);
  assert.equal(titleComments.columns.title, titleDescription);
  assert.equal(Object.hasOwn(titleComments.columns, 'body'), false);
  assert.match(allComments.columns.loaded_at, /not.*source.*modification/i);
  assert.deepEqual(
    [
      ...(await database.sql`SELECT id, title, body FROM "note""data".notes`),
    ].map((row) => ({ ...row })),
    [record],
  );
  assert.equal(
    (
      await database.sql`SELECT count(*)::int AS n FROM "note""data"."note""titles"`
    )[0]?.n,
    2,
  );

  const revised = new Stream({
    name: stream.name,
    jsonSchema: {
      ...schema,
      description: 'Revised source meaning.',
      properties: { ...schema.properties, title: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  const revisedSource = new Messages(revised);
  revisedSource.messages = rows(revised, [record]);
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: revisedSource,
        destination,
        steps: [new Copy(revised, destination.table('notes'))],
      }),
    ],
  }).run();
  const revisedComments = await comments('notes');
  assert.ok(revisedComments.relation.includes('Revised source meaning.'));
  assert.equal(revisedComments.columns.title, null);
  assert.equal((await comments(titles.name)).columns.title, titleDescription);

  // Explicit targets already support sources without a properties schema.
  const unschematized = new Stream({
    name: stream.name,
    jsonSchema: { type: 'object' },
    supportedSyncModes: ['full_refresh'],
  });
  const plainSource = new Messages(unschematized);
  plainSource.messages = rows(unschematized, [record]);
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: plainSource,
        destination,
        steps: [new Copy(unschematized, titles)],
      }),
    ],
  }).run();
  const plainComments = await comments(titles.name);
  assert.equal(plainComments.columns.id, null);
  assert.equal(plainComments.columns.title, null);
  assert.equal(
    (
      await database.sql`SELECT count(*)::int AS n FROM "note""data"."note""titles"`
    )[0]?.n,
    1,
  );
});

test('invalid schema annotations fail before extraction or storage access', async () => {
  const destination = new PostgresDestination({
    url: 'postgres://unused/unused',
    schema: 'raw',
  });
  for (const invalid of [null, 1, 'bad\0text', '\ud800']) {
    for (const atRoot of [true, false]) {
      const stream = new Stream({
        name: 'items',
        // @ts-expect-error -- null and 1 are deliberately mistyped descriptions the destination must reject
        jsonSchema: atRoot
          ? {
              type: 'object',
              description: invalid,
              properties: { id: { type: 'string' } },
            }
          : {
              type: 'object',
              properties: { id: { type: 'string', description: invalid } },
            },
        supportedSyncModes: ['full_refresh'],
      });
      const source = new Messages(stream);
      await assert.rejects(
        new Pipeline({
          connections: [
            new Connection({
              name: 'test',
              source,
              destination,
              steps: [new Copy(stream, destination.table('items'))],
            }),
          ],
        }).run(),
        /JSON Schema description/,
      );
      assert.equal(source.extracted, 0);
    }
  }
});

test('file text and bounded original bytes survive replay, replacement and deletion with checkpoints', async () => {
  await using database = await scratchDatabase(server);
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-postgres-files-'),
  );
  const file = join(scratch.path, 'note.txt');
  const empty = join(scratch.path, 'empty.txt');
  const bytes = Buffer.alloc(PostgresFileStore.chunkSize + 3, 'a');
  await writeFile(file, bytes);
  await writeFile(empty, '');
  class TextParser extends DocumentParser {
    constructor() {
      super('test-text');
    }
    override parse(path: string) {
      return readFile(path, 'utf8');
    }
  }
  const stream = new Stream({
    name: 'attachments',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    supportedSyncModes: ['full_refresh', 'incremental'],
    primaryKey: ['id'],
    supportsFileTransfer: true,
    emitsDeletes: true,
  });
  const source = new Messages(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'apple_notes',
  });
  const table = destination.table('attachments', (c) => [
    c.text('id'),
    c.integer('version'),
    c.text('content').from(stream.file).parse(new TextParser()),
    c.blob('bytes').from(stream.file),
  ]);
  const fileColumn = table.columns.find((column) => column.name === 'bytes');
  assert.ok(fileColumn);
  const store = new PostgresFileStore(destination.schema, table, fileColumn);
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: destination.schema,
        }),
        steps: [
          new Copy(stream, table, {
            id: 'attachments',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
          }),
        ],
      }),
    ],
  });
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 1 }, file },
    { stream: stream.name, data: { id: 'empty', version: 1 }, file: empty },
    { stream: stream.name, data: { id: 'missing', version: 1 }, file: null },
  ];
  await pipeline.run();
  const comments = await database.sql`
    SELECT a.attname AS name, col_description(a.attrelid, a.attnum) AS description
    FROM pg_attribute a WHERE a.attrelid = 'apple_notes.attachments'::regclass AND a.attnum > 0`;
  const descriptions = Object.fromEntries(
    comments.map((row) => [row.name, row.description]),
  );
  assert.match(descriptions.content, /test-text/);
  assert.match(descriptions.content, /NULL.*no text/);
  assert.ok(descriptions.bytes.includes(store.qualifiedName));
  assert.match(descriptions.bytes, /UUID/);
  assert.match(descriptions.bytes, /order.*n/i);
  const initial =
    await database.sql`SELECT id, bytes, loaded_at FROM apple_notes.attachments ORDER BY id`;
  assert.deepEqual(
    (
      await database.sql`SELECT id, length(content) AS length, bytes IS NULL AS missing FROM apple_notes.attachments ORDER BY id`
    ).map((row) => ({ ...row })),
    [
      { id: 'empty', length: 0, missing: false },
      { id: 'missing', length: null, missing: true },
      { id: 'note', length: bytes.length, missing: false },
    ],
  );
  const chunks = await database.sql.unsafe<{ bytes: Buffer }[]>(
    `SELECT chunks.bytes FROM ${store.qualifiedName} chunks JOIN apple_notes.attachments a ON a.bytes = chunks.file WHERE a.id = 'note' ORDER BY chunks.n`,
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.bytes.length),
    [PostgresFileStore.chunkSize, 3],
  );
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => chunk.bytes)), bytes);
  const orphanCount = async () =>
    (
      await database.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${store.qualifiedName} chunks WHERE NOT EXISTS (SELECT 1 FROM apple_notes.attachments a WHERE a.bytes = chunks.file)`,
      )
    )[0]?.n;
  assert.equal(await orphanCount(), 0);

  // The cursor guard rejects these replays, including their newly staged files.
  await pipeline.run();
  assert.deepEqual(
    await database.sql`SELECT id, bytes, loaded_at FROM apple_notes.attachments ORDER BY id`,
    initial,
  );
  assert.equal(await orphanCount(), 0);
  assert.equal(
    (
      await database.sql`SELECT count(*)::int AS n FROM apple_notes._elt_checkpoints`
    )[0]?.n,
    1,
  );

  await writeFile(file, 'updated');
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 2 }, file },
    { type: 'DELETE', stream: stream.name, key: { id: 'empty' } },
  ];
  await pipeline.run();
  assert.equal(
    (
      await database.sql`SELECT content FROM apple_notes.attachments WHERE id = 'note'`
    )[0]?.content,
    'updated',
  );
  assert.equal(await orphanCount(), 0);
  assert.equal(
    (
      await database.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${store.qualifiedName}`,
      )
    )[0]?.n,
    1,
  );

  // A failed record discards files already staged by this uncommitted batch.
  source.messages = [
    { stream: stream.name, data: { id: 'note', version: 3 }, file: empty },
    { stream: stream.name, data: { id: 'bad', version: 'invalid' }, file },
  ];
  await assert.rejects(pipeline.run(), PipelineError);
  assert.equal(
    (
      await database.sql`SELECT content FROM apple_notes.attachments WHERE id = 'note'`
    )[0]?.content,
    'updated',
  );
  assert.equal(await orphanCount(), 0);

  await pipeline.clear();
  assert.equal(
    (
      await database.sql.unsafe(
        `SELECT count(*)::int AS n FROM ${store.qualifiedName}`,
      )
    )[0]?.n,
    0,
  );
  assert.equal(
    (
      await database.sql`SELECT count(*)::int AS n FROM apple_notes._elt_checkpoints`
    )[0]?.n,
    0,
  );
});

test('a copy creates its schema and a table typed from the stream schema', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: ['number', 'null'] },
        done: { type: 'boolean' },
        on: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        note: { type: 'string' },
      },
      required: ['id', 'count', 'ratio', 'done', 'on', 'at'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [
    {
      id: 'a',
      count: 9007199254740991,
      ratio: 0.25,
      done: true,
      on: '2024-02-29',
      at: '2025-01-02T03:04:05.006Z',
      note: 'x',
    },
    {
      id: 'b',
      count: -1,
      ratio: null,
      done: false,
      on: '2025-12-31',
      at: '2025-01-02T00:00:00.000Z',
    },
  ]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'Raw Source',
  });

  const [result] = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(stream, destination.table('Items'))],
      }),
    ],
  }).run();

  assert.equal(result?.count, 2);
  assert.deepEqual(
    await database.sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'Raw Source' AND table_name = 'Items' ORDER BY ordinal_position`.then(
      (columns) => columns.map((column) => ({ ...column })),
    ),
    [
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'count', data_type: 'bigint', is_nullable: 'NO' },
      {
        column_name: 'ratio',
        data_type: 'double precision',
        is_nullable: 'YES',
      },
      { column_name: 'done', data_type: 'boolean', is_nullable: 'NO' },
      { column_name: 'on', data_type: 'date', is_nullable: 'NO' },
      {
        column_name: 'at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      { column_name: 'note', data_type: 'text', is_nullable: 'YES' },
      {
        column_name: 'loaded_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
    ],
  );
  assert.deepEqual(
    await database.sql`SELECT id, count::text, ratio, done, "on"::text, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, note, loaded_at = min(loaded_at) OVER () AS one_load FROM "Raw Source"."Items" ORDER BY id`.then(
      (loaded) => loaded.map((row) => ({ ...row })),
    ),
    [
      {
        id: 'a',
        count: '9007199254740991',
        ratio: 0.25,
        done: true,
        on: '2024-02-29',
        at: '2025-01-02T03:04:05.006Z',
        note: 'x',
        one_load: true,
      },
      {
        id: 'b',
        count: '-1',
        ratio: null,
        done: false,
        on: '2025-12-31',
        at: '2025-01-02T00:00:00.000Z',
        note: null,
        one_load: true,
      },
    ],
  );
  const identity = destination.identity(destination.table('Items'));
  assert.doesNotMatch(identity, /postgres:postgres|password/);
  assert.match(identity, /"schema":"Raw Source"/);
});

test('overwrite replaces rows while readers keep seeing the previous load', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const load = (source: Source) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(stream, destination.table('items'))],
        }),
      ],
    }).run();
  const first = new Messages(stream);
  first.messages = rows(stream, [{ id: 'old-1' }, { id: 'old-2' }]);
  await load(first);

  let seenDuringLoad: string[] = [];
  class Slow extends Messages {
    protected override async *extract(configuration: CopyConfiguration) {
      yield* super.extract(configuration);
      const reader = await database.sql.reserve();
      try {
        await reader`SET lock_timeout = '1s'`;
        seenDuringLoad = (
          await reader`SELECT id FROM raw.items ORDER BY id`
        ).map((row) => String(row.id));
      } finally {
        reader.release();
      }
    }
  }
  const second = new Slow(stream);
  second.messages = rows(stream, [{ id: 'new' }]);
  await load(second);

  assert.deepEqual(seenDuringLoad, ['old-1', 'old-2']);
  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.items`).map((row) => row.id),
    ['new'],
  );
});

test('append keeps every load', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'events',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [{ id: 'a' }]);
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(stream, destination.table('events'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });

  await pipeline.run();
  await pipeline.run();

  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.events`).map((row) => row.id),
    ['a', 'a'],
  );
});

test('cursor_newer keeps the greatest cursor by byte order; replace keeps the newest extraction', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'versions',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['id', 'version', 'name'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const checkpoints = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const load = (
    table: string,
    dedupPolicy: 'cursor_newer' | 'replace',
    data: object[],
  ) => {
    const source = new Messages(stream);
    source.messages = rows(stream, data);
    return new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(stream, destination.table(table), {
              id: table,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
              dedupPolicy,
            }),
          ],
        }),
      ],
    }).run();
  };
  const names = async (table: string) =>
    Object.fromEntries(
      (
        await database.sql.unsafe(
          `SELECT id, name FROM raw.${table} ORDER BY id`,
        )
      ).map((row) => [row.id, row.name]),
    );
  // 'B' sorts before 'a' by bytes but after it in most locales.
  const first = [
    { id: 'x', version: 'a', name: 'x-first' },
    { id: 'x', version: 'B', name: 'x-older' },
    { id: 'x', version: 'a', name: 'x-tie' },
    { id: 'y', version: 'a', name: 'y-first' },
  ];

  await load('newer', 'cursor_newer', first);
  await load('newer', 'cursor_newer', [
    { id: 'y', version: 'b', name: 'y-second' },
    { id: 'x', version: 'B', name: 'x-replayed' },
  ]);
  await load('restated', 'replace', first);
  await load('restated', 'replace', [
    { id: 'y', version: 'B', name: 'y-restated' },
  ]);
  const many = Array.from({ length: 2500 }, (_, index) => ({
    id: String(index % 1200),
    version: 'v',
    name: `row-${index}`,
  }));
  await load('many', 'replace', many);

  assert.deepEqual(await names('newer'), { x: 'x-first', y: 'y-second' });
  assert.deepEqual(await names('restated'), {
    x: 'x-tie',
    y: 'y-restated',
  });
  const [comments] = await database.sql`
    SELECT obj_description('raw.newer'::regclass, 'pg_class') AS newer,
      obj_description('raw.restated'::regclass, 'pg_class') AS restated`;
  assert.match(comments?.newer, /Copy key: id/);
  assert.match(
    comments?.newer,
    /greatest version wins; equal cursors retain the first/,
  );
  assert.match(comments?.newer, /Text cursors compare by byte order/);
  assert.match(comments?.restated, /newest extracted record wins/);
  const loaded = await names('many');
  assert.equal(Object.keys(loaded).length, 1200);
  assert.equal(loaded['0'], 'row-2400');
  // 1199 recurs at 2399, one batch later.
  assert.equal(loaded['1199'], 'row-2399');
});

test('deletions remove keyed rows in source order', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', format: 'date' },
        id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['day', 'id', 'name'],
    },
    primaryKey: ['day', 'id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  const source = new Messages(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(stream, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  source.messages = rows(stream, [
    { day: '2026-01-01', id: 1, name: 'one' },
    { day: '2026-01-01', id: 2, name: 'two' },
  ]);
  await pipeline.run();

  source.messages = [
    { stream: 'items', data: { day: '2026-01-01', id: 3, name: 'three' } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-01', id: 3 } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-01', id: 1 } },
    { type: 'DELETE', stream: 'items', key: { day: '2026-01-02', id: 2 } },
  ];
  const [result] = await pipeline.run();

  assert.deepEqual(
    { count: result?.count, deleted: result?.deleted },
    { count: 1, deleted: 3 },
  );
  assert.deepEqual(
    (await database.sql`SELECT name FROM raw.items ORDER BY id`).map(
      (row) => row.name,
    ),
    ['two'],
  );
});

test('a source failure commits nothing: no table, rows or owner', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  class Failing extends Messages {
    protected override async *extract(configuration: CopyConfiguration) {
      yield* super.extract(configuration);
      throw new Error('source broke');
    }
  }
  const source = new Failing(stream);
  source.messages = rows(stream, [{ id: 'a' }]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });

  await assert.rejects(
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(stream, destination.table('items'))],
        }),
      ],
    }).run(),
    /source broke/,
  );

  assert.deepEqual(
    [...(await database.sql`SELECT to_regnamespace('raw') AS schema`)],
    [{ schema: null }],
  );
});

test('a table has one writer, even when another loads only its own partitions', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'records',
    jsonSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        id: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['owner', 'id', 'version'],
    },
    primaryKey: ['owner', 'id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    partitionKey: ['owner'],
  });
  class Owned extends Messages {
    readonly owner: string;
    constructor(owner: string) {
      super(stream, owner);
      this.owner = owner;
      this.messages = rows(stream, [{ owner, id: '1', version: 1 }]);
    }
    protected override partitions() {
      return [{ owner: this.owner }];
    }
  }
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const checkpoints = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const upsert = (id: string, source: Owned) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(stream, destination.table('records'), {
              id,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
              cursorField: 'version',
            }),
          ],
        }),
      ],
    }).run();
  const other = new Owned('b');
  const late = new Owned('c');

  await upsert('a', new Owned('a'));
  await upsert('a', new Owned('a'));
  await assert.rejects(
    upsert('b', other),
    /Target records is written by \{"copy":"a"\}; \{"copy":"b"\} cannot write it/,
  );
  await assert.rejects(
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source: late,
          destination,
          steps: [new Copy(stream, destination.table('records'))],
        }),
      ],
    }).run(),
    /\{"source":"c","stream":"records"\} cannot write it/,
  );

  assert.equal(other.extracted + late.extracted, 0);
  assert.deepEqual(
    (await database.sql`SELECT owner FROM raw.records ORDER BY owner`).map(
      (row) => row.owner,
    ),
    ['a'],
  );
  await database.sql`DROP TABLE raw.records`;
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: late,
        destination,
        steps: [new Copy(stream, destination.table('records'))],
      }),
    ],
  }).run();
  assert.equal(late.extracted, 1);
});

test('a key column stored as another type rebuilds the table, and a changed key rebuilds the index', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['id', 'kind', 'version'],
    },
    supportedSyncModes: ['full_refresh'],
  });
  const source = new Messages(stream);
  source.messages = rows(stream, [
    { id: '1', kind: 'a', version: 1 },
    { id: '1', kind: 'b', version: 1 },
  ]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const dedup = (primaryKey: string[]) =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [
            new Copy(stream, destination.table('items'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite_dedup',
              cursorField: 'version',
              primaryKey,
            }),
          ],
        }),
      ],
    }).run();
  const indexes = async () =>
    (
      await database.sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'raw' AND tablename = 'items' AND indexname LIKE '\_elt\_dedup\_%'`
    ).map((row) => String(row.indexdef).replace(/^.* USING btree /, ''));

  await dedup(['id', 'kind']);
  assert.deepEqual(await indexes(), ['(id, kind)']);
  await dedup(['id']);
  assert.deepEqual(await indexes(), ['(id)']);

  await database.sql`DROP TABLE raw.items`;
  await database.sql`CREATE TABLE raw.items (id bigint, kind text, version bigint, loaded_at timestamptz NOT NULL)`;
  await dedup(['id']);
  assert.deepEqual(
    await database.sql`SELECT data_type FROM information_schema.columns WHERE table_schema = 'raw' AND table_name = 'items' AND column_name = 'id'`.then(
      (columns) => columns.map((column) => column.data_type),
    ),
    ['text'],
  );
  assert.deepEqual(await indexes(), ['(id)']);
});

test('declarations are checked before any connection', () => {
  const url = 'postgres://u:p@127.0.0.1:1/db';
  assert.throws(
    () => new PostgresDestination({ url: 'mysql://x/y', schema: 'raw' }),
    /postgres:\/\/ connection URL/,
  );
  assert.throws(
    () => new PostgresDestination({ url, schema: 'pg_raw' }),
    /reserved/,
  );
  const destination = new PostgresDestination({ url, schema: 'raw' });
  assert.throws(() => destination.table('_ELT_writers'), /reserved/);
  assert.throws(() => destination.table('x'.repeat(64)), /Invalid table name/);
  assert.throws(
    () => destination.table('items', (columns) => [columns.text('loaded_at')]),
    /reserved/,
  );
  assert.doesNotMatch(JSON.stringify(destination), /u:p/);
});

// One copy's checkpoint binding, as a run of that copy alone passes it.
const only = (id: string, copy: object = {}, shape: object = {}) =>
  new Map([[id, { copy, shape }]]);

test('a Postgres checkpoint store resumes from the last acknowledged state in the schema', async () => {
  await using database = await scratchDatabase(server);
  const store = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const bindings = only('copy', { source: 'test', target: 'records' });
  const received: unknown[] = [];
  const run = (states: unknown[], fail = false) =>
    store.run(bindings, async (checkpoints) => {
      const state = checkpoints.state('copy');
      received.push(structuredClone(state));
      if (state !== null && typeof state === 'object')
        Reflect.set(state, 'mutated', true);
      for (const next of states) await checkpoints.save('copy', next, false);
      if (fail) throw new Error('source broke');
    });

  await run([{ page: 1 }, { page: 2 }]);
  await run([]);
  // What was acknowledged before a failure stays saved.
  await assert.rejects(run([{ page: 3 }], true), /source broke/);
  await run([]);

  assert.deepEqual(received, [null, { page: 2 }, { page: 2 }, { page: 3 }]);
  assert.deepEqual(
    [
      ...(await database.sql`SELECT id, state::text FROM raw._elt_checkpoints`),
    ].map((row) => ({ ...row })),
    [{ id: 'copy', state: '{"state":{"page":3},"reloading":false}' }],
  );
});

test('a changed binding is refused until the Postgres checkpoint is reset', async () => {
  await using database = await scratchDatabase(server);
  const store = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const save = (target: string) =>
    store.run(only('copy', { target }), async (checkpoints) =>
      checkpoints.save('copy', { from: checkpoints.state('copy') }, false),
    );

  await save('a');
  await assert.rejects(
    save('b'),
    /Checkpoint binding changed for copy; reset it or use a new copy ID/,
  );
  await store.reset('copy');
  const resumed = await store.run(only('copy', { target: 'b' }), async (c) =>
    c.state('copy'),
  );

  assert.equal(resumed, null);
});

test('a checkpoint that cannot be saved after its rows commit is reported with the committed rows', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const source = new Messages(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(stream, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  source.messages = rows(stream, [{ id: 1 }]);
  await pipeline.run();
  await database.sql.unsafe(`
    CREATE FUNCTION raw.refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$;
    CREATE TRIGGER refuse BEFORE INSERT OR UPDATE ON raw._elt_checkpoints FOR EACH ROW EXECUTE FUNCTION raw.refuse();
  `);
  source.messages = rows(stream, [{ id: 2 }, { id: 3 }]);

  const failure = await pipeline.run().then(
    () => assert.fail('run should report the unsaved checkpoint'),
    (error: unknown) => error,
  );

  assert.ok(failure instanceof PipelineError, String(failure));
  assert.equal(failure.results[0]?.count, 2);
  assert.match(
    String(failure.cause),
    /was not saved after the destination committed/,
  );
  assert.ok(failure.cause instanceof Error);
  assert.match(String(failure.cause.cause), /disk full/);
  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.items ORDER BY id`).map(
      (row) => row.id,
    ),
    ['1', '2', '3'],
  );
});

test('a copy commits at each checkpoint, its rows share one loaded_at, and no checkpoint transaction idles meanwhile', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  const { promise: held, resolve: holding } = Promise.withResolvers<void>();
  class Paused extends Messages {
    protected override async *extract() {
      yield { stream: 'items', data: { id: 1 } };
      yield { type: 'STATE' as const, stream: 'items', state: { page: 1 } };
      holding();
      await hold;
      yield { stream: 'items', data: { id: 2 } };
      yield { type: 'STATE' as const, stream: 'items', state: { page: 2 } };
    }
  }
  const source = new Paused(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const running = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(stream, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  }).run();

  await held;
  // The first checkpoint's rows and state are already visible mid-load.
  const midway = {
    rows: (await database.sql`SELECT id FROM raw.items`).map((row) => row.id),
    state: (
      await database.sql`SELECT state::text FROM raw._elt_checkpoints`
    ).map((row) => row.state),
    checkpoints: (
      await database.sql`SELECT state FROM pg_stat_activity WHERE application_name = 'elt-checkpoints' AND datname = current_database()`
    ).map((row) => row.state),
  };
  release();
  await running;

  assert.deepEqual(midway, {
    rows: ['1'],
    state: ['{"state":{"page":1},"reloading":false}'],
    checkpoints: ['idle'],
  });
  assert.deepEqual(
    (
      await database.sql`SELECT count(DISTINCT loaded_at)::int AS n, count(*)::int AS rows FROM raw.items`
    ).map((row) => ({ ...row })),
    [{ n: 1, rows: 2 }],
  );
});

test('replications checkpoint in parallel, and one already running is refused', async () => {
  await using database = await scratchDatabase(server);
  const store = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const { promise: bothStarted, resolve: release } =
    Promise.withResolvers<void>();
  let started = 0;
  const waiting = (id: string) =>
    store.run(only(id), async (checkpoints) => {
      if (++started === 2) release();
      await bothStarted;
      await checkpoints.save(id, { done: true }, false);
    });

  // Both runs wait until the other has started, so both locks are held at once.
  await Promise.all([waiting('a'), waiting('b')]);
  const { promise: hold, resolve: finish } = Promise.withResolvers<void>();
  const running = store.run(only('b'), async () => {
    await hold;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A run of a and b fails on b and releases a, which a later run can take.
  await assert.rejects(
    store.run(
      new Map([
        ['a', { copy: {}, shape: {} }],
        ['b', { copy: {}, shape: {} }],
      ]),
      async () => {},
    ),
    /Checkpoint b is in use by another run/,
  );
  await store.run(only('a'), async () => {});
  finish();
  await running;
});

test('checkpoint state keeps text JSONB would refuse, and the store holds no credentials', async () => {
  await using database = await scratchDatabase(server);
  const store = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const state = { nul: 'a\u0000b', lone: '\ud800' };

  await store.run(only('copy'), (checkpoints) =>
    checkpoints.save('copy', state, false),
  );
  const resumed = await store.run(only('copy'), async (checkpoints) =>
    checkpoints.state('copy'),
  );

  assert.deepEqual(resumed, state);
  assert.doesNotMatch(JSON.stringify(store), /postgres:postgres/);
  assert.throws(
    () => new PostgresCheckpointStore({ url: 'mysql://x/y', schema: 'raw' }),
    /postgres:\/\/ connection URL/,
  );
  assert.throws(
    () => new PostgresCheckpointStore({ url: database.url, schema: 'pg_raw' }),
    /reserved/,
  );
});

test('clear empties a table and keeps views on it, releasing its owner and checkpoint; a table dropped by hand reloads from no checkpoint', async () => {
  await using database = await scratchDatabase(server);
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
  });
  const received: unknown[] = [];
  class Recording extends Messages {
    protected override async *extract(
      configuration: CopyConfiguration,
      state?: unknown,
    ) {
      received.push(state);
      yield* super.extract(configuration);
    }
  }
  const source = new Recording(stream);
  source.messages = rows(stream, [{ id: 1 }]);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(stream, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const control = async () => ({
    rows: (await database.sql`SELECT count(*)::int AS n FROM raw.items`).map(
      (row) => row.n,
    ),
    owners: (await database.sql`SELECT target FROM raw._elt_writers`).map(
      (row) => row.target,
    ),
    checkpoints: (await database.sql`SELECT id FROM raw._elt_checkpoints`).map(
      (row) => row.id,
    ),
  });
  await pipeline.run();
  await database.sql`CREATE VIEW raw.items_view AS SELECT id FROM raw.items`;

  await pipeline.clear();
  assert.deepEqual(await control(), { rows: [0], owners: [], checkpoints: [] });
  await pipeline.run();
  assert.deepEqual(await control(), {
    rows: [1],
    owners: ['items'],
    checkpoints: ['items'],
  });
  assert.deepEqual(
    (await database.sql`SELECT id FROM raw.items_view`).map((row) => row.id),
    ['1'],
  );

  await database.sql`DROP VIEW raw.items_view`;
  await database.sql`DROP TABLE raw.items`;
  received.length = 0;
  await pipeline.run();

  assert.deepEqual(received, [null]);
  assert.deepEqual(await control(), {
    rows: [1],
    owners: ['items'],
    checkpoints: ['items'],
  });
});

// A stream of { id, version } rows keyed by id, deletable.
const scripted = (name: string, { snapshot = true } = {}) =>
  new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: snapshot ? true : undefined,
    emitsDeletes: true,
  });

// One entry of a script: a message to emit, an Error to throw there, or a
// step to run (and await) once the consumer took the entry before it.
type Scripted = SourceMessage | Error | (() => unknown);

// Reads what a test scripts for each stream, up to concurrency streams at once.
class ScriptedSource extends Source {
  override coverage() {
    return { description: 'test', selection: {} };
  }

  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  protected override readonly concurrency: number;
  scripts: Record<string, readonly Scripted[]>;

  constructor(
    streams: readonly Stream[],
    scripts: Record<string, readonly Scripted[]>,
    { concurrency = 1 } = {},
  ) {
    super();
    this.catalog = new Catalog(streams);
    this.scripts = scripts;
    this.concurrency = concurrency;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
    _partition: Partition | null,
  ): AsyncGenerator<SourceMessage> {
    yield* this.play(configuration.stream.name);
  }

  protected async *play(script: string) {
    for (const entry of this.scripts[script] ?? []) {
      if (entry instanceof Error) throw entry;
      if (typeof entry === 'function') await entry();
      else yield entry;
    }
  }
}

const record = (stream: string, id: string, version: number) => ({
  stream,
  data: { id, version },
});
const checkpoint = (stream: string, state: unknown) => ({
  type: 'STATE' as const,
  stream,
  state,
});
const removal = (stream: string, id: string) => ({
  type: 'DELETE' as const,
  stream,
  key: { id },
});
// More records than one flush holds, so some already sit in the stage table.
const flushed = (stream: string, prefix: string) =>
  Array.from({ length: 1500 }, (_, index) =>
    record(stream, `${prefix}${index}`, 1),
  );

const incremental = (id: string) =>
  ({
    id,
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  }) as const;

const loaded = async (database: { sql: postgres.Sql }, table: string) =>
  (
    await database.sql.unsafe(
      `SELECT id, version::int FROM raw.${table} ORDER BY id COLLATE "C"`,
    )
  ).map(({ id, version }) => `${id}:${version}`);

const savedStates = async (database: { sql: postgres.Sql }) =>
  (
    await database.sql`SELECT id, state::text FROM raw._elt_checkpoints ORDER BY id`
  ).map(({ id, state }) => `${id}=${state}`);

test('a stream that fails publishes none of its staged rows while its sibling commits, and a failing overwrite keeps the old table', async () => {
  await using database = await scratchDatabase(server);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const broken = scripted('broken');
  const good = scripted('good');
  const snapshot = scripted('snapshot');
  const source = new ScriptedSource([broken, good, snapshot], {
    snapshot: [record('snapshot', 'old', 1)],
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(broken, destination.table('broken'), incremental('broken')),
          new Copy(good, destination.table('good'), incremental('good')),
          new Copy(snapshot, destination.table('snapshot')),
        ],
      }),
    ],
  });
  await pipeline.run();

  source.scripts = {
    broken: [...flushed('broken', 'b'), new Error('broken upstream')],
    good: [record('good', 'g1', 1), checkpoint('good', { page: 1 })],
    snapshot: [...flushed('snapshot', 'new'), new Error('snapshot upstream')],
  };
  const error = await pipeline.run().then(
    () => assert.fail('the broken streams should fail the run'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.length,
    ]),
    [
      ['broken', 0, 1],
      ['good', 1, 0],
      ['snapshot', 0, 1],
    ],
  );
  assert.deepEqual(await loaded(database, 'broken'), []);
  assert.deepEqual(await loaded(database, 'good'), ['g1:1']);
  assert.deepEqual(await loaded(database, 'snapshot'), ['old:1']);
  assert.deepEqual(await savedStates(database), [
    'good={"state":{"page":1},"reloading":false}',
  ]);
});

test("a failing partition's flushed rows are discarded while the next partition commits", async () => {
  await using database = await scratchDatabase(server);
  const pages = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        id: { type: 'string' },
        version: { type: 'integer' },
      },
      required: ['site', 'id', 'version'],
    },
    primaryKey: ['site', 'id'],
    partitionKey: ['site'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  class Sites extends ScriptedSource {
    override coverage() {
      return {
        description: 'Configured properties a and b.',
        selection: { sites: ['a', 'b'] },
      };
    }
    protected override partitions() {
      return [{ site: 'a' }, { site: 'b' }];
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      yield* this.play(`${configuration.stream.name}/${partition?.site}`);
    }
  }
  const page = (site: string, id: string) => ({
    stream: 'pages',
    data: { site, id, version: 1 },
  });
  const source = new Sites([pages], {
    'pages/a': [
      ...Array.from({ length: 1500 }, (_, index) => page('a', String(index))),
      new Error('scan of a broke'),
    ],
    'pages/b': [page('b', '1'), checkpoint('pages', { page: 1 })],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });

  const error = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(pages, destination.table('pages'), {
            id: 'pages',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  })
    .run()
    .then(
      () => assert.fail('partition a should fail the run'),
      (error: unknown) => error,
    );

  assert.ok(error instanceof PipelineError, String(error));
  const [result] = error.results;
  assert.equal(result?.count, 1);
  assert.deepEqual(
    result?.failures.map(({ partition }) => partition),
    [{ site: 'a' }],
  );
  assert.deepEqual(
    (await database.sql`SELECT site, id FROM raw.pages`).map(
      ({ site, id }) => `${site}/${id}`,
    ),
    ['b/1'],
  );
  assert.deepEqual(await savedStates(database), [
    'pages={"state":{"partitions":[{"partition":{"site":"b"},"state":{"page":1}}]},"reloading":false}',
  ]);
});

test('a staged unit merges like its operations applied one at a time, under replace and cursor_newer', async () => {
  await using database = await scratchDatabase(server);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const script = (stream: string) => [
    record(stream, 'a', 1),
    removal(stream, 'a'),
    record(stream, 'a', 2),
    record(stream, 'b', 1),
    removal(stream, 'b'),
    record(stream, 'c', 5),
    record(stream, 'c', 3),
    record(stream, 'd', 4),
    record(stream, 'd', 4),
    checkpoint(stream, { page: 1 }),
  ];
  const replacing = scripted('replacing');
  // cursor_newer needs a cursor the copy selects, not a source-defined one.
  const guarded = scripted('guarded', { snapshot: false });
  const source = new ScriptedSource([replacing, guarded], {
    replacing: script('replacing'),
    guarded: script('guarded'),
  });

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(
            replacing,
            destination.table('replacing'),
            incremental('replacing'),
          ),
          new Copy(guarded, destination.table('guarded'), {
            ...incremental('guarded'),
            cursorField: 'version',
            dedupPolicy: 'cursor_newer',
          }),
        ],
      }),
    ],
  }).run();

  // Sequentially: a is deleted then reloaded at 2; b ends deleted; replace
  // keeps each key's last record, cursor_newer its greatest cursor.
  assert.deepEqual(await loaded(database, 'replacing'), ['a:2', 'c:3', 'd:4']);
  assert.deepEqual(await loaded(database, 'guarded'), ['a:2', 'c:5', 'd:4']);
});

test('a checkpoint lost between commit and save replays to the same rows', async () => {
  await using database = await scratchDatabase(server);
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class Snapshots extends ScriptedSource {
    rows: Record<string, unknown>[] = [];
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffSnapshot(configuration.stream, this.rows, state);
    }
  }
  const source = new Snapshots([items], {});
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(items, destination.table('items'), incremental('items')),
        ],
      }),
    ],
  });
  const names = async () =>
    (await database.sql`SELECT id, name FROM raw.items ORDER BY id`).map(
      ({ id, name }) => `${id}:${name}`,
    );
  source.rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  await pipeline.run();
  const [first] =
    await database.sql`SELECT state::text FROM raw._elt_checkpoints`;
  source.rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B2' },
    { id: 'd', name: 'D' },
  ];
  await pipeline.run();
  const settled = { rows: await names(), states: await savedStates(database) };

  // The second run's rows committed but its checkpoint was never saved.
  await database.sql`UPDATE raw._elt_checkpoints SET state = ${first?.state}::text::json`;
  const [replay] = await pipeline.run();

  assert.deepEqual(settled.rows, ['a:A', 'b:B2', 'd:D']);
  assert.deepEqual([replay?.count, replay?.deleted], [2, 1]);
  assert.deepEqual(
    { rows: await names(), states: await savedStates(database) },
    settled,
  );
});

test('array fields load as native arrays of their item type, in order, and an unchanged snapshot writes nothing', async () => {
  await using database = await scratchDatabase(server);
  const lists = new Stream({
    name: 'lists',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        counts: { type: 'array', items: { type: 'integer' } },
        words: { type: ['array', 'null'], items: { type: 'string' } },
        ratios: { type: 'array', items: { type: 'number' } },
        flags: { type: 'array', items: { type: 'boolean' } },
        days: { type: 'array', items: { type: 'string', format: 'date' } },
        times: {
          type: 'array',
          items: { type: 'string', format: 'date-time' },
        },
      },
      required: ['id', 'counts', 'words', 'ratios', 'flags', 'days', 'times'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class Snapshots extends ScriptedSource {
    rows: Record<string, unknown>[] = [];
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      yield* diffSnapshot(configuration.stream, this.rows, state);
    }
  }
  const source = new Snapshots([lists], {});
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(lists, destination.table('lists'), incremental('lists')),
        ],
      }),
    ],
  });
  const a = {
    id: 'a',
    counts: [3, 1, 9007199254740991],
    words: ['b', 'a', 'b'],
    ratios: [0.5, -2],
    flags: [true, false],
    days: ['0000-03-01', '2024-02-29'],
    times: ['2025-01-02T03:04:05.006Z'],
  };
  const b = {
    id: 'b',
    counts: [],
    words: null,
    ratios: [],
    flags: [],
    days: [],
    times: [],
  };
  source.rows = [a, b];

  const [first] = await pipeline.run();
  const [unchanged] = await pipeline.run();
  source.rows = [{ ...a, counts: [3, 1] }, b];
  const [changed] = await pipeline.run();

  assert.deepEqual([first?.count, unchanged?.count, changed?.count], [2, 0, 1]);
  assert.deepEqual(
    (
      await database.sql`SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = 'raw' AND table_name = 'lists' AND data_type = 'ARRAY' ORDER BY ordinal_position`
    ).map((column) => ({ ...column })),
    [
      {
        column_name: 'counts',
        data_type: 'ARRAY',
        udt_name: '_int8',
        is_nullable: 'NO',
      },
      {
        column_name: 'words',
        data_type: 'ARRAY',
        udt_name: '_text',
        is_nullable: 'YES',
      },
      {
        column_name: 'ratios',
        data_type: 'ARRAY',
        udt_name: '_float8',
        is_nullable: 'NO',
      },
      {
        column_name: 'flags',
        data_type: 'ARRAY',
        udt_name: '_bool',
        is_nullable: 'NO',
      },
      {
        column_name: 'days',
        data_type: 'ARRAY',
        udt_name: '_date',
        is_nullable: 'NO',
      },
      {
        column_name: 'times',
        data_type: 'ARRAY',
        udt_name: '_timestamptz',
        is_nullable: 'NO',
      },
    ],
  );
  assert.deepEqual(
    (
      await database.sql`SELECT id, counts::text, words::text, ratios::text, flags::text,
        days[1] = DATE '0001-03-01 BC' AS year_zero, days[2]::text AS leap_day,
        times[1] = TIMESTAMPTZ '2025-01-02T03:04:05.006Z' AS instant,
        cardinality(times) AS times
        FROM raw.lists ORDER BY id`
    ).map((row) => ({ ...row })),
    [
      {
        id: 'a',
        counts: '{3,1}',
        words: '{b,a,b}',
        ratios: '{0.5,-2}',
        flags: '{t,f}',
        year_zero: true,
        leap_day: '2024-02-29',
        instant: true,
        times: 1,
      },
      {
        id: 'b',
        counts: '{}',
        words: null,
        ratios: '{}',
        flags: '{}',
        year_zero: null,
        leap_day: null,
        instant: null,
        times: 0,
      },
    ],
  );
});

test("a statement that fails in one stream's merge does not erase a sibling's stage", async () => {
  await using database = await scratchDatabase(server);
  const staged = scripted('staged');
  const dated = new Stream({
    name: 'dated',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        on: { type: 'string', format: 'date' },
      },
      required: ['id', 'on'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  const source = new ScriptedSource(
    [staged, dated],
    {
      staged: [checkpoint('staged', { page: 0 })],
      dated: [
        { stream: 'dated', data: { id: 'a', on: '2026-01-01' } },
        checkpoint('dated', { page: 0 }),
      ],
    },
    { concurrency: 2 },
  );
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(staged, destination.table('staged'), incremental('staged')),
          new Copy(dated, destination.table('dated'), incremental('dated')),
        ],
      }),
    ],
  });
  await pipeline.run();
  // A constraint someone added to the table stays authoritative.
  await database.sql.unsafe(
    `ALTER TABLE raw.dated ADD CONSTRAINT recent CHECK ("on" >= '2000-01-01')`,
  );
  const { promise: stagedRows, resolve: rowsStaged } =
    Promise.withResolvers<void>();
  const { promise: datedFailed, resolve: failDated } =
    Promise.withResolvers<void>();
  const { promise: stagedCommitted, resolve: commitStaged } =
    Promise.withResolvers<void>();
  // staged flushes 1000 rows into its stage; dated's merge then breaks the
  // constraint; only then does staged reach its checkpoint.
  source.scripts = {
    staged: [
      ...flushed('staged', 's'),
      () => {
        rowsStaged();
        return datedFailed;
      },
      checkpoint('staged', { page: 1 }),
      commitStaged,
    ],
    dated: [
      () => stagedRows,
      { stream: 'dated', data: { id: 'b', on: '1999-12-31' } },
      checkpoint('dated', { page: 1 }),
      () => {
        failDated();
        return stagedCommitted;
      },
    ],
  };

  const error = await pipeline.run().then(
    () => assert.fail('dated should fail the run'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.equal((await loaded(database, 'staged')).length, 1500);
  assert.deepEqual(
    [...(await database.sql`SELECT id FROM raw.dated`)],
    [{ id: 'a' }],
  );
  assert.deepEqual(await savedStates(database), [
    'dated={"state":{"page":0},"reloading":false}',
    'staged={"state":{"page":1},"reloading":false}',
  ]);
  assert.match(
    String(error.results[1]?.failures[0]?.error),
    /violates check constraint "recent"/,
  );
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.length,
    ]),
    [
      ['staged', 1500, 0],
      ['dated', 0, 1],
    ],
  );
});

test('year 0000, which ISO counts astronomically, loads as 1 BC, and year 0001 stays AD', async () => {
  await using database = await scratchDatabase(server);
  const moments = new Stream({
    name: 'moments',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        on: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'on', 'at'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  const source = new ScriptedSource([moments], {
    moments: [
      {
        stream: 'moments',
        data: { id: 'leap', on: '0000-02-29', at: '0000-06-01T12:00:00.000Z' },
      },
      {
        stream: 'moments',
        data: { id: 'first', on: '0001-01-01', at: '0001-01-01T00:00:00.000Z' },
      },
    ],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(moments, destination.table('moments'))],
      }),
    ],
  }).run();

  assert.deepEqual(
    [
      ...(await database.sql`
        SELECT id,
          "on" = '0001-02-29 BC'::date AS "onBC",
          "at" = '0001-06-01 12:00:00+00 BC'::timestamptz AS "atBC",
          "on" - 1 = '0001-12-31 BC'::date AS "dayBefore"
        FROM raw.moments ORDER BY id`),
    ],
    [
      { id: 'first', onBC: false, atBC: false, dayBefore: true },
      { id: 'leap', onBC: true, atBC: true, dayBefore: false },
    ],
  );
});

test('warehouse sync history distinguishes unchanged success, partial commits, failures and unfinished passes', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  let window = {
    startAt: '2020-01-01T00:00:00.000Z',
    endAt: '2021-01-01T00:00:00.000Z',
  };
  class Windowed extends ScriptedSource {
    override coverage() {
      return {
        description: 'Requested UTC [startAt, endAt).',
        selection: window,
      };
    }
  }
  const good = scripted('good');
  const bad = scripted('bad');
  const source = new Windowed([good, bad], {
    good: [record('good', 'g1', 1), checkpoint('good', {})],
    bad: [checkpoint('bad', {})],
  });
  const history = new PostgresSyncHistory({ url: database.url });
  await history.install();
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [good, bad].map(
          (stream) =>
            new Copy(
              stream,
              destination.table(stream.name),
              incremental(stream.name),
            ),
        ),
      }),
    ],
  });
  const run = () => pipeline.run();
  const status = async () => {
    const [row] = await sql`SELECT * FROM marts.sync_status`;
    assert.ok(row);
    return row;
  };
  await run();
  const first = await status();
  const [original] = await sql`SELECT loaded_at::text FROM raw.good`;
  assert.equal(first.status, 'succeeded');
  assert.equal(first.latest_attempt_id, first.last_successful_attempt_id);
  const [empty] =
    await sql`SELECT status, written_count::int, selection, target_exists FROM marts.extraction_coverage WHERE stream = 'bad'`;
  assert.deepEqual(
    { ...empty },
    {
      status: 'succeeded',
      written_count: 0,
      selection: window,
      target_exists: true,
    },
  );

  source.scripts = {
    good: [checkpoint('good', {})],
    bad: [checkpoint('bad', {})],
  };
  const unchanged = await run();
  assert.ok(
    unchanged.every(({ count, deleted }) => count === 0 && deleted === 0),
  );
  const second = await status();
  assert.notEqual(
    second.last_successful_attempt_id,
    first.last_successful_attempt_id,
  );
  assert.ok(second.last_successful_sync_at > first.last_successful_sync_at);
  assert.deepEqual(
    [...(await sql`SELECT loaded_at::text FROM raw.good`)],
    [original],
  );

  window = { ...window, endAt: '2022-01-01T00:00:00.000Z' };
  source.scripts = {
    good: [checkpoint('good', {})],
    bad: [
      record('bad', 'committed', 1),
      checkpoint('bad', {}),
      record('bad', 'discarded', 1),
      new Error('lost page'),
    ],
  };
  await assert.rejects(run, PipelineError);
  const partial = await status();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.last_successful_attempt_id, second.latest_attempt_id);
  assert.deepEqual(await loaded(database, 'bad'), ['committed:1']);
  const [copy] =
    await sql`SELECT status, written_count::int, deleted_count::int, failures, selection
    FROM marts.extraction_coverage WHERE attempt_id = ${partial.latest_attempt_id} AND stream = 'bad'`;
  assert.deepEqual(
    { ...copy },
    {
      status: 'partial',
      written_count: 1,
      deleted_count: 0,
      failures: [{ partition: null, error: 'lost page' }],
      selection: window,
    },
  );
  const [prior] = await sql`SELECT selection FROM marts.extraction_coverage
    WHERE attempt_id = ${second.latest_attempt_id} AND stream = 'bad'`;
  assert.equal(prior?.selection.endAt, '2021-01-01T00:00:00.000Z');

  source.scripts = {
    good: [new Error('offline')],
    bad: [new Error('offline')],
  };
  await assert.rejects(run, PipelineError);
  assert.equal((await status()).status, 'failed');
  assert.equal(
    (await status()).last_successful_attempt_id,
    second.latest_attempt_id,
  );

  // Read the durable running declaration from inside the public extraction flow.
  source.scripts = {
    good: [
      async () => {
        const running = await status();
        assert.equal(running.status, 'running');
        assert.equal(running.completed_at, null);
        assert.equal(
          running.last_successful_attempt_id,
          second.latest_attempt_id,
        );
        const pending =
          await sql`SELECT status, written_count FROM marts.extraction_coverage WHERE attempt_id = ${running.latest_attempt_id}`;
        assert.ok(
          pending.every(
            (row) => row.status === 'running' && row.written_count === null,
          ),
        );
      },
      checkpoint('good', {}),
    ],
    bad: [checkpoint('bad', {})],
  };
  await run();
  assert.equal((await status()).status, 'succeeded');
  // A new process installs the history again and keeps what was recorded.
  source.scripts = {
    good: [checkpoint('good', {})],
    bad: [checkpoint('bad', {})],
  };
  const restarted = new PostgresSyncHistory({ url: database.url });
  await restarted.install();
  await new Pipeline({
    history: restarted,
    connections: pipeline.connections,
  }).run();
  assert.equal(
    (await sql`SELECT count(*)::int AS n FROM marts.sync_attempts`)[0]?.n,
    6,
  );
});

test('warehouse records failed partitions and validation errors without fabricating success', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  const stream = new Stream({
    name: 'pages',
    jsonSchema: {
      type: 'object',
      properties: { site: { type: 'string' }, id: { type: 'string' } },
      required: ['site', 'id'],
    },
    primaryKey: ['site', 'id'],
    partitionKey: ['site'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  class Sites extends ScriptedSource {
    override coverage() {
      return {
        description: 'Configured properties a and b.',
        selection: { sites: ['a', 'b'] },
      };
    }
    protected override partitions() {
      return [{ site: 'a' }, { site: 'b' }];
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      yield* this.play(String(partition?.site));
    }
  }
  const source = new Sites([stream], {
    a: [
      { stream: 'pages', data: { site: 'a', id: '1' } },
      checkpoint('pages', {}),
    ],
    b: [new Error('property denied')],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const copy = new Copy(stream, destination.table('pages'), {
    id: 'pages',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const history = new PostgresSyncHistory({ url: database.url });
  await history.install();
  const connection = { name: 'sites', source, destination, steps: [copy] };
  await assert.rejects(
    new Pipeline({
      history,
      connections: [
        new Connection({
          ...connection,
          checkpoints: new PostgresCheckpointStore({
            url: database.url,
            schema: 'raw',
          }),
        }),
      ],
    }).run(),
    PipelineError,
  );
  const [partial] =
    await sql`SELECT status, written_count::int, failures, selection FROM marts.extraction_coverage`;
  assert.deepEqual(
    { ...partial },
    {
      status: 'partial',
      written_count: 1,
      failures: [{ partition: { site: 'b' }, error: 'property denied' }],
      selection: { sites: ['a', 'b'] },
    },
  );
  assert.equal(
    (await sql`SELECT last_successful_sync_at FROM marts.sync_status`)[0]
      ?.last_successful_sync_at,
    null,
  );

  await assert.rejects(
    new Pipeline({ history, connections: [new Connection(connection)] }).run(),
    /checkpoint store/,
  );
  const [invalid] =
    await sql`SELECT c.status, c.written_count, c.failures FROM marts.extraction_coverage c JOIN marts.sync_status s ON s.latest_attempt_id = c.attempt_id`;
  assert.equal(invalid?.status, 'failed');
  assert.equal(invalid?.written_count, null);
  assert.match(invalid?.failures[0].error, /checkpoint store/);
});

test('one pipeline loads each connection into its own schema, and a failing connection leaves the other recorded as succeeded', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  const connection = (
    schema: string,
    scripts: Record<string, readonly Scripted[]>,
  ) => {
    const items = scripted('items');
    const destination = new PostgresDestination({ url: database.url, schema });
    return new Connection({
      name: schema,
      source: new ScriptedSource([items], scripts),
      destination,
      checkpoints: new PostgresCheckpointStore({ url: database.url, schema }),
      steps: [
        new Copy(
          items,
          destination.table('items'),
          incremental(`${schema}:items`),
        ),
      ],
    });
  };
  const history = new PostgresSyncHistory({ url: database.url });
  await history.install();
  const pipeline = new Pipeline({
    history,
    connections: [
      connection('notes', {
        items: [record('items', 'n1', 1), checkpoint('items', {})],
      }),
      connection('mail', { items: [new Error('mail denied')] }),
    ],
  });

  await assert.rejects(pipeline.run(), PipelineError);

  assert.deepEqual(
    [...(await sql`SELECT id FROM notes.items`)],
    [{ id: 'n1' }],
  );
  assert.deepEqual(
    [
      ...(await sql`SELECT connector, status FROM marts.sync_status ORDER BY connector`),
    ],
    [
      { connector: 'mail', status: 'failed' },
      { connector: 'notes', status: 'succeeded' },
    ],
  );
  assert.deepEqual(
    [
      ...(await sql`SELECT a.connector, c.target_schema, c.status FROM marts.extraction_coverage c
        JOIN marts.sync_attempts a ON a.attempt_id = c.attempt_id ORDER BY a.connector`),
    ],
    [
      { connector: 'mail', target_schema: 'mail', status: 'failed' },
      { connector: 'notes', target_schema: 'notes', status: 'succeeded' },
    ],
  );
});

test('each watch pass is recorded under its own connection when it completes', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  class Twice extends ScriptedSource {
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
      yield streams;
    }
  }
  const connection = (schema: string) => {
    const items = scripted('items');
    const destination = new PostgresDestination({ url: database.url, schema });
    return new Connection({
      name: schema,
      source: new Twice([items], {
        items: [record('items', schema, 1), checkpoint('items', {})],
      }),
      destination,
      checkpoints: new PostgresCheckpointStore({ url: database.url, schema }),
      steps: [
        new Copy(
          items,
          destination.table('items'),
          incremental(`${schema}:items`),
        ),
      ],
    });
  };
  const history = new PostgresSyncHistory({ url: database.url });
  await history.install();
  const pipeline = new Pipeline({
    history,
    connections: [connection('notes'), connection('mail')],
  });
  const passes: string[] = [];

  for await (const { connection } of pipeline.watch({
    signal: AbortSignal.timeout(10_000),
  }))
    passes.push(connection.name);

  assert.deepEqual(passes.toSorted(), ['mail', 'mail', 'notes', 'notes']);
  const attempts = await sql`SELECT connector, status FROM marts.sync_attempts`;
  assert.deepEqual(
    attempts
      .map(({ connector, status }) => `${connector}:${status}`)
      .toSorted(),
    ['mail:succeeded', 'mail:succeeded', 'notes:succeeded', 'notes:succeeded'],
  );
  // Each pass closes its own attempt when it finishes, not when the watch
  // ends: a connection's earlier attempt is closed before its next one opens.
  // The two connections run at once, so their timestamps may tie.
  const overlapping = await sql`
    SELECT earlier.connector FROM marts.sync_attempts earlier
    JOIN marts.sync_attempts later ON later.connector = earlier.connector
      AND later.attempt_id > earlier.attempt_id
    WHERE earlier.completed_at > later.started_at`;
  assert.deepEqual([...overlapping], []);
});

test('stream_status keeps each stream own latest outcome when a watch pass reads only what changed', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  const a = scripted('a');
  const b = scripted('b');
  class Changes extends ScriptedSource {
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
      yield [a];
    }
  }
  const source = new Changes([a, b], {
    a: [record('a', 'a1', 1), checkpoint('a', {})],
    b: [new Error('b denied')],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const history = new PostgresSyncHistory({ url: database.url });
  await history.install();
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [a, b].map(
          (stream) =>
            new Copy(
              stream,
              destination.table(stream.name),
              incremental(stream.name),
            ),
        ),
      }),
    ],
  });

  for await (const _pass of pipeline.watch({
    signal: AbortSignal.timeout(10_000),
  }));

  assert.deepEqual(
    [...(await sql`SELECT connector, status FROM marts.sync_status`)],
    [{ connector: 'notes', status: 'succeeded' }],
  );
  assert.deepEqual(
    [
      ...(await sql`SELECT stream, status, last_successful_attempt_id IS NOT NULL AS succeeded_once, target_table
        FROM marts.stream_status ORDER BY stream`),
    ],
    [
      {
        stream: 'a',
        status: 'succeeded',
        succeeded_once: true,
        target_table: 'a',
      },
      {
        stream: 'b',
        status: 'failed',
        succeeded_once: false,
        target_table: 'b',
      },
    ],
  );
  const [streamA] =
    await sql`SELECT latest_attempt_id, last_successful_attempt_id FROM marts.stream_status WHERE stream = 'a'`;
  const [latest] = await sql`SELECT latest_attempt_id FROM marts.sync_status`;
  assert.equal(streamA?.latest_attempt_id, latest?.latest_attempt_id);
  assert.equal(streamA?.last_successful_attempt_id, latest?.latest_attempt_id);
});

// A described stream loaded with a stored file field and a reader view.
function readerNotes(database: { url: string }, files: LocalFiles) {
  const stream = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'One row per note.',
      properties: {
        id: { type: 'integer', description: 'Note ID.' },
        title: { type: 'string', description: 'Note title.' },
      },
      required: ['id', 'title'],
    },
    primaryKey: ['id'],
    sourceDefinedCursor: true,
    supportedSyncModes: ['full_refresh', 'incremental'],
    emitsDeletes: true,
    supportsFileTransfer: true,
  });
  const source = new Messages(stream);
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const copy = new Copy(
    stream,
    destination
      .table('raw_notes', (columns) => [
        ...PostgresColumns.fromSchema(stream.jsonSchema),
        columns.text('ref').from(stream.file.store(files)),
      ])
      .withReaderView('marts', 'notes'),
    {
      id: 'notes',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    },
  );
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [copy],
      }),
    ],
  });
  return { stream, source, destination, copy, pipeline };
}

test('a reader view shows exactly the loaded columns and their descriptions, follows changes without being recreated, and never locks readers out', async () => {
  const scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reader-pg-'));
  try {
    await using database = await scratchDatabase(server);
    const { sql } = database;
    await sql`CREATE SCHEMA marts`;
    const path = join(scratch.path, 'note.txt');
    await writeFile(path, 'body');
    const files = new LocalFiles({ directory: join(scratch.path, 'files') });
    const { source, destination, copy, pipeline } = readerNotes(
      database,
      files,
    );
    source.messages = [
      { stream: 'notes', data: { id: 1, title: 'First' }, file: path },
      { stream: 'notes', data: { id: 2, title: 'Second' }, file: null },
    ];
    await pipeline.run();

    const view = async () => [
      ...(await sql`SELECT id, title, ref, loaded_at FROM marts.notes ORDER BY id`),
    ];
    const [first, second] = await view();
    assert.equal(await readFile(String(first?.ref), 'utf8'), 'body');
    assert.equal(second?.ref, null);
    const descriptions = async (relation: string) => [
      ...(await sql`SELECT a.attname AS name, col_description(a.attrelid, a.attnum) AS description
        FROM pg_attribute a WHERE a.attrelid = ${relation}::regclass AND a.attnum > 0 ORDER BY a.attnum`),
    ];
    const viewColumns = await descriptions('marts.notes');
    assert.deepEqual(
      viewColumns.map(({ name }) => name),
      ['id', 'title', 'ref', 'loaded_at'],
    );
    assert.deepEqual(viewColumns, await descriptions('raw.raw_notes'));
    assert.equal(
      viewColumns[2]?.description,
      `${files.reference} NULL when the source file is unavailable.`,
    );
    const [comments] =
      await sql`SELECT obj_description('marts.notes'::regclass) AS view,
      obj_description('raw.raw_notes'::regclass) AS "table"`;
    assert.match(String(comments?.view), /One row per note\./);
    assert.equal(comments?.view, comments?.table);

    const oid = async () =>
      (await sql`SELECT 'marts.notes'::regclass::oid AS oid`)[0]?.oid;
    const created = await oid();
    source.messages = [
      { stream: 'notes', data: { id: 1, title: 'Renamed' }, file: path },
      { type: 'DELETE', stream: 'notes', key: { id: 2 } },
    ];
    await pipeline.run();
    assert.deepEqual(
      (await view()).map(({ id, title }) => ({ id, title })),
      [{ id: '1', title: 'Renamed' }],
    );
    assert.equal(await oid(), created);

    // A prepared load stays open while the source reads; readers of the view
    // it keeps must not wait behind it.
    const load = await destination.load();
    try {
      await using stage = await load.prepare(copy.configuration, copy.to, {
        writer: copy.writer(source),
        restart: false,
        reloading: false,
      });
      assert.ok(stage);
      const blocking = await sql`SELECT mode FROM pg_locks
        WHERE relation = 'marts.notes'::regclass AND pid <> pg_backend_pid()
        AND mode = 'AccessExclusiveLock'`;
      assert.deepEqual([...blocking], []);
      await sql.begin(async (reader) => {
        await reader`SET LOCAL lock_timeout = '200ms'`;
        assert.equal(
          (await reader`SELECT count(*)::int AS n FROM marts.notes`)[0]?.n,
          1,
        );
      });
    } finally {
      await load[Symbol.asyncDispose]();
    }
  } finally {
    await scratch[Symbol.asyncDispose]();
  }
});

test('a reader view needs every column described and refuses a view it did not create', async () => {
  await using database = await scratchDatabase(server);
  const { sql } = database;
  await sql`CREATE SCHEMA marts`;
  const scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reader-pg-'));
  try {
    const files = new LocalFiles({ directory: scratch.path });
    const undescribed = new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' } },
      },
      supportedSyncModes: ['full_refresh'],
    });
    const destination = new PostgresDestination({
      url: database.url,
      schema: 'raw',
    });
    assert.throws(
      () =>
        destination.validate(
          new Copy(
            undescribed,
            destination.table('raw_notes').withReaderView('marts', 'notes'),
          ).configuration,
          destination.table('raw_notes').withReaderView('marts', 'notes'),
        ),
      /Reader view marts\.notes needs JSON Schema descriptions for the stream, id, title of stream notes/,
    );

    await sql`CREATE VIEW marts.notes AS SELECT 1 AS id`;
    const definition = async () =>
      (await sql`SELECT pg_get_viewdef('marts.notes'::regclass) AS d`)[0]?.d;
    const before = await definition();
    const { source, pipeline } = readerNotes(database, files);
    source.messages = [{ stream: 'notes', data: { id: 1, title: 'A' } }];
    await assert.rejects(pipeline.run(), (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.match(
        String(error.cause),
        /"marts"\."notes" is not a view of exactly "raw"\."raw_notes"/,
      );
      return true;
    });
    assert.equal(await definition(), before);
    assert.equal(
      (await sql`SELECT to_regclass('raw.raw_notes') AS t`)[0]?.t,
      null,
    );
  } finally {
    await scratch[Symbol.asyncDispose]();
  }
});

test('string formats load exactly: microsecond times typed, finer ones as text that orders as time, decimals and int64 exact', async () => {
  await using database = await scratchDatabase(server);
  const ledger = new Stream({
    name: 'ledger',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'int64' },
        version: { type: 'string', format: 'date-time', precision: 7 },
        amount: { type: 'string', format: 'decimal', precision: 19, scale: 4 },
        ratio: { type: 'string', format: 'decimal' },
        at: { type: 'string', format: 'date-time', precision: 6 },
        local: { type: 'string', format: 'date-time-local', precision: 3 },
        exact: { type: 'string', format: 'date-time-local', precision: 7 },
        clock: { type: 'string', format: 'time-local', precision: 0 },
        bytes: { type: 'string', contentEncoding: 'base64' },
        ids: { type: 'array', items: { type: 'string', format: 'int64' } },
      },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
  });
  const source = new Messages(ledger);
  const entry = (id: string, version: string, amount: string) => ({
    id,
    version,
    amount,
    ratio: '0.5',
    at: '2025-01-02T03:04:05.123456Z',
    local: '2024-02-29T12:00:00.250',
    exact: '9999-12-31T23:59:59.9999999',
    clock: '23:59:59',
    bytes: 'AAEC/w==',
    ids: ['9007199254740993', '-9223372036854775808'],
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(ledger, destination.table('ledger'), {
            id: 'ledger',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
          }),
        ],
      }),
    ],
  });

  // Typed microseconds would round both versions to .123456 and tie.
  source.messages = rows(ledger, [
    entry('9223372036854775807', '2025-01-02T03:04:05.1234561Z', '-0.5000'),
    entry(
      '9223372036854775807',
      '2025-01-02T03:04:05.1234567Z',
      '922337203685477.5807',
    ),
    entry('1', '2025-01-02T03:04:05.0000000Z', '0.0000'),
  ]);
  await pipeline.run();

  assert.deepEqual(
    await database.sql`SELECT column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'raw' AND table_name = 'ledger' AND column_name <> 'loaded_at' ORDER BY ordinal_position`.then(
      (columns) =>
        columns.map(
          ({ column_name, data_type, numeric_precision, numeric_scale }) =>
            [column_name, data_type, numeric_precision, numeric_scale].join(
              ' ',
            ),
        ),
    ),
    [
      'id bigint 64 0',
      'version text  ',
      'amount numeric 19 4',
      'ratio numeric  ',
      'at timestamp with time zone  ',
      'local timestamp without time zone  ',
      'exact text  ',
      'clock time without time zone  ',
      'bytes bytea  ',
      'ids ARRAY  ',
    ],
  );
  assert.deepEqual(
    await database.sql`SELECT id::text, version, amount::text, ratio::text, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, to_char(local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS local, exact, clock::text, encode(bytes, 'base64') AS bytes, ids::text[] AS ids FROM raw.ledger ORDER BY id DESC`.then(
      (loaded) => loaded.map((row) => ({ ...row })),
    ),
    [
      {
        ...entry(
          '9223372036854775807',
          '2025-01-02T03:04:05.1234567Z',
          '922337203685477.5807',
        ),
      },
      { ...entry('1', '2025-01-02T03:04:05.0000000Z', '0.0000') },
    ],
  );

  source.messages = [
    { type: 'DELETE', stream: 'ledger', key: { id: '9223372036854775807' } },
  ];
  await pipeline.run();
  assert.deepEqual(
    await database.sql`SELECT id::text FROM raw.ledger`.then((loaded) =>
      loaded.map(({ id }) => id),
    ),
    ['1'],
  );
});

test('a reset replaces its partition, or the whole table, at the next commit; a failure before the checkpoint keeps rows and checkpoint', async () => {
  await using database = await scratchDatabase(server);
  const schema = {
    type: 'object',
    properties: { account: { type: 'string' }, id: { type: 'string' } },
  } as const;
  const items = new Stream({
    name: 'items',
    jsonSchema: schema,
    primaryKey: ['account', 'id'],
    partitionKey: ['account'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  const table = new Stream({
    name: 'table',
    jsonSchema: schema,
    primaryKey: ['account', 'id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  // What each partition of items, and the table, emits on the next run.
  let script: Record<string, (SourceMessage | Error)[]> = {};
  const received: unknown[] = [];
  class Resetting extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'resetting';
    protected readonly catalog = new Catalog([items, table]);
    protected override partitions() {
      return [{ account: 'a' }, { account: 'b' }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
      partition: Partition | null,
    ) {
      const name = String(partition?.account ?? configuration.stream.name);
      received.push([name, state]);
      for (const message of script[name] ?? []) {
        if (message instanceof Error) throw message;
        yield message;
      }
    }
  }
  const record = (stream: string, account: string, id: string) => ({
    stream,
    data: { account, id },
  });
  const reset = (stream: string) => ({ type: 'RESET' as const, stream });
  const state = (stream: string, pass: number) => ({
    type: 'STATE' as const,
    stream,
    state: { pass },
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const selection = {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  } as const;
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Resetting(),
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            ...selection,
          }),
          new Copy(table, destination.table('table'), {
            id: 'table',
            ...selection,
          }),
        ],
      }),
    ],
  });
  const loaded = async () =>
    (
      await database.sql`SELECT 'items' AS stream, account, id FROM raw.items UNION ALL SELECT 'table', account, id FROM raw."table" ORDER BY 1, 2, 3`
    ).map(({ stream, account, id }) => `${stream} ${account}${id}`);

  script = {
    a: [
      record('items', 'a', '1'),
      record('items', 'a', '2'),
      state('items', 1),
    ],
    b: [record('items', 'b', '1'), state('items', 1)],
    table: [
      record('table', 'x', '1'),
      record('table', 'x', '2'),
      state('table', 1),
    ],
  };
  await pipeline.run();
  // a1 and x1 vanished upstream; only a reset can tell.
  script = {
    a: [reset('items'), record('items', 'a', '2'), state('items', 2)],
    b: [state('items', 2)],
    table: [reset('table'), record('table', 'x', '2'), state('table', 2)],
  };
  await pipeline.run();
  assert.deepEqual(await loaded(), ['items a2', 'items b1', 'table x2']);

  // b commits after a failed, so a reset a dropped must not reach b's commit.
  script = {
    a: [reset('items'), record('items', 'a', '3'), new Error('gone')],
    b: [record('items', 'b', '2'), state('items', 3)],
    table: [reset('table'), new Error('gone')],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(await loaded(), [
    'items a2',
    'items b1',
    'items b2',
    'table x2',
  ]);
  script = {};
  received.length = 0;
  await pipeline.run();
  assert.deepEqual(received, [
    ['a', { pass: 2 }],
    ['b', { pass: 3 }],
    ['table', { pass: 2 }],
  ]);
});

test('a stream whose shape changes reloads into a table rebuilt and swapped in under its reader view; a description edit only updates comments', async () => {
  await using database = await scratchDatabase(server);
  await database.sql`CREATE SCHEMA marts`;
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const checkpoints = new PostgresCheckpointStore({
    url: database.url,
    schema: 'raw',
  });
  const received: unknown[] = [];
  // Each run discovers its stream anew, as a database source does.
  const run = (properties: Properties, data: readonly object[]) => {
    const stream = new Stream({
      name: 'items',
      jsonSchema: { type: 'object', description: 'Items.', properties },
      primaryKey: ['id'],
      supportedSyncModes: ['incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
    });
    class Discovered extends Messages {
      protected override async *extract(
        configuration: CopyConfiguration,
        state?: unknown,
      ) {
        received.push(state);
        yield* super.extract(configuration);
      }
    }
    const source = new Discovered(stream);
    source.messages = rows(stream, data);
    return new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(
              stream,
              destination.table('items').withReaderView('marts', 'items'),
              {
                id: 'items',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
          ],
        }),
      ],
    }).run();
  };
  const id = { type: 'string', description: 'Id.' } as const;
  const name = { type: 'string', description: 'Name.' } as const;
  const shape = async () =>
    (
      await database.sql`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, col_description('marts.items'::regclass, a.attnum) AS description FROM pg_attribute a WHERE a.attrelid = 'marts.items'::regclass AND a.attnum > 0 ORDER BY a.attnum`
    ).map(
      ({ attname, type, description }) => `${attname} ${type} ${description}`,
    );
  const loaded = async () =>
    (await database.sql`SELECT * FROM marts.items ORDER BY id`).map(
      ({ loaded_at: _, ...row }) => ({ ...row }),
    );

  await run({ id, name }, [{ id: '1', name: 'one' }]);
  await run({ id, name: { ...name, description: 'Display name.' } }, [
    { id: '1', name: 'one' },
  ]);
  assert.deepEqual(received.splice(0), [null, {}]);
  assert.ok((await shape()).includes('name text Display name.'));

  // A column added, then retyped: each reload starts from no checkpoint.
  const size = { type: ['integer', 'null'], description: 'Size.' } as const;
  await run({ id, name, size }, [{ id: '1', name: 'one', size: 3 }]);
  assert.deepEqual(await loaded(), [{ id: '1', name: 'one', size: '3' }]);
  const text = { type: ['string', 'null'], description: 'Size.' } as const;
  await run({ id, name, size: text }, [{ id: '1', name: 'one', size: 'L' }]);
  await run({ id, name, size: text }, []);
  assert.deepEqual(received.splice(0), [null, null, {}]);
  assert.deepEqual(await loaded(), [{ id: '1', name: 'one', size: 'L' }]);
  assert.ok((await shape()).includes('size text Size.'));

  // A reader that holds the view outlasts the swap's wait; the reload stays
  // hidden, and the next run continues it from its checkpoint and swaps.
  const reader = postgres(database.url, { max: 1, onnotice: () => {} });
  try {
    await reader.begin(async (sql) => {
      await sql`SELECT * FROM marts.items`;
      await assert.rejects(
        run({ id, name }, [{ id: '1', name: 'one' }]),
        /lock timeout/,
      );
    });
  } finally {
    await reader.end();
  }
  assert.deepEqual(await loaded(), [{ id: '1', name: 'one', size: 'L' }]);
  await run({ id, name }, [{ id: '1', name: 'one' }]);
  assert.deepEqual(await loaded(), [{ id: '1', name: 'one' }]);
  assert.deepEqual(received.splice(0), [null, {}]);
});

test('a load holds no transaction while the source reads, so a run over many tables holds none of their locks', async () => {
  await using database = await scratchDatabase(server);
  const streams = Array.from(
    { length: 50 },
    (_, index) =>
      new Stream({
        name: `t${index}`,
        jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
        primaryKey: ['id'],
        supportedSyncModes: ['incremental'],
        sourceDefinedCursor: true,
        emitsDeletes: true,
      }),
  );
  const held: number[] = [];
  class Many extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'many';
    protected readonly catalog = new Catalog(streams);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      // A lock table shared by the whole server runs out past a few
      // thousand tables held in one transaction.
      if (configuration.stream === streams[0]) {
        // Relations a load creates are invisible to other sessions until it
        // commits, so count their locks without naming them.
        const [locks] =
          await database.sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'relation' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND pid <> pg_backend_pid()`;
        held.push(Number(locks?.n));
      }
      yield { stream: configuration.stream.name, data: { id: '1' } };
      yield {
        type: 'STATE' as const,
        stream: configuration.stream.name,
        state: {},
      };
    }
  }
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });

  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Many(),
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  }).run();

  assert.deepEqual(held, [0]);
  assert.deepEqual(
    await database.sql`SELECT count(*)::int AS n FROM raw.t49`.then((rows) =>
      rows.map((row) => row.n),
    ),
    [1],
  );
});

test('a reset reloads into a hidden table: readers keep the old rows until the stream ends, a failed reload resumes, and a new reset discards it', async () => {
  await using database = await scratchDatabase(server);
  const items = new Stream({
    name: 'items',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  // A step that holds the read between two checkpoints until the test lets it go.
  const pause = Symbol('pause');
  let script: (SourceMessage | Error | typeof pause)[] = [];
  const received: unknown[] = [];
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  class Scripted extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'scripted';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      state: unknown,
    ) {
      received.push(state);
      for (const step of script) {
        if (step instanceof Error) throw step;
        if (step === pause) {
          reached.resolve();
          await gate.promise;
          continue;
        }
        yield step;
      }
    }
  }
  const row = (id: string) => ({ stream: 'items', data: { id } });
  const reset = { type: 'RESET' as const, stream: 'items' };
  const state = (at: string) => ({
    type: 'STATE' as const,
    stream: 'items',
    state: { at },
  });
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Scripted(),
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: database.url,
          schema: 'raw',
        }),
        steps: [
          new Copy(items, destination.table('items'), {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const visible = async () =>
    (await database.sql`SELECT id FROM raw.items ORDER BY id`).map(
      ({ id }) => id,
    );

  script = [row('a1'), row('a2'), state('a')];
  await pipeline.run();

  // Chunk 1 of the reload committed; readers on another connection still
  // see the previous rows.
  script = [reset, row('b1'), state('b1'), pause, row('b2'), state('b')];
  const reloading = pipeline.run();
  await reached.promise;
  const during = await visible();
  gate.resolve();
  await reloading;
  assert.deepEqual(during, ['a1', 'a2']);
  assert.deepEqual(await visible(), ['b1', 'b2']);

  // A reload that fails keeps the previous rows visible and resumes.
  script = [reset, row('c1'), state('c1'), new Error('gone')];
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(await visible(), ['b1', 'b2']);
  script = [row('c2'), state('c')];
  await pipeline.run();
  assert.deepEqual(await visible(), ['c1', 'c2']);

  // A reset while a reload is open starts it over without the stale rows.
  script = [reset, row('d1'), state('d1'), new Error('gone')];
  await assert.rejects(pipeline.run(), PipelineError);
  script = [reset, row('e1'), state('e')];
  await pipeline.run();
  assert.deepEqual(await visible(), ['e1']);
  assert.deepEqual(received.slice(1), [
    { at: 'a' },
    { at: 'b' },
    { at: 'c1' },
    { at: 'c' },
    { at: 'd1' },
  ]);
});

test('rows past one JSON string stage in batches by size, and a record too large to send fails its stream naming its column and key', async () => {
  await using database = await scratchDatabase(server);
  const docs = new Stream({
    name: 'docs',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  let records: Record<string, string>[] = [];
  class Documents extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'documents';
    protected readonly catalog = new Catalog([docs]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      for (const data of records) yield { stream: 'docs', data };
    }
  }
  const destination = new PostgresDestination({
    url: database.url,
    schema: 'raw',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Documents(),
        destination,
        steps: [
          new Copy(docs, destination.table('docs'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
        ],
      }),
    ],
  });
  const stored = async () =>
    [
      ...(await database.sql`SELECT count(*)::int AS rows, min(length(body)) AS shortest FROM raw.docs`),
    ][0];

  // 600 rows of 1 MB add up past V8's longest string, so they cannot travel
  // as one batch.
  const megabyte = 'x'.repeat(2 ** 20);
  records = Array.from({ length: 600 }, (_, index) => ({
    id: String(index),
    body: megabyte,
    notes: '',
  }));
  await pipeline.run();
  assert.deepEqual({ ...(await stored()) }, { rows: 600, shortest: 2 ** 20 });

  // Two 270 MB values make one row longer than any string V8 can build.
  const huge = 'x'.repeat(270_000_000);
  records = [{ id: 'huge', body: huge, notes: huge }];
  const error = await pipeline.run().then(
    () => assert.fail('the huge record should fail its stream'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof PipelineError, String(error));
  assert.match(
    String(error.results[0]?.failures[0]?.error),
    /"raw"\."docs" with key \{"id":"huge"\} is too large to stage: its largest value, in column body, is 270000000 bytes/,
  );
  assert.deepEqual({ ...(await stored()) }, { rows: 600, shortest: 2 ** 20 });
});
