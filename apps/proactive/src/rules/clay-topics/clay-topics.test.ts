import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
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
import { ClayBdAgentMessages } from './clay-bd-agent-messages.ts';
import { ClayDataHubMcpMessages } from './clay-data-hub-mcp-messages.ts';

const postgresql = new Postgres({ environment: process.env });

type SlackMessage = {
  workspaceId: string;
  channelId: string;
  ts: string;
  userId: string;
  text: string | null;
  threadTs: string | null;
};

function slackStream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: 'A Slack message.',
      properties: {
        workspaceId: { type: 'string', description: 'Its workspace.' },
        channelId: { type: 'string', description: 'Its conversation.' },
        ts: { type: 'string', description: 'Its Slack timestamp.' },
        userId: { type: 'string', description: 'Who sent it.' },
        text: { type: ['string', 'null'], description: 'What it says.' },
        threadTs: {
          type: ['string', 'null'],
          description: 'The Slack timestamp of its thread parent.',
        },
      },
      required: [
        'workspaceId',
        'channelId',
        'ts',
        'userId',
        'text',
        'threadTs',
      ],
    },
    primaryKey: ['workspaceId', 'channelId', 'ts'],
    supportedSyncModes: ['full_refresh'],
  });
}

const messages = slackStream('slack_messages');
const replies = slackStream('slack_thread_replies');

// The upstream of the test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads every Slack message and thread reply posted so far, as an upstream
// that replaces its tables whole.
class Posted extends Source {
  readonly identity = 'posted';
  protected readonly catalog = new Catalog([messages, replies]);
  readonly #messages: readonly SlackMessage[];
  readonly #replies: readonly SlackMessage[];

  constructor(
    messages: readonly SlackMessage[],
    replies: readonly SlackMessage[],
  ) {
    super();
    this.#messages = messages;
    this.#replies = replies;
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

  protected override async *extract({ stream }: CopyConfiguration) {
    const posted =
      stream.name === messages.name ? this.#messages : this.#replies;
    for (const data of posted) yield { stream: stream.name, data };
  }
}

type Row = readonly [
  workspaceId: string,
  channelId: string,
  ts: string,
  userId: string,
  text: string | null,
  threadTs: string | null,
];

// The Slack import in a warehouse: each load gives marts.slack_messages and
// marts.slack_thread_replies every message posted so far, and a rule reads
// them as of two loads.
function workspace(url: string) {
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const history = new PostgresSyncHistory({ url });
  const copies = [messages, replies].map(
    (stream) =>
      new Copy(
        stream,
        destination.table(stream.name).withReaderView('marts', stream.name),
        {
          id: stream.name,
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite',
        },
      ),
  );
  const postedMessages: SlackMessage[] = [];
  const postedReplies: SlackMessage[] = [];
  const toMessage = ([
    workspaceId,
    channelId,
    ts,
    userId,
    text,
    threadTs,
  ]: Row): SlackMessage => ({
    workspaceId,
    channelId,
    ts,
    userId,
    text,
    threadTs,
  });
  return {
    // Posts the messages and replies and loads them. A copy that a later load
    // writes has a newer loaded_at than the copies written before it. Resolves
    // to the position of the load.
    async load(
      newMessages: readonly Row[],
      newReplies: readonly Row[],
    ): Promise<string> {
      postedMessages.push(...newMessages.map(toMessage));
      postedReplies.push(...newReplies.map(toMessage));
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'slack',
            source: new Posted([...postedMessages], [...postedReplies]),
            destination,
            checkpoints,
            steps: copies,
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

const url = (channelId: string, ts: string) =>
  `slack://channel?team=T20H06JTC&id=${channelId}&message=${ts}`;

test('only Clay messages about the BD agent or Data Hub MCP match, with conversation context', async () => {
  await using database = await postgresql.database();
  const slack = workspace(database.connectionString);
  const empty = await slack.load([], []);
  const initial = await slack.load(
    [
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000000.000001',
        'U03CUQ5SCRY',
        'Thanks for the work on the BD agent!',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000020.000001',
        'U03CUQ5SCRY',
        '^^ i’ll add more here as i keep testing',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000030.000001',
        'U03CUQ5SCRY',
        'Lunch tomorrow?',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000040.000001',
        'U03CUQ5SCRY',
        'Thank you!!!',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000100.000001',
        'U03CUQ5SCRY',
        'Hey guys, thanks for all the work on the data hub MCP!',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000110.000001',
        'U03CUQ5SCRY',
        'This was the MCP version',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000120.000001',
        'U03CUQ5SCRY',
        'Seems like it’s still missing elements',
        null,
      ],
      ['T20H06JTC', 'C0BH287LC4R', '1000130.000001', 'U03CUQ5SCRY', null, null],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000140.000001',
        'U01SRLD2QBS',
        'I updated the data hub MCP',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000150.000001',
        'U03CUQ5SCRY',
        'Thanks!! will take a look',
        null,
      ],
      [
        'T20H06JTC',
        'OTHER',
        '1000160.000001',
        'OTHER_USER',
        'The DataHub connector needs a fix',
        null,
      ],
      [
        'T20H06JTC',
        'OTHER',
        '1000170.000001',
        'U03CUQ5SCRY',
        'Any update?',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000180.000001',
        'U03CUQ5SCRY',
        'We could use an MCP for Story Radar',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000190.000001',
        'U03CUQ5SCRY',
        'Any update?',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000200.000001',
        'U03CUQ5SCRY',
        'The data hub has a new logo',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000210.000001',
        'U0BE0G3DU8M',
        'The BD agent and Data Hub MCP are updated',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000220.000001',
        'U03CUQ5SCRY',
        'Can you show me the prompt(s)?',
        null,
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1020000.000001',
        'U03CUQ5SCRY',
        'Any update?',
        null,
      ],
      [
        'T20H06JTC',
        'UNRELATED',
        '1000170.000001',
        'U03CUQ5SCRY',
        'Any update?',
        null,
      ],
      [
        'OTHER_WORKSPACE',
        'C0BH287LC4R',
        '1000000.000001',
        'U03CUQ5SCRY',
        'Data hub MCP',
        null,
      ],
    ],
    [
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1000100.000001',
        'U03CUQ5SCRY',
        'Hey guys, thanks for all the work on the data hub MCP!',
        '1000100.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1029990.000001',
        'U0BE0G3DU8M',
        'Thank you. I’m looking into it.',
        '1000100.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1030000.000001',
        'U03CUQ5SCRY',
        'Thanks!! Let me know if you have an update',
        '1000100.000001',
      ],
      [
        'T20H06JTC',
        'OTHER',
        '1030010.000001',
        'U03CUQ5SCRY',
        'Any update?',
        '1000100.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1030020.000001',
        'OTHER_USER',
        'Any update?',
        '1000100.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1030025.000001',
        'U0BE0G3DU8M',
        'Also, it seems that we have similar brief titles: The Local Infrastructure Hub and BP Local Infrastructure Hub',
        '1000220.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1030030.000001',
        'U03CUQ5SCRY',
        'ahh ok will check it',
        '1000220.000001',
      ],
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1030040.000001',
        'U03CUQ5SCRY',
        'Lunch tomorrow?',
        '1000000.000001',
      ],
    ],
  );

  const bd = new ClayBdAgentMessages();
  const mcp = new ClayDataHubMcpMessages();
  const urls = (timestamps: string[]) =>
    timestamps.map((ts) => url('C0BH287LC4R', ts));
  const bdMatches = await slack.evaluate(bd, empty, initial);
  assert.deepEqual(
    bdMatches.map(({ url }) => url).sort(),
    urls([
      '1000000.000001',
      '1000020.000001',
      '1000220.000001',
      '1030030.000001',
    ]).sort(),
  );
  const mcpMatches = await slack.evaluate(mcp, empty, initial);
  assert.deepEqual(
    mcpMatches.map(({ url }) => url).sort(),
    [
      ...urls([
        '1000100.000001',
        '1000110.000001',
        '1000120.000001',
        '1000130.000001',
        '1000150.000001',
        '1000220.000001',
        '1030000.000001',
        '1030030.000001',
      ]),
      url('OTHER', '1000170.000001'),
    ].sort(),
  );
  assert.equal(
    bdMatches[0]?.text,
    'Clay · BD agent: Thanks for the work on the BD agent!',
  );
  assert.equal(
    mcpMatches.find(
      (match) => match.url === url('C0BH287LC4R', '1000130.000001'),
    )?.text,
    'Clay · Data Hub MCP: (no text)',
  );
  assert.equal(
    bdMatches[0]?.url,
    'slack://channel?team=T20H06JTC&id=C0BH287LC4R&message=1000000.000001',
  );

  const watch = async (from: string, to: string) => ({
    bd: await slack.evaluate(bd, from, to),
    mcp: await slack.evaluate(mcp, from, to),
  });
  const posted = await slack.load(
    [
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1040000.000001',
        'U03CUQ5SCRY',
        'The MCP is ready',
        null,
      ],
      [
        'T20H06JTC',
        'OTHER',
        '1040000.000001',
        'U03CUQ5SCRY',
        'The business development agent is ready',
        null,
      ],
      ['T20H06JTC', 'OTHER', '1040001.000001', 'U03CUQ5SCRY', 'Lunch?', null],
      [
        'T20H06JTC',
        'OTHER',
        '1040002.000001',
        'OTHER_USER',
        'The BD agent is ready',
        null,
      ],
    ],
    [],
  );
  const matches = await watch(initial, posted);
  assert.equal(matches.bd.length, 1, 'one BD notification, only from Clay');
  assert.equal(matches.mcp.length, 1, 'one MCP notification, only from Clay');
  const unchanged = await slack.load([], []);
  assert.deepEqual(
    await watch(posted, unchanged),
    { bd: [], mcp: [] },
    'unchanged messages do not notify again',
  );
  const edited = await slack.load(
    [],
    [
      [
        'T20H06JTC',
        'C0BH287LC4R',
        '1040000.000001',
        'U03CUQ5SCRY',
        'The MCP is ready, edited',
        null,
      ],
    ],
  );
  assert.deepEqual(
    await watch(unchanged, edited),
    { bd: [], mcp: [] },
    'a later edited broadcast is the same message',
  );
  assert.equal(
    (await slack.evaluate(mcp, empty, edited)).find(
      (match) => match.url === url('C0BH287LC4R', '1040000.000001'),
    )?.text,
    'Clay · Data Hub MCP: The MCP is ready, edited',
  );
});
