import { appendFileSync } from 'node:fs';

import { SqliteJobQueue } from '../index.ts';

// Works queue q of the file at argv[2] and appends each job id it runs to the
// log at argv[3], until its parent stops it. With argv[4] 'hang' it tells its
// parent it claimed a job and never finishes it, as a worker that dies
// mid-job.
const [path, log, mode] = process.argv.slice(2);
// Without a path the queue would silently run in memory, apart from the
// file the other processes share.
if (path === undefined || log === undefined)
  throw new Error('Usage: claimer.ts <queue file> <log file> [hang]');
const queue = new SqliteJobQueue({
  path,
  pollingIntervalMs: 5,
  schedule: false,
});
await queue.start();
await queue.work('q', {}, async (jobs) => {
  for (const job of jobs) appendFileSync(log, `${job.id}\n`);
  if (mode === 'hang') {
    process.send?.('claimed');
    await new Promise(() => {});
  }
});
process.send?.('working');
