import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import { Eca } from '@workspace/eca';

import { ClayBdAgentMessages } from './clay-bd-agent-messages.ts';
import { ClayDataHubMcpMessages } from './clay-data-hub-mcp-messages.ts';

const postgresql = new Postgres({ environment: process.env });

test('only Clay messages about the BD agent or Data Hub MCP match, with conversation context', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await sql`CREATE SCHEMA marts`;
  await sql`CREATE TABLE marts.slack_messages (
    "workspaceId" text, "channelId" text, ts text, "userId" text,
    text text, "threadTs" text, loaded_at timestamptz DEFAULT now(),
    PRIMARY KEY ("workspaceId", "channelId", ts)
  )`;
  await sql`CREATE TABLE marts.slack_thread_replies (LIKE marts.slack_messages INCLUDING ALL)`;
  await sql`INSERT INTO marts.slack_messages
    ("workspaceId", "channelId", ts, "userId", text) VALUES
    ('T20H06JTC', 'C0BH287LC4R', '1000000.000001', 'U03CUQ5SCRY', 'Thanks for the work on the BD agent!'),
    ('T20H06JTC', 'C0BH287LC4R', '1000020.000001', 'U03CUQ5SCRY', '^^ i’ll add more here as i keep testing'),
    ('T20H06JTC', 'C0BH287LC4R', '1000030.000001', 'U03CUQ5SCRY', 'Lunch tomorrow?'),
    ('T20H06JTC', 'C0BH287LC4R', '1000040.000001', 'U03CUQ5SCRY', 'Thank you!!!'),
    ('T20H06JTC', 'C0BH287LC4R', '1000100.000001', 'U03CUQ5SCRY', 'Hey guys, thanks for all the work on the data hub MCP!'),
    ('T20H06JTC', 'C0BH287LC4R', '1000110.000001', 'U03CUQ5SCRY', 'This was the MCP version'),
    ('T20H06JTC', 'C0BH287LC4R', '1000120.000001', 'U03CUQ5SCRY', 'Seems like it’s still missing elements'),
    ('T20H06JTC', 'C0BH287LC4R', '1000130.000001', 'U03CUQ5SCRY', NULL),
    ('T20H06JTC', 'C0BH287LC4R', '1000140.000001', 'U01SRLD2QBS', 'I updated the data hub MCP'),
    ('T20H06JTC', 'C0BH287LC4R', '1000150.000001', 'U03CUQ5SCRY', 'Thanks!! will take a look'),
    ('T20H06JTC', 'OTHER', '1000160.000001', 'OTHER_USER', 'The DataHub connector needs a fix'),
    ('T20H06JTC', 'OTHER', '1000170.000001', 'U03CUQ5SCRY', 'Any update?'),
    ('T20H06JTC', 'C0BH287LC4R', '1000180.000001', 'U03CUQ5SCRY', 'We could use an MCP for Story Radar'),
    ('T20H06JTC', 'C0BH287LC4R', '1000190.000001', 'U03CUQ5SCRY', 'Any update?'),
    ('T20H06JTC', 'C0BH287LC4R', '1000200.000001', 'U03CUQ5SCRY', 'The data hub has a new logo'),
    ('T20H06JTC', 'C0BH287LC4R', '1000210.000001', 'U0BE0G3DU8M', 'The BD agent and Data Hub MCP are updated'),
    ('T20H06JTC', 'C0BH287LC4R', '1000220.000001', 'U03CUQ5SCRY', 'Can you show me the prompt(s)?'),
    ('T20H06JTC', 'C0BH287LC4R', '1020000.000001', 'U03CUQ5SCRY', 'Any update?'),
    ('T20H06JTC', 'UNRELATED', '1000170.000001', 'U03CUQ5SCRY', 'Any update?'),
    ('OTHER_WORKSPACE', 'C0BH287LC4R', '1000000.000001', 'U03CUQ5SCRY', 'Data hub MCP')`;
  await sql`INSERT INTO marts.slack_thread_replies
    ("workspaceId", "channelId", ts, "userId", text, "threadTs") VALUES
    ('T20H06JTC', 'C0BH287LC4R', '1000100.000001', 'U03CUQ5SCRY', 'Hey guys, thanks for all the work on the data hub MCP!', '1000100.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1029990.000001', 'U0BE0G3DU8M', 'Thank you. I’m looking into it.', '1000100.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1030000.000001', 'U03CUQ5SCRY', 'Thanks!! Let me know if you have an update', '1000100.000001'),
    ('T20H06JTC', 'OTHER', '1030010.000001', 'U03CUQ5SCRY', 'Any update?', '1000100.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1030020.000001', 'OTHER_USER', 'Any update?', '1000100.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1030025.000001', 'U0BE0G3DU8M', 'Also, it seems that we have similar brief titles: The Local Infrastructure Hub and BP Local Infrastructure Hub', '1000220.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1030030.000001', 'U03CUQ5SCRY', 'ahh ok will check it', '1000220.000001'),
    ('T20H06JTC', 'C0BH287LC4R', '1030040.000001', 'U03CUQ5SCRY', 'Lunch tomorrow?', '1000000.000001')`;

  const bd = { condition: new ClayBdAgentMessages() };
  const mcp = { condition: new ClayDataHubMcpMessages() };
  const keys = (timestamps: string[]) =>
    timestamps.map((ts) => `T20H06JTC/C0BH287LC4R/${ts}`).sort();
  const bdMatches = await bd.condition.evaluate(sql);
  assert.deepEqual(
    bdMatches.map(({ key }) => key).sort(),
    keys([
      '1000000.000001',
      '1000020.000001',
      '1000220.000001',
      '1030030.000001',
    ]),
  );
  const mcpMatches = await mcp.condition.evaluate(sql);
  assert.deepEqual(
    mcpMatches.map(({ key }) => key).sort(),
    [
      ...keys([
        '1000100.000001',
        '1000110.000001',
        '1000120.000001',
        '1000130.000001',
        '1000150.000001',
        '1000220.000001',
        '1030000.000001',
        '1030030.000001',
      ]),
      'T20H06JTC/OTHER/1000170.000001',
    ].sort(),
  );
  assert.equal(
    bdMatches[0]?.data.text,
    'Clay · BD agent: Thanks for the work on the BD agent!',
  );
  assert.equal(
    mcpMatches.find(({ key }) => key.endsWith('/1000130.000001'))?.data.text,
    'Clay · Data Hub MCP: (no text)',
  );
  assert.equal(
    bdMatches[0]?.data.url,
    'slack://channel?team=T20H06JTC&id=C0BH287LC4R&message=1000000.000001',
  );

  const eca = new Eca<postgres.Sql, { text: string; url: string }>({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
  });
  await eca.add(bd);
  await eca.add(mcp);
  const watch = () =>
    Array.fromAsync(eca.watch({ signal: new AbortController().signal }));
  assert.deepEqual(await watch(), [], 'old messages form the baseline');
  await sql`INSERT INTO marts.slack_messages
    ("workspaceId", "channelId", ts, "userId", text) VALUES
    ('T20H06JTC', 'C0BH287LC4R', '1040000.000001', 'U03CUQ5SCRY', 'The MCP is ready'),
    ('T20H06JTC', 'OTHER', '1040000.000001', 'U03CUQ5SCRY', 'The business development agent is ready'),
    ('T20H06JTC', 'OTHER', '1040001.000001', 'U03CUQ5SCRY', 'Lunch?'),
    ('T20H06JTC', 'OTHER', '1040002.000001', 'OTHER_USER', 'The BD agent is ready')`;
  const matches = await watch();
  assert.equal(
    matches.length,
    2,
    'one BD and one MCP notification, only from Clay',
  );
  assert.equal(matches.filter(({ rule }) => rule === bd).length, 1);
  assert.equal(matches.filter(({ rule }) => rule === mcp).length, 1);
  assert.deepEqual(await watch(), [], 'unchanged messages do not notify again');
  await sql`INSERT INTO marts.slack_thread_replies
    ("workspaceId", "channelId", ts, "userId", text, loaded_at) VALUES
    ('T20H06JTC', 'C0BH287LC4R', '1040000.000001', 'U03CUQ5SCRY', 'The MCP is ready, edited', now() + interval '1 second')`;
  assert.deepEqual(
    await watch(),
    [],
    'a later edited broadcast is the same message',
  );
  assert.equal(
    (await mcp.condition.evaluate(sql)).find(({ key }) =>
      key.endsWith('/1040000.000001'),
    )?.data.text,
    'Clay · Data Hub MCP: The MCP is ready, edited',
  );
});
