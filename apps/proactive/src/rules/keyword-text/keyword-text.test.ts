import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

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

import type { Automation } from '../../engine/automation.ts';
import { KeywordText } from './keyword-text.ts';

const postgresql = new Postgres({ environment: process.env });

type Text = {
  guid: string;
  handle: string;
  text: string;
  isFromMe: boolean;
  date: string | null;
};

const messages = new Stream({
  name: 'messages_messages',
  jsonSchema: {
    type: 'object',
    description: 'A message.',
    properties: {
      guid: { type: 'string', description: 'Its id.' },
      handle: { type: 'string', description: 'Who sent it.' },
      text: { type: 'string', description: 'What it says.' },
      isFromMe: { type: 'boolean', description: 'Whether the user sent it.' },
      date: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When it was sent.',
      },
    },
    required: ['guid', 'handle', 'text', 'isFromMe', 'date'],
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

// Reads every message so far, as an upstream that replaces its table whole.
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

// The Messages import in a warehouse: each load gives marts.messages_messages
// every message so far, and a rule reads it as of two loads.
function inbox(url: string) {
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const history = new PostgresSyncHistory({ url });
  const copy = new Copy(
    messages,
    destination
      .table('messages_messages')
      .withReaderView('marts', 'messages_messages'),
    {
      id: 'messages',
      syncMode: 'full_refresh',
      destinationSyncMode: 'overwrite',
    },
  );
  const received: Text[] = [];
  return {
    // Writes messages the way the Messages load does, one row each, and loads
    // them. Resolves to the position of the load.
    async receive(
      ...texts: readonly [text: string, isFromMe: boolean][]
    ): Promise<string> {
      received.push(
        ...texts.map(([text, isFromMe]) => ({
          guid: randomUUID(),
          handle: 'me@example.com',
          text,
          isFromMe,
          date: '2026-10-11T09:00:00.000Z',
        })),
      );
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'messages',
            source: new Received([...received]),
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

test('a received text with the marker matches once, and a text the user sends to themselves counts once', async () => {
  await using database = await postgresql.database();
  const warehouse = inbox(database.connectionString);
  const rule = new KeywordText();
  const empty = await warehouse.receive(['proactive: from before', false]);
  const marked = await warehouse.receive(
    ['proactive: call the bank tomorrow', true],
    ['proactive: call the bank tomorrow', false],
    ['call the bank tomorrow', false],
  );
  const later = await warehouse.receive(['Hello', false]);

  assert.deepEqual(await warehouse.evaluate(rule, empty, marked), [
    { text: 'proactive: call the bank tomorrow' },
  ]);
  assert.deepEqual(
    await warehouse.evaluate(rule, marked, later),
    [],
    'a marked text is told once',
  );
});
