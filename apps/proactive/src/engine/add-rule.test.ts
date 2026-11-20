import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { Postgres } from '@zukhruf/testing/postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  Gauge,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import { addRule } from './add-rule.ts';
import { RuleStore } from './rule-store.ts';

const postgresql = new Postgres({ environment: process.env });

type Text = { guid: string; handle: string; text: string };

const messages = new Stream({
  name: 'messages_messages',
  jsonSchema: {
    type: 'object',
    description: 'A message.',
    properties: {
      guid: { type: 'string', description: 'Its id.' },
      handle: { type: 'string', description: 'Who sent it.' },
      text: { type: 'string', description: 'What it says.' },
    },
    required: ['guid', 'handle', 'text'],
  },
  primaryKey: ['guid'],
  supportedSyncModes: ['full_refresh'],
});

// The upstream of the test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads the messages it was given, as an upstream that replaces its table
// whole.
class Received extends Source {
  readonly identity = 'received';
  protected readonly catalog = new Catalog([messages]);
  readonly #texts: readonly Text[];

  constructor(texts: readonly Text[]) {
    super();
    this.#texts = texts;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract() {
    for (const data of this.#texts) yield { stream: messages.name, data };
  }
}

// A warehouse whose marts.messages_messages holds these messages, and a
// rule file, both new: the rules added and the reading of the warehouse as
// it is now.
async function setup(
  url: string,
  folder: string,
  ...texts: readonly [handle: string, text: string][]
) {
  const destination = new PostgresDestination({ url });
  await new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'messages',
        source: new Received(
          texts.map(([handle, text]) => ({ guid: randomUUID(), handle, text })),
        ),
        destination,
        checkpoints: new PostgresCheckpointStore({ url }),
        steps: [
          new Copy(messages, destination.table('messages_messages'), {
            id: 'messages',
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
        ],
      }),
    ],
  }).run();
  const reading = await destination.reading();
  if ('expired' in reading) assert.fail(reading.expired);
  return { reading, store: new RuleStore(join(folder, 'rules.sqlite')) };
}

const keywordText = `name: keyword-text
when: "a text says proactive:"
sql: SELECT handle, text FROM marts.messages_messages WHERE text ILIKE 'proactive:%' ORDER BY text
notify: "{handle}: {text}"
`;

test('a rule is kept, and what it finds true now comes back as its message tells each row', async () => {
  await using database = await postgresql.database();
  await using folder = await new TemporaryFiles().directory('proactive-');
  const { reading, store } = await setup(
    database.connectionString,
    folder.path,
    ['Mom', 'proactive: call the bank'],
    ['Mom', 'hello'],
    ['Dad', 'proactive: buy bread'],
  );
  await using _reading = reading;
  using _store = store;

  assert.deepEqual(await addRule(keywordText, reading, store), [
    'Dad: proactive: buy bread',
    'Mom: proactive: call the bank',
  ]);
  assert.deepEqual(store.rules(), [
    {
      name: 'keyword-text',
      when: 'a text says proactive:',
      sql: `SELECT handle, text FROM marts.messages_messages WHERE text ILIKE 'proactive:%' ORDER BY text`,
      notify: '{handle}: {text}',
    },
  ]);
});

test('an agent rule is kept, and each row true now comes back as JSON, as the agent would get it', async () => {
  await using database = await postgresql.database();
  await using folder = await new TemporaryFiles().directory('proactive-');
  const { reading, store } = await setup(
    database.connectionString,
    folder.path,
    ['Careem', 'Order ID: 42'],
  );
  await using _reading = reading;
  using _store = store;

  assert.deepEqual(
    await addRule(
      JSON.stringify({
        name: 'careem-calories',
        when: 'I order food',
        sql: `SELECT text FROM marts.messages_messages WHERE handle = 'Careem'`,
        agent: 'Log my calorie intake from the food I ordered.',
      }),
      reading,
      store,
    ),
    ['{"text":"Order ID: 42"}'],
  );
  assert.equal(store.rules().length, 1);
});

test('a rule whose SQL fails is not kept', async () => {
  await using database = await postgresql.database();
  await using folder = await new TemporaryFiles().directory('proactive-');
  const { reading, store } = await setup(
    database.connectionString,
    folder.path,
  );
  await using _reading = reading;
  using _store = store;

  await assert.rejects(
    addRule(
      `name: broken
when: never
sql: SELECT text FROM marts.no_such_view
notify: "{text}"
`,
      reading,
      store,
    ),
    /no_such_view/u,
  );
  assert.deepEqual(store.rules(), []);
});

test('a rule whose message names a column its SQL does not select is not kept, also when no row is true', async () => {
  await using database = await postgresql.database();
  await using folder = await new TemporaryFiles().directory('proactive-');
  const { reading, store } = await setup(
    database.connectionString,
    folder.path,
  );
  await using _reading = reading;
  using _store = store;

  await assert.rejects(
    addRule(keywordText.replace('{handle}', '{sender}'), reading, store),
    /\{sender\}/u,
  );
  assert.deepEqual(store.rules(), []);
});

test('a rule with no action, with both actions, with a field the format does not have, or with a name already kept is refused', async () => {
  await using database = await postgresql.database();
  await using folder = await new TemporaryFiles().directory('proactive-');
  const { reading, store } = await setup(
    database.connectionString,
    folder.path,
  );
  await using _reading = reading;
  using _store = store;
  const rule = { name: 'r', when: 'w', sql: 'SELECT 1 AS one' };

  for (const document of [
    rule,
    { ...rule, notify: '{one}', agent: 'do it' },
    { ...rule, notify: '{one}', key: 'month' },
    { ...rule, name: 'Has Spaces', notify: '{one}' },
  ])
    await assert.rejects(
      addRule(JSON.stringify(document), reading, store),
      `refused: ${JSON.stringify(document)}`,
    );
  assert.deepEqual(store.rules(), []);

  await addRule(JSON.stringify({ ...rule, notify: '{one}' }), reading, store);
  await assert.rejects(
    addRule(JSON.stringify({ ...rule, notify: 'again {one}' }), reading, store),
    /UNIQUE constraint failed/u,
  );
  assert.equal(store.rules().length, 1);
});
