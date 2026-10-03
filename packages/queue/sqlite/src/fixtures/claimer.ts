import { appendFileSync } from 'node:fs';

import { SqliteJobQueue } from '../index.ts';

// Works queue q of the file at argv[2] and appends each job id it runs to the
// log at argv[3], until its parent stops it.
const [path, log] = process.argv.slice(2);
// Without a path the queue would silently run in memory, apart from the
// file the other processes share.
if (path === undefined || log === undefined)
  throw new Error('Usage: claimer.ts <queue file> <log file>');
const queue = new SqliteJobQueue({
  path,
  pollingIntervalMs: 5,
  schedule: false,
});
await queue.start();
await queue.work('q', {}, async (jobs) => {
  for (const job of jobs) appendFileSync(log, `${job.id}\n`);
});
process.send?.('working');
