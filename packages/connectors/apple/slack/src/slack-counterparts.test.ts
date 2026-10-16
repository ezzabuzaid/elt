import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type IndexedDBWrite,
  IndexedDBWriter,
} from '@workspace/codec-chromium-indexeddb/test';
import { Settings } from '@workspace/settings';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

// The SDK finds the Slack store under HOME each time the connector builds its
// source, so HOME points at the test's folder from importing the connector
// until its pass ends. node --test runs this file in its own process.
async function importUnder(home: string): Promise<string> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: SlackConnector } = await import('./slack-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Slack reads nothing through EventKit.
    const connector = new SlackConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
    // One pass as the hosts run it, from a saved selection into its import.
    using settings = new Settings(join(home, 'Apple'));
    const selection = {
      connector: connector.name,
      scope: {},
      includeAttachments: false,
    };
    settings.select([selection], {
      facts: () => connector,
      permissions: () => connector.guidance(),
    });
    const outcome = await connector.import(settings, selection);
    assert.deepEqual(outcome, { status: 'imported' });
    return settings.database(selection);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// Reads as query-apple tells the agent to: the macOS sqlite3 shell,
// read-only. A failing statement fails the test rather than reading as no rows.
function read(database: string, sql: string): Record<string, unknown>[] {
  const result = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', '-cmd', '.timeout 30000', database, sql],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout || '[]');
}

type Member = {
  readonly id: string;
  readonly name: string;
  readonly realName?: string;
  readonly displayName?: string;
  readonly email?: string;
  // For a bot's user, its bot.
  readonly botId?: string;
};

type Channel = {
  readonly id: string;
  readonly kind: 'public' | 'private' | 'im' | 'mpim';
  // For a direct message, the other person.
  readonly with?: string;
  // The members Slack lists, as it does for a group direct message.
  readonly members?: readonly string[];
  // Whether the user belongs to it; a public channel the user only looked at
  // is not joined.
  readonly joined?: false;
};

type Message = {
  readonly channel: string;
  readonly ts: string;
  readonly user?: string;
  readonly bot?: string;
  // The thread it replies in, as a reply's thread_ts.
  readonly reply?: string;
};

// A workspace client's state as the Slack app persists it, with only the
// slices the counterparts read: Slack's own field names, collections keyed by
// id, messages by channel and ts.
function client({
  team,
  user,
  members,
  bots = [],
  channels,
  messages,
}: {
  readonly team: { readonly id: string; readonly name: string };
  readonly user: string;
  readonly members: readonly Member[];
  readonly bots?: readonly { readonly id: string; readonly name: string }[];
  readonly channels: readonly Channel[];
  readonly messages: readonly Message[];
}): IndexedDBWrite {
  return {
    database: 'reduxPersistence',
    objectStore: 'reduxPersistenceStore',
    key: `persist:slack-client-${team.id}-${user}`,
    form: 'blob',
    value: {
      selfTeamIds: { teamId: team.id },
      teams: {
        [team.id]: {
          id: team.id,
          name: team.name,
          domain: team.name.toLowerCase(),
        },
      },
      channels: Object.fromEntries(
        channels.map(({ id, kind, with: other, members: ids, joined }) => [
          id,
          {
            id,
            name: id,
            is_im: kind === 'im',
            is_mpim: kind === 'mpim',
            is_private: kind !== 'public',
            is_member: joined ?? true,
            ...(other === undefined ? {} : { user: other }),
            ...(ids === undefined ? {} : { members: ids }),
          },
        ]),
      ),
      members: Object.fromEntries(
        members.map(({ id, name, realName, displayName, email, botId }) => [
          id,
          {
            id,
            team_id: team.id,
            name,
            ...(realName === undefined ? {} : { real_name: realName }),
            is_bot: botId !== undefined,
            is_self: id === user,
            profile: {
              ...(displayName === undefined
                ? {}
                : { display_name: displayName }),
              ...(email === undefined ? {} : { email }),
              ...(botId === undefined ? {} : { bot_id: botId }),
            },
          },
        ]),
      ),
      bots: Object.fromEntries(bots.map(({ id, name }) => [id, { id, name }])),
      messages: Object.fromEntries(
        [...new Set(messages.map(({ channel }) => channel))].map((channel) => [
          channel,
          Object.fromEntries(
            messages
              .filter((message) => message.channel === channel)
              .map(({ ts, user: author, bot, reply }) => [
                ts,
                {
                  type: 'message',
                  ts,
                  channel,
                  text: 'hello',
                  ...(author === undefined ? {} : { user: author }),
                  ...(bot === undefined ? {} : { bot_id: bot }),
                  ...(author === undefined && bot !== undefined
                    ? { subtype: 'bot_message' }
                    : {}),
                  ...(reply === undefined
                    ? {}
                    : { _hidden_reply: true, thread_ts: reply }),
                },
              ]),
          ),
        ]),
      ),
    },
  };
}

const slackbot = { id: 'USLACKBOT', name: 'slackbot', realName: 'Slackbot' };

test('Slack counterparts name each member by workspace, link it to its email, and tell what the user sent, received and shares with them', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'slack-counterparts-'),
  );
  await new IndexedDBWriter(
    join(
      home.path,
      'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/IndexedDB/https_app.slack.com_0.indexeddb.leveldb',
    ),
  ).save([
    client({
      team: { id: 'T1', name: 'January' },
      user: 'U1',
      members: [
        {
          id: 'U1',
          name: 'ezz',
          realName: 'Ezz Abuzaid',
          email: 'ezz@january.sh',
        },
        {
          id: 'U2',
          name: 'sara',
          realName: 'Sara Haddad',
          email: ' Sara@Example.com ',
        },
        { id: 'U3', name: 'omar', displayName: 'Omar S' },
        { id: 'U4', name: 'donut', realName: 'Donut', botId: 'B4' },
        {
          id: 'U5',
          name: 'nadia',
          realName: 'Nadia Odeh',
          email: 'nadia@example.com',
        },
        slackbot,
      ],
      bots: [
        { id: 'B4', name: 'Donut' },
        { id: 'B9', name: 'Deploys' },
      ],
      channels: [
        { id: 'D1', kind: 'im', with: 'U2' },
        // The user's own direct message.
        { id: 'D2', kind: 'im', with: 'U1' },
        { id: 'D3', kind: 'im', with: 'USLACKBOT' },
        { id: 'G1', kind: 'mpim', members: ['U1', 'U2', 'U3'] },
        { id: 'C1', kind: 'public' },
        { id: 'C2', kind: 'public', joined: false },
      ],
      messages: [
        { channel: 'D1', ts: '1790000100.000100', user: 'U1' },
        { channel: 'D1', ts: '1790000200.000200', user: 'U2' },
        { channel: 'D1', ts: '1790000300.000300', user: 'U1' },
        {
          channel: 'D1',
          ts: '1790000400.000400',
          user: 'U2',
          reply: '1790000300.000300',
        },
        // An incoming webhook posting in the user's own direct message.
        { channel: 'D2', ts: '1790000500.000500', bot: 'B9' },
        { channel: 'D2', ts: '1790000600.000600', bot: 'B9' },
        { channel: 'D2', ts: '1790000700.000700', user: 'U1' },
        { channel: 'G1', ts: '1790000800.000800', user: 'U3' },
        { channel: 'G1', ts: '1790000900.000900', user: 'U1' },
        { channel: 'C1', ts: '1790001000.001000', user: 'U4', bot: 'B4' },
        // A bot that has a user, posting as the bot alone.
        { channel: 'C1', ts: '1790001100.001100', bot: 'B4' },
        // Someone Slack keeps no member for.
        { channel: 'C1', ts: '1790001150.001150', user: 'U6' },
        { channel: 'C2', ts: '1790001200.001200', user: 'U5' },
      ],
    }),
    client({
      team: { id: 'T2', name: 'Delivery' },
      user: 'U7',
      members: [
        {
          id: 'U7',
          name: 'ezz.abuzaid',
          realName: 'Ezz Abuzaid',
          email: 'ezz@delivery.com',
        },
        {
          id: 'U8',
          name: 'sara.h',
          realName: 'Sara Haddad',
          email: 'sara@example.com',
        },
        slackbot,
        { id: 'USLACK', name: 'slack', realName: 'Slack' },
      ],
      channels: [
        { id: 'D4', kind: 'im', with: 'U8' },
        { id: 'D5', kind: 'im', with: 'USLACKBOT' },
        { id: 'D6', kind: 'im', with: 'USLACK' },
        { id: 'P1', kind: 'private' },
      ],
      messages: [
        { channel: 'D4', ts: '1790002000.002000', user: 'U8' },
        { channel: 'P1', ts: '1790002100.002100', user: 'U7' },
        {
          channel: 'P1',
          ts: '1790002200.002200',
          user: 'U8',
          reply: '1790002100.002100',
        },
        // Slack's own notice, such as being added to a user group.
        { channel: 'D6', ts: '1790002300.002300', user: 'USLACK' },
      ],
    }),
  ]);

  const database = await importUnder(home.path);

  assert.deepEqual(
    read(
      database,
      'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY identifier, relation',
    ),
    [
      // A webhook has no member: its bot ID, under its workspace, is the one
      // identifier Slack gives it.
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: 'T1:B9',
        linked_type: null,
        linked_identifier: null,
        name: 'Deploys',
        first_at: '2026-09-21T14:21:40.000500Z',
        last_at: '2026-09-21T14:23:20.000600Z',
        occurrences: 2,
        context:
          '{"workspace":"January","isBot":true,"conversations":{"im":1}}',
      },
      // The user's notes in their own direct message are theirs alone.
      {
        relation: 'self',
        identifier_type: 'app',
        identifier: 'T1:U1',
        linked_type: 'email',
        linked_identifier: 'ezz@january.sh',
        name: 'Ezz Abuzaid',
        first_at: '2026-09-21T14:15:00.000100Z',
        last_at: '2026-09-21T14:28:20.000900Z',
        occurrences: 4,
        context:
          '{"workspace":"January","isBot":false,"conversations":{"im":2,"mpim":1}}',
      },
      // Every message of the direct message and of the group direct message
      // Slack lists her in, though she wrote none in the group.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T1:U2',
        linked_type: 'email',
        linked_identifier: 'sara@example.com',
        name: 'Sara Haddad',
        first_at: '2026-09-21T14:15:00.000100Z',
        last_at: '2026-09-21T14:28:20.000900Z',
        occurrences: 6,
        context:
          '{"workspace":"January","isBot":false,"conversations":{"im":1,"mpim":1}}',
      },
      // Her message and her thread reply.
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: 'T1:U2',
        linked_type: 'email',
        linked_identifier: 'sara@example.com',
        name: 'Sara Haddad',
        first_at: '2026-09-21T14:16:40.000200Z',
        last_at: '2026-09-21T14:20:00.000400Z',
        occurrences: 2,
        context:
          '{"workspace":"January","isBot":false,"conversations":{"im":1}}',
      },
      {
        relation: 'sent',
        identifier_type: 'app',
        identifier: 'T1:U2',
        linked_type: 'email',
        linked_identifier: 'sara@example.com',
        name: 'Sara Haddad',
        first_at: '2026-09-21T14:15:00.000100Z',
        last_at: '2026-09-21T14:18:20.000300Z',
        occurrences: 2,
        context:
          '{"workspace":"January","isBot":false,"conversations":{"im":1}}',
      },
      // No real name: the name he chose to show.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T1:U3',
        linked_type: null,
        linked_identifier: null,
        name: 'Omar S',
        first_at: '2026-09-21T14:26:40.000800Z',
        last_at: '2026-09-21T14:28:20.000900Z',
        occurrences: 2,
        context:
          '{"workspace":"January","isBot":false,"conversations":{"mpim":1}}',
      },
      // A bot's posts as its user and as the bot alone are one member's.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T1:U4',
        linked_type: null,
        linked_identifier: null,
        name: 'Donut',
        first_at: '2026-09-21T14:30:00.001000Z',
        last_at: '2026-09-21T14:32:30.001150Z',
        occurrences: 3,
        context:
          '{"workspace":"January","isBot":true,"conversations":{"public":1}}',
      },
      // An author Slack keeps no member for has no name, and whether it is a
      // bot is unknown.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T1:U6',
        linked_type: null,
        linked_identifier: null,
        name: null,
        first_at: '2026-09-21T14:30:00.001000Z',
        last_at: '2026-09-21T14:32:30.001150Z',
        occurrences: 3,
        context:
          '{"workspace":"January","isBot":null,"conversations":{"public":1}}',
      },
      // A direct message Slack holds no message of still puts Slackbot, which
      // Slack does not mark a bot, in touch with the user.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T1:USLACKBOT',
        linked_type: null,
        linked_identifier: null,
        name: 'Slackbot',
        first_at: null,
        last_at: null,
        occurrences: 0,
        context:
          '{"workspace":"January","isBot":true,"conversations":{"im":1}}',
      },
      {
        relation: 'self',
        identifier_type: 'app',
        identifier: 'T2:U7',
        linked_type: 'email',
        linked_identifier: 'ezz@delivery.com',
        name: 'Ezz Abuzaid',
        first_at: '2026-09-21T14:48:20.002100Z',
        last_at: '2026-09-21T14:48:20.002100Z',
        occurrences: 1,
        context:
          '{"workspace":"Delivery","isBot":false,"conversations":{"private":1}}',
      },
      // Her reply puts her in the private channel; her email links her to
      // her member in the other workspace.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T2:U8',
        linked_type: 'email',
        linked_identifier: 'sara@example.com',
        name: 'Sara Haddad',
        first_at: '2026-09-21T14:46:40.002000Z',
        last_at: '2026-09-21T14:50:00.002200Z',
        occurrences: 3,
        context:
          '{"workspace":"Delivery","isBot":false,"conversations":{"im":1,"private":1}}',
      },
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: 'T2:U8',
        linked_type: 'email',
        linked_identifier: 'sara@example.com',
        name: 'Sara Haddad',
        first_at: '2026-09-21T14:46:40.002000Z',
        last_at: '2026-09-21T14:46:40.002000Z',
        occurrences: 1,
        context:
          '{"workspace":"Delivery","isBot":false,"conversations":{"im":1}}',
      },
      // Slack's own member is no bot to Slack either.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T2:USLACK',
        linked_type: null,
        linked_identifier: null,
        name: 'Slack',
        first_at: '2026-09-21T14:51:40.002300Z',
        last_at: '2026-09-21T14:51:40.002300Z',
        occurrences: 1,
        context:
          '{"workspace":"Delivery","isBot":true,"conversations":{"im":1}}',
      },
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: 'T2:USLACK',
        linked_type: null,
        linked_identifier: null,
        name: 'Slack',
        first_at: '2026-09-21T14:51:40.002300Z',
        last_at: '2026-09-21T14:51:40.002300Z',
        occurrences: 1,
        context:
          '{"workspace":"Delivery","isBot":true,"conversations":{"im":1}}',
      },
      // Slackbot has one member ID in every workspace: each is its own.
      {
        relation: 'member',
        identifier_type: 'app',
        identifier: 'T2:USLACKBOT',
        linked_type: null,
        linked_identifier: null,
        name: 'Slackbot',
        first_at: null,
        last_at: null,
        occurrences: 0,
        context:
          '{"workspace":"Delivery","isBot":true,"conversations":{"im":1}}',
      },
    ],
  );
  // Readers find the view and every column described in the catalog.
  assert.equal(
    read(
      database,
      "SELECT count(*) AS n FROM catalog WHERE name LIKE 'counterparts.%' AND description <> ''",
    )[0]?.n,
    10,
  );
});
