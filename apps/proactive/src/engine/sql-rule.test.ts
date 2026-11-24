import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { Postgres } from '@zukhruf/testing/postgres';

import { Connection, Copy, IterableSource, Pipeline } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import { CodexStandIn } from '../testing/codex-stand-in.ts';
import type { Automation } from './automation.ts';
import { SqlAgentRule, SqlNotifyRule } from './sql-rule.ts';

const postgresql = new Postgres({ environment: process.env });

type Text = { guid: string; handle: string; text: string };

const messagesSchema = {
  type: 'object',
  description: 'A message.',
  properties: {
    guid: { type: 'string', description: 'Its id.' },
    handle: { type: 'string', description: 'Who sent it.' },
    text: { type: 'string', description: 'What it says.' },
  },
  required: ['guid', 'handle', 'text'],
} as const;

// The Messages import in a warehouse: each load gives marts.messages_messages
// every message so far, and a rule reads it as of two loads.
function inbox(url: string) {
  const destination = new PostgresDestination({ url });
  const checkpoints = new PostgresCheckpointStore({ url });
  const history = new PostgresSyncHistory({ url });
  const received: Text[] = [];
  // Reads every message so far, as an upstream that replaces its table whole.
  const source = new IterableSource({
    identity: 'received',
    streams: {
      messages_messages: {
        description: 'Every message so far.',
        jsonSchema: messagesSchema,
        primaryKey: ['guid'],
        snapshot: () => received,
      },
    },
  });
  const copy = new Copy(
    source.streams.messages_messages,
    destination.table('messages_messages'),
    {
      id: 'messages',
      syncMode: 'full_refresh',
      destinationSyncMode: 'overwrite',
    },
  );
  return {
    // Loads every message so far, plus these. Resolves to the position of
    // the load.
    async receive(
      ...texts: readonly [handle: string, text: string][]
    ): Promise<string> {
      received.push(
        ...texts.map(([handle, text]) => ({
          guid: randomUUID(),
          handle,
          text,
        })),
      );
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'messages',
            source,
            destination,
            checkpoints,
            steps: [copy],
          }),
        ],
      }).run();
      const positions = await destination.positions();
      if ('expired' in positions) assert.fail(positions.expired);
      const position = positions.at(-1);
      assert.ok(position !== undefined, 'the load made a position');
      return position;
    },
    // What the rule gives between the warehouse as of two positions.
    async evaluate<Data>(
      rule: Automation<Data>,
      from: string,
      to: string,
    ): Promise<readonly Data[]> {
      const before = await destination.reading(from);
      if ('expired' in before) assert.fail(before.expired);
      await using _before = before;
      const after = await destination.reading(to);
      if ('expired' in after) assert.fail(after.expired);
      await using _after = after;
      return await rule.evaluate(before, after);
    },
  };
}

test('a row that the SQL gives after and not before matches once, also when the SQL gives it twice, and a row it keeps giving matches no more', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new SqlNotifyRule(
    `SELECT text FROM marts.messages_messages WHERE text ILIKE 'proactive:%'`,
    '{text}',
  );
  const empty = await warehouse.receive();
  const first = await warehouse.receive(
    ['Mom', 'proactive: call the bank'],
    ['Dad', 'proactive: call the bank'],
    ['Mom', 'hello'],
  );
  const second = await warehouse.receive(['Mom', 'proactive: buy bread']);

  assert.deepEqual(await warehouse.evaluate(rule, empty, first), [
    { text: 'proactive: call the bank' },
  ]);
  assert.deepEqual(await warehouse.evaluate(rule, first, second), [
    { text: 'proactive: buy bread' },
  ]);
});

test('rows are compared whole, so a row whose count changes matches again', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new SqlNotifyRule(
    `SELECT handle, count(*) AS texts FROM marts.messages_messages GROUP BY handle
     UNION ALL SELECT 'every handle', 0`,
    '{handle}: {texts}',
  );
  const empty = await warehouse.receive();
  const one = await warehouse.receive(['Mom', 'hello']);
  const two = await warehouse.receive(['Mom', 'are you there?']);

  assert.deepEqual(await warehouse.evaluate(rule, empty, one), [
    { handle: 'Mom', texts: '1' },
  ]);
  assert.deepEqual(
    await warehouse.evaluate(rule, one, two),
    [{ handle: 'Mom', texts: '2' }],
    'a running count is a new row at each change',
  );
});

test("a notify rule's message fills each {column} with the row's value, and a column the row lacks fails", () => {
  const rule = new SqlNotifyRule(
    'SELECT 1',
    'You spent {spent} JOD in {month}.',
  );

  assert.equal(
    rule.message({ month: '2026-10', spent: '215.250' }),
    'You spent 215.250 JOD in 2026-10.',
  );
  assert.throws(
    () => rule.message({ month: '2026-10' }),
    /\{spent\}/u,
    'a message that names a column the SQL does not select is a failure, not a blank',
  );
});

test("an agent rule gives Codex its instruction and the matched row, and returns the agent's answer", async () => {
  await using directory = await new TemporaryFiles().directory(
    'proactive-test-',
  );
  const codex = await CodexStandIn.create(directory.path, () => 'Logged');
  const rule = new SqlAgentRule(
    'SELECT 1',
    'Log my calorie intake from the food I ordered.',
    join(directory.path, 'agent'),
    codex.path,
  );

  assert.equal(
    await rule.act({ orderId: '42' }, new AbortController().signal),
    'Logged',
  );
  const [call] = await codex.calls();
  assert.ok(call, 'Codex ran');
  assert.ok(
    call.prompt.startsWith('Log my calorie intake from the food I ordered.'),
  );
  assert.ok(call.prompt.includes('{"orderId":"42"}'));
});
