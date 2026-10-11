import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import postgres from 'postgres';

import { Eca, type Warehouse } from '@workspace/eca';

import { EarlyMonthSpend } from './early-month-spend.ts';
import { KeywordText } from './keyword-text.ts';
import pipeline from './pipeline.ts';

// Conditions read the marts as agent_reader, which can read nothing else.
const readerUrl = 'postgres://agent_reader:agent@127.0.0.1:55432/warehouse';

// postgres.js has no Symbol.asyncDispose, so the stack ends the client.
await using stack = new AsyncDisposableStack();
const sql = stack.adopt(
  postgres(readerUrl, { max: 1, onnotice: () => {} }),
  (client) => client.end(),
);

// A rule starts from what the marts held before this run's pass, so the first
// run, with nothing loaded yet, loads first and tells nothing.
const [loaded] =
  await sql`SELECT 1 FROM marts.sync_status WHERE connector = 'apple-messages' AND last_successful_sync_at IS NOT NULL`;
if (loaded === undefined) {
  await pipeline.run();
}

// This run's pass is the warehouse's one commit.
const warehouse: Warehouse<postgres.Sql> = {
  sql,
  async *commits(signal) {
    await pipeline.run();
    if (!signal.aborted) {
      yield;
    }
  },
};
const eca = new Eca<postgres.Sql, { spent: number } | { text: string }>({
  warehouse,
});
await eca.add({ condition: new EarlyMonthSpend() });
await eca.add({ condition: new KeywordText() });

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => stop.abort());
}

const run = promisify(execFile);
for await (const match of eca.watch({ signal: stop.signal })) {
  await run('/usr/bin/osascript', [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title "Proactive"',
    '-e',
    'end run',
    'spent' in match.data
      ? `You spent ${match.data.spent} JOD in the first 10 days of ${match.key}.`
      : match.data.text,
  ]);
}
