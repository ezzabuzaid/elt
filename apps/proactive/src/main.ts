import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import postgres from 'postgres';

import { Eca, type Warehouse } from '@workspace/eca';

import { EarlyMonthSpend } from './early-month-spend.ts';
import { KeywordText } from './keyword-text.ts';
import { MeetingBriefWriter } from './meeting-brief-writer.ts';
import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import pipeline from './pipeline.ts';
import { type MeetingBrief, PlanningMeetings } from './planning-meetings.ts';
import { SpendSpike } from './spend-spike.ts';

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
const loaded =
  await sql`SELECT connector FROM marts.sync_status WHERE connector IN ('apple-messages', 'slack', 'apple-calendar', 'apple-mail') AND last_successful_sync_at IS NOT NULL`;
if (loaded.length !== 4) {
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
const eca = new Eca<
  postgres.Sql,
  | { spent: number }
  | { spent: number; usual: number }
  | { due: string }
  | { text: string }
  | MeetingBrief
>({
  warehouse,
});

await eca.add({ condition: new EarlyMonthSpend() });
await eca.add({ condition: new SpendSpike() });
await eca.add({ condition: new MissingMidMonthCredit() });
await eca.add({ condition: new KeywordText() });
await eca.add({ condition: new PlanningMeetings() });
const briefs = new MeetingBriefWriter(
  fileURLToPath(
    new URL('../../../outputs/proactive/meeting-briefs/', import.meta.url),
  ),
);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => stop.abort());
}

const run = promisify(execFile);
for await (const match of eca.watch({ signal: stop.signal })) {
  // A rule whose condition threw is evaluated again at the next commit.
  if ('error' in match) {
    process.stderr.write(`A rule failed: ${String(match.error)}\n`);
    continue;
  }
  const brief =
    'meeting' in match.data
      ? await briefs.write(match.data, stop.signal)
      : null;
  if (brief !== null) process.stdout.write(`Meeting brief: ${brief}\n`);
  const message =
    'meeting' in match.data
      ? `Planning brief ready: ${match.data.meeting.name}\n${brief}`
      : 'usual' in match.data
        ? `You spent ${match.data.spent} JOD in ${match.key}, over twice your usual ${match.data.usual} JOD a week.`
        : 'spent' in match.data
          ? `You spent ${match.data.spent} JOD in the first 10 days of ${match.key}.`
          : 'due' in match.data
            ? `The mid-month credit of ${match.key} has not arrived. It was due by ${match.data.due}.`
            : match.data.text;
  await run('/usr/bin/osascript', [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title "Proactive"',
    '-e',
    'end run',
    message,
  ]);
}
