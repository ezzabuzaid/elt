import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  type FieldSchema,
  Gauge,
  Pipeline,
  type Properties,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import type { Automation } from '../../engine/automation.ts';
import { MeetingBriefWriter } from './meeting-brief-writer.ts';
import { type MeetingBrief, PlanningMeetings } from './planning-meetings.ts';

const postgresql = new Postgres({ environment: process.env });

const key: FieldSchema = { type: 'string' };
const text: FieldSchema = { type: ['string', 'null'] };
const integer: FieldSchema = { type: ['integer', 'null'] };
const number: FieldSchema = { type: ['number', 'null'] };
const boolean: FieldSchema = { type: ['boolean', 'null'] };
const time: FieldSchema = { type: ['string', 'null'], format: 'date-time' };

// A marts table that the rule reads. Each column is in each row, and only
// the primary key cannot be null, as in the tables of the imports. A reader
// view needs a description of the stream and of each column, so each one is
// its name.
function table(
  name: string,
  columns: Properties,
  primaryKey: readonly string[],
): Stream {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description: name,
      properties: Object.fromEntries(
        Object.entries(columns).map(([column, schema]) => [
          column,
          { ...schema, description: column },
        ]),
      ),
      required: Object.keys(columns),
    },
    primaryKey,
    supportedSyncModes: ['full_refresh'],
  });
}

type SlackMessage = {
  workspaceId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  sentAt: string;
  userId: string;
  text: string;
};

const slack = {
  workspaceId: text,
  channelId: text,
  ts: text,
  threadTs: text,
  sentAt: time,
  userId: text,
  text,
};
const calendars = table(
  'calendar_calendars',
  { id: key, type: integer, subscribed: boolean },
  ['id'],
);
const events = table(
  'calendar_events',
  {
    eventId: key,
    calendarId: text,
    name: text,
    startAt: time,
    endAt: time,
    body: text,
    location: text,
    url: text,
    allDay: boolean,
    status: integer,
  },
  ['eventId'],
);
const attendees = table(
  'calendar_attendees',
  {
    id: key,
    eventId: text,
    name: text,
    url: text,
    status: integer,
    isCurrentUser: boolean,
    type: integer,
  },
  ['id'],
);
const slackMessages = table('slack_messages', slack, []);
const slackReplies = table('slack_thread_replies', slack, []);
const messages = table(
  'messages_messages',
  { guid: text, date: time, isFromMe: boolean, handle: text, text },
  [],
);
const chatMessages = table(
  'messages_chat_messages',
  { messageGuid: text, chatGuid: text },
  [],
);
// Mail IDs are decimal text, and its membership table joins by the
// Message-ID hash, not messages.id or the undocumented conversationId.
const mailMessages = table(
  'mail_messages',
  {
    id: key,
    messageId: text,
    dateReceived: time,
    subjectPrefix: text,
    subject: text,
    sender: text,
    globalMessageId: text,
    deleted: number,
  },
  ['id'],
);
const mailConversations = table(
  'mail_conversation_messages',
  { conversationId: text, messageId: text },
  [],
);
const mailAddresses = table('mail_addresses', { id: key, address: text }, [
  'id',
]);
const mailSubjects = table('mail_subjects', { id: key, subject: text }, ['id']);
const mailParts = table(
  'mail_message_parts',
  {
    messageId: text,
    partId: text,
    text,
    contentType: text,
    isAttachment: boolean,
  },
  [],
);
const mailGlobalData = table(
  'mail_message_global_data',
  { id: key, messageIdHeader: text },
  ['id'],
);
const tables = [
  calendars,
  events,
  attendees,
  slackMessages,
  slackReplies,
  messages,
  chatMessages,
  mailMessages,
  mailConversations,
  mailAddresses,
  mailSubjects,
  mailParts,
  mailGlobalData,
];

// The upstream of the test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads every row given so far, as it is now, as upstreams that replace
// their tables whole.
class Imports extends Source {
  readonly identity = 'imports';
  protected readonly catalog = new Catalog(tables);
  readonly #rows: readonly (readonly [Stream, object])[];

  constructor(rows: readonly (readonly [Stream, object])[]) {
    super();
    this.#rows = rows;
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
    for (const [table, data] of this.#rows)
      if (table.name === stream.name) yield { stream: stream.name, data };
  }
}

// The Calendar, Slack, Messages and Mail imports in a warehouse: each load
// gives each marts table every row given so far, and a rule reads it as of
// two loads.
function imports(url: string) {
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const history = new PostgresSyncHistory({ url });
  const copies = tables.map((stream) => ({
    stream,
    copy: new Copy(
      stream,
      destination.table(stream.name).withReaderView('marts', stream.name),
      {
        id: stream.name,
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite',
      },
    ),
  }));
  const rows: (readonly [Stream, object])[] = [];
  return {
    add(stream: Stream, ...data: readonly object[]) {
      rows.push(...data.map((row): readonly [Stream, object] => [stream, row]));
    },
    // Loads the tables given, with their rows as they are now, as the import
    // that owns them does; the other tables keep what they hold. Resolves to
    // the position of the load.
    async load(...changed: readonly Stream[]): Promise<string> {
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'imports',
            source: new Imports([...rows]),
            destination,
            checkpoints,
            steps: copies
              .filter(({ stream }) => changed.includes(stream))
              .map(({ copy }) => copy),
          }),
        ],
      }).run();
      const positions = await destination.positions();
      if ('expired' in positions) assert.fail(positions.expired);
      const position = positions.at(-1);
      assert.ok(position !== undefined, 'the load made a position');
      return position;
    },
    // What the rule gives between the warehouse as of two positions, both
    // read at the time at, as eca reads a step in which only the data moves.
    async evaluate<Data>(
      rule: Automation<Data>,
      from: string,
      to: string,
      at: Temporal.Instant,
    ): Promise<readonly Data[]> {
      const before = await destination.reading(from);
      if ('expired' in before) assert.fail(before.expired);
      await using _before = before;
      const after = await destination.reading(to);
      if ('expired' in after) assert.fail(after.expired);
      await using _after = after;
      return await rule.evaluate({ ...before, at }, { ...after, at });
    },
  };
}

test('planning briefs follow new meetings and related evidence, without retriggering on imports', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  const warehouse = imports(database.connectionString);
  const rule = new PlanningMeetings(new MeetingBriefWriter(tmpdir()), sql);
  const now = Temporal.Instant.from('2026-10-11T12:00Z');
  const event = (
    eventId: string,
    calendarId: string,
    name: string,
    startAt: string,
  ) => ({
    eventId,
    calendarId,
    name,
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60_000).toISOString(),
    body: null,
    location: null,
    url: null,
    allDay: false,
    status: 1,
  });
  warehouse.add(
    calendars,
    { id: 'own', type: 1, subscribed: false },
    { id: 'holidays', type: 1, subscribed: true },
  );
  warehouse.add(
    events,
    event('old', 'own', 'Earlier project planning', '2026-10-12T09:00:00.000Z'),
    event('past', 'own', 'Atlas planning', '2026-10-10T09:00:00.000Z'),
    event(
      'subscription',
      'holidays',
      'Atlas planning',
      '2026-10-12T09:00:00.000Z',
    ),
    event('ordinary', 'own', 'Dentist', '2026-10-12T09:00:00.000Z'),
  );
  const baseline = await warehouse.load(...tables);

  const meeting = {
    ...event('new', 'own', 'Atlas planning', '2026-10-12T09:00:00.000Z'),
    url: 'https://meet.example/atlas',
  };
  warehouse.add(events, meeting);
  warehouse.add(
    attendees,
    {
      id: 'accepted',
      eventId: 'new',
      name: 'Alex',
      url: 'mailto:alex@example.com',
      status: 2,
      isCurrentUser: false,
      type: 1,
    },
    {
      id: 'declined',
      eventId: 'new',
      name: 'Sam',
      url: 'mailto:sam@example.com',
      status: 3,
      isCurrentUser: false,
      type: 1,
    },
  );
  const decision: SlackMessage = {
    workspaceId: 'T',
    channelId: 'C',
    ts: '1',
    threadTs: null,
    sentAt: '2026-10-10T10:00:00.000Z',
    userId: 'U',
    text: 'Atlas: we chose the smaller launch.',
  };
  const lunch: SlackMessage = {
    workspaceId: 'T',
    channelId: 'C',
    ts: '2',
    threadTs: null,
    sentAt: '2026-10-10T10:01:00.000Z',
    userId: 'U',
    text: 'Lunch?',
  };
  warehouse.add(slackMessages, decision, lunch);
  const decisionReply = { ...decision, threadTs: '1' };
  warehouse.add(slackReplies, decisionReply, {
    workspaceId: 'T',
    channelId: 'C',
    ts: '3',
    threadTs: '1',
    sentAt: '2026-10-10T10:02:00.000Z',
    userId: 'V',
    text: 'Who owns the remaining questions?',
  });
  warehouse.add(
    messages,
    {
      guid: 'sms',
      date: '2026-10-10T10:03:00.000Z',
      isFromMe: false,
      handle: '+123',
      text: 'Atlas budget is approved.',
    },
    {
      guid: 'old-sms',
      date: '2026-09-01T10:00:00.000Z',
      isFromMe: false,
      handle: '+123',
      text: 'Atlas outdated budget.',
    },
  );
  warehouse.add(
    chatMessages,
    { messageGuid: 'sms', chatGuid: 'chat' },
    { messageGuid: 'old-sms', chatGuid: 'chat' },
  );
  warehouse.add(
    mailMessages,
    {
      id: '10',
      messageId: '100',
      dateReceived: '2026-10-10T10:04:00.000Z',
      subjectPrefix: null,
      subject: 's',
      sender: 'a',
      globalMessageId: 'g',
      deleted: 0,
    },
    {
      id: '11',
      messageId: '101',
      dateReceived: '2026-10-10T10:05:00.000Z',
      subjectPrefix: null,
      subject: 's2',
      sender: 'a',
      globalMessageId: null,
      deleted: 0,
    },
  );
  warehouse.add(
    mailSubjects,
    { id: 's', subject: 'Atlas preparation' },
    { id: 's2', subject: 'Re: owner confirmed' },
  );
  warehouse.add(mailAddresses, { id: 'a', address: 'alex@example.com' });
  warehouse.add(
    mailConversations,
    { conversationId: 'conversation', messageId: '100' },
    { conversationId: 'conversation', messageId: '101' },
  );
  warehouse.add(mailGlobalData, {
    id: 'g',
    messageIdHeader: '<atlas@example.com>',
  });
  warehouse.add(
    mailParts,
    {
      messageId: '10',
      partId: '1',
      text: 'Recent decision from email',
      contentType: 'text/plain',
      isAttachment: false,
    },
    {
      messageId: '10',
      partId: '2',
      text: 'Private attachment not for the brief',
      contentType: 'text/plain',
      isAttachment: true,
    },
  );
  const imported = await warehouse.load(...tables);
  const matches = await warehouse.evaluate(rule, baseline, imported, now);
  assert.equal(matches.length, 1);
  const [match] = matches;
  assert.ok(match);
  assert.equal(match.meeting.eventId, 'new');
  assert.deepEqual(match.meeting.attendees, [
    { name: 'Alex', url: 'mailto:alex@example.com', status: 2 },
  ]);
  assert.deepEqual(
    match.conversations.map(({ id }) => id),
    [
      'Slack/T/C/1',
      'Slack/T/C/3',
      'Messages/sms/chat',
      'Mail/10/conversation',
      'Mail/11/conversation',
    ],
  );
  assert.equal(
    match.conversations[3]?.url,
    'message://%3Catlas%40example.com%3E',
  );
  assert.ok(match.conversations[4]?.text.includes('not available on this Mac'));
  assert.ok(!JSON.stringify(match).includes('Private attachment'));

  // Slack gives a message that starts a thread its own ts as thread_ts. Thus
  // a later import writes a newer copy of the message, with a newer
  // loaded_at, and the brief reads the same conversation from it.
  decision.threadTs = '1';
  const reimported = await warehouse.load(slackMessages);
  assert.deepEqual(
    await warehouse.evaluate(rule, imported, reimported, now),
    [],
    'new import metadata does not refresh a brief',
  );

  warehouse.add(slackReplies, {
    workspaceId: 'T',
    channelId: 'C',
    ts: '4',
    threadTs: '1',
    sentAt: '2026-10-11T10:00:00.000Z',
    userId: 'V',
    text: 'Alex will handle those questions.',
  });
  const replied = await warehouse.load(slackReplies);
  const refresh = await warehouse.evaluate(rule, reimported, replied, now);
  assert.equal(refresh.length, 1);
  const [refreshed] = refresh;
  assert.ok(refreshed);
  assert.notDeepEqual(refreshed, match);
  assert.equal(
    refreshed.conversations.at(-1)?.text,
    'Alex will handle those questions.',
  );

  lunch.text = 'Unrelated lunch edit';
  const unrelated = await warehouse.load(slackMessages);
  assert.deepEqual(
    await warehouse.evaluate(rule, replied, unrelated, now),
    [],
    'unrelated messages do not refresh',
  );

  // The reply copy now has a newer loaded_at than the message copy, which
  // keeps the earlier text.
  decisionReply.text = 'Atlas: changed decision.';
  const edited = await warehouse.load(slackReplies);
  assert.equal(
    (await warehouse.evaluate(rule, unrelated, edited, now)).length,
    1,
    'edits refresh using the latest Slack copy',
  );

  meeting.startAt = '2026-10-12T08:00:00.000Z';
  const rescheduled = await warehouse.load(events);
  assert.equal(
    (await warehouse.evaluate(rule, edited, rescheduled, now)).length,
    1,
    'rescheduling refreshes the same meeting',
  );

  meeting.status = 3;
  const cancelled = await warehouse.load(events);
  assert.deepEqual(
    await warehouse.evaluate(rule, rescheduled, cancelled, now),
    [],
    'cancelled meetings stop matching',
  );

  warehouse.add(
    events,
    event('generic', 'own', 'Planning meeting', '2026-10-12T09:00:00.000Z'),
  );
  const added = await warehouse.load(events);
  const [generic] = await warehouse.evaluate(rule, cancelled, added, now);
  assert.ok(generic);
  assert.deepEqual(
    generic.conversations,
    [],
    'generic titles do not match every message',
  );
});

test('brief generation replaces one file atomically and preserves it on failure', async () => {
  await using directory = await new TemporaryFiles().directory(
    'proactive-test-',
  );
  const executable = join(directory.path, 'codex');
  // The real Codex service requires an authenticated, paid network request.
  // This executable stands in for that external boundary; execFile, stdin,
  // output-file handling and filesystem publication all run for real.
  await writeFile(
    executable,
    `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
assert.ok(process.argv.includes('--ignore-user-config'));
assert.ok(!process.argv.includes('--model'));
assert.ok(prompt.includes('untrusted content'));
const brief = JSON.parse(prompt.slice(prompt.indexOf('\\n{') + 1));
if (brief.meeting.name === 'fail') process.exit(1);
const text = brief.meeting.name === 'empty' ? ' ' : '# ' + brief.meeting.name;
await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], text);
`,
    { mode: 0o700 },
  );
  const outputs = join(directory.path, 'briefs');
  const writer = new MeetingBriefWriter(outputs, executable);
  const brief: MeetingBrief = {
    meeting: {
      eventId: '../event/id',
      name: 'Atlas planning',
      startAt: new Date('2026-10-12T09:00Z'),
      endAt: new Date('2026-10-12T10:00Z'),
      body: null,
      location: null,
      url: null,
      attendees: [],
    },
    conversations: [],
    coverage: [],
  };
  const signal = new AbortController().signal;
  const path = await writer.write(brief, signal);
  assert.equal(await readFile(path, 'utf8'), '# Atlas planning');
  brief.meeting.name = 'Atlas revised planning';
  assert.equal(await writer.write(brief, signal), path);
  assert.equal(await readFile(path, 'utf8'), '# Atlas revised planning');
  for (const name of ['fail', 'empty']) {
    brief.meeting.name = name;
    await assert.rejects(writer.write(brief, signal));
    assert.equal(await readFile(path, 'utf8'), '# Atlas revised planning');
  }
  assert.equal(
    (await readdir(outputs)).length,
    1,
    'temporary directories are removed',
  );
});

test('a new planning match writes its brief, with how fresh each source is now, and tells the user where it is', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await sql`CREATE SCHEMA marts`;
  await sql`CREATE TABLE marts.sync_status (connector text, status text, last_successful_sync_at timestamptz)`;
  await sql`INSERT INTO marts.sync_status VALUES ('apple-calendar', 'succeeded', now()), ('whatsapp', 'succeeded', now())`;
  await using directory = await new TemporaryFiles().directory(
    'proactive-test-',
  );
  const executable = join(directory.path, 'codex');
  // The real Codex service requires an authenticated, paid network request.
  // This executable stands in for that external boundary.
  await writeFile(
    executable,
    `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const brief = JSON.parse(prompt.slice(prompt.indexOf('\\n{') + 1));
await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], '# ' + brief.meeting.name + ' from ' + brief.coverage.map(({ connector }) => connector).join(', '));
`,
    { mode: 0o700 },
  );
  const outputs = join(directory.path, 'briefs');
  const planning = new PlanningMeetings(
    new MeetingBriefWriter(outputs, executable),
    sql,
  );

  const receipt = await planning.act(
    {
      meeting: {
        eventId: 'atlas',
        name: 'Atlas planning',
        startAt: new Date('2026-10-12T09:00Z'),
        endAt: new Date('2026-10-12T10:00Z'),
        body: null,
        location: null,
        url: null,
        attendees: [],
      },
      conversations: [],
    },
    new AbortController().signal,
  );

  const [title, path = ''] = receipt.split('\n');
  assert.equal(title, 'Planning brief ready: Atlas planning');
  assert.ok(path.startsWith(outputs));
  assert.equal(
    await readFile(path, 'utf8'),
    '# Atlas planning from apple-calendar',
    'the brief reads the coverage of its sources when it is written',
  );
});
