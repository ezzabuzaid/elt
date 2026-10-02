import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { SqliteJobQueue } from './index.ts';

const claimer = join(import.meta.dirname, 'fixtures/claimer.ts');

test('several processes working one queue file run each job once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'queue-processes-'));
  const path = join(directory, 'queue.sqlite');
  const log = join(directory, 'handled.log');
  const queue = new SqliteJobQueue({ path, schedule: false });
  const children = [];
  try {
    await queue.start();
    await queue.createQueue('q');
    const ids = [];
    for (let index = 0; index < 20; index++)
      ids.push(await queue.send('q', { index }));
    // Holding the write lock lets every worker read the same waiting jobs
    // before any of them can claim one.
    const lock = new DatabaseSync(path);
    lock.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 3; index++) {
      const child = fork(claimer, [path, log], { stdio: 'ignore' });
      children.push(child);
      await new Promise((resolve) => child.once('message', resolve));
    }
    await sleep(300);
    lock.exec('COMMIT');
    lock.close();

    for (let waited = 0; waited < 10_000; waited += 20) {
      const jobs = await queue.findJobs('q');
      if (jobs.every(({ state }) => state === 'completed')) break;
      await sleep(20);
    }

    const handled = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(handled.toSorted(), ids.toSorted());
  } finally {
    for (const child of children) child.kill();
    await queue.stop({ close: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
