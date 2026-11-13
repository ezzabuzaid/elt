import { fileURLToPath } from 'node:url';

import { Shutdown } from '@zukhruf/shutdown';
import postgres from 'postgres';

import type { Warehouse } from '@eltjs/eca';
import { PostgresDestination } from '@eltjs/elt-postgresql';

import { Automations } from './automations.ts';
import { CareemCalories } from './careem-calories.ts';
import { ClayBdAgentMessages } from './clay-bd-agent-messages.ts';
import { ClayDataHubMcpMessages } from './clay-data-hub-mcp-messages.ts';
import { EarlyMonthSpend } from './early-month-spend.ts';
import { KeywordText } from './keyword-text.ts';
import { MeetingBriefWriter } from './meeting-brief-writer.ts';
import { MissingMidMonthCredit } from './missing-mid-month-credit.ts';
import pipeline, { warehouseUrl } from './pipeline.ts';
import { PlanningMeetings } from './planning-meetings.ts';
import { SpendSpike } from './spend-spike.ts';

// Conditions read the marts as agent_reader, which can read nothing else.
const readerUrl = 'postgres://agent_reader:agent@127.0.0.1:55432/warehouse';

using shutdown = new Shutdown();
// postgres.js has no Symbol.asyncDispose, so the stack ends the clients.
await using stack = new AsyncDisposableStack();
const sql = stack.adopt(
  postgres(readerUrl, { max: 1, onnotice: () => {} }),
  (client) => client.end(),
);
// The loading role keeps the cursor of each automation.
const writer = stack.adopt(
  postgres(warehouseUrl, { max: 1, onnotice: () => {} }),
  (client) => client.end(),
);

await pipeline.run({ signal: shutdown.signal });

// A reading takes its position from the numbering in _warehouse, which the
// pass made. agent_reader reads that and nothing else of _warehouse.
await writer`GRANT USAGE ON SCHEMA _warehouse TO agent_reader`;
await writer`GRANT SELECT ON _warehouse._elt_epoch, _warehouse._elt_commits, _warehouse._elt_loads, _warehouse._elt_commit_numbers TO agent_reader`;

// The positions and readings of the database, as agent_reader. No load goes
// through this destination.
const reader = new PostgresDestination({ url: readerUrl, schema: 'marts' });
const warehouse: Warehouse<postgres.Sql> = {
  stable: (after) => reader.positions(after),
  read: (position) => reader.reading(position),
};
const outputs = new URL('../../../outputs/proactive/', import.meta.url);
const automations = new Automations({ warehouse, cursors: writer });
automations.add('early-month-spend', new EarlyMonthSpend());
automations.add('spend-spike', new SpendSpike());
automations.add('missing-mid-month-credit', new MissingMidMonthCredit());
automations.add('keyword-text', new KeywordText());
automations.add('clay-bd-agent-messages', new ClayBdAgentMessages());
automations.add('clay-data-hub-mcp-messages', new ClayDataHubMcpMessages());
automations.add(
  'planning-meetings',
  new PlanningMeetings(
    new MeetingBriefWriter(fileURLToPath(new URL('meeting-briefs/', outputs))),
    sql,
  ),
);
automations.add(
  'careem-calories',
  new CareemCalories(fileURLToPath(new URL('agent/', outputs))),
);

// A failed automation does not stop the others, but the run still exits
// non-zero so the failure is not silent.
if ((await automations.run(shutdown.signal)) > 0) {
  process.exitCode = 1;
}
