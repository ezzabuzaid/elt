import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Shutdown } from '@zukhruf/shutdown';
import postgres from 'postgres';

import type { Warehouse } from '@eltjs/eca';
import { PostgresDestination } from '@eltjs/elt-postgresql';

import { Automations } from './engine/automations.ts';
import { RuleStore } from './engine/rule-store.ts';
import { SqlAgentRule, SqlNotifyRule } from './engine/sql-rule.ts';
import pipeline from './pipeline.ts';
import { rulesFile, rulesFolder } from './rules-file.ts';
import { ClayBdAgentMessages } from './rules/clay-topics/clay-bd-agent-messages.ts';
import { ClayDataHubMcpMessages } from './rules/clay-topics/clay-data-hub-mcp-messages.ts';
import { MeetingBriefWriter } from './rules/planning-meetings/meeting-brief-writer.ts';
import { PlanningMeetings } from './rules/planning-meetings/planning-meetings.ts';
import { readerUrl, warehouseUrl } from './warehouse.ts';

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

// The positions and readings of the database, as agent_reader. No load goes
// through this destination.
const reader = new PostgresDestination({ url: readerUrl, schema: 'marts' });
const warehouse: Warehouse<postgres.Sql> = {
  stable: (after) => reader.positions(after),
  read: (position) => reader.reading(position),
};
const outputs = new URL('../../../outputs/proactive/', import.meta.url);
const agent = fileURLToPath(new URL('agent/', outputs));
const automations = new Automations({ warehouse, cursors: writer });
automations.add('clay-bd-agent-messages', new ClayBdAgentMessages());
automations.add('clay-data-hub-mcp-messages', new ClayDataHubMcpMessages());
automations.add(
  'planning-meetings',
  new PlanningMeetings(
    new MeetingBriefWriter(fileURLToPath(new URL('meeting-briefs/', outputs))),
    sql,
  ),
);

await mkdir(rulesFolder, { recursive: true });
using rules = new RuleStore(rulesFile);
for (const rule of rules.rules())
  automations.add(
    rule.name,
    rule.notify === undefined
      ? new SqlAgentRule(rule.sql, rule.agent, agent)
      : new SqlNotifyRule(rule.sql, rule.notify),
  );

// A failed automation does not stop the others, but the run still exits
// non-zero so the failure is not silent.
if ((await automations.run(shutdown.signal)) > 0) {
  process.exitCode = 1;
}
