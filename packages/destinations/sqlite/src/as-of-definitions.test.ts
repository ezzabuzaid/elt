import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
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
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  View,
  asOfDefinitions,
  asOfFunctions,
  installSQLiteCatalog,
} from './index.ts';

// Reads the messages a test scripts for each stream, keyed by its name.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #steps: Readonly<Record<string, readonly SourceMessage[]>>;

  constructor(
    streams: readonly Stream[],
    steps: Readonly<Record<string, readonly SourceMessage[]>>,
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
    yield* this.#steps[configuration.stream.name] ?? [];
  }
}

// The wall time of every pass, which a retention test moves past its
// window, as the retention tests do.
let now = Date.now();
const clock = {
  Date: { now: () => now },
  performance,
  setTimeout,
  clearTimeout,
};

const notes = new Stream({
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
  emitsDeletes: true,
});

const note = (id: string, version: number, body: string) => ({
  stream: 'notes',
  data: { id, version, body },
});
const removed = (id: string) => ({
  type: 'DELETE' as const,
  stream: 'notes',
  key: { id },
});
const checkpoint = (read: number) => ({
  type: 'STATE' as const,
  stream: 'notes',
  state: { read },
});

// An import as a host makes it: raw_notes with its reader view notes, a View
// over the reader view and a View over that View.
function notesImport(directory: string, retention?: Temporal.Duration) {
  const destination = new SQLiteDestination({
    path: join(directory, 'notes.sqlite'),
    ...(retention === undefined ? {} : { retention }),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const derived = [
    new View({
      into: destination,
      name: 'bodies',
      description: 'The body of each note.',
      columns: { id: 'Note id.', body: 'Text of the note.' },
      sql: 'SELECT id, body FROM notes',
    }),
    new View({
      into: destination,
      name: 'body_list',
      description: 'Every body, in order of id.',
      columns: { bodies: 'The bodies, joined.' },
      sql: "SELECT group_concat(body, ',' ORDER BY id) AS bodies FROM bodies",
    }),
  ];
  const copy = new Copy(
    notes,
    destination.table('raw_notes').withReaderView('notes'),
    {
      id: 'notes',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      cursorField: 'version',
    },
  );
  const pass = (steps: readonly SourceMessage[]) =>
    new Pipeline({
      clock,
      connections: [
        new Connection({
          name: 'notes',
          source: new Scripted([notes], { notes: steps }),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
      history: new SQLiteSyncHistory(),
      derived,
    }).run();
  return { destination, pass };
}

function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

function asOf(destination: SQLiteDestination, sql: string, position: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// A connection of a host that reads the import attached under a name of its
// own, with the views of the position under the prefix mail.
function federated(path: string, position: string): DatabaseSync {
  const database = open(':memory:');
  for (const [name, implementation] of Object.entries(asOfFunctions))
    database.function(name, implementation);
  database.prepare(`ATTACH ? AS "hidden"`).run(path);
  const definitions = asOfDefinitions(database, {
    schema: 'hidden',
    position,
    prefix: 'mail',
  });
  if ('expired' in definitions) assert.fail(definitions.expired);
  for (const definition of definitions) database.exec(definition);
  return database;
}

const rows = (database: DatabaseSync, sql: string) =>
  database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

test('the views of a position read each target, its reader view and a View over a View as that position does, and a later commit changes none of them', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, pass } = notesImport(scratch.path);
  await pass([note('n1', 1, 'a'), note('n2', 1, 'b'), checkpoint(1)]);
  await pass([note('n1', 2, 'c'), removed('n2'), checkpoint(2)]);
  const position = newest(destination);
  await pass([note('n1', 3, 'e'), note('n3', 1, 'f'), checkpoint(3)]);
  const expected = {
    target: asOf(destination, 'SELECT * FROM raw_notes', position).map(
      ({ _elt_row_hash: _, ...row }) => row,
    ),
    reader: asOf(destination, 'SELECT * FROM notes ORDER BY id', position),
    list: asOf(destination, 'SELECT * FROM body_list', position),
  };
  using database = federated(destination.path, position);

  const read = () => ({
    target: rows(database, 'SELECT * FROM mail_raw_notes'),
    reader: rows(database, 'SELECT * FROM mail_notes ORDER BY id'),
    list: rows(database, 'SELECT * FROM mail_body_list'),
  });
  const before = read();
  await pass([note('n4', 1, 'g'), removed('n1'), checkpoint(4)]);

  assert.deepEqual(expected.list, [{ bodies: 'c' }]);
  assert.deepEqual(before, expected);
  assert.deepEqual(read(), expected);
});

test('the views of a position fail through their guard, with the reason, once the retention deletes the history that position reads', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, pass } = notesImport(
    scratch.path,
    Temporal.Duration.from({ milliseconds: 20 }),
  );
  await pass([note('n1', 1, 'a'), checkpoint(1)]);
  const position = newest(destination);
  await pass([note('n1', 2, 'b'), checkpoint(2)]);
  using database = federated(destination.path, position);
  assert.deepEqual(rows(database, 'SELECT body FROM mail_raw_notes'), [
    { body: 'a' },
  ]);
  now += 60;

  await pass([note('n1', 3, 'c'), checkpoint(3)]);

  for (const view of ['mail_raw_notes', 'mail_notes', 'mail_body_list'])
    assert.throws(
      () => rows(database, `SELECT * FROM ${view}`),
      /older than the retention/,
      view,
    );
});

test('the views of a position fail through their guard when the file is made again, though its target holds no row', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, pass } = notesImport(scratch.path);
  await pass([note('n1', 1, 'a'), checkpoint(1)]);
  const position = newest(destination);
  using database = federated(destination.path, position);
  database.exec('DETACH "hidden"');
  for (const file of await readdir(scratch.path))
    await rm(join(scratch.path, file), { recursive: true });
  await pass([]);
  database.prepare(`ATTACH ? AS "hidden"`).run(destination.path);

  assert.deepEqual(
    rows(database, 'SELECT count(*) AS n FROM hidden.raw_notes'),
    [{ n: 0 }],
  );
  assert.throws(
    () => rows(database, 'SELECT * FROM mail_raw_notes'),
    /earlier numbering/,
  );
});

test('the views of the sync history, its tables and the catalog fail with a message that they cannot be read as of a position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, pass } = notesImport(scratch.path);
  await pass([note('n1', 1, 'a'), checkpoint(1)]);
  installSQLiteCatalog({ path: destination.path });
  using database = federated(destination.path, newest(destination));

  for (const view of [
    'mail_sync_attempts',
    'mail__elt_sync_attempts',
    'mail_sync_status',
    'mail_extraction_coverage',
    'mail__elt_stream_checks',
  ])
    assert.throws(
      () => rows(database, `SELECT * FROM ${view}`),
      /The sync history cannot be read as of a position/,
      view,
    );
  assert.throws(
    () => rows(database, 'SELECT * FROM mail_catalog'),
    /View "catalog" cannot be read as of a position/,
  );
});

test('the views of a position older than the retention are not made, and the reason says why', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-as-of-');
  const { destination, pass } = notesImport(
    scratch.path,
    Temporal.Duration.from({ milliseconds: 20 }),
  );
  await pass([note('n1', 1, 'a'), checkpoint(1)]);
  const position = newest(destination);
  await pass([note('n1', 2, 'b'), checkpoint(2)]);
  now += 60;
  await pass([note('n1', 3, 'c'), checkpoint(3)]);
  using database = open(':memory:');
  database.prepare(`ATTACH ? AS "hidden"`).run(destination.path);

  const definitions = asOfDefinitions(database, {
    schema: 'hidden',
    position,
    prefix: 'mail',
  });

  assert.ok('expired' in definitions);
  assert.match(definitions.expired, /older than the retention/);
});
