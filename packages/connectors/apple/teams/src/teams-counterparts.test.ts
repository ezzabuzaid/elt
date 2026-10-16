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

// New Teams keeps what its web client loads in Chromium's IndexedDB for
// teams.microsoft.com, inside its App Store container under HOME.
const store =
  'Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb';

const tenant = '7c1b6a4e-0d2f-4a8e-9b3c-5e6f7a8b9c0d';
const user = '11111111-1111-4111-8111-111111111111';
const me = `8:orgid:${user}`;
const ada = '8:orgid:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const grace = '8:orgid:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const bot = '28:cccccccc-3333-4333-8333-cccccccccccc';
const linus = '8:orgid:dddddddd-4444-4444-8444-dddddddddddd';
const heidi = '8:orgid:eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const ivan = '8:orgid:ffffffff-6666-4666-8666-ffffffffffff';
const parking = '28:99999999-7777-4777-8777-999999999999';

const ms = (instant: string) => Date.parse(instant);

type Entry = Record<string, unknown>;

// A message as the reply chain cache holds it: Teams names it by when the
// service received it.
function message({
  conversationId,
  sentAt,
  creator,
  name = null,
  messageType = 'RichText/Html',
  content = '<p>hi</p>',
  properties = {},
}: {
  readonly conversationId: string;
  readonly sentAt: string;
  readonly creator: string;
  readonly name?: string | null;
  readonly messageType?: string;
  readonly content?: string | null;
  readonly properties?: Entry;
}) {
  const id = String(ms(sentAt));
  return {
    id,
    conversationId,
    parentMessageId: id,
    originalArrivalTime: ms(sentAt),
    creator,
    imDisplayName: name,
    messageType,
    contentType: 'Text',
    content,
    isSentByCurrentUser: creator === me,
    properties,
  };
}

// An entry of the call history, a message of the client's 48:calllogs list.
function callLog(loggedAt: string, log: Entry) {
  return message({
    conversationId: '48:calllogs',
    sentAt: loggedAt,
    creator: me,
    messageType: 'Text',
    properties: { 'call-log': JSON.stringify(log) },
  });
}

const party = (id: string, displayName: string | null = null) => ({
  id,
  type: 'default',
  displayName,
});

const member = (id: string) => ({ id, role: 'User', isReader: false });

const notes = {
  id: '48:notes',
  type: 'StreamOfNotes',
  lastMessageTimeUtc: ms('2026-09-15T07:00:00.000Z'),
  members: [member(me)],
};

const people = [
  {
    mri: me,
    type: 'ADUser',
    displayName: 'Ezz Abuzaid',
    email: 'Ezz@Contoso.com',
    userPrincipalName: 'ezz@contoso.com',
  },
  {
    mri: ada,
    type: 'ADUser',
    displayName: 'Ada Lovelace',
    email: ' Ada@Contoso.com ',
    userPrincipalName: 'ada@contoso.com',
  },
  { mri: bot, type: 'BOT', displayName: 'Planner' },
];

// One signed-in account's store as its web client saves it: each manager's
// records in a database of its own, named after the tenant and the user.
async function teamsUnder(
  home: string,
  {
    conversations,
    messages,
    profiles,
    meetings,
  }: {
    readonly conversations: readonly Entry[];
    readonly messages: readonly ReturnType<typeof message>[];
    readonly profiles: readonly Entry[];
    readonly meetings: readonly Entry[];
  },
): Promise<void> {
  const put = (
    manager: string,
    objectStore: string,
    key: string,
    value: unknown,
  ): IndexedDBWrite => ({
    database: `Teams:${manager}:react-web-client:${tenant}:${user}:en-us`,
    objectStore,
    key,
    value,
  });
  await new IndexedDBWriter(join(home, store)).save([
    ...conversations.map((conversation) =>
      put(
        'conversation-manager',
        'conversations',
        String(conversation.id),
        conversation,
      ),
    ),
    ...messages.map((one) =>
      put(
        'replychain-manager',
        'replychains',
        `${one.conversationId}/${one.id}`,
        {
          conversationId: one.conversationId,
          replyChainId: one.id,
          messageMap: { [`${one.creator}_${one.id}`]: one },
        },
      ),
    ),
    ...profiles.map((profile) =>
      put('profiles', 'profiles', String(profile.mri), profile),
    ),
    ...meetings.map((meeting) =>
      put('calendar', 'calendar', String(meeting.objectId), meeting),
    ),
  ]);
}

// One pass as the hosts run it, from a saved selection into its import. The
// Teams SDK finds the app's store under HOME, so HOME points at the test's
// folder while the connector loads and imports; node --test runs this file in
// its own process.
async function importUnder(home: string): Promise<string> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: TeamsConnector } = await import('./teams-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Teams reads nothing through EventKit.
    const connector = new TeamsConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
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

const counterparts =
  'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY identifier, relation';

test('Teams counterparts: what the user wrote and received in chats, everyone in a conversation with the user, and the account itself', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'teams-counterparts-'),
  );
  const direct = `19:${user}_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa@unq.gbl.spaces`;
  const group = '19:launch@thread.v2';
  const meeting = '19:meeting_review@thread.v2';
  const channel = '19:reviews@thread.tacv2';
  await teamsUnder(home.path, {
    conversations: [
      {
        id: direct,
        type: 'Chat',
        lastMessageTimeUtc: ms('2026-09-02T10:00:00.000Z'),
        threadProperties: { createdat: ms('2026-08-01T09:00:00.000Z') },
        members: [member(me), member(ada)],
      },
      {
        id: group,
        type: 'Chat',
        lastMessageTimeUtc: ms('2026-09-06T12:00:00.000Z'),
        threadProperties: { createdat: ms('2026-08-05T09:00:00.000Z') },
        members: [member(me), member(ada), member(grace)],
        botMembers: [member(bot)],
      },
      {
        id: meeting,
        type: 'Meeting',
        lastMessageTimeUtc: ms('2026-09-08T15:00:00.000Z'),
        threadProperties: { createdat: ms('2026-08-10T09:00:00.000Z') },
        members: [member(me), member(linus)],
      },
      // Teams keeps no member list for a channel, nor when it was created.
      {
        id: channel,
        type: 'Topic',
        teamId: '19:design@thread.tacv2',
        lastMessageTimeUtc: ms('2026-09-10T12:00:00.000Z'),
        threadProperties: { topic: 'reviews', createdat: null },
      },
      notes,
    ],
    messages: [
      message({
        conversationId: direct,
        sentAt: '2026-09-01T09:00:00.000Z',
        creator: ada,
        name: 'Ada',
      }),
      // A deleted message keeps its place and its sender.
      message({
        conversationId: direct,
        sentAt: '2026-09-01T12:00:00.000Z',
        creator: ada,
        name: 'Ada',
        content: null,
        properties: { deletetime: String(ms('2026-09-01T12:05:00.000Z')) },
      }),
      message({
        conversationId: direct,
        sentAt: '2026-09-02T10:00:00.000Z',
        creator: me,
        name: 'Ezz Abuzaid',
      }),
      // Teams' own record of a change to the chat, sent by the chat itself.
      message({
        conversationId: group,
        sentAt: '2026-08-05T09:00:01.000Z',
        creator: group,
        messageType: 'ThreadActivity/AddMember',
        content: '<addmember></addmember>',
      }),
      message({
        conversationId: group,
        sentAt: '2026-09-05T08:00:00.000Z',
        creator: me,
        name: 'Ezz Abuzaid',
      }),
      message({
        conversationId: group,
        sentAt: '2026-09-05T09:00:00.000Z',
        creator: grace,
        name: 'Grace Hopper',
      }),
      // A call's event in the chat, which call_logs records as the call.
      message({
        conversationId: group,
        sentAt: '2026-09-05T10:00:00.000Z',
        creator: ada,
        messageType: 'Event/Call',
        content: '<partlist alt=""></partlist>',
      }),
      message({
        conversationId: group,
        sentAt: '2026-09-06T12:00:00.000Z',
        creator: bot,
        name: 'Planner',
        messageType: 'RichText/Media_Card',
      }),
      message({
        conversationId: meeting,
        sentAt: '2026-09-08T15:00:00.000Z',
        creator: grace,
        name: 'Grace Hopper',
      }),
      message({
        conversationId: channel,
        sentAt: '2026-09-10T12:00:00.000Z',
        creator: ada,
        name: 'Ada',
        properties: {
          mentions: JSON.stringify([
            {
              itemid: 0,
              mri: ivan,
              mentionType: 'person',
              displayName: 'Ivan',
            },
          ]),
          emotions: [
            {
              key: 'like',
              users: [{ mri: heidi, time: ms('2026-09-10T12:10:00.000Z') }],
            },
          ],
        },
      }),
      message({
        conversationId: '48:notes',
        sentAt: '2026-09-15T07:00:00.000Z',
        creator: me,
        name: 'Ezz Abuzaid',
      }),
    ],
    profiles: people,
    meetings: [],
  });

  const database = await importUnder(home.path);

  assert.deepEqual(read(database, counterparts), [
    // A bot is a counterpart too; the directory names it but gives no email.
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: bot,
      linked_type: null,
      linked_identifier: null,
      name: 'Planner',
      first_at: '2026-08-05T09:00:00.000Z',
      last_at: '2026-09-06T12:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":1,"meeting":0,"channel":0}',
    },
    {
      relation: 'received',
      identifier_type: 'app',
      identifier: bot,
      linked_type: null,
      linked_identifier: null,
      name: 'Planner',
      first_at: '2026-09-06T12:00:00.000Z',
      last_at: '2026-09-06T12:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":1}',
    },
    {
      relation: 'sent',
      identifier_type: 'app',
      identifier: bot,
      linked_type: null,
      linked_identifier: null,
      name: 'Planner',
      first_at: '2026-09-05T08:00:00.000Z',
      last_at: '2026-09-05T08:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":1}',
    },
    // The account's own Teams ID, linked to the user's address.
    {
      relation: 'self',
      identifier_type: 'app',
      identifier: me,
      linked_type: 'email',
      linked_identifier: 'ezz@contoso.com',
      name: 'Ezz Abuzaid',
      first_at: null,
      last_at: null,
      occurrences: 1,
      context: null,
    },
    // Ada shares the one-on-one chat, the group chat and, by writing in it,
    // the channel; the directory's name for her wins over her messages', and
    // its address is trimmed and lowercase.
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: ada,
      linked_type: 'email',
      linked_identifier: 'ada@contoso.com',
      name: 'Ada Lovelace',
      first_at: '2026-08-01T09:00:00.000Z',
      last_at: '2026-09-10T12:00:00.000Z',
      occurrences: 3,
      context: '{"direct":1,"group":1,"meeting":0,"channel":1}',
    },
    // Her deleted message counts; her call event in the group chat and her
    // channel post do not.
    {
      relation: 'received',
      identifier_type: 'app',
      identifier: ada,
      linked_type: 'email',
      linked_identifier: 'ada@contoso.com',
      name: 'Ada Lovelace',
      first_at: '2026-09-01T09:00:00.000Z',
      last_at: '2026-09-01T12:00:00.000Z',
      occurrences: 2,
      context: '{"direct":2,"group":0}',
    },
    {
      relation: 'sent',
      identifier_type: 'app',
      identifier: ada,
      linked_type: 'email',
      linked_identifier: 'ada@contoso.com',
      name: 'Ada Lovelace',
      first_at: '2026-09-02T10:00:00.000Z',
      last_at: '2026-09-05T08:00:00.000Z',
      occurrences: 2,
      context: '{"direct":1,"group":1}',
    },
    // Teams never looked Grace up: no address, and the name her messages
    // carry. Writing in the meeting chat makes her a member of it, not a
    // sender to the user.
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: grace,
      linked_type: null,
      linked_identifier: null,
      name: 'Grace Hopper',
      first_at: '2026-08-05T09:00:00.000Z',
      last_at: '2026-09-08T15:00:00.000Z',
      occurrences: 2,
      context: '{"direct":0,"group":1,"meeting":1,"channel":0}',
    },
    {
      relation: 'received',
      identifier_type: 'app',
      identifier: grace,
      linked_type: null,
      linked_identifier: null,
      name: 'Grace Hopper',
      first_at: '2026-09-05T09:00:00.000Z',
      last_at: '2026-09-05T09:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":1}',
    },
    {
      relation: 'sent',
      identifier_type: 'app',
      identifier: grace,
      linked_type: null,
      linked_identifier: null,
      name: 'Grace Hopper',
      first_at: '2026-09-05T08:00:00.000Z',
      last_at: '2026-09-05T08:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":1}',
    },
    // Only the meeting chat's member list names Linus.
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: linus,
      linked_type: null,
      linked_identifier: null,
      name: null,
      first_at: '2026-08-10T09:00:00.000Z',
      last_at: '2026-09-08T15:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":0,"meeting":1,"channel":0}',
    },
    // Reacting and being @mentioned in the channel make members of it too.
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: heidi,
      linked_type: null,
      linked_identifier: null,
      name: null,
      first_at: null,
      last_at: '2026-09-10T12:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":0,"meeting":0,"channel":1}',
    },
    {
      relation: 'member',
      identifier_type: 'app',
      identifier: ivan,
      linked_type: null,
      linked_identifier: null,
      name: null,
      first_at: null,
      last_at: '2026-09-10T12:00:00.000Z',
      occurrences: 1,
      context: '{"direct":0,"group":0,"meeting":0,"channel":1}',
    },
  ]);
  // Readers find the view and every column described in the catalog.
  assert.equal(
    read(
      database,
      "SELECT count(*) AS n FROM catalog WHERE name LIKE 'counterparts.%' AND description <> ''",
    )[0]?.n,
    10,
  );
});

test('Teams counterparts: who called the user and whom the user called, who else was on a call, and who organized and attended meetings', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'teams-counterparts-'),
  );
  await teamsUnder(home.path, {
    conversations: [notes],
    messages: [
      callLog('2026-09-12T14:35:04.963Z', {
        callId: 'call-1',
        startTime: '2026-09-12T14:35:04.9634166Z',
        connectTime: '2026-09-12T14:35:07.7068228Z',
        endTime: '2026-09-12T14:55:25.0540543Z',
        callDirection: 'incoming',
        callType: 'twoParty',
        callState: 'accepted',
        originatorParticipant: party(ada, 'Ada'),
        targetParticipant: party(me),
        participantList: null,
      }),
      // A group call Ada placed, with Linus and a call park service on it.
      callLog('2026-09-13T16:00:00.000Z', {
        callId: 'call-2',
        startTime: '2026-09-13T16:00:00Z',
        connectTime: '2026-09-13T16:00:05Z',
        endTime: '2026-09-13T16:10:05Z',
        callDirection: 'incoming',
        callType: 'multiParty',
        callState: 'accepted',
        originatorParticipant: party(ada, 'Ada'),
        targetParticipant: party(me),
        participantList: [
          { id: ada, type: 'default', tenantId: tenant },
          { id: me, type: 'default', tenantId: tenant },
          { id: linus, type: 'default', tenantId: tenant },
          { id: parking, type: 'callParkService', tenantId: tenant },
        ],
      }),
      callLog('2026-09-14T09:00:00.123Z', {
        callId: 'call-3',
        startTime: '2026-09-14T09:00:00.1234567Z',
        connectTime: '2026-09-14T09:00:03Z',
        endTime: '2026-09-14T09:01:03Z',
        callDirection: 'outgoing',
        callType: 'twoParty',
        callState: 'accepted',
        originatorParticipant: party(me, 'Ezz Abuzaid'),
        targetParticipant: party(ada),
        participantList: null,
      }),
      callLog('2026-09-15T10:00:00.000Z', {
        callId: 'call-4',
        startTime: '2026-09-15T10:00:00Z',
        connectTime: null,
        endTime: '2026-09-15T10:00:30Z',
        callDirection: 'incoming',
        callType: 'twoParty',
        callState: 'missed',
        originatorParticipant: party(grace, 'Grace Hopper'),
        targetParticipant: party(me),
        participantList: null,
      }),
      callLog('2026-09-16T10:00:00.000Z', {
        callId: 'call-5',
        startTime: '2026-09-16T10:00:00Z',
        connectTime: null,
        endTime: '2026-09-16T10:00:10Z',
        callDirection: 'incoming',
        callType: 'twoParty',
        callState: 'declined',
        originatorParticipant: party(grace, 'Grace Hopper'),
        targetParticipant: party(me),
        participantList: null,
      }),
      callLog('2026-09-17T10:00:00.000Z', {
        callId: 'call-6',
        startTime: '2026-09-17T10:00:00Z',
        connectTime: null,
        endTime: '2026-09-17T10:00:20Z',
        callDirection: 'incoming',
        callType: 'twoParty',
        callState: 'missed',
        originatorParticipant: party(grace, 'Grace Hopper'),
        targetParticipant: party(me),
        participantList: null,
      }),
    ],
    profiles: people,
    meetings: [
      {
        objectId: 'AAMkAD-review',
        subject: 'Design review',
        startTime: new Date('2026-10-14T13:00:00.000Z'),
        endTime: new Date('2026-10-14T13:45:00.000Z'),
        organizerName: 'A. Lovelace',
        organizerAddress: 'Ada@Contoso.com',
        myResponseType: 'Accepted',
        isCancelled: false,
        attendees: [
          {
            status: { response: 'None' },
            type: 'Organizer',
            role: 'User',
            address: 'Ada@Contoso.com',
            name: 'A. Lovelace',
          },
          {
            status: { response: 'Accepted' },
            type: 'Required',
            role: 'User',
            address: 'EZZ@contoso.com',
            name: 'Ezz Abuzaid',
          },
          {
            status: { response: 'Accepted' },
            type: 'Required',
            role: 'User',
            address: ' Rana@Example.com ',
            name: 'Rana',
          },
          {
            status: { response: 'Accepted' },
            type: 'Resource',
            role: 'User',
            address: 'room-1@contoso.com',
            name: 'Room 1',
          },
        ],
      },
      {
        objectId: 'AAMkAD-planning',
        subject: 'Planning',
        startTime: new Date('2026-10-20T09:00:00.000Z'),
        endTime: new Date('2026-10-20T09:30:00.000Z'),
        organizerName: 'A. Lovelace',
        organizerAddress: 'ada@contoso.com',
        myResponseType: 'NotResponded',
        isCancelled: true,
        attendees: [
          {
            status: { response: 'None' },
            type: 'Optional',
            role: 'User',
            address: 'rana@example.com',
            name: 'Rana',
          },
        ],
      },
      // A meeting the user organizes names the user alone.
      {
        objectId: 'AAMkAD-focus',
        subject: 'Focus time',
        startTime: new Date('2026-10-21T08:00:00.000Z'),
        endTime: new Date('2026-10-21T10:00:00.000Z'),
        organizerName: 'Ezz Abuzaid',
        organizerAddress: 'EZZ@Contoso.com',
        myResponseType: 'Organizer',
        isCancelled: false,
        attendees: [
          {
            status: { response: 'None' },
            type: 'Organizer',
            role: 'User',
            address: 'EZZ@Contoso.com',
            name: 'Ezz Abuzaid',
          },
        ],
      },
    ],
  });

  const database = await importUnder(home.path);

  assert.deepEqual(read(database, counterparts), [
    {
      relation: 'self',
      identifier_type: 'app',
      identifier: me,
      linked_type: 'email',
      linked_identifier: 'ezz@contoso.com',
      name: 'Ezz Abuzaid',
      first_at: null,
      last_at: null,
      occurrences: 1,
      context: null,
    },
    // Times cut from the calling service's seven fraction digits to
    // milliseconds; seconds connected 1217.3 + 600.
    {
      relation: 'answered-call',
      identifier_type: 'app',
      identifier: ada,
      linked_type: 'email',
      linked_identifier: 'ada@contoso.com',
      name: 'Ada Lovelace',
      first_at: '2026-09-12T14:35:04.963Z',
      last_at: '2026-09-13T16:00:00.000Z',
      occurrences: 2,
      context: '{"group":1,"seconds":1817}',
    },
    {
      relation: 'outgoing-call',
      identifier_type: 'app',
      identifier: ada,
      linked_type: 'email',
      linked_identifier: 'ada@contoso.com',
      name: 'Ada Lovelace',
      first_at: '2026-09-14T09:00:00.123Z',
      last_at: '2026-09-14T09:00:00.123Z',
      occurrences: 1,
      context: '{"group":0,"seconds":60}',
    },
    // Two missed calls and a declined one; Grace's name is the call log's.
    {
      relation: 'missed-call',
      identifier_type: 'app',
      identifier: grace,
      linked_type: null,
      linked_identifier: null,
      name: 'Grace Hopper',
      first_at: '2026-09-15T10:00:00.000Z',
      last_at: '2026-09-17T10:00:00.000Z',
      occurrences: 3,
      context: '{"group":0,"declined":1}',
    },
    // Linus was on Ada's group call; the call park service is no one.
    {
      relation: 'attendee',
      identifier_type: 'app',
      identifier: linus,
      linked_type: null,
      linked_identifier: null,
      name: null,
      first_at: '2026-09-13T16:00:00.000Z',
      last_at: '2026-09-13T16:00:00.000Z',
      occurrences: 1,
      context: '{"meetings":0,"calls":1,"cancelled":0}',
    },
    // A meeting names people by address: the organizer once per meeting
    // though the attendee list repeats her, by the directory's name for her
    // address, and neither the user nor the room.
    {
      relation: 'organizer',
      identifier_type: 'email',
      identifier: 'ada@contoso.com',
      linked_type: null,
      linked_identifier: null,
      name: 'Ada Lovelace',
      first_at: '2026-10-14T13:00:00.000Z',
      last_at: '2026-10-20T09:00:00.000Z',
      occurrences: 2,
      context: '{"cancelled":1}',
    },
    {
      relation: 'attendee',
      identifier_type: 'email',
      identifier: 'rana@example.com',
      linked_type: null,
      linked_identifier: null,
      name: 'Rana',
      first_at: '2026-10-14T13:00:00.000Z',
      last_at: '2026-10-20T09:00:00.000Z',
      occurrences: 2,
      context: '{"meetings":2,"calls":0,"cancelled":1}',
    },
  ]);
});
