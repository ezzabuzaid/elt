import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import postgres from 'postgres';

import { Eca } from '@workspace/eca';

import { MeetingBriefWriter } from './meeting-brief-writer.ts';
import { type MeetingBrief, PlanningMeetings } from './planning-meetings.ts';

async function scratchDatabase() {
  const server =
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@127.0.0.1:55432/postgres';
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  const name = `proactive_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(server);
    url.pathname = `/${name}`;
    const sql = postgres(url.href, { max: 1, onnotice: () => {} });
    return {
      sql,
      async [Symbol.asyncDispose]() {
        await sql.end();
        try {
          await admin.unsafe(`DROP DATABASE "${name}"`);
        } finally {
          await admin.end();
        }
      },
    };
  } catch (error) {
    await admin.end();
    throw error;
  }
}

test('planning briefs follow new meetings and related evidence, without retriggering on imports', async () => {
  await using database = await scratchDatabase();
  const { sql } = database;
  await sql`CREATE SCHEMA marts`;
  await sql`CREATE TABLE marts.calendar_calendars (id text PRIMARY KEY, type bigint, subscribed boolean)`;
  await sql`CREATE TABLE marts.calendar_events (
    "eventId" text PRIMARY KEY, "calendarId" text, name text, "startAt" timestamptz, "endAt" timestamptz,
    body text, location text, url text, "allDay" boolean DEFAULT false, status bigint DEFAULT 1
  )`;
  await sql`CREATE TABLE marts.calendar_attendees (
    id text PRIMARY KEY, "eventId" text, name text, url text, status bigint,
    "isCurrentUser" boolean DEFAULT false, type bigint DEFAULT 1
  )`;
  await sql`CREATE TABLE marts.slack_messages (
    "workspaceId" text, "channelId" text, ts text, "threadTs" text, "sentAt" timestamptz,
    "userId" text, text text, loaded_at timestamptz DEFAULT now()
  )`;
  await sql`CREATE TABLE marts.slack_thread_replies (LIKE marts.slack_messages INCLUDING ALL)`;
  await sql`CREATE TABLE marts.messages_messages (guid text, date timestamptz, "isFromMe" boolean, handle text, text text)`;
  await sql`CREATE TABLE marts.messages_chat_messages ("messageGuid" text, "chatGuid" text)`;
  // Mail IDs are decimal text, and its membership table joins by the
  // Message-ID hash, not messages.id or the undocumented conversationId.
  await sql`CREATE TABLE marts.mail_messages (
    id text PRIMARY KEY, "messageId" text, "dateReceived" timestamptz, "subjectPrefix" text,
    subject text, sender text, "globalMessageId" text, deleted double precision DEFAULT 0
  )`;
  await sql`CREATE TABLE marts.mail_conversation_messages ("conversationId" text, "messageId" text)`;
  await sql`CREATE TABLE marts.mail_addresses (id text PRIMARY KEY, address text)`;
  await sql`CREATE TABLE marts.mail_subjects (id text PRIMARY KEY, subject text)`;
  await sql`CREATE TABLE marts.mail_message_parts (
    "messageId" text, "partId" text, text text, "contentType" text, "isAttachment" boolean
  )`;
  await sql`CREATE TABLE marts.mail_message_global_data (id text PRIMARY KEY, "messageIdHeader" text)`;
  await sql`CREATE TABLE marts.sync_status (connector text, status text, last_successful_sync_at timestamptz)`;
  await sql`INSERT INTO marts.sync_status VALUES ('apple-calendar', 'succeeded', now()), ('apple-mail', 'succeeded', now())`;
  await sql`INSERT INTO marts.calendar_calendars VALUES ('own', 1, false), ('holidays', 1, true)`;
  await sql`INSERT INTO marts.calendar_events ("eventId", "calendarId", name, "startAt", "endAt") VALUES
    ('old', 'own', 'Earlier project planning', '2026-10-12T09:00Z', '2026-10-12T10:00Z'),
    ('past', 'own', 'Atlas planning', '2026-10-10T09:00Z', '2026-10-10T10:00Z'),
    ('subscription', 'holidays', 'Atlas planning', '2026-10-12T09:00Z', '2026-10-12T10:00Z'),
    ('ordinary', 'own', 'Dentist', '2026-10-12T09:00Z', '2026-10-12T10:00Z')`;
  const condition = new PlanningMeetings(
    new MeetingBriefWriter(tmpdir()),
    () => new Date('2026-10-11T12:00Z'),
  );
  const eca = new Eca<postgres.Sql, MeetingBrief>({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
  });
  await eca.add({ condition });
  const watch = () =>
    Array.fromAsync(eca.watch({ signal: new AbortController().signal }));
  assert.deepEqual(await watch(), [], 'existing meetings are the baseline');
  await sql`INSERT INTO marts.calendar_events ("eventId", "calendarId", name, "startAt", "endAt", url) VALUES
    ('new', 'own', 'Atlas planning', '2026-10-12T09:00Z', '2026-10-12T10:00Z', 'https://meet.example/atlas')`;
  await sql`INSERT INTO marts.calendar_attendees (id, "eventId", name, url, status) VALUES
    ('accepted', 'new', 'Alex', 'mailto:alex@example.com', 2),
    ('declined', 'new', 'Sam', 'mailto:sam@example.com', 3)`;
  await sql`INSERT INTO marts.slack_messages ("workspaceId", "channelId", ts, "sentAt", "userId", text) VALUES
    ('T', 'C', '1', '2026-10-10T10:00Z', 'U', 'Atlas: we chose the smaller launch.'),
    ('T', 'C', '2', '2026-10-10T10:01Z', 'U', 'Lunch?')`;
  await sql`INSERT INTO marts.slack_thread_replies ("workspaceId", "channelId", ts, "threadTs", "sentAt", "userId", text) VALUES
    ('T', 'C', '1', '1', '2026-10-10T10:00Z', 'U', 'Atlas: we chose the smaller launch.'),
    ('T', 'C', '3', '1', '2026-10-10T10:02Z', 'V', 'Who owns the remaining questions?')`;
  await sql`INSERT INTO marts.messages_messages VALUES
    ('sms', '2026-10-10T10:03Z', false, '+123', 'Atlas budget is approved.'),
    ('old-sms', '2026-09-01T10:00Z', false, '+123', 'Atlas outdated budget.')`;
  await sql`INSERT INTO marts.messages_chat_messages VALUES ('sms', 'chat'), ('old-sms', 'chat')`;
  await sql`INSERT INTO marts.mail_messages (id, "messageId", "dateReceived", subject, sender, "globalMessageId") VALUES
    ('10', '100', '2026-10-10T10:04Z', 's', 'a', 'g'), ('11', '101', '2026-10-10T10:05Z', 's2', 'a', NULL)`;
  await sql`INSERT INTO marts.mail_subjects VALUES ('s', 'Atlas preparation'), ('s2', 'Re: owner confirmed')`;
  await sql`INSERT INTO marts.mail_addresses VALUES ('a', 'alex@example.com')`;
  await sql`INSERT INTO marts.mail_conversation_messages VALUES ('conversation', '100'), ('conversation', '101')`;
  await sql`INSERT INTO marts.mail_message_global_data VALUES ('g', '<atlas@example.com>')`;
  await sql`INSERT INTO marts.mail_message_parts VALUES
    ('10', '1', 'Recent decision from email', 'text/plain', false),
    ('10', '2', 'Private attachment not for the brief', 'text/plain', true)`;
  const matches = await watch();
  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.ok(match && 'data' in match);
  assert.equal(match.data.meeting.eventId, 'new');
  assert.deepEqual(match.data.meeting.attendees, [
    { name: 'Alex', url: 'mailto:alex@example.com', status: 2 },
  ]);
  assert.deepEqual(
    match.data.conversations.map(({ id }) => id),
    [
      'Slack/T/C/1',
      'Slack/T/C/3',
      'Messages/sms/chat',
      'Mail/10/conversation',
      'Mail/11/conversation',
    ],
  );
  assert.equal(
    match.data.conversations[3]?.url,
    'message://%3Catlas%40example.com%3E',
  );
  assert.ok(
    match.data.conversations[4]?.text.includes('not available on this Mac'),
  );
  assert.ok(!JSON.stringify(match.data).includes('Private attachment'));
  await sql`UPDATE marts.slack_messages SET loaded_at = now() + interval '1 second'`;
  await sql`UPDATE marts.sync_status SET last_successful_sync_at = now()`;
  assert.deepEqual(
    await watch(),
    [],
    'new import metadata does not refresh a brief',
  );
  await sql`INSERT INTO marts.slack_thread_replies ("workspaceId", "channelId", ts, "threadTs", "sentAt", "userId", text) VALUES
    ('T', 'C', '4', '1', '2026-10-11T10:00Z', 'V', 'Alex will handle those questions.')`;
  const refresh = await watch();
  assert.equal(refresh.length, 1);
  assert.ok(refresh[0] && 'data' in refresh[0]);
  assert.notEqual(refresh[0].key, match.key);
  assert.equal(
    refresh[0].data.conversations.at(-1)?.text,
    'Alex will handle those questions.',
  );
  await sql`UPDATE marts.slack_messages SET text = 'Unrelated lunch edit' WHERE ts = '2'`;
  assert.deepEqual(await watch(), [], 'unrelated messages do not refresh');
  await sql`UPDATE marts.slack_thread_replies SET text = 'Atlas: changed decision.', loaded_at = now() + interval '2 seconds' WHERE ts = '1'`;
  assert.equal(
    (await watch()).length,
    1,
    'edits refresh using the latest Slack copy',
  );
  await sql`UPDATE marts.calendar_events SET "startAt" = '2026-10-12T08:00Z' WHERE "eventId" = 'new'`;
  assert.equal(
    (await watch()).length,
    1,
    'rescheduling refreshes the same meeting',
  );
  await sql`UPDATE marts.calendar_events SET status = 3 WHERE "eventId" = 'new'`;
  assert.deepEqual(await watch(), [], 'cancelled meetings stop matching');
  await sql`INSERT INTO marts.calendar_events ("eventId", "calendarId", name, "startAt", "endAt") VALUES
    ('generic', 'own', 'Planning meeting', '2026-10-12T09:00Z', '2026-10-12T10:00Z')`;
  const generic = (await watch())[0];
  assert.ok(generic && 'data' in generic);
  assert.deepEqual(
    generic.data.conversations,
    [],
    'generic titles do not match every message',
  );
});

test('brief generation replaces one file atomically and preserves it on failure', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
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

test('a new planning match writes its brief and tells the user where it is', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
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
await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], '# ' + brief.meeting.name);
`,
    { mode: 0o700 },
  );
  const outputs = join(directory.path, 'briefs');
  const planning = new PlanningMeetings(
    new MeetingBriefWriter(outputs, executable),
  );
  const brief: MeetingBrief = {
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
    coverage: [],
  };

  const receipt = await planning.act(
    { key: 'atlas', data: brief },
    new AbortController().signal,
  );

  const [title, path = ''] = receipt.split('\n');
  assert.equal(title, 'Planning brief ready: Atlas planning');
  assert.ok(path.startsWith(outputs));
  assert.equal(await readFile(path, 'utf8'), '# Atlas planning');
});
