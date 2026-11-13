import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles } from '@zukhruf/testing/fs';

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
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

import {
  type Condition,
  Eca,
  type Outcome,
  type Rule,
  type Warehouse,
} from './index.ts';

// The upstream of a test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a test source's read: a message, or a wait the test ends.
type Step = SourceMessage | (() => Promise<void>);

// Reads the steps a test scripts for its one stream.
class Scripted extends Source {
  readonly identity = 'scripted';
  protected readonly catalog: Catalog;
  readonly #steps: readonly Step[];

  constructor(stream: Stream, steps: readonly Step[]) {
    super();
    this.catalog = new Catalog([stream]);
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

  protected override async *extract(_configuration: CopyConfiguration) {
    for (const step of this.#steps)
      if (typeof step === 'function') await step();
      else yield step;
  }
}

// Tasks keyed by id; a newer copy of a task has a greater version.
const tasks = new Stream({
  name: 'tasks',
  jsonSchema: {
    type: 'object',
    description: 'A task.',
    properties: {
      id: { type: 'string', description: 'Task id.' },
      version: { type: 'integer', description: 'Version of the task.' },
      status: { type: 'string', description: 'open or done.' },
      due: { type: 'string', description: 'When the task is due.' },
    },
    required: ['id', 'version'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['incremental'],
});

const task = (
  id: string,
  version: number,
  status: 'open' | 'done',
  due?: Temporal.Instant,
) => ({
  stream: 'tasks',
  data: {
    id,
    version,
    status,
    ...(due === undefined ? {} : { due: `${due}` }),
  },
});
const checkpoint = (read: number) => ({
  type: 'STATE' as const,
  stream: 'tasks',
  state: { read },
});

// A SQLite file of tasks, a pass that loads the steps a test scripts into it,
// and an eca over it, as a host wires them.
function warehouse(directory: string, retention?: Temporal.Duration) {
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
    ...(retention === undefined ? {} : { retention }),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(directory, 'state.sqlite'),
  });
  const copy = new Copy(tasks, destination.table('tasks'), {
    id: 'tasks',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    cursorField: 'version',
  });
  const pass = (steps: readonly Step[]) =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source: new Scripted(tasks, steps),
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    }).run();
  const port: Warehouse<DatabaseSync> = {
    stable: async (after) => destination.positions(after),
    read: async (position) => destination.reading(position),
  };
  return {
    destination,
    pass,
    eca: () =>
      new Eca<DatabaseSync, string>({ warehouse: port, clock: globalThis }),
  };
}

// The ids of the open tasks of a reading.
function open(sql: DatabaseSync): Set<string> {
  return new Set(
    sql
      .prepare(`SELECT id FROM tasks WHERE status = 'open'`)
      .all()
      .map(({ id }) => String(id)),
  );
}

// A task that is open now and was not before.
const opened: Rule<DatabaseSync, string> = {
  condition: {
    async evaluate(before, after) {
      const was = open(before.sql);
      return [...open(after.sql)].filter((id) => !was.has(id)).sort();
    },
  },
};

// An open task whose deadline passed between the two readings.
const overdue: Rule<DatabaseSync, string> = {
  condition: {
    async evaluate(before, after) {
      return after.sql
        .prepare(`SELECT id, due FROM tasks WHERE status = 'open'`)
        .all()
        .filter(({ due }) => {
          const at = Temporal.Instant.from(String(due));
          return (
            Temporal.Instant.compare(at, before.at) > 0 &&
            Temporal.Instant.compare(at, after.at) <= 0
          );
        })
        .map(({ id }) => String(id));
    },
  },
};

// The one outcome of evaluating one rule.
async function outcome(
  eca: Eca<DatabaseSync, string>,
  rule: Rule<DatabaseSync, string>,
  cursor: string,
): Promise<Outcome<DatabaseSync, string>> {
  const outcomes = await Array.fromAsync(eca.evaluate([{ rule, cursor }]));
  assert.equal(outcomes.length, 1);
  const [only] = outcomes;
  if (only === undefined) assert.fail('no outcome');
  return only;
}

// The matches and the cursor of an evaluation that ended its walk.
async function walked(
  eca: Eca<DatabaseSync, string>,
  rule: Rule<DatabaseSync, string>,
  cursor: string,
) {
  const result = await outcome(eca, rule, cursor);
  if ('expired' in result) assert.fail(result.expired);
  if ('error' in result) throw result.error;
  return result;
}

test('a rule matches what becomes true after the cursor that start gave, and the cursor it gets back does not match it again', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await eca().start();
  await pass([task('t1', 2, 'open'), checkpoint(2)]);

  const first = await walked(eca(), opened, cursor);
  const second = await walked(eca(), opened, first.cursor);

  assert.deepEqual(first.matches, ['t1']);
  assert.deepEqual(second.matches, []);
});

test('a key that stops matching and matches again between two evaluations matches again, for an eca made after a restart', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'open'), checkpoint(1)]);
  const cursor = await eca().start();
  await pass([task('t1', 2, 'done'), checkpoint(2)]);
  await pass([task('t1', 3, 'open'), checkpoint(3)]);

  const { matches } = await walked(eca(), opened, cursor);

  assert.deepEqual(matches, ['t1']);
});

test('an evaluation that only moves time matches a deadline once, when it passes', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  // Far enough ahead that the pass, the start and the first evaluation end
  // before it, also on a busy machine.
  const due = Temporal.Now.instant().add({ milliseconds: 1500 });
  await pass([task('t1', 1, 'open', due), checkpoint(1)]);
  const cursor = await eca().start();

  const early = await walked(eca(), overdue, cursor);
  await delay(due.epochMilliseconds - Date.now() + 200);
  const passed = await walked(eca(), overdue, early.cursor);
  const later = await walked(eca(), overdue, passed.cursor);

  assert.deepEqual(early.matches, []);
  assert.deepEqual(passed.matches, ['t1']);
  assert.deepEqual(later.matches, []);
});

test('a deadline that passes while its task is open matches, read with the data of that time, though a later position closed the task', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  const due = Temporal.Now.instant().add({ milliseconds: 1500 });
  await pass([task('t1', 1, 'open', due), checkpoint(1)]);
  const cursor = await eca().start();
  await delay(due.epochMilliseconds - Date.now() + 200);
  await pass([task('t1', 2, 'done', due), checkpoint(2)]);

  const { matches } = await walked(eca(), overdue, cursor);

  assert.deepEqual(matches, ['t1']);
});

test('a cursor older than the retention of the warehouse is expired, and the host hears why', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(
    scratch.path,
    Temporal.Duration.from({ seconds: 1 }),
  );
  await pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await eca().start();
  await pass([task('t1', 2, 'open'), checkpoint(2)]);
  await delay(1500);
  await pass([task('t1', 3, 'done'), checkpoint(3)]);

  const result = await outcome(eca(), opened, cursor);

  assert.ok('expired' in result, JSON.stringify(result));
  assert.equal(result.rule, opened);
  assert.match(result.expired, /retention/);
});

test('a cursor of a warehouse that a fresh run made again is expired', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const first = warehouse(scratch.path);
  await first.pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await first.eca().start();
  // The write-ahead log persists beside each file, so it goes with it.
  for (const file of ['data.sqlite', 'state.sqlite'])
    for (const suffix of ['', '-wal', '-shm'])
      await rm(join(scratch.path, `${file}${suffix}`), { force: true });
  const again = warehouse(scratch.path);
  await again.pass([task('t1', 1, 'open'), checkpoint(1)]);

  const result = await outcome(again.eca(), opened, cursor);

  assert.ok('expired' in result, JSON.stringify(result));
  assert.match(result.expired, /earlier numbering/);
});

test('a condition that throws at a step gives the matches of the steps before it and a cursor after the last good step, and the next evaluation goes on from there', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { destination, pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await eca().start();
  await pass([task('t1', 2, 'open'), checkpoint(2)]);
  await pass([task('t2', 1, 'open'), checkpoint(3)]);
  const third = destination.positions();
  if ('expired' in third) assert.fail(third.expired);
  const broken = third.at(-1);
  await pass([task('t3', 1, 'open'), checkpoint(4)]);
  const failing: Rule<DatabaseSync, string> = {
    condition: {
      async evaluate(before, after) {
        if (after.position === broken) throw new Error('the condition broke');
        return opened.condition.evaluate(before, after);
      },
    },
  };

  const failed = await outcome(eca(), failing, cursor);
  if (!('error' in failed)) assert.fail(JSON.stringify(failed));
  const resumed = await walked(eca(), opened, failed.cursor);

  assert.deepEqual(failed.matches, ['t1']);
  assert.match(String(failed.error), /the condition broke/);
  assert.deepEqual(resumed.matches, ['t2', 't3']);
});

test('a rule that the host pauses and resumes matches, at resume, what each position it missed made true', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), task('t2', 1, 'done'), checkpoint(1)]);
  const paused = await eca().start();
  await pass([task('t1', 2, 'open'), checkpoint(2)]);
  await pass([task('t2', 2, 'open'), checkpoint(3)]);
  await pass([task('t1', 3, 'done'), checkpoint(4)]);

  const { matches } = await walked(eca(), opened, paused);

  assert.deepEqual(matches, ['t1', 't2']);
});

test('an evaluation while a pass is half done reads up to the position before that pass, and the next one reads the pass once it ends', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await eca().start();
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const running = pass([
    task('t1', 2, 'open'),
    checkpoint(2),
    async () => {
      reached.resolve();
      await released.promise;
    },
    task('t2', 1, 'open'),
    checkpoint(3),
  ]);
  await reached.promise;

  const during = await walked(eca(), opened, cursor);
  released.resolve();
  await running;
  const after = await walked(eca(), opened, during.cursor);

  assert.deepEqual(during.matches, []);
  assert.deepEqual(after.matches, ['t1', 't2']);
});

test('each rule of an evaluation gives its own outcome, in order, and one whose condition throws stops no other', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), checkpoint(1)]);
  const cursor = await eca().start();
  await pass([task('t1', 2, 'open'), checkpoint(2)]);
  const throwing: Rule<DatabaseSync, string> = {
    condition: {
      async evaluate() {
        throw new Error('broken');
      },
    } satisfies Condition<DatabaseSync, string>,
  };

  const outcomes = await Array.fromAsync(
    eca().evaluate([
      { rule: throwing, cursor },
      { rule: opened, cursor },
    ]),
  );

  assert.deepEqual(
    outcomes.map((result) => [result.rule, 'error' in result]),
    [
      [throwing, true],
      [opened, false],
    ],
  );
  const [failed, matched] = outcomes;
  assert.ok(failed !== undefined && 'cursor' in failed);
  assert.equal(failed.cursor, cursor);
  assert.ok(matched !== undefined && 'matches' in matched);
  assert.deepEqual(matched.matches, ['t1']);
});

test('a cursor that eca did not make is a TypeError', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { pass, eca } = warehouse(scratch.path);
  await pass([task('t1', 1, 'done'), checkpoint(1)]);

  await assert.rejects(
    Array.fromAsync(eca().evaluate([{ rule: opened, cursor: 'tasks:1' }])),
    TypeError,
  );
});

test('start on a warehouse that has no position yet throws, with the reason the warehouse gives', async () => {
  await using scratch = await new TemporaryFiles().directory('eca-');
  const { eca } = warehouse(scratch.path);

  await assert.rejects(eca().start(), /no load has committed|no position/i);
});
