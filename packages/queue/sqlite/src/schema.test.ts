import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SQLITE_BACKGROUND_QUEUE_TABLES,
  SQLITE_QUEUE_SCHEMA,
  assertSqliteSupportedQueuePolicy,
  isSqliteSupportedQueuePolicy,
} from './schema.ts';

describe('SQLite queue schema', () => {
  it('defines the durable queue, job, and schedule tables', () => {
    assert.deepEqual(SQLITE_BACKGROUND_QUEUE_TABLES, [
      'background_queues',
      'background_jobs',
      'background_schedules',
    ]);

    const schema = SQLITE_QUEUE_SCHEMA.join('\n');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS background_queues/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS background_jobs/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS background_schedules/);
  });

  it('snapshots queue defaults on jobs and preserves exclusive queue semantics', () => {
    const schema = SQLITE_QUEUE_SCHEMA.join('\n');

    assert.match(schema, /retry_limit INTEGER NOT NULL DEFAULT 2/);
    assert.match(schema, /expire_seconds INTEGER NOT NULL DEFAULT 900/);
    assert.match(schema, /heartbeat_seconds INTEGER/);
    assert.match(
      schema,
      /CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_exclusive_i/,
    );
    assert.match(
      schema,
      /WHERE state IN \('created', 'retry', 'active'\) AND policy = 'exclusive'/,
    );
  });

  it('only advertises policies that the SQLite package intends to implement first', () => {
    assert.equal(isSqliteSupportedQueuePolicy(undefined), true);
    assert.equal(isSqliteSupportedQueuePolicy('standard'), true);
    assert.equal(isSqliteSupportedQueuePolicy('exclusive'), true);
    assert.equal(isSqliteSupportedQueuePolicy('singleton'), false);
    assert.throws(
      () => assertSqliteSupportedQueuePolicy('singleton'),
      /SQLite queue policy is not supported: singleton/,
    );
  });
});
