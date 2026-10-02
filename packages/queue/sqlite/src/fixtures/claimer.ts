import { appendFileSync } from 'node:fs';

import { SqliteJobQueue } from '../index.ts';

// Works queue q of the file at argv[2] and appends each job id it runs to the
// log at argv[3], until its parent stops it.
const [path, log] = process.argv.slice(2);
const queue = new SqliteJobQueue({
  path,
  pollingIntervalMs: 5,
  schedule: false,
});
await queue.start();
await queue.work('q', {}, async ([job]) => {
  appendFileSync(log, `${job.id}\n`);
});
process.send?.('working');
