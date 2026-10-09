import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import type { QueueJob } from '@workspace/queue-abstract';

import { SqliteJobQueue } from './index.ts';

function createIdGenerator(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for condition');
}

describe('SqliteJobQueue', () => {
  it('snapshots queue defaults and returns null for active exclusive duplicates', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 1800,
      heartbeatSeconds: 30,
    });
    await queue.updateQueue('chat-run', {
      retryLimit: 2,
      retryDelay: 5,
    });

    const firstJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    const duplicateJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-2' },
      { singletonKey: 'chat-1' },
    );
    const jobs = await queue.findJobs<{ streamId: string }>('chat-run', {
      key: 'chat-1',
    });

    assert.equal(firstJobId, 'id-1');
    assert.equal(duplicateJobId, null);
    assert.ok(firstJobId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.state, 'created');
    assert.equal(jobs[0]?.data.streamId, 'stream-1');
    assert.equal(jobs[0]?.retryLimit, 2);
    assert.equal(jobs[0]?.retryDelay, 5);
    assert.equal(jobs[0]?.expireInSeconds, 1800);
    assert.equal(jobs[0]?.heartbeatSeconds, 30);

    await queue.cancel('chat-run', firstJobId);
    const replacementJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-3' },
      { singletonKey: 'chat-1' },
    );

    assert.equal(replacementJobId, 'id-3');
    await queue.stop({ graceful: true, close: true });
  });

  it('aborts the active job signal when cancelling a running job', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
    });
    const jobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(jobId);

    let activeJob: QueueJob<{ streamId: string }> | undefined;
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });

    await queue.work<{ streamId: string }>(
      'chat-run',
      { localConcurrency: 1 },
      async ([job]) => {
        assert.ok(job);
        activeJob = job;
        job.signal.addEventListener('abort', resolveAborted, { once: true });
        await aborted;
      },
    );

    await waitFor(async () => activeJob !== undefined);
    assert.equal(activeJob?.signal.aborted, false);

    await queue.cancel('chat-run', jobId);
    await aborted;
    assert.equal(activeJob?.signal.aborted, true);

    await waitFor(async () => {
      const [job] = await queue.findJobs('chat-run', { id: jobId });
      return job?.state === 'cancelled';
    });

    await queue.stop({ graceful: true, close: true });
  });

  it('frees exclusive slots after cancelling or failing in-flight jobs', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
    });

    const cancelledJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(cancelledJobId);
    await queue.cancel('chat-run', cancelledJobId);

    const failedJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-2' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(failedJobId);
    await queue.fail('chat-run', failedJobId, {
      message: 'startup recovery failed active job',
    });

    const replacementJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-3' },
      { singletonKey: 'chat-1' },
    );
    const duplicateJobId = await queue.send(
      'chat-run',
      { streamId: 'stream-4' },
      { singletonKey: 'chat-1' },
    );

    assert.equal(replacementJobId, 'id-3');
    assert.equal(duplicateJobId, null);
    await queue.stop({ graceful: true, close: true });
  });

  it('claims jobs through work and completes them when the handler succeeds', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const jobId = await queue.send('chat-run', { streamId: 'stream-1' });
    assert.ok(jobId);
    const handledJobs: QueueJob<{ streamId: string }>[] = [];

    await queue.work<{ streamId: string }>(
      'chat-run',
      { localConcurrency: 1 },
      async (jobs) => {
        handledJobs.push(...jobs);
      },
    );

    await waitFor(async () => {
      const [job] = await queue.findJobs<{ streamId: string }>('chat-run', {
        id: jobId,
      });
      return job?.state === 'completed';
    });

    assert.equal(handledJobs.length, 1);
    assert.equal(handledJobs[0]?.id, jobId);
    assert.equal(handledJobs[0]?.data.streamId, 'stream-1');
    assert.ok(handledJobs[0]?.signal instanceof AbortSignal);
    await queue.stop({ graceful: true, close: true });
  });

  it('runs up to localConcurrency jobs before earlier jobs finish', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', { retryLimit: 0 });
    const firstJobId = await queue.send('chat-run', { streamId: 'stream-1' });
    const secondJobId = await queue.send('chat-run', { streamId: 'stream-2' });
    assert.ok(firstJobId);
    assert.ok(secondJobId);

    const activeJobs: QueueJob<{ streamId: string }>[] = [];
    let releaseHandlers!: () => void;
    const handlersReleased = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });

    await queue.work<{ streamId: string }>(
      'chat-run',
      { localConcurrency: 2 },
      async ([job]) => {
        assert.ok(job);
        activeJobs.push(job);
        await handlersReleased;
      },
    );

    await waitFor(async () => activeJobs.length === 2);
    assert.deepEqual(
      activeJobs.map((job) => job.id).sort(),
      [firstJobId, secondJobId].sort(),
    );

    releaseHandlers();
    await waitFor(async () => {
      const jobs = await queue.findJobs<{ streamId: string }>('chat-run');
      return jobs.every((job) => job.state === 'completed');
    });
    await queue.stop({ graceful: true, close: true });
  });

  it('retries failed worker jobs until retryLimit is exhausted', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('automation-run', {
      retryLimit: 1,
      retryDelay: 0,
    });
    const jobId = await queue.send('automation-run', { automationId: 'a-1' });
    assert.ok(jobId);
    let attempts = 0;

    await queue.work<{ automationId: string }>(
      'automation-run',
      { localConcurrency: 1 },
      async () => {
        attempts++;
        throw new Error('handler failed');
      },
    );

    await waitFor(async () => {
      const [job] = await queue.findJobs<{ automationId: string }>(
        'automation-run',
        { id: jobId },
      );
      return job?.state === 'failed';
    });
    const [job] = await queue.findJobs<{ automationId: string }>(
      'automation-run',
      { id: jobId },
    );

    assert.equal(attempts, 2);
    assert.equal(job?.retryCount, 1);
    assert.deepEqual(job?.output, { message: 'handler failed' });
    await queue.stop({ graceful: true, close: true });
  });

  it('finds and fails active jobs for startup recovery', async () => {
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
    });
    await queue.start();
    await queue.createQueue('chat-run', {
      policy: 'exclusive',
      retryLimit: 0,
    });
    const jobId = await queue.send(
      'chat-run',
      { streamId: 'stream-1' },
      { singletonKey: 'chat-1' },
    );
    assert.ok(jobId);

    let resolveHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    await queue.work<{ streamId: string }>(
      'chat-run',
      { localConcurrency: 1 },
      async () => {
        await handlerBlocked;
      },
    );

    await waitFor(async () => {
      const [job] = await queue.findJobs<{ streamId: string }>('chat-run', {
        id: jobId,
      });
      return job?.state === 'active';
    });

    const inFlightJobs = await queue.findJobs<{ streamId: string }>('chat-run');
    assert.deepEqual(
      inFlightJobs.map((job) => ({
        id: job.id,
        streamId: job.data.streamId,
        state: job.state,
      })),
      [{ id: jobId, streamId: 'stream-1', state: 'active' }],
    );

    await queue.fail('chat-run', jobId, {
      message:
        'Marked stale active chat-run job as failed during backend startup recovery',
      code: 'chat/recovery-stale-active-job',
    });

    const [failedJob] = await queue.findJobs<{ streamId: string }>('chat-run', {
      id: jobId,
    });
    assert.equal(failedJob?.state, 'failed');
    assert.deepEqual(failedJob?.output, {
      message:
        'Marked stale active chat-run job as failed during backend startup recovery',
      code: 'chat/recovery-stale-active-job',
    });

    resolveHandler();
    await queue.stop({ graceful: true, close: true });
  });

  it('upserts and deletes schedules by queue and key', async () => {
    const database = new DatabaseSync(':memory:');
    let currentDate = new Date('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      database,
      idGenerator: createIdGenerator(),
      now: () => currentDate,
      schedule: false,
    });
    await queue.start();
    await queue.createQueue('automation-run');

    await queue.schedule(
      'automation-run',
      '0 * * * *',
      { automationId: 'a-1' },
      { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
    );
    await queue.schedule(
      'automation-run',
      '15 * * * *',
      { automationId: 'a-1' },
      { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
    );

    const row = readScheduleRow(
      database
        .prepare(
          `SELECT queue_name, key, cron, timezone, data, options
        FROM background_schedules`,
        )
        .get(),
    );

    assert.deepEqual(row, {
      queue_name: 'automation-run',
      key: 'a-1',
      cron: '15 * * * *',
      timezone: 'UTC',
      data: JSON.stringify({ automationId: 'a-1' }),
      options: JSON.stringify({ singletonKey: 'a-1' }),
    });

    let jobs = await queue.findJobs<{ automationId: string }>('automation-run');
    assert.equal(jobs.length, 0);

    currentDate = new Date('2026-01-01T00:15:00.000Z');
    await queue.runDueSchedules();
    await queue.runDueSchedules();

    jobs = await queue.findJobs<{ automationId: string }>('automation-run');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.data.automationId, 'a-1');
    assert.equal(jobs[0]?.singletonKey, 'a-1');

    await queue.unschedule('automation-run', 'a-1');
    const remaining = database
      .prepare('SELECT COUNT(*) AS count FROM background_schedules')
      .get();

    assert.equal(readSqliteCount(remaining), 0);
    await queue.stop({ graceful: true });
    database.close();
  });

  it('abandons a slot the process slept through instead of replaying it', async () => {
    const database = new DatabaseSync(':memory:');
    let currentDate = new Date('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      database,
      idGenerator: createIdGenerator(),
      now: () => currentDate,
      schedule: false,
    });

    try {
      await queue.start();
      await queue.createQueue('automation-run');
      await queue.schedule(
        'automation-run',
        '0 */6 * * *',
        { automationId: 'a-1' },
        { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
      );

      // Slots at 06:00 and 12:00 pass while the desktop app is quit.
      currentDate = new Date('2026-01-01T14:00:00.000Z');
      await queue.runDueSchedules();

      assert.equal(
        (await queue.findJobs('automation-run')).length,
        0,
        'a slot missed by hours must not be replayed on relaunch',
      );

      const next = readScheduleNextRunOn(
        database.prepare('SELECT next_run_on FROM background_schedules').get(),
      );
      assert.equal(
        new Date(next).toISOString(),
        '2026-01-01T18:00:00.000Z',
        'the cursor still advances past the abandoned slot',
      );

      // The next on-time slot fires normally.
      currentDate = new Date('2026-01-01T18:00:10.000Z');
      await queue.runDueSchedules();
      assert.equal((await queue.findJobs('automation-run')).length, 1);
    } finally {
      await queue.stop({ graceful: true });
      database.close();
    }
  });

  it('aborts and fails a job that outlives expireInSeconds as timed out', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
      now: () => clock,
    });
    await queue.start();
    try {
      await queue.createQueue('q', { expireInSeconds: 60, retryLimit: 0 });
      await queue.send('q', {});
      const aborted = Promise.withResolvers<void>();

      // A second slot keeps the worker polling while the job runs.
      await queue.work('q', { localConcurrency: 2 }, async ([job]) => {
        clock = new Date(clock.getTime() + 61_000);
        job?.signal.addEventListener('abort', () => aborted.resolve());
        await aborted.promise;
      });
      await aborted.promise;

      const [job] = await queue.findJobs('q');
      assert.equal(job?.state, 'failed');
      assert.deepEqual(job?.output, { value: { message: 'job timed out' } });
    } finally {
      await queue.stop({ graceful: true, close: true });
    }
  });

  it('keeps a running job whose worker refreshes its heartbeat past its first lease', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const queue = new SqliteJobQueue({
      idGenerator: createIdGenerator(),
      pollingIntervalMs: 5,
      now: () => clock,
    });
    await queue.start();
    try {
      await queue.createQueue('q', { heartbeatSeconds: 10 });
      await queue.send('q', {});
      const done = Promise.withResolvers<void>();
      const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

      // Twelve seconds pass in two steps, each shorter than the heartbeat,
      // while a second slot keeps the worker polling.
      await queue.work(
        'q',
        { localConcurrency: 2, heartbeatRefreshSeconds: 0.02 },
        async () => {
          clock = new Date(clock.getTime() + 6_000);
          await pause();
          clock = new Date(clock.getTime() + 6_000);
          await pause();
          done.resolve();
        },
      );
      await done.promise;

      await waitFor(async () =>
        (await queue.findJobs('q')).every(({ state }) => state !== 'active'),
      );
      const [job] = await queue.findJobs('q');
      assert.equal(job?.state, 'completed');
      assert.equal(job?.retryCount, 0);
    } finally {
      await queue.stop({ graceful: true, close: true });
    }
  });
});

function readSqliteCount(value: unknown): number {
  const count = readSqliteRow(value).count;
  if (typeof count !== 'number') {
    throw new TypeError('Expected SQLite count to be a number');
  }
  return count;
}

function readScheduleNextRunOn(value: unknown): string {
  const nextRunOn = readSqliteRow(value).next_run_on;
  if (typeof nextRunOn !== 'string') {
    throw new TypeError('Expected next_run_on to be a string');
  }
  return nextRunOn;
}

function readScheduleRow(value: unknown): {
  queue_name: unknown;
  key: unknown;
  cron: unknown;
  timezone: unknown;
  data: unknown;
  options: unknown;
} {
  const row = readSqliteRow(value);
  return {
    queue_name: row.queue_name,
    key: row.key,
    cron: row.cron,
    timezone: row.timezone,
    data: row.data,
    options: row.options,
  };
}

function readSqliteRow(value: unknown): Record<string, unknown> {
  assert.ok(isSqliteRow(value));
  return value;
}

function isSqliteRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
