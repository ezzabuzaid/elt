import assert from 'node:assert/strict';
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
  Pipeline,
  Rule,
  type RuleColumn,
  type RuleResult,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  asOfDefinitions,
  asOfFunctions,
  asOfSelect,
} from './index.ts';

type Note = { readonly id: string; readonly body: string };

// Notes the test sets before each pass, copied in full each pass.
class Notes extends Source {
  readonly identity = 'notes';
  rows: readonly Note[] = [];
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        body: { type: 'string', description: 'Text of the note.' },
      },
      required: ['id', 'body'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.notes]);

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

  protected override async *extract() {
    for (const row of this.rows) yield { stream: 'notes', data: row };
  }
}

// The body of each note in capitals.
class Shout extends Rule<Note, string> {
  readonly key = { name: 'id', description: 'Note id.' };
  readonly output: Readonly<Record<string, RuleColumn>> = {
    loud: { description: 'The body in capitals.', type: 'text' },
  };
  readonly batch = 10;
  readonly concurrency = 1;

  read(row: Readonly<Record<string, unknown>>) {
    return {
      key: String(row.id),
      input: { id: String(row.id), body: String(row.body) },
    };
  }

  async identity() {
    return 'shout-v1';
  }

  async compute(
    inputs: readonly Note[],
  ): Promise<readonly RuleResult<Readonly<Record<string, string>>>[]> {
    return inputs.map(({ body }) => ({ value: { loud: body.toUpperCase() } }));
  }
}

// An import as a host makes it: raw_notes with its reader view notes, and a
// computed dataset loud_notes over the reader view's table.
function notesImport(directory: string) {
  const source = new Notes();
  const destination = new SQLiteDestination({
    path: join(directory, 'notes.sqlite'),
  });
  const target = destination.table('raw_notes').withReaderView('notes');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'loud_notes',
        description: 'Each note in capitals.',
        from: [target],
        compute: new Shout(),
      }),
    ],
  });
  // Two passes, so the first position reads rows the second replaced.
  const load = async () => {
    source.rows = [
      { id: 'n1', body: 'a' },
      { id: 'n2', body: 'b' },
    ];
    await pipeline.run();
    const first = newest(destination);
    source.rows = [{ id: 'n1', body: 'c' }];
    await pipeline.run();
    return first;
  };
  return { destination, load };
}

function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

// The columns a reader sees of a query.
const columns = (database: DatabaseSync, sql: string) =>
  database
    .prepare(sql)
    .columns()
    .map(({ name }) => name);

// The columns of each relation as a reading of the position shows it.
function readColumns(
  destination: SQLiteDestination,
  position: string,
  relations: readonly string[],
) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _reading = reading;
  return relations.map((relation) =>
    columns(reading.sql, `SELECT * FROM "${relation}"`),
  );
}

// The columns of each relation as the views of the position show it, in a
// connection of a host that attaches the import.
function definedColumns(
  destination: SQLiteDestination,
  position: string,
  relations: readonly string[],
) {
  using database = open(':memory:');
  for (const [name, implementation] of Object.entries(asOfFunctions))
    database.function(name, implementation);
  database.prepare('ATTACH ? AS "notes_file"').run(destination.path);
  const definitions = asOfDefinitions(database, {
    schema: 'notes_file',
    position,
    prefix: 'mail',
  });
  if ('expired' in definitions) assert.fail(definitions.expired);
  for (const definition of definitions) database.exec(definition);
  return relations.map((relation) =>
    columns(database, `SELECT * FROM "mail_${relation}"`),
  );
}

const stream = ['id', 'body', 'loaded_at'];
const computed = ['id', 'input_hash', 'rule', 'status', 'error', 'loud'];

test("a copy's reader view shows the stream's fields and loaded_at, and none of the destination's own columns", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-external-');
  const { destination, load } = notesImport(scratch.path);
  await load();

  using database = open(destination.path, { readOnly: true });

  assert.deepEqual(columns(database, 'SELECT * FROM notes'), stream);
});

test("a table and its reader view show the stream's fields and loaded_at as of a position: in a reading, through asOfSelect and through the views of that position or of the newest one", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-external-');
  const { destination, load } = notesImport(scratch.path);
  const first = await load();

  using database = open(destination.path, { readOnly: true });
  database.exec('BEGIN');
  const last = newest(destination);
  const selected = asOfSelect(database, 'raw_notes', first);
  if (typeof selected !== 'string') assert.fail(selected.expired);
  const selectedNewest = asOfSelect(database, 'raw_notes', last);
  if (typeof selectedNewest !== 'string') assert.fail(selectedNewest.expired);

  assert.deepEqual(
    {
      reading: readColumns(destination, first, ['raw_notes', 'notes']),
      newest: readColumns(destination, last, ['raw_notes', 'notes']),
      select: columns(database, selected),
      selectNewest: columns(database, selectedNewest),
      defined: definedColumns(destination, first, ['raw_notes', 'notes']),
      definedNewest: definedColumns(destination, last, ['raw_notes', 'notes']),
    },
    {
      reading: [stream, stream],
      newest: [stream, stream],
      select: stream,
      selectNewest: stream,
      defined: [stream, stream],
      definedNewest: [stream, stream],
    },
  );
});

test("a computed dataset's view shows the rule's columns now and as of a position, and so does its table as of a position or of the newest one, with none of the destination's own columns", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-external-');
  const { destination, load } = notesImport(scratch.path);
  const first = await load();

  using database = open(destination.path, { readOnly: true });

  assert.deepEqual(
    {
      now: columns(database, 'SELECT * FROM loud_notes'),
      reading: readColumns(destination, first, [
        'loud_notes',
        'raw_loud_notes',
      ]),
      newest: readColumns(destination, newest(destination), [
        'loud_notes',
        'raw_loud_notes',
      ]),
      defined: definedColumns(destination, first, [
        'loud_notes',
        'raw_loud_notes',
      ]),
    },
    {
      now: computed,
      reading: [computed, computed],
      newest: [computed, computed],
      defined: [computed, computed],
    },
  );
});
