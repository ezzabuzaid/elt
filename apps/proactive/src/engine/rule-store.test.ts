import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import { RuleStore } from './rule-store.ts';

test('a rule that is added is read back with its one action, also after the store opens again', async () => {
  await using directory = await new TemporaryFiles().directory(
    'proactive-rules-',
  );
  const path = join(directory.path, 'rules.sqlite');
  {
    using store = new RuleStore(path);
    store.add({
      name: 'keyword-text',
      when: 'a text says proactive:',
      sql: `SELECT text FROM marts.messages_messages WHERE text ILIKE 'proactive:%'`,
      notify: '{text}',
    });
    store.add({
      name: 'careem-calories',
      when: 'I order food',
      sql: 'SELECT 1 AS order',
      agent: 'Log my calorie intake from the food I ordered.',
    });
  }

  using store = new RuleStore(path);
  assert.deepEqual(store.rules(), [
    {
      name: 'careem-calories',
      when: 'I order food',
      sql: 'SELECT 1 AS order',
      agent: 'Log my calorie intake from the food I ordered.',
    },
    {
      name: 'keyword-text',
      when: 'a text says proactive:',
      sql: `SELECT text FROM marts.messages_messages WHERE text ILIKE 'proactive:%'`,
      notify: '{text}',
    },
  ]);
});

test('a rule written by hand with no action or with two is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'proactive-rules-',
  );
  const path = join(directory.path, 'rules.sqlite');
  new RuleStore(path)[Symbol.dispose]();
  using database = open(path);
  const insert = database.prepare(
    'INSERT INTO rules (name, "when", sql, notify, agent) VALUES (?, ?, ?, ?, ?)',
  );

  assert.throws(
    () => insert.run('none', 'words', 'SELECT 1', null, null),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insert.run('two', 'words', 'SELECT 1', '{x}', 'do x'),
    /CHECK constraint failed/u,
  );
});
