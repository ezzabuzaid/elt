import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';

import type { QueueJob } from '@workspace/queue-abstract';

import { type PgBossJobQueue, createPgBossJobQueue } from './index.ts';

const POSTGRES_IMAGE = process.env.QUEUE_POSTGRES_IMAGE ?? 'postgres:17-alpine';
const POSTGRES_START_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const runId = randomUUID().replaceAll('-', '').slice(0, 12);

function uniqueQueueName(name: string): string {
  return `${name}_${runId}`;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Timed out waiting for queue condition');
}

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

// Per-test server + queue, disposed at the end of each test, so every test
// stays self-contained (no shared lifecycle hooks). Without Docker the server
// cannot start, and the test fails.
async function withQueue(
  run: (jobQueue: PgBossJobQueue) => Promise<void>,
): Promise<void> {
  await using server = await new Postgres({
    docker,
    image: POSTGRES_IMAGE,
    password: 'postgres',
    database: 'queue_test',
    user: 'postgres',
  }).start();
  const jobQueue = createPgBossJobQueue({
    connectionString: server.connectionString,
    application_name: `queue_postgres_test_${runId}`,
    schedule: true,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
    queueCacheIntervalSeconds: 1,
    supervise: false,
  });
  await jobQueue.start();
  try {
    await run(jobQueue);
  } finally {
    await jobQueue.stop({ graceful: true, close: true, timeout: 30_000 });
  }
}

const IT_TIMEOUT_MS = POSTGRES_START_TIMEOUT_MS + TEST_TIMEOUT_MS;

describe('PgBossJobQueue integration', () => {
  it(
    'manages queues and preserves exclusive enqueue semantics',
    { timeout: IT_TIMEOUT_MS },
    () =>
      withQueue(async (jobQueue) => {
        const name = uniqueQueueName('chat_run_exclusive');

        await jobQueue.createQueue(name, {
          policy: 'exclusive',
          retryLimit: 0,
          expireInSeconds: 1800,
          heartbeatSeconds: 30,
        });
        await jobQueue.updateQueue(name, {
          retryLimit: 2,
          retryDelay: 5,
        });

        const firstJobId = await jobQueue.send(
          name,
          { streamId: 'stream-1' },
          { singletonKey: 'chat-1' },
        );
        const duplicateJobId = await jobQueue.send(
          name,
          { streamId: 'stream-2' },
          { singletonKey: 'chat-1' },
        );

        assert.ok(firstJobId);
        assert.equal(duplicateJobId, null);

        const [job] = await jobQueue.findJobs<{ streamId: string }>(name, {
          key: 'chat-1',
        });
        assert.equal(job?.state, 'created');
        assert.equal(job?.data.streamId, 'stream-1');
        assert.equal(job?.retryLimit, 2);
        assert.equal(job?.retryDelay, 5);
        assert.equal(job?.expireInSeconds, 1800);
        assert.equal(job?.heartbeatSeconds, 30);

        await jobQueue.cancel(name, firstJobId);
        const replacementJobId = await jobQueue.send(
          name,
          { streamId: 'stream-3' },
          { singletonKey: 'chat-1' },
        );

        assert.ok(replacementJobId);
        await jobQueue.deleteQueue(name);
      }),
  );

  it(
    'claims and completes jobs through workers',
    { timeout: IT_TIMEOUT_MS },
    () =>
      withQueue(async (jobQueue) => {
        const name = uniqueQueueName('chat_run_worker');
        const handledJobs: QueueJob<{ streamId: string }>[] = [];

        await jobQueue.createQueue(name, { retryLimit: 0 });
        const jobId = await jobQueue.send(name, { streamId: 'stream-1' });
        assert.ok(jobId);

        await jobQueue.work<{ streamId: string }>(
          name,
          { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
          async (jobs) => {
            handledJobs.push(...jobs);
          },
        );

        await waitFor(async () => {
          const [job] = await jobQueue.findJobs<{ streamId: string }>(name, {
            id: jobId,
          });
          return job?.state === 'completed';
        });

        assert.equal(handledJobs.length, 1);
        assert.equal(handledJobs[0]?.id, jobId);
        assert.equal(handledJobs[0]?.data.streamId, 'stream-1');
        assert.ok(handledJobs[0]?.signal instanceof AbortSignal);
      }),
  );

  it(
    'retries failed worker jobs until retryLimit is exhausted',
    { timeout: IT_TIMEOUT_MS },
    () =>
      withQueue(async (jobQueue) => {
        const name = uniqueQueueName('automation_run_retry');
        let attempts = 0;

        await jobQueue.createQueue(name, {
          retryLimit: 1,
          retryDelay: 0,
        });
        const jobId = await jobQueue.send(name, { automationId: 'a-1' });
        assert.ok(jobId);

        await jobQueue.work<{ automationId: string }>(
          name,
          { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
          async () => {
            attempts++;
            throw new Error('handler failed');
          },
        );

        await waitFor(async () => {
          const [job] = await jobQueue.findJobs<{ automationId: string }>(
            name,
            {
              id: jobId,
            },
          );
          return job?.state === 'failed';
        });

        const [job] = await jobQueue.findJobs<{ automationId: string }>(name, {
          id: jobId,
        });
        assert.equal(attempts, 2);
        assert.equal(job?.retryCount, 1);
      }),
  );

  it(
    'schedules and unschedules jobs through pg-boss cron handling',
    { timeout: IT_TIMEOUT_MS },
    () =>
      withQueue(async (jobQueue) => {
        const name = uniqueQueueName('automation_run_schedule');

        await jobQueue.createQueue(name, { retryLimit: 0 });
        await jobQueue.schedule(
          name,
          '* * * * *',
          { automationId: 'a-1' },
          { key: 'a-1', singletonKey: 'a-1', tz: 'UTC' },
        );

        await waitFor(async () => {
          const jobs = await jobQueue.findJobs<{ automationId: string }>(name, {
            key: 'a-1',
          });
          return jobs.some(
            (job) =>
              job.data.automationId === 'a-1' &&
              (job.state === 'created' || job.state === 'active'),
          );
        });

        await jobQueue.unschedule(name, 'a-1');
      }),
  );
});
