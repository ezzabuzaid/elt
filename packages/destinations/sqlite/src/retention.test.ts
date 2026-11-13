import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  LocalFiles,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  asOfSelect,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

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

  override changeSignals(): ChangeSignal[] {
    return [];
  }

  protected override async *extract(configuration: CopyConfiguration) {
    for (const step of this.#steps[configuration.stream.name] ?? [])
      if (typeof step === 'function') await step();
      else yield step;
  }
}

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
const after = (duration: Temporal.DurationLike) => {
  now += Temporal.Duration.from(duration).total('milliseconds');
};

// A window of history that a test outwaits by moving the clock past it.
const window = Temporal.Duration.from({ milliseconds: 20 });
const outwait = () => after({ milliseconds: 60 });

const notes = () =>
  new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'integer' },
        body: { type: 'string' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
  });

const note = (id: string, version: number, body = id) => ({
  stream: 'notes',
  data: { id, version, body },
});
const checkpoint = (stream: string, read: number) => ({
  type: 'STATE' as const,
  stream,
  state: { read },
});

// A file with the retention given, and a pass of one deduplicating copy of
// the stream with the steps a test scripts for it.
function file(
  directory: string,
  stream: Stream,
  table: (destination: SQLiteDestination) => SQLiteTable,
  retention?: Temporal.Duration,
) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
    ...(retention === undefined ? {} : { retention }),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const copy = new Copy(stream, table(destination), {
    id: stream.name,
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });
  const pipeline = (steps: readonly Step[]) =>
    new Pipeline({
      clock,
      connections: [
        new Connection({
          name: 'notes',
          source: new Scripted([stream], { [stream.name]: steps }),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
      history: new SQLiteSyncHistory(),
    });
  const pass = (steps: readonly Step[]) => pipeline(steps).run();
  return { destination, pipeline, pass };
}

const notesFile = (directory: string, retention?: Temporal.Duration) =>
  file(
    directory,
    notes(),
    (destination) => destination.table('notes'),
    retention,
  );

function positions(destination: SQLiteDestination, after?: string) {
  const listed = destination.positions(after);
  if ('expired' in listed) assert.fail(listed.expired);
  return listed;
}

function newest(destination: SQLiteDestination): string {
  const position = positions(destination).at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

function asOf(destination: SQLiteDestination, sql: string, position?: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// The rows of the history of a target, as the file keeps them.
function replaced(destination: SQLiteDestination, target: string) {
  const [recorded] = storedRows(
    destination.path,
    `SELECT history FROM _elt_histories WHERE target = '${target}'`,
  );
  if (recorded === undefined) assert.fail(`${target} has no history`);
  return storedRows(
    destination.path,
    `SELECT * FROM "${String(recorded.history)}" ORDER BY replaced_in, id`,
  );
}

// A wait the test ends, and a promise that settles once the read reached it.
function latch() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    step: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

test('a commit after the window deletes the history that only positions older than the window read, and the oldest position left reads exactly', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(scratch.path, window);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  const first = newest(destination);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  const second = newest(destination);
  const asSecond = asOf(destination, 'SELECT * FROM notes', second);
  outwait();

  await pass([note('n1', 3, 'third'), checkpoint('notes', 3)]);

  assert.deepEqual(
    replaced(destination, 'notes').map(({ body }) => body),
    ['second'],
  );
  assert.deepEqual(positions(destination), [second, newest(destination)]);
  assert.notEqual(first, second);
  assert.deepEqual(asOf(destination, 'SELECT * FROM notes', second), asSecond);
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes'), [
    { body: 'third' },
  ]);
});

test('a position inside the window stays readable after a later commit applies the retention', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(
    scratch.path,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  const second = newest(destination);
  after({ milliseconds: 1200 });
  await pass([note('n1', 3, 'third'), checkpoint('notes', 3)]);
  const third = newest(destination);

  await pass([note('n1', 4, 'fourth'), checkpoint('notes', 4)]);

  assert.deepEqual(positions(destination), [
    second,
    third,
    newest(destination),
  ]);
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', second), [
    { body: 'second' },
  ]);
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', third), [
    { body: 'third' },
  ]);
});

test('the commit that first outwaits the window keeps readable each position inside it, and the newest position older than it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(
    scratch.path,
    Temporal.Duration.from({ seconds: 3 }),
  );
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  const first = newest(destination);
  after({ milliseconds: 1800 });
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  const second = newest(destination);
  await pass([note('n1', 3, 'third'), checkpoint('notes', 3)]);
  const third = newest(destination);
  after({ milliseconds: 1800 });

  await pass([note('n1', 4, 'fourth'), checkpoint('notes', 4)]);

  assert.deepEqual(positions(destination), [
    first,
    second,
    third,
    newest(destination),
  ]);
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', first), [
    { body: 'first' },
  ]);
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', second), [
    { body: 'second' },
  ]);
});

test('a reading of a position older than the window, and the positions after it, are expired with a reason that names the retention', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(scratch.path, window);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  const first = newest(destination);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  outwait();
  await pass([note('n1', 3, 'third'), checkpoint('notes', 3)]);

  const reading = destination.reading(first);
  const listed = destination.positions(first);

  assert.ok('expired' in reading, 'the reading is expired');
  assert.match(reading.expired, /retention/);
  assert.ok('expired' in listed, 'the positions are expired');
  assert.match(listed.expired, /retention/);
});

test('with no window set, the window is 30 days: a position stays readable for 30 days and is expired after', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(scratch.path);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  const first = newest(destination);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  after({ days: 29 });
  await pass([note('n1', 3, 'third'), checkpoint('notes', 3)]);

  assert.deepEqual(destination.retention, Temporal.Duration.from({ days: 30 }));
  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', first), [
    { body: 'first' },
  ]);

  after({ days: 2 });
  await pass([note('n1', 4, 'fourth'), checkpoint('notes', 4)]);

  const reading = destination.reading(first);
  assert.ok('expired' in reading, 'a position 31 days old is expired');
  assert.match(reading.expired, /retention/);
});

test('a pass that stays open longer than the window leaves the position before it readable exactly', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(scratch.path, window);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  const before = newest(destination);
  const wait = latch();
  const open = pass([
    note('n1', 3, 'third'),
    checkpoint('notes', 3),
    wait.step,
    note('n2', 1),
    checkpoint('notes', 4),
  ]);
  await wait.reached;
  outwait();
  wait.release();
  await open;

  assert.deepEqual(asOf(destination, 'SELECT body FROM notes', before), [
    { body: 'second' },
  ]);
});

test('a clear after the window deletes the history that only positions older than the window read', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pipeline, pass } = notesFile(scratch.path, window);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  await pass([note('n1', 2, 'second'), checkpoint('notes', 2)]);
  const second = newest(destination);
  outwait();

  await pipeline([]).clear();

  assert.equal(positions(destination)[0], second);
  assert.deepEqual(
    replaced(destination, 'notes').map(({ body }) => body),
    ['second'],
  );
});

// Documents keyed by id, each with the bytes of one file.
const documents = () =>
  new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, version: { type: 'integer' } },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
    supportsFileTransfer: true,
  });

async function document(
  directory: string,
  id: string,
  version: number,
  text: string,
): Promise<SourceMessage> {
  const path = join(directory, `${id}-${version}-${text}.txt`);
  await writeFile(path, text);
  return { stream: 'documents', data: { id, version }, file: path };
}

// The chunk table of the bytes of the documents, by the documented rule.
const chunks = `"_elt_files_${hash('sha256', JSON.stringify(['documents', 'bytes'])).slice(0, 40)}"`;

test('a commit after the window deletes the stored files that only expired history rows refer to, and keeps the files of current rows and of newer history rows', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const stream = documents();
  const { destination, pass } = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.blob('bytes').from(stream.file),
      ]),
    window,
  );
  await pass([
    await document(scratch.path, 'd1', 1, 'a'),
    await document(scratch.path, 'd2', 1, 'b'),
    checkpoint('documents', 1),
  ]);
  await pass([
    await document(scratch.path, 'd1', 2, 'a2'),
    checkpoint('documents', 2),
  ]);
  const second = newest(destination);
  outwait();

  await pass([
    await document(scratch.path, 'd2', 2, 'b2'),
    checkpoint('documents', 3),
  ]);

  const texts = (position?: string) =>
    asOf(
      destination,
      `SELECT d.id, group_concat(CAST(c.bytes AS TEXT), '') AS text FROM documents AS d JOIN ${chunks} AS c ON c.file = d.bytes GROUP BY d.id ORDER BY d.id`,
      position,
    );
  assert.deepEqual(
    storedRows(
      destination.path,
      `SELECT group_concat(CAST(bytes AS TEXT), '') AS text FROM ${chunks} GROUP BY file ORDER BY text`,
    ).map(({ text }) => text),
    ['a2', 'b', 'b2'],
  );
  assert.deepEqual(texts(second), [
    { id: 'd1', text: 'a2' },
    { id: 'd2', text: 'b' },
  ]);
  assert.deepEqual(texts(), [
    { id: 'd1', text: 'a2' },
    { id: 'd2', text: 'b2' },
  ]);
});

test('a stored file that an expired history row and a current row both refer to stays, as when a table drops a column and keeps the row', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const stream = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
  });
  const titled = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.text('title'),
        c.blob('bytes').from(stream.file),
      ]),
    window,
  );
  const untitled = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.blob('bytes').from(stream.file),
      ]),
    window,
  );
  const titledDocument = async (id: string, text: string) => ({
    ...(await document(scratch.path, id, 1, text)),
    data: { id, version: 1, title: text },
  });
  await titled.pass([
    await titledDocument('d1', 'a'),
    checkpoint('documents', 1),
  ]);
  await untitled.pass([
    await document(scratch.path, 'd2', 1, 'b'),
    checkpoint('documents', 2),
  ]);
  const kept = replaced(untitled.destination, 'documents');
  outwait();

  await untitled.pass([
    await document(scratch.path, 'd3', 1, 'c'),
    checkpoint('documents', 3),
  ]);

  assert.deepEqual(
    kept.map(({ id, title }) => ({ id, title })),
    [{ id: 'd1', title: 'a' }],
  );
  assert.deepEqual(replaced(untitled.destination, 'documents'), []);
  assert.deepEqual(
    asOf(
      untitled.destination,
      `SELECT d.id, group_concat(CAST(c.bytes AS TEXT), '') AS text FROM documents AS d JOIN ${chunks} AS c ON c.file = d.bytes GROUP BY d.id ORDER BY d.id`,
    ),
    [
      { id: 'd1', text: 'a' },
      { id: 'd2', text: 'b' },
      { id: 'd3', text: 'c' },
    ],
  );
});

test('a stored file that an expired history row and a newer history row both refer to stays, and the position that reads the newer row reads its bytes', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const stream = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['id', 'version'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['incremental'],
    supportsFileTransfer: true,
  });
  const retention = Temporal.Duration.from({ seconds: 3 });
  const titled = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.text('title'),
        c.blob('bytes').from(stream.file),
      ]),
    retention,
  );
  const untitled = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.blob('bytes').from(stream.file),
      ]),
    retention,
  );
  await titled.pass([
    {
      ...(await document(scratch.path, 'd1', 1, 'a')),
      data: { id: 'd1', version: 1, title: 'a' },
    },
    checkpoint('documents', 1),
  ]);
  await untitled.pass([
    await document(scratch.path, 'd2', 1, 'b'),
    checkpoint('documents', 2),
  ]);
  const second = newest(untitled.destination);
  after({ milliseconds: 1800 });
  await untitled.pass([
    await document(scratch.path, 'd1', 2, 'a2'),
    checkpoint('documents', 3),
  ]);
  after({ milliseconds: 1800 });

  await untitled.pass([
    await document(scratch.path, 'd3', 1, 'c'),
    checkpoint('documents', 4),
  ]);

  assert.equal(positions(untitled.destination)[0], second);
  assert.deepEqual(
    asOf(
      untitled.destination,
      `SELECT d.id, group_concat(CAST(c.bytes AS TEXT), '') AS text FROM documents AS d JOIN ${chunks} AS c ON c.file = d.bytes GROUP BY d.id ORDER BY d.id`,
      second,
    ),
    [
      { id: 'd1', text: 'a' },
      { id: 'd2', text: 'b' },
    ],
  );
});

test('a file in a file storage that only an expired history row refers to is deleted once the stream commits after the window', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const stream = documents();
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const { destination, pass } = file(
    scratch.path,
    stream,
    (destination) =>
      destination.table('documents', (c) => [
        c.text('id'),
        c.integer('version'),
        c.text('ref').from(stream.file.store(files)),
      ]),
    window,
  );
  await pass([
    await document(scratch.path, 'd1', 1, 'first'),
    checkpoint('documents', 1),
  ]);
  const [stored] = asOf(destination, 'SELECT ref FROM documents');
  const kept = join(files.directory, String(stored?.ref));
  await pass([
    { type: 'DELETE', stream: 'documents', key: { id: 'd1' } },
    checkpoint('documents', 2),
  ]);
  await access(kept);
  outwait();

  await pass([
    await document(scratch.path, 'd2', 1, 'second'),
    checkpoint('documents', 3),
  ]);

  await assert.rejects(access(kept), { code: 'ENOENT' });
});

test('the select of a target as of a position, run on the file or on the file attached under another name, reads the rows the reading reads, and a position older than the window is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-retention-');
  const { destination, pass } = notesFile(scratch.path, window);
  await pass([note('n1', 1, 'first'), checkpoint('notes', 1)]);
  const first = newest(destination);
  await pass([note('n1', 2, 'second'), note('n2', 1), checkpoint('notes', 2)]);
  const second = newest(destination);
  await pass([
    { type: 'DELETE', stream: 'notes', key: { id: 'n2' } },
    note('n3', 1),
    checkpoint('notes', 3),
  ]);
  const read = asOf(destination, 'SELECT * FROM notes ORDER BY id', second);
  using direct = open(destination.path, { readOnly: true });
  using federation = open(':memory:');
  federation.prepare('ATTACH DATABASE ? AS "hidden"').run(destination.path);
  const select = (
    database: DatabaseSync,
    position: string,
    schema?: string,
  ) => {
    const sql = asOfSelect(database, 'notes', position, { schema });
    if (typeof sql !== 'string') assert.fail(sql.expired);
    return database
      .prepare(`SELECT * FROM (${sql}) ORDER BY id`)
      .all()
      .map((row) => ({ ...row }));
  };

  const fromFile = select(direct, second);
  const fromAttached = select(federation, second, 'hidden');
  outwait();
  await pass([note('n4', 1), checkpoint('notes', 4)]);
  const expired = asOfSelect(direct, 'notes', first);

  assert.equal(read.length, 2);
  assert.deepEqual(fromFile, read);
  assert.deepEqual(fromAttached, read);
  assert.ok(typeof expired !== 'string', 'the select is expired');
  assert.match(expired.expired, /retention/);
});
