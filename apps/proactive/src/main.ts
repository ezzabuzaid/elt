import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import type { Warehouse } from '@workspace/eca';

import { Automations } from './automations.ts';
import { CareemCalories } from './careem-calories.ts';
import { ClayBdAgentMessages } from './clay-bd-agent-messages.ts';
import { ClayDataHubMcpMessages } from './clay-data-hub-mcp-messages.ts';
import { EarlyMonthSpend } from './early-month-spend.ts';
import { KeywordText } from './keyword-text.ts';
import { MeetingBriefWriter } from './meeting-brief-writer.ts';
import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import pipeline from './pipeline.ts';
import { PlanningMeetings } from './planning-meetings.ts';
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
const outputs = new URL('../../../outputs/proactive/', import.meta.url);
const automations = new Automations({ warehouse });
await automations.add(new EarlyMonthSpend());
await automations.add(new SpendSpike());
await automations.add(new MissingMidMonthCredit());
await automations.add(new KeywordText());
await automations.add(new ClayBdAgentMessages());
await automations.add(new ClayDataHubMcpMessages());
await automations.add(
  new PlanningMeetings(
    new MeetingBriefWriter(fileURLToPath(new URL('meeting-briefs/', outputs))),
  ),
);
await automations.add(
  new CareemCalories(fileURLToPath(new URL('agent/', outputs))),
);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => stop.abort());
}
// A failed automation does not stop the others, but the run still exits
// non-zero so the failure is not silent.
if ((await automations.run(stop.signal)) > 0) {
  process.exitCode = 1;
}
