import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  type PostgresTable,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

// The wall time of every pass, which the tests move, as elt's own tests do
// (ADR 0019). The timers run for real, so a pass runs as it does, but the
// time of each commit, which the retention compares with its window, is the
// test's own: a slow machine cannot make a commit older than the test says.
let now = Date.now();
const clock = {
  Date: { now: () => now },
  performance,
  setTimeout,
  clearTimeout,
};
const elapse = (duration: Temporal.DurationLike) => {
  now += Temporal.Duration.from(duration).total('milliseconds');
};

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a test source's read: a message, or a wait the test ends.
type Step = SourceMessage | (() => Promise<void>);

// Reads the steps a test scripts for each stream, keyed by the stream's name.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #steps: Readonly<Record<string, readonly Step[]>>;

  constructor(
    streams: readonly Stream[],
    steps: Readonly<Record<string, readonly Step[]>>,
  ) {
    super();
    this.catalog = new Catalog(streams);
    this.#steps = steps;
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

  protected override async *extract(configuration: CopyConfiguration) {
    for (const step of this.#steps[configuration.stream.name] ?? [])
      if (typeof step === 'function') await step();
      else yield step;
  }
}

// Notes keyed by id; a newer copy of a note has a greater version.
const notes = () =>
  new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        version: { type: 'integer', description: 'Version of the note.' },
        body: { type: 'string', description: 'Text of the note.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
  });

const note = (id: string, version: number, body: string) => ({
  stream: 'notes',
  data: { id, version, body },
});
const checkpoint = (stream: string, read: number) => ({
  type: 'STATE' as const,
  stream,
  state: { read },
});

// A schema raw of the database, with the retention a test sets, and a pass of
// one copy that keeps the newest version of each note, or of the copy a test
// gives.
function warehouse(
  url: string,
  retention?: Temporal.Duration,
  stream: Stream = notes(),
) {
  const destination = new PostgresDestination({
    url,
    schema: 'raw',
    ...(retention === undefined ? {} : { retention }),
  });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const pass = (
    steps: Readonly<Record<string, readonly Step[]>>,
    copy: Copy<PostgresTable> = new Copy(
      stream,
      destination
        .table(stream.name)
        .withReaderView('marts', `raw_${stream.name}`),
      {
        id: stream.name,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'version',
      },
    ),
  ) =>
    new Pipeline({
      clock,
      history: new PostgresSyncHistory({ url }),
      connections: [
        new Connection({
          name: 'raw',
          source: new Scripted([copy.from], steps),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    });
  return { destination, pass };
}

// A client of the test's own, ended with the test.
function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

async function positions(destination: PostgresDestination) {
  const listed = await destination.positions();
  if ('expired' in listed) assert.fail(listed.expired);
  return listed;
}

async function newest(destination: PostgresDestination): Promise<string> {
  const position = (await positions(destination)).at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// The rows a query reads as of a position, or as of the newest one.
async function asOf(
  destination: PostgresDestination,
  query: string,
  position?: string,
) {
  const reading = await destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _reading = reading;
  return (await reading.sql.unsafe(query)).map((row) => ({ ...row }));
}

// Why a reading of a position is expired; fails when it is not.
async function expiredReading(
  destination: PostgresDestination,
  position: string,
): Promise<string> {
  const reading = await destination.reading(position);
  if (!('expired' in reading)) {
    await reading[Symbol.asyncDispose]();
    assert.fail(`${position} reads`);
  }
  return reading.expired;
}

// The bodies that the history of raw.notes keeps, oldest replaced first.
async function kept(sql: postgres.Sql, column = 'body') {
  const [history] = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'raw'::regnamespace AND relkind = 'r' AND relname LIKE '\_elt\_history\_%'`;
  if (history === undefined) assert.fail('raw has no history');
  return (
    await sql.unsafe(
      `SELECT "${column}" AS value FROM raw."${history.name}" ORDER BY replaced_in, 1`,
    )
  ).map(({ value }) => value);
}

const body = 'SELECT body FROM marts.raw_notes';
const retentionReason = /retention/;

test('a commit after the window deletes the history that only positions older than the window read, and the oldest position left reads exactly', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  await pass({
    notes: [note('n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  const second = await newest(destination);
  elapse({ milliseconds: 1500 });

  await pass({ notes: [note('n1', 3, 'third'), checkpoint('notes', 3)] }).run();

  assert.deepEqual(await positions(destination), [
    second,
    await newest(destination),
  ]);
  assert.deepEqual(await asOf(destination, body, second), [{ body: 'second' }]);
  assert.deepEqual(await kept(sql), ['second']);
});

test('a reading of a position older than the window, and the positions after it, are expired with a reason that names the retention', async () => {
  await using database = await databases.database();
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  const first = await newest(destination);
  await pass({
    notes: [note('n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  elapse({ milliseconds: 1500 });

  await pass({ notes: [note('n1', 3, 'third'), checkpoint('notes', 3)] }).run();

  assert.match(await expiredReading(destination, first), retentionReason);
  const after = await destination.positions(first);
  assert.ok('expired' in after, JSON.stringify(after));
  assert.match(after.expired, retentionReason);
});

test('the commit that first outwaits the window keeps readable each position inside it, and the newest position older than it', async () => {
  await using database = await databases.database();
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 4 }),
  );
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  const first = await newest(destination);
  elapse({ milliseconds: 2400 });
  await pass({
    notes: [note('n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  const second = await newest(destination);
  await pass({ notes: [note('n1', 3, 'third'), checkpoint('notes', 3)] }).run();
  const third = await newest(destination);
  elapse({ milliseconds: 2400 });

  await pass({
    notes: [note('n1', 4, 'fourth'), checkpoint('notes', 4)],
  }).run();

  assert.deepEqual(await positions(destination), [
    first,
    second,
    third,
    await newest(destination),
  ]);
  assert.deepEqual(await asOf(destination, body, first), [{ body: 'first' }]);
  assert.deepEqual(await asOf(destination, body, second), [{ body: 'second' }]);
});

test('with no window set, the window is 30 days: a position stays readable for 30 days and is expired after', async () => {
  await using database = await databases.database();
  const { destination, pass } = warehouse(database.connectionString);
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  const first = await newest(destination);
  await pass({
    notes: [note('n1', 2, 'second'), checkpoint('notes', 2)],
  }).run();
  elapse({ days: 29 });
  await pass({ notes: [note('n1', 3, 'third'), checkpoint('notes', 3)] }).run();

  assert.equal(destination.retention.toString(), 'P30D');
  assert.deepEqual(await asOf(destination, body, first), [{ body: 'first' }]);

  elapse({ days: 2 });
  await pass({
    notes: [note('n1', 4, 'fourth'), checkpoint('notes', 4)],
  }).run();

  assert.match(await expiredReading(destination, first), retentionReason);
});

test('a pass that stays open longer than the window leaves the position before it readable exactly', async () => {
  await using database = await databases.database();
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  const first = await newest(destination);

  await pass({
    notes: [
      note('n1', 2, 'second'),
      checkpoint('notes', 2),
      async () => elapse({ milliseconds: 1500 }),
      note('n1', 3, 'third'),
      checkpoint('notes', 3),
    ],
  }).run();

  assert.deepEqual(await asOf(destination, body, first), [{ body: 'first' }]);
});

test('a clear after the window deletes the history that only positions older than the window read', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass({ notes: [note('n1', 1, 'first'), checkpoint('notes', 1)] }).run();
  const first = await newest(destination);
  const pipeline = pass({
    notes: [note('n1', 2, 'second'), checkpoint('notes', 2)],
  });
  await pipeline.run();
  const second = await newest(destination);
  elapse({ milliseconds: 1500 });

  await pipeline.clear();

  assert.deepEqual(await kept(sql), ['second']);
  assert.match(await expiredReading(destination, first), retentionReason);
  assert.deepEqual(await asOf(destination, body, second), [{ body: 'second' }]);
});

test('a commit after the window deletes the stored files that only expired history rows refer to, and keeps the files of current rows and of newer history rows', async () => {
  await using database = await databases.database();
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  await using clients = new AsyncDisposableStack();
  const sql = client(database.connectionString, clients);
  const documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document.',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        version: { type: 'integer', description: 'Version of the document.' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
  });
  const { destination, pass } = warehouse(
    database.connectionString,
    Temporal.Duration.from({ seconds: 1 }),
    documents,
  );
  const copy = new Copy(
    documents,
    destination
      .table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.blob('bytes').from(documents.file),
      ])
      .withReaderView('marts', 'raw_documents'),
    {
      id: 'documents',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    },
  );
  const document = async (id: string, version: number, text: string) => {
    const path = join(scratch.path, `${id}-${text}.txt`);
    await writeFile(path, text);
    return { stream: 'documents', data: { id, version }, file: path };
  };
  await pass(
    {
      documents: [
        await document('d1', 1, 'a'),
        await document('d2', 1, 'b'),
        checkpoint('documents', 1),
      ],
    },
    copy,
  ).run();
  await pass(
    { documents: [await document('d1', 2, 'a2'), checkpoint('documents', 2)] },
    copy,
  ).run();
  const second = await newest(destination);
  elapse({ milliseconds: 1500 });

  await pass(
    { documents: [await document('d2', 2, 'b2'), checkpoint('documents', 3)] },
    copy,
  ).run();

  const [chunks] = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'raw'::regnamespace AND relkind = 'r' AND relname LIKE '\_elt\_files\_%'`;
  if (chunks === undefined) assert.fail('raw has no chunk table');
  assert.deepEqual(
    (
      await sql.unsafe(
        `SELECT convert_from(string_agg(bytes, ''::bytea ORDER BY n), 'UTF8') AS text FROM raw."${chunks.name}" GROUP BY file ORDER BY 1`,
      )
    ).map(({ text }) => text),
    ['a2', 'b', 'b2'],
  );
  assert.deepEqual(
    await asOf(
      destination,
      `SELECT d.id, convert_from(string_agg(f.bytes, ''::bytea ORDER BY f.n), 'UTF8') AS text
       FROM marts.raw_documents d JOIN raw."${chunks.name}" f ON f.file = d.bytes
       GROUP BY d.id ORDER BY d.id`,
      second,
    ),
    [
      { id: 'd1', text: 'a2' },
      { id: 'd2', text: 'b' },
    ],
  );
});
