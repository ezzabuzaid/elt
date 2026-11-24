import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads the messages a test scripts for its stream.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #messages: readonly SourceMessage[];

  constructor(stream: Stream, messages: readonly SourceMessage[]) {
    super();
    this.catalog = new Catalog([stream]);
    this.#messages = messages;
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

  protected override async *extract(_configuration: CopyConfiguration) {
    yield* this.#messages;
  }
}

// Notes keyed by id; a newer copy of a note has a greater version, and the
// upstream deletes a note at a version too.
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
  supportedSyncModes: ['full_refresh', 'incremental'],
  emitsDeletes: true,
});

const note = (id: string, version: number, body = `${id}@${version}`) => ({
  stream: 'notes',
  data: { id, version, body },
});
const tombstone = (id: string, cursor: string | number) => ({
  type: 'DELETE' as const,
  stream: 'notes',
  key: { id },
  cursor,
});
const checkpoint = (read: number) => ({
  type: 'STATE' as const,
  stream: 'notes',
  state: { read },
});

// An incremental copy that keeps the newest version of each note:
// cursor_newer, as a copy with a cursor field deduplicates by default.
const incremental = (destination: SQLiteDestination) =>
  new Copy(notes, destination.table('notes'), {
    id: 'notes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });

// A file, its checkpoints, and a pass of one copy that reads the messages
// a test scripts for it.
function notesFile(directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const pass = (
    messages: readonly SourceMessage[],
    copy: Copy<SQLiteTable> = incremental(destination),
  ) =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'notes',
          source: new Scripted(notes, messages),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    }).run();
  const loaded = () =>
    storedRows(
      destination.path,
      'SELECT id, version, body FROM notes ORDER BY id',
    );
  return { destination, checkpoints, pass, loaded };
}

// What each copy of a run read and deleted.
const counts = (results: readonly { count: number; deleted: number }[]) =>
  results.map(({ count, deleted }) => ({ count, deleted }));

// The newest position of the file.
function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

// The rows that commits replaced or removed from the notes, as their history
// keeps them.
function replaced(destination: SQLiteDestination) {
  const [recorded] = storedRows(
    destination.path,
    "SELECT history FROM _elt_histories WHERE target = 'raw_notes'",
  );
  if (recorded === undefined) assert.fail('notes have no history');
  return storedRows(
    destination.path,
    `SELECT id, version, body FROM "${String(recorded.history)}" ORDER BY id, version`,
  );
}

// The rows a query reads as of a position.
function asOf(destination: SQLiteDestination, sql: string, position: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// The commit that wrote each stored note. The commit is internal, so only
// the raw table shows it.
const commits = (destination: SQLiteDestination) =>
  storedRows(
    destination.path,
    'SELECT id, committed_in FROM raw_notes ORDER BY id',
  );

test('a DELETE without a cursor fails the run of a cursor_newer copy, naming the stream, and the stored row stays', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), checkpoint(1)]);

  const run = pass([
    { type: 'DELETE', stream: 'notes', key: { id: 'a' } },
    checkpoint(2),
  ]);

  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.errors[0] instanceof TypeError);
    assert.match(
      error.errors[0].message,
      /^DELETE for notes must carry cursor, its value of version/,
    );
    return true;
  });
  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('a DELETE with a cursor fails the run of a replace copy, naming the stream, as no rule of that copy compares it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, pass, loaded } = notesFile(scratch.path);
  const replace = new Copy(notes, destination.table('notes'), {
    id: 'notes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
    dedupPolicy: 'replace',
  });
  await pass([note('a', 5), checkpoint(1)], replace);

  const run = pass([tombstone('a', 7), checkpoint(2)], replace);

  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.errors[0] instanceof TypeError);
    assert.match(
      error.errors[0].message,
      /^DELETE for notes carries a cursor, which only a cursor_newer copy compares/,
    );
    return true;
  });
  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test("a DELETE whose cursor is not of the cursor field's type fails the run, naming the stream, with the value check's error as its cause", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), checkpoint(1)]);

  const run = pass([tombstone('a', '7'), checkpoint(2)]);

  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PipelineError);
    const [refused] = error.errors;
    assert.ok(refused instanceof TypeError);
    assert.equal(
      refused.message,
      'DELETE for notes has an invalid cursor version',
    );
    assert.ok(refused.cause instanceof TypeError);
    assert.equal(
      refused.cause.message,
      'Key/cursor field version requires non-null integer',
    );
    return true;
  });
  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('a tombstone older than the stored row deletes nothing: the row keeps its body and its commit, and the history keeps no copy of it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), checkpoint(1)]);
  const before = newest(destination);
  const written = commits(destination);

  const result = await pass([tombstone('a', 3), checkpoint(2)]);

  // The run counts each deletion it applied, as it counts each record that
  // cursor_newer discards.
  assert.deepEqual(counts(result), [{ count: 0, deleted: 1 }]);
  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
  assert.deepEqual(commits(destination), written);
  assert.deepEqual(replaced(destination), []);
  assert.deepEqual(asOf(destination, 'SELECT id, version FROM notes', before), [
    { id: 'a', version: 5 },
  ]);
});

test('a tombstone newer than the stored row deletes it, and the history keeps the row', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), checkpoint(1)]);

  const result = await pass([tombstone('a', 7), checkpoint(2)]);

  assert.deepEqual(counts(result), [{ count: 0, deleted: 1 }]);
  assert.deepEqual(loaded(), []);
  assert.deepEqual(replaced(destination), [
    { id: 'a', version: 5, body: 'a@5' },
  ]);
});

test('a tombstone with the cursor of the stored row deletes nothing, as a record with that cursor replaces nothing', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), checkpoint(1)]);

  await pass([tombstone('a', 5), checkpoint(2)]);

  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
  assert.deepEqual(replaced(destination), []);
});

test('in one commit, a tombstone older than a record before it loses to the record', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);

  await pass([note('a', 5), tombstone('a', 3), checkpoint(1)]);

  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
});

test('in one commit, a tombstone newer than the records on both sides of it wins, so neither record loads', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);

  await pass([note('a', 1), tombstone('a', 6), note('a', 3), checkpoint(1)]);

  assert.deepEqual(loaded(), []);
});

test('in one commit, of a record and a tombstone with the same cursor the first wins, whichever it is', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);
  await pass([note('b', 2), checkpoint(1)]);

  await pass([
    note('a', 4),
    tombstone('a', 4),
    tombstone('b', 4),
    note('b', 4),
    checkpoint(2),
  ]);

  assert.deepEqual(loaded(), [{ id: 'a', version: 4, body: 'a@4' }]);
});

test('in one commit, of two tombstones the greatest cursor wins, whichever comes first', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { pass, loaded } = notesFile(scratch.path);
  await pass([note('a', 5), note('b', 5), checkpoint(1)]);

  await pass([
    tombstone('a', 7),
    tombstone('a', 3),
    tombstone('b', 3),
    tombstone('b', 7),
    checkpoint(2),
  ]);

  assert.deepEqual(loaded(), []);
});

test('a replay after a reset of the checkpoint changes nothing: its old tombstone keeps the newer row, which keeps its commit, and the history gains no row', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, checkpoints, pass, loaded } = notesFile(scratch.path);
  const changes = [
    note('a', 1),
    checkpoint(1),
    tombstone('a', 2),
    checkpoint(2),
    note('a', 3),
    checkpoint(3),
  ];
  await pass(changes);
  const written = commits(destination);
  const history = replaced(destination);

  await checkpoints.reset('notes');
  await pass(changes);

  assert.deepEqual(loaded(), [{ id: 'a', version: 3, body: 'a@3' }]);
  assert.deepEqual(commits(destination), written);
  assert.deepEqual(history, [{ id: 'a', version: 1, body: 'a@1' }]);
  assert.deepEqual(replaced(destination), history);
});

test('a full refresh that replaces its target ranks tombstones with records by cursor too', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-guard-');
  const { destination, pass, loaded } = notesFile(scratch.path);
  const refresh = new Copy(notes, destination.table('notes'), {
    id: 'notes',
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite_dedup',
    cursorField: 'version',
  });

  await pass(
    [note('a', 5), tombstone('a', 3), note('b', 1), tombstone('b', 2)],
    refresh,
  );

  assert.deepEqual(loaded(), [{ id: 'a', version: 5, body: 'a@5' }]);
});
