import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { Latch } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import {
  Connection,
  Copy,
  IterableSource,
  Pipeline,
  type PipelineClock,
  Rule,
  type RuleColumns,
  type RuleResult,
  type RuleValues,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';
import { storedRows } from './testing/stored-rows.ts';

type Note = { readonly id: string; readonly text: string };

const notesSchema = {
  description: 'One notes record.',
  type: 'object',
  properties: {
    id: { description: 'Id of the record.', type: 'string' },
    text: { description: 'Text of the record.', type: 'string' },
  },
  required: ['id', 'text'],
} as const;

// Each note's text in capitals, one note a call; a note whose text starts
// with "bad" fails, one whose text starts with "throw" fails the call, and a
// call for a note in holding waits until the test releases it.
class Shout extends Rule<Note, RuleColumns> {
  readonly key = { name: 'id', description: 'Note id.' };
  readonly output: RuleColumns;
  readonly batch = 1;
  readonly concurrency = 1;
  readonly holding = new Map<string, Hold>();

  constructor(
    output: RuleColumns = {
      loud: { description: 'The text in capitals.', type: 'text' },
    },
  ) {
    super();
    this.output = output;
  }

  read(row: Readonly<Record<string, unknown>>) {
    return {
      key: String(row.id),
      input: { id: String(row.id), text: String(row.text) },
    };
  }

  async identity() {
    return 'shout-v1';
  }

  async compute(
    inputs: readonly Note[],
  ): Promise<readonly RuleResult<RuleValues<RuleColumns>>[]> {
    const results = [];
    for (const { id, text } of inputs) {
      const held = this.holding.get(id);
      held?.reached.open();
      await held?.released.wait();
      if (text.startsWith('throw')) throw new Error(`${id} threw`);
      results.push(
        text.startsWith('bad')
          ? { error: `${id} is bad` }
          : {
              value: Object.fromEntries(
                Object.keys(this.output).map((column) => [
                  column,
                  `${text.toUpperCase()}:${column}`,
                ]),
              ),
            },
      );
    }
    return results;
  }
}

// A wait the test ends, and a latch that opens once a call reached it.
class Hold {
  readonly reached = new Latch();
  readonly released = new Latch();
}

function shouted(
  directory: string,
  rule = new Shout(),
  clock: PipelineClock = globalThis,
) {
  // Notes the test sets before each run, copied in full each pass.
  const host: { rows: readonly Note[] } = { rows: [] };
  const source = new IterableSource({
    identity: 'notes',
    streams: {
      notes: {
        description: 'The notes that the test sets.',
        jsonSchema: notesSchema,
        primaryKey: ['id'],
        snapshot: () => host.rows,
      },
    },
  });
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('notes');
  const pipeline = new Pipeline({
    clock,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.streams.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'loud_notes',
        description: 'Each note in capitals.',
        from: [target],
        compute: rule,
      }),
    ],
  });
  return { host, destination, pipeline, rule };
}

// The commit numbers of the file's positions.
function walkable(destination: SQLiteDestination): number[] {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  return positions.map((position) => Number(position.split(':')[1]));
}

function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

// What a query showed as of a position.
function asOf(destination: SQLiteDestination, position: string, sql: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _ = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

const loud = 'SELECT id, status, loud, error FROM loud_notes ORDER BY id';

const commitsOfRefreshes = (destination: SQLiteDestination) =>
  storedRows(
    destination.path,
    "SELECT c.number, c.committed_at FROM _elt_commits AS c JOIN _elt_loads AS l ON l.id = c.load WHERE l.dataset = 'loud_notes' ORDER BY c.number",
  );

const committed = (destination: SQLiteDestination) =>
  storedRows(
    destination.path,
    'SELECT id, committed_in FROM raw_loud_notes ORDER BY id',
  );

test('the view of a computed dataset, read as of a position, shows the rows it had there after a later refresh changed one', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const { host, destination, pipeline } = shouted(scratch.path);
  host.rows = [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ];
  await pipeline.run();
  const first = newest(destination);
  const then = storedRows(destination.path, loud);
  host.rows = [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'three' },
  ];

  await pipeline.run();

  assert.deepEqual(then, [
    { id: 'a', status: 'computed', loud: 'ONE:loud', error: null },
    { id: 'b', status: 'computed', loud: 'TWO:loud', error: null },
  ]);
  assert.deepEqual(storedRows(destination.path, loud), [
    { id: 'a', status: 'computed', loud: 'ONE:loud', error: null },
    { id: 'b', status: 'computed', loud: 'THREE:loud', error: null },
  ]);
  assert.deepEqual(asOf(destination, first, loud), then);
});

test('a row whose input a later pass removed still reads as of a position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const { host, destination, pipeline } = shouted(scratch.path);
  host.rows = [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ];
  await pipeline.run();
  const first = newest(destination);
  host.rows = [{ id: 'a', text: 'one' }];

  await pipeline.run();

  assert.deepEqual(storedRows(destination.path, loud), [
    { id: 'a', status: 'computed', loud: 'ONE:loud', error: null },
  ]);
  assert.deepEqual(asOf(destination, first, loud), [
    { id: 'a', status: 'computed', loud: 'ONE:loud', error: null },
    { id: 'b', status: 'computed', loud: 'TWO:loud', error: null },
  ]);
});

test('a row the rule makes again with the same values keeps its commit, beside a row of the same refresh that changed, and a refresh that changes nothing commits nothing', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const { host, destination, pipeline } = shouted(scratch.path);
  host.rows = [
    { id: 'a', text: 'bad one' },
    { id: 'b', text: 'two' },
  ];
  await pipeline.run();
  const first = committed(destination);
  const firstPosition = newest(destination);
  host.rows = [
    { id: 'a', text: 'bad one' },
    { id: 'b', text: 'three' },
  ];

  // The failed row is tried again, and fails as before.
  await pipeline.run();
  const second = committed(destination);
  const secondPosition = newest(destination);
  const changing = commitsOfRefreshes(destination);
  await pipeline.run();

  // A failed row is the one the rule makes again from the same input and
  // rule, so it is the row that can come back with the same values.
  assert.deepEqual(second[0], first[0]);
  assert.ok(
    Number(second[1]?.committed_in) > Number(first[1]?.committed_in),
    JSON.stringify({ first, second }),
  );
  assert.deepEqual(committed(destination), second);
  assert.ok(changing.length > 0);
  assert.deepEqual(commitsOfRefreshes(destination), changing);
  assert.deepEqual(asOf(destination, firstPosition, loud), [
    { id: 'a', status: 'failed', loud: null, error: 'a is bad' },
    { id: 'b', status: 'computed', loud: 'TWO:loud', error: null },
  ]);
  assert.deepEqual(asOf(destination, secondPosition, loud), [
    { id: 'a', status: 'failed', loud: null, error: 'a is bad' },
    { id: 'b', status: 'computed', loud: 'THREE:loud', error: null },
  ]);
});

test('a commit of a refresh that still runs is no position, and once it ends each of its commits has its own number and its end is one', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const { host, destination, pipeline, rule } = shouted(scratch.path);
  host.rows = [{ id: 'a', text: 'one' }];
  await pipeline.run();
  host.rows = [
    { id: 'a', text: 'uno' },
    { id: 'b', text: 'two' },
  ];
  const held = new Hold();
  rule.holding.set('b', held);

  const running = pipeline.run();
  try {
    await held.reached.wait();
    const [a] = committed(destination);
    const during = walkable(destination);
    held.released.open();
    await running;
    const [, b] = committed(destination);

    assert.ok(a !== undefined, 'a was not committed while b was held');
    assert.ok(during.length > 0, 'the run before is no position');
    assert.ok(
      during.every((number) => number < Number(a.committed_in)),
      JSON.stringify({ during, a }),
    );
    assert.ok(Number(b?.committed_in) > Number(a.committed_in));
    assert.ok(!walkable(destination).includes(Number(a.committed_in)));
    assert.deepEqual(walkable(destination).slice(-1), [
      Number(b?.committed_in),
    ]);
  } finally {
    held.released.open();
    await running.catch(() => {});
  }
});

test('a refresh whose rule throws closes its load, so its commits up to the failure end at a position', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const { host, destination, pipeline } = shouted(scratch.path);
  host.rows = [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'throw two' },
  ];

  await assert.rejects(pipeline.run(), /b threw/);

  const [a, b] = committed(destination);
  assert.equal(b, undefined);
  assert.equal(walkable(destination).at(-1), Number(a?.committed_in));
});

test('a refresh that a killed process left open hides every later position, until the next refresh of its dataset closes it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const path = join(scratch.path, 'data.sqlite');
  // A process that loads two notes and is killed while the rule computes
  // the second, after the first one's commit.
  const killedRun = `
    import { Connection, Copy, IterableSource, Pipeline, Rule } from '@eltjs/elt';
    import { ComputedDataset, SQLiteDestination, SQLiteSyncHistory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
    class Shout extends Rule {
      key = { name: 'id', description: 'Note id.' };
      output = { loud: { description: 'The text in capitals.', type: 'text' } };
      batch = 1;
      concurrency = 1;
      read(row) { return { key: String(row.id), input: { id: String(row.id), text: String(row.text) } }; }
      async identity() { return 'shout-v1'; }
      async compute([{ id, text }]) {
        if (id === 'b') { process.stdout.write('committed\\n'); await new Promise(() => setInterval(() => {}, 1 << 30)); }
        return [{ value: { loud: text.toUpperCase() + ':loud' } }];
      }
    }
    const source = new IterableSource({ identity: 'notes', streams: { notes: { description: 'Two notes.', jsonSchema: { type: 'object', description: 'A note.', properties: { id: { type: 'string', description: 'Note id.' }, text: { type: 'string', description: 'Note text.' } }, required: ['id', 'text'] }, primaryKey: ['id'], snapshot: () => [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] } } });
    const destination = new SQLiteDestination({ path: process.env.DATABASE });
    const target = destination.table('notes');
    await new Pipeline({ clock: globalThis, history: new SQLiteSyncHistory(),
      connections: [new Connection({ name: 'notes', source, destination, steps: [new Copy(source.streams.notes, target)] })],
      derived: [new ComputedDataset({ into: destination, name: 'loud_notes', description: 'Each note in capitals.', from: [target], compute: new Shout() })],
    }).run();
  `;
  const killed = spawn(
    process.execPath,
    ['--input-type=module', '-e', killedRun],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, DATABASE: path },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const exited = once(killed, 'exit');
  await Promise.race([
    once(killed.stdout, 'data'),
    exited.then(() => assert.fail('the process ended before its commit')),
  ]);
  killed.kill('SIGKILL');
  await exited;
  const { host, destination, pipeline } = shouted(scratch.path);
  const [a] = committed(destination);
  const left = walkable(destination);
  host.rows = [
    { id: 'a', text: 'one' },
    { id: 'b', text: 'two' },
  ];

  await pipeline.run();

  assert.ok(a !== undefined, 'the killed refresh never committed a');
  assert.ok(
    left.every((number) => number < Number(a.committed_in)),
    JSON.stringify({ left, a }),
  );
  const after = walkable(destination);
  assert.ok(after.includes(Number(a.committed_in)), JSON.stringify(after));
  assert.equal(
    after.at(-1),
    Number(
      storedRows(path, 'SELECT max(number) AS newest FROM _elt_commits')[0]
        ?.newest,
    ),
  );
});

test('a refresh that remakes its table for a new declaration keeps the rows of the old one, so they read as of a position before it', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const before = shouted(scratch.path);
  before.host.rows = [{ id: 'a', text: 'one' }];
  await before.pipeline.run();
  const first = newest(before.destination);
  const after = shouted(
    scratch.path,
    new Shout({
      loud: { description: 'The text in capitals.', type: 'text' },
      louder: { description: 'The text in capitals again.', type: 'text' },
    }),
  );
  after.host.rows = [{ id: 'a', text: 'two' }];

  await after.pipeline.run();

  assert.deepEqual(
    storedRows(
      after.destination.path,
      'SELECT id, loud, louder FROM loud_notes',
    ),
    [{ id: 'a', loud: 'TWO:loud', louder: 'TWO:louder' }],
  );
  assert.deepEqual(
    asOf(after.destination, first, 'SELECT id, loud, louder FROM loud_notes'),
    [{ id: 'a', loud: 'ONE:loud', louder: null }],
  );
});

test('a commit of a refresh is made at the time of the pipeline clock', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-computed-');
  const at = Date.parse('2001-02-03T04:05:06.000Z');
  const { host, destination, pipeline } = shouted(scratch.path, new Shout(), {
    Date: { now: () => at },
    performance,
    setTimeout,
    clearTimeout,
  });
  host.rows = [{ id: 'a', text: 'one' }];

  await pipeline.run();

  const commits = commitsOfRefreshes(destination);
  assert.ok(commits.length > 0);
  for (const { committed_at } of commits)
    assert.equal(committed_at, '2001-02-03T04:05:06.000Z');
});
