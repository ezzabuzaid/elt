import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  Gauge,
  Pipeline,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import { PostgresDestination, PostgresSyncHistory } from './index.ts';

const databases = new Postgres({ environment: process.env });

class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A step of a read: a message, or a wait the test ends.
type Step = SourceMessage | (() => Promise<void>);

// Reads the notes stream, one step after another.
class Scripted extends Source {
  readonly identity = 'scripted';
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.notes]);
  readonly #steps: readonly Step[];

  constructor(steps: readonly Step[]) {
    super();
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

  protected override async *extract() {
    for (const step of this.#steps)
      if (typeof step === 'function') await step();
      else yield step;
  }
}

function notes(url: string, steps: readonly Step[]) {
  const source = new Scripted(steps);
  const destination = new PostgresDestination({ url, schema: 'raw' });
  return new Connection({
    name: 'notes',
    source,
    destination,
    steps: [new Copy(source.notes, destination.table('notes'))],
  });
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

function client(url: string, stack: AsyncDisposableStack): postgres.Sql {
  return stack.adopt(postgres(url, { max: 1, onnotice: () => {} }), (sql) =>
    sql.end(),
  );
}

const attempts = async (sql: postgres.Sql) => [
  ...(await sql`
    SELECT status, error, failure_type FROM marts.sync_attempts ORDER BY attempt_id`),
];

// Waits until no session of the sync history is open in the database.
async function historySessionsEnd(
  sql: postgres.Sql,
  signal: AbortSignal,
): Promise<void> {
  await waitFor(
    async () => {
      const [open] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'elt-sync-history'`;
      assert.equal(open?.n, 0, 'a session of the sync history is open');
    },
    { signal, interval: 20 },
  );
}

test('a pass that a killed process left running stays running until the next attempt of its connection, which records it as failed, and a pass leaves no session open', async (t) => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  // A process that begins a pass of notes, then is killed while it reads.
  const pass = `
    import { Catalog, Connection, Copy, Gauge, Pipeline, Source, Stream } from '@eltjs/elt';
    import { PostgresDestination, PostgresSyncHistory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'index.ts')).href)};
    class Hanging extends Source {
      identity = 'hanging';
      notes = new Stream({
        name: 'notes',
        jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
        supportedSyncModes: ['full_refresh'],
      });
      catalog = new Catalog([this.notes]);
      coverage() { return { description: 'test', selection: {} }; }
      async currentAsOf() { return null; }
      async open() { return new AsyncDisposableStack(); }
      changeSignals(streams) { return [{ gauge: new (class extends Gauge { async read() { return 0; } })(), streams, interval: 1000, timeout: 1000 }]; }
      async *extract() {
        process.stdout.write('reading\\n');
        await new Promise(() => setInterval(() => {}, 1 << 30));
      }
    }
    const url = process.env.DATABASE;
    const source = new Hanging();
    const destination = new PostgresDestination({ url, schema: 'raw' });
    await new Pipeline({ clock: globalThis,
      connections: [new Connection({ name: 'notes', source, destination, steps: [new Copy(source.notes, destination.table('notes'))] })],
      history: new PostgresSyncHistory({ url }),
    }).run();
  `;
  const killed = spawn(process.execPath, ['--input-type=module', '-e', pass], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATABASE: url },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(killed, 'exit');
  await Promise.race([
    once(killed.stdout, 'data'),
    exited.then(() => assert.fail('the process ended before its pass read')),
  ]);
  killed.kill('SIGKILL');
  await exited;
  await historySessionsEnd(sql, t.signal);
  const left = await attempts(sql);

  await new Pipeline({
    clock: globalThis,
    connections: [notes(url, [{ stream: 'notes', data: { id: 'n1' } }])],
    history: new PostgresSyncHistory({ url }),
  }).run();

  const ended = {
    status: 'failed',
    error:
      'The session running this pass ended before the pass did: its process stopped, or lost the database',
    failure_type: 'system',
  };
  const succeeded = { status: 'succeeded', error: null, failure_type: null };
  assert.deepEqual(left, [
    { status: 'running', error: null, failure_type: null },
  ]);
  assert.deepEqual(await attempts(sql), [ended, succeeded]);
  assert.deepEqual(
    [
      ...(await sql`
        SELECT c.status, c.failures->0->>'error' AS error
        FROM marts.extraction_coverage c ORDER BY c.attempt_id`),
    ],
    [
      { status: 'failed', error: ended.error },
      { status: 'succeeded', error: null },
    ],
  );
  await historySessionsEnd(sql, t.signal);
});

test('an attempt that begins while a pass of its connection runs, as a failed change signal records one, leaves that pass running', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = client(url, clients);
  const wait = latch();
  const connection = notes(url, [
    wait.step,
    { stream: 'notes', data: { id: 'n1' } },
  ]);
  const history = new PostgresSyncHistory({ url });
  const passing = new Pipeline({
    clock: globalThis,
    connections: [connection],
    history,
  }).run();
  await wait.reached;
  {
    await using signal = await history.begin(connection, [], new Date());
    await signal.fail(
      new Error('The change signal failed'),
      'system',
      new Date(),
    );
  }

  const during = await attempts(sql);
  wait.release();
  await passing;

  const signalled = {
    status: 'failed',
    error: 'The change signal failed',
    failure_type: 'system',
  };
  assert.deepEqual(during, [
    { status: 'running', error: null, failure_type: null },
    signalled,
  ]);
  assert.deepEqual(await attempts(sql), [
    { status: 'succeeded', error: null, failure_type: null },
    signalled,
  ]);
});
