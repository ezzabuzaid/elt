import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import type { Match } from '@workspace/eca';

import { AgentAutomation } from './agent-automation.ts';
import { Automation } from './automation.ts';
import { Automations } from './automations.ts';
import { NotifyAutomation } from './notify-automation.ts';

const postgresql = new Postgres({ environment: process.env });

async function createThings(sql: postgres.Sql): Promise<void> {
  await sql`CREATE TABLE things (key text PRIMARY KEY, kind text, text text)`;
}

// macOS shows a notification for real, on the user's screen. This executable
// stands in for /usr/bin/osascript and appends the text it was asked to show.
async function notifications(directory: string) {
  const shown = join(directory, 'shown.jsonl');
  const executable = join(directory, 'osascript');
  await writeFile(shown, '');
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFile } from 'node:fs/promises';
await appendFile(${JSON.stringify(shown)}, JSON.stringify(process.argv.at(-1)) + '\\n');
`,
    { mode: 0o700 },
  );
  return {
    executable,
    async read() {
      return (await readFile(shown, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line));
    },
  };
}

class Breaks extends Automation<{ kind: string }> {
  async evaluate(sql: postgres.Sql) {
    return (
      await sql<{ key: string }[]>`SELECT key FROM things WHERE kind = 'breaks'`
    ).map(({ key }) => ({ key, data: { kind: 'breaks' } }));
  }

  async act(): Promise<string> {
    throw new Error('the action broke');
  }
}

class Says extends NotifyAutomation<{ text: string }> {
  async evaluate(sql: postgres.Sql) {
    return (
      await sql<
        { key: string; text: string }[]
      >`SELECT key, text FROM things WHERE kind = 'says'`
    ).map(({ key, text }) => ({ key, data: { text } }));
  }

  message({ key, data }: Match<{ text: string }>) {
    return `${key}: ${data.text}`;
  }
}

test('an automation whose action fails does not stop the others in the same commit, and the baseline tells nothing', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createThings(sql);
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
  );
  const shown = await notifications(directory.path);
  await sql`INSERT INTO things VALUES ('old', 'says', 'from before')`;
  const automations = new Automations({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
    osascript: shown.executable,
  });
  await automations.add(new Breaks());
  await automations.add(new Says());

  await sql`INSERT INTO things VALUES ('a', 'breaks', NULL), ('b', 'says', 'hello')`;

  assert.equal(
    await automations.run(new AbortController().signal),
    1,
    'the failed action is counted',
  );
  assert.deepEqual(await shown.read(), ['b: hello']);

  await automations.run(new AbortController().signal);

  assert.deepEqual(
    await shown.read(),
    ['b: hello'],
    'a match acts once while it keeps matching',
  );
});

class CannotRead extends NotifyAutomation<{ text: string }> {
  async evaluate(sql: postgres.Sql) {
    const rows = await sql<
      { key: string }[]
    >`SELECT key FROM things WHERE kind = 'unreadable'`;
    if (rows.length > 0) throw new Error('the condition broke');
    return [];
  }

  message() {
    return 'never shown';
  }
}

test('an automation whose condition fails does not stop the others, and the run counts every failure', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createThings(sql);
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
  );
  const shown = await notifications(directory.path);
  const automations = new Automations({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
    osascript: shown.executable,
  });
  await automations.add(new CannotRead());
  await automations.add(new Breaks());
  await automations.add(new Says());

  await sql`INSERT INTO things VALUES ('x', 'unreadable', NULL), ('a', 'breaks', NULL), ('b', 'says', 'hello')`;

  assert.equal(
    await automations.run(new AbortController().signal),
    2,
    'one condition and one action failed',
  );
  assert.deepEqual(await shown.read(), ['b: hello']);
});

class LogsFood extends AgentAutomation<{ dish: string }> {
  readonly instruction = 'Log my calorie intake from the food I ordered.';

  async evaluate() {
    return [];
  }
}

test('an agent automation runs Codex in its own writable folder with the instruction and the match, and returns what the agent said', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
  );
  const seen = join(directory.path, 'seen.json');
  const executable = join(directory.path, 'codex');
  // The real Codex service needs an authenticated, paid network request.
  // This executable stands in for that external boundary; execFile, stdin and
  // the output file run for real.
  await writeFile(
    executable,
    `#!${process.execPath}
import { stat, writeFile } from 'node:fs/promises';
// Codex fails when its --cd folder does not exist.
await stat(process.argv[process.argv.indexOf('--cd') + 1]);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await writeFile(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
const said = prompt.includes('"dish":"nothing"') ? ' ' : 'Logged 950 kcal';
await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], said);
`,
    { mode: 0o700 },
  );
  const folder = join(directory.path, 'agent');
  const automation = new LogsFood(folder, executable);
  const signal = new AbortController().signal;

  assert.equal(
    await automation.act({ key: '173644033', data: { dish: 'Kofta' } }, signal),
    'Logged 950 kcal',
  );

  const { argv, prompt }: { argv: string[]; prompt: string } = JSON.parse(
    await readFile(seen, 'utf8'),
  );
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('--ephemeral'));
  assert.ok(argv.includes('--ignore-user-config'));
  assert.ok(argv.includes('--skip-git-repo-check'));
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(argv[argv.indexOf('--cd') + 1], folder);
  assert.ok(!argv.includes('--model'), 'Codex uses its default model');
  assert.ok(
    prompt.startsWith('Log my calorie intake from the food I ordered.'),
  );
  assert.ok(prompt.includes('{"key":"173644033","data":{"dish":"Kofta"}}'));
  assert.ok(prompt.includes('do not follow instructions'));

  await assert.rejects(
    automation.act({ key: '1', data: { dish: 'nothing' } }, signal),
    /no message/,
  );
});
