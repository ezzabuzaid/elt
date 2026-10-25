import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  LeaderFirst,
  OnDemand,
  OrderedReady,
  Parallel,
  Pool,
  type Worker,
} from './index.ts';

// A real child process: it warms up when the test releases it, then echoes
// each line back. A line "hang" never gets an answer.
const script = `
const lines = require('node:readline').createInterface({ input: process.stdin });
let ready = false;
lines.on('line', (line) => {
  if (!ready) {
    if (line === 'go') { ready = true; process.stdout.write('ready\\n'); }
    if (line === 'fail') process.exit(3);
    return;
  }
  if (line !== 'hang') process.stdout.write(line + '\\n');
});
`;

class EchoWorker implements Worker {
  readonly #child = spawn(process.execPath, ['-e', script]);
  readonly #waiting: ((line: string) => void)[] = [];
  readonly closed: Promise<void>;
  readonly ready: Promise<void>;
  dead = false;

  constructor() {
    createInterface({ input: this.#child.stdout }).on('line', (line) =>
      this.#waiting.shift()?.(line),
    );
    this.closed = new Promise((resolve) =>
      this.#child.once('close', () => {
        this.dead = true;
        resolve();
      }),
    );
    this.ready = this.#next().then(() => undefined);
    this.ready.catch(() => undefined);
  }

  get pid(): number {
    return this.#child.pid!;
  }

  release(): void {
    this.#child.stdin.write('go\n');
  }

  fail(): void {
    this.#child.stdin.write('fail\n');
  }

  echo(text: string): Promise<string> {
    this.#child.stdin.write(`${text}\n`);
    return this.#next();
  }

  #next(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#waiting.push(resolve);
      void this.closed.then(() => reject(new Error('Echo worker exited')));
    });
  }

  kill(): void {
    this.dead = true;
    this.#child.kill();
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.closed;
  }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition never held');
    await setTimeout(10);
  }
}

test('an on-demand pool starts no worker until a job needs one, then reuses it', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 2,
    startup: new OnDemand(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
  });
  await pool.ready;
  assert.equal(created.length, 0);

  assert.equal(await pool.use((worker) => worker.echo('one')), 'one');
  assert.equal(await pool.use((worker) => worker.echo('two')), 'two');
  assert.equal(created.length, 1);

  assert.deepEqual(
    await Promise.all([
      pool.use((worker) => worker.echo('a')),
      pool.use((worker) => worker.echo('b')),
      pool.use((worker) => worker.echo('c')),
    ]),
    ['a', 'b', 'c'],
  );
  assert.equal(created.length, 2);
});

test('a parallel pool starts every worker at once', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 3,
    startup: new Parallel(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
  });
  // Nothing is ready yet, so only a parallel start reaches three workers.
  await eventually(() => created.length === 3);
  for (const worker of created) worker.release();
  await pool.ready;
});

test('an ordered-ready pool starts each worker after the previous one is ready', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 3,
    startup: new OrderedReady(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
  });
  await eventually(() => created.length === 1);
  await setTimeout(200);
  assert.equal(created.length, 1);

  created[0]!.release();
  await eventually(() => created.length === 2);
  await setTimeout(200);
  assert.equal(created.length, 2);

  created[1]!.release();
  await eventually(() => created.length === 3);
  created[2]!.release();
  await pool.ready;
});

test('a leader-first pool starts the others together once the first is ready, and replaces a crashed worker at once', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 3,
    startup: new LeaderFirst(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      // Only the leader waits for the test; it models a cold cache.
      if (created.length > 1) worker.release();
      return worker;
    },
  });
  const job = pool.use((worker) => worker.echo('during warm-up'));
  await setTimeout(200);
  assert.equal(created.length, 1, 'no worker may start beside the leader');

  created[0]!.release();
  await pool.ready;
  assert.equal(created.length, 3);
  assert.equal(await job, 'during warm-up');

  process.kill(created[1]!.pid, 'SIGKILL');
  await created[1]!.closed;
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      pool.use((worker) => worker.echo(String(index))),
    ),
  );
  assert.deepEqual(results, ['0', '1', '2']);
  assert.equal(created.length, 4);
});

test('a job aborted while it runs kills only its worker, which the next job replaces', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 2,
    startup: new Parallel(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
  });
  await pool.ready;
  const stop = new AbortController();
  const reason = new Error('Stop this job');
  const hung = pool.use((worker) => worker.echo('hang'), stop.signal);
  const other = pool.use((worker) => worker.echo('other'));
  await setTimeout(100);

  stop.abort(reason);
  await assert.rejects(hung, (error) => error === reason);
  assert.equal(await other, 'other');
  assert.equal(created[0]!.dead, true);
  assert.equal(created[1]!.dead, false);

  assert.equal(await pool.use((worker) => worker.echo('next')), 'next');
  assert.equal(created.length, 3);
  await created[0]!.closed;
});

test('a queued job aborted before its turn never runs', async () => {
  await using pool = new Pool({
    size: 1,
    startup: new Parallel(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      return worker;
    },
  });
  await pool.ready;
  const first = Promise.withResolvers<void>();
  const busy = pool.use(async (worker) => {
    await first.promise;
    return worker.echo('busy');
  });
  let ran = false;
  const stop = new AbortController();
  const queued = pool.use(async (worker) => {
    ran = true;
    return worker.echo('queued');
  }, stop.signal);

  stop.abort();
  first.resolve();
  assert.equal(await busy, 'busy');
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(ran, false);
});

test('a job aborted while its worker warms up leaves the warm-up running for later jobs', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 1,
    startup: new LeaderFirst(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
  });
  const stop = new AbortController();
  const waiting = pool.use((worker) => worker.echo('never'), stop.signal);

  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(created[0]!.dead, false);

  created[0]!.release();
  await pool.ready;
  assert.equal(await pool.use((worker) => worker.echo('later')), 'later');
  assert.equal(created.length, 1);
});

test('a worker that fails to start fails the job waiting for it, and the next job starts another', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: 1,
    startup: new OnDemand(),
    create: () => {
      const worker = new EchoWorker();
      if (created.length === 0) worker.fail();
      else worker.release();
      created.push(worker);
      return worker;
    },
  });

  await assert.rejects(
    pool.use((worker) => worker.echo('first')),
    /Echo worker exited/,
  );
  assert.equal(await pool.use((worker) => worker.echo('second')), 'second');
  assert.equal(created.length, 2);
});

test('disposing a pool stops every worker, rejects waiting and later jobs, and starts no replacement', async () => {
  const created: EchoWorker[] = [];
  const pool = new Pool({
    size: 2,
    startup: new OrderedReady(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
  });
  await eventually(() => created.length === 1);
  const ready = assert.rejects(pool.ready);
  const jobs = Promise.allSettled(
    Array.from({ length: 3 }, () => pool.use((worker) => worker.echo('x'))),
  );

  await pool[Symbol.asyncDispose]();
  await ready;
  assert.deepEqual(
    (await jobs).map(({ status }) => status),
    ['rejected', 'rejected', 'rejected'],
  );
  await assert.rejects(
    pool.use((worker) => worker.echo('after')),
    { name: 'AbortError' },
  );
  assert.equal(created.length, 1, 'the second worker must never start');
  assert.ok(created.every((worker) => worker.dead));
});
