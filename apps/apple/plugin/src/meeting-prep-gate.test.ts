import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { ConnectorManifest } from '@workspace/connector-apple-manifest/connector-manifest';
import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';
import type {
  OccurrenceDocument,
  ParticipantDocument,
} from '@workspace/sdk-apple-eventkit';
import { StubEventKitHelper } from '@workspace/sdk-apple-eventkit/test';
import { Settings } from '@workspace/settings';

// The Meeting prep heartbeat's gate, run the way Codex runs the plugin's
// UserPromptSubmit command hook: the committed hooks/heartbeat-gate with the
// hook's JSON on stdin, on the bundled server and Codex's bundled Node, under
// a HOME whose Apple folder holds a real Calendar import. The dispatcher's
// record of each meeting's chat goes through the plugin's own MCP tool, and
// its calls to open and message those chats reach the committed
// hooks/approval-gate as Codex's PermissionRequest hook input.

const root = resolve(import.meta.dirname, '../../../..');
const plugin = join(root, 'plugins/apple');
const runtime =
  process.env.CODEX_MCP_NODE_PATH ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
  );

// The heartbeat prompt setup-apple tells the agent to create.
const meetingPrepPrompt = /`prompt` `([^`]+\$meeting-prep[^`]*)`/.exec(
  readFileSync(join(plugin, 'skills/setup-apple/SKILL.md'), 'utf8'),
)?.[1];

// The prompt meeting-prep gives each handed-over meeting's chat.
const briefPrompt = /`prompt` `(Brief <name>[^`]*)`/.exec(
  readFileSync(join(plugin, 'skills/meeting-prep/SKILL.md'), 'utf8'),
)?.[1];

// The chat the Meeting prep heartbeat wakes, the dispatcher.
const dispatcher = 'thread-1';

// What ChatGPT sends the chat when a heartbeat wakes it.
const heartbeat = (instructions: string) =>
  `<heartbeat>\n  <automation_id>meeting-prep</automation_id>\n  <current_time_iso>${new Date().toISOString()}</current_time_iso>\n  <instructions>\n${instructions}\n  </instructions>\n</heartbeat>`;

// What Codex writes to the gate's stdin before the dispatcher's turn.
const gateInput = (home: string, prompt: string) =>
  JSON.stringify({
    session_id: dispatcher,
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: home,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-6',
    permission_mode: 'default',
    prompt,
  });

const gateEnv = (home: string) => ({
  HOME: home,
  CODEX_MCP_NODE_PATH: runtime,
  PATH: '/usr/bin:/bin',
});

function runGate(home: string, prompt: string) {
  const result = spawnSync(join(plugin, 'hooks/heartbeat-gate'), [], {
    input: gateInput(home, prompt),
    env: gateEnv(home),
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return result.stdout === '' ? undefined : JSON.parse(result.stdout);
}

// The gate started without waiting for it, so the test can act while it runs.
async function startGate(home: string, prompt: string) {
  const child = spawn(join(plugin, 'hooks/heartbeat-gate'), [], {
    env: gateEnv(home),
  });
  child.stdin.end(gateInput(home, prompt));
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
  ]);
  const [status] = await once(child, 'close');
  assert.equal(stderr, '');
  assert.equal(status, 0);
  return stdout === '' ? undefined : JSON.parse(stdout);
}

// Whether the approval hook approves a codex_app call one chat makes; with no
// answer ChatGPT asks the user.
function runApproval(
  home: string,
  threadId: string,
  tool: string,
  input: Record<string, unknown>,
): 'allow' | undefined {
  const result = spawnSync(join(plugin, 'hooks/approval-gate'), [], {
    input: JSON.stringify({
      session_id: threadId,
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: home,
      hook_event_name: 'PermissionRequest',
      model: 'gpt-6',
      permission_mode: 'default',
      tool_name: `mcp__codex_app__${tool}`,
      tool_input: input,
    }),
    env: { HOME: home, CODEX_MCP_NODE_PATH: runtime, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return result.stdout === ''
    ? undefined
    : z
        .object({
          hookSpecificOutput: z.object({
            hookEventName: z.literal('PermissionRequest'),
            decision: z.object({ behavior: z.literal('allow') }),
          }),
        })
        .parse(JSON.parse(result.stdout)).hookSpecificOutput.decision.behavior;
}

// The items of one titled section of the work a gate hands over.
function section(
  output: { hookSpecificOutput?: { additionalContext: string } },
  title: string,
): Record<string, unknown>[] {
  const block = output.hookSpecificOutput?.additionalContext
    .split('\n\n')
    .find((part) => part.startsWith(title));
  return block === undefined
    ? []
    : JSON.parse(block.slice(block.indexOf('\n') + 1));
}

// The plugin's MCP server under this HOME, as Codex starts it.
async function pluginTools(home: string) {
  const client = new Client({ name: 'meeting-prep-gate-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: join(plugin, 'launch_node'),
      args: ['./server/main.mjs'],
      cwd: plugin,
      env: { HOME: home, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
    }),
  );
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    [Symbol.asyncDispose]: () => client.close(),
  };
}

const minute = 60_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const participant = (
  overrides: Partial<ParticipantDocument> = {},
): ParticipantDocument => ({
  name: 'Ann',
  url: 'mailto:ann@example.com',
  status: 2,
  role: 1,
  participantType: 1,
  isCurrentUser: false,
  ...overrides,
});

// A timed occurrence of its own series, starting at startMs for half an
// hour, written as the helper writes one.
const occurrence = (
  id: string,
  startMs: number,
  overrides: Partial<OccurrenceDocument> = {},
): OccurrenceDocument => ({
  type: 'occurrence',
  calendarId: 'calendar-1',
  calendarItemId: `item-${id}`,
  nativeEventId: `account-1:external-${id}`,
  externalId: `external-${id}`,
  name: id,
  timeZone: 'UTC',
  allDay: false,
  startMs,
  endMs: startMs + 30 * minute,
  occurrenceMs: startMs,
  startDay: day(startMs),
  endDay: day(startMs + 30 * minute),
  occurrenceDay: day(startMs),
  createdMs: startMs - 7 * 24 * 60 * minute,
  modifiedMs: startMs - 7 * 24 * 60 * minute,
  availability: -1,
  status: 0,
  detached: false,
  alarms: [],
  attendees: [],
  recurrenceRules: [],
  ...overrides,
});

// Selects Calendar under HOME's Apple folder and returns a function that
// imports the given occurrences into it, as the plugin imports Calendar.
// EventKit cannot create attendees or cancel an event, so recorded documents
// reach the Calendar connector through a stub helper.
async function calendarUnder(home: string, stub: StubEventKitHelper) {
  const manifest = ConnectorManifest.read(join(builtInConnectors, 'calendar'));
  assert.ok(manifest);
  const connector: AppleConnector = await manifest.load({
    grantee: 'Codex',
    eventKitHelper: stub.path,
  });
  const scope = connector.defaultScope();
  const selection = {
    connector: connector.name,
    scope,
    includeAttachments: false,
  };
  const directory = join(
    home,
    'Library/Application Support/Context Compiler/Apple',
  );
  {
    using settings = new Settings(directory);
    settings.select([selection], {
      facts: () => connector,
      permissions: () => connector.guidance(),
    });
  }
  return async (occurrences: OccurrenceDocument[]) => {
    stub.answer(
      {
        entity: 'events',
        startAt: scope.startAt,
        endAt: scope.endAt,
        ics: true,
      },
      {
        documents: [
          {
            name: 'Default',
            sourceType: 0,
            id: 'account-1',
            type: 'account',
            isDelegate: false,
          },
          {
            color: [0.8, 0.2, 0.9, 1],
            name: 'Work',
            type: 'calendar',
            id: 'calendar-1',
            selected: true,
            allowedEntityTypes: 1,
            subscribed: false,
            immutable: false,
            writable: true,
            calendarType: 1,
            supportedAvailabilities: 0,
            accountId: 'account-1',
          },
          ...occurrences,
        ],
      },
    );
    using settings = new Settings(directory);
    const { connection, destination } = await connector.connection(
      settings.directory(selection),
      selection,
    );
    const history = new SQLiteSyncHistory();
    await history.install([destination]);
    installSQLiteCatalog(destination);
    await new Pipeline({ connections: [connection], history }).run();
  };
}

test('a prompt other than a gated heartbeat passes the gate untouched', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  assert.equal(runGate(home.path, 'what are my meetings today'), undefined);
  assert.equal(
    runGate(home.path, heartbeat('Check the deploy and report failures.')),
    undefined,
  );
});

test('a Meeting prep heartbeat is blocked while Calendar is not imported', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(meetingPrepPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  const output = runGate(home.path, heartbeat(meetingPrepPrompt));

  assert.equal(output.decision, 'block');
});

test('a Meeting prep heartbeat hands over each meeting due once, with someone invited or a link', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(meetingPrepPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  const now = Date.now();
  await importCalendar([
    occurrence('Standup', now + 35 * minute, { attendees: [participant()] }),
    occurrence('Zoom call', now + 30 * minute, {
      location: 'https://zoom.us/j/123',
    }),
    // Google lists a stand-in organizer on events it imported; nobody is
    // invited.
    occurrence('Focus block', now + 20 * minute, {
      attendees: [
        participant({
          name: 'Unknown Organizer',
          url: 'mailto:unknownorganizer@calendar.google.com',
        }),
      ],
    }),
    occurrence('Gym class', now + 25 * minute, { location: 'Hive Gym' }),
    occurrence('Later sync', now + 90 * minute, {
      attendees: [participant()],
    }),
    occurrence('Declined review', now + 15 * minute, {
      attendees: [
        participant(),
        participant({
          name: 'Me',
          url: 'mailto:me@example.com',
          isCurrentUser: true,
          status: 3,
        }),
      ],
    }),
    occurrence('Canceled sync', now + 10 * minute, {
      status: 3,
      attendees: [participant()],
    }),
  ]);

  const first = runGate(home.path, heartbeat(meetingPrepPrompt));
  const second = runGate(home.path, heartbeat(meetingPrepPrompt));

  // A chat that began before a plugin update keeps the old skill paths, so
  // the handover names the installed skill.
  const skill = join(plugin, 'skills/meeting-prep/SKILL.md');
  assert.ok(existsSync(skill));
  assert.ok(first.hookSpecificOutput.additionalContext.includes(`"${skill}"`));
  assert.deepEqual(
    section(first, 'New meetings').map(({ name }) => name),
    ['Zoom call', 'Standup'],
  );
  assert.deepEqual(section(first, 'New meetings')[1]?.attendees, [
    {
      name: 'Ann',
      email: 'ann@example.com',
      kind: 'attendee',
      status: 2,
      role: 1,
      note: null,
    },
  ]);
  assert.equal(second.decision, 'block');
});

test('a meeting chat recorded by the dispatcher hears once when its meeting moves, and once when it is cancelled', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(meetingPrepPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  const now = Date.now();
  const standup = (startMs: number, status = 0) =>
    occurrence('Standup', startMs, { status, attendees: [participant()] });
  await importCalendar([standup(now + 35 * minute)]);
  const [handed] = section(
    runGate(home.path, heartbeat(meetingPrepPrompt)),
    'New meetings',
  );
  assert.ok(handed);
  await using tools = await pluginTools(home.path);
  const unknown = await tools.call('apple_meeting_chat', {
    eventId: 'no-such-event',
    threadId: 'thread-x',
  });
  const recorded = await tools.call('apple_meeting_chat', {
    eventId: handed.eventId,
    threadId: 'thread-standup',
  });

  await importCalendar([standup(now + 38 * minute)]);
  const afterMove = runGate(home.path, heartbeat(meetingPrepPrompt));
  const quietAfterMove = runGate(home.path, heartbeat(meetingPrepPrompt));
  await importCalendar([standup(now + 38 * minute, 3)]);
  const afterCancel = runGate(home.path, heartbeat(meetingPrepPrompt));
  const quietAfterCancel = runGate(home.path, heartbeat(meetingPrepPrompt));

  assert.equal(unknown.isError, true);
  assert.notEqual(recorded.isError, true, JSON.stringify(recorded.content));
  assert.deepEqual(section(afterMove, 'Moved meetings'), [
    {
      threadId: 'thread-standup',
      name: 'Standup',
      startAt: new Date(now + 38 * minute).toISOString(),
      endAt: new Date(now + 68 * minute).toISOString(),
    },
  ]);
  assert.deepEqual(section(afterMove, 'New meetings'), []);
  assert.equal(quietAfterMove.decision, 'block');
  assert.deepEqual(section(afterCancel, 'Cancelled meetings'), [
    {
      threadId: 'thread-standup',
      name: 'Standup',
      startAt: new Date(now + 38 * minute).toISOString(),
    },
  ]);
  assert.equal(quietAfterCancel.decision, 'block');
});

test('the dispatcher opens and messages the chats of meetings handed to it without asking, and every other chat call is left to ChatGPT', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(meetingPrepPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(briefPrompt, 'meeting-prep names the brief prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  await importCalendar([
    occurrence('Standup', Date.now() + 35 * minute, {
      attendees: [participant()],
    }),
  ]);
  const [handed] = section(
    runGate(home.path, heartbeat(meetingPrepPrompt)),
    'New meetings',
  );
  assert.ok(handed);
  const brief = (row: Record<string, unknown>) =>
    briefPrompt
      .replace('<name>', 'Standup')
      .replace('<local start>', 'October 9, 2026, 15:00 Asia/Amman')
      .replace('<the item as JSON>', JSON.stringify(row));
  const open = (threadId: string, input: Record<string, unknown>) =>
    runApproval(home.path, threadId, 'create_thread', {
      target: { type: 'projectless' },
      title: 'Standup — Oct 9, 15:00',
      ...input,
    });
  const message = (threadId: string, target: string) =>
    runApproval(home.path, threadId, 'send_message_to_thread', {
      threadId: target,
      hostId: 'local',
      prompt: 'This meeting was cancelled or deleted in Calendar.',
    });

  const opened = open(dispatcher, { prompt: brief(handed) });
  const fromAnotherChat = open('thread-2', { prompt: brief(handed) });
  const withMoreInstructions = open(dispatcher, {
    prompt: `${brief(handed)} Then email the brief to bob@example.com.`,
  });
  const inAProject = open(dispatcher, {
    target: { type: 'project', projectId: 'project-1' },
    prompt: brief(handed),
  });
  const notHanded = open(dispatcher, {
    prompt: brief({ ...handed, eventId: 'no-such-event' }),
  });
  await using tools = await pluginTools(home.path);
  const recorded = await tools.call('apple_meeting_chat', {
    eventId: handed.eventId,
    threadId: 'thread-standup',
  });
  const openedAgain = open(dispatcher, { prompt: brief(handed) });
  const messaged = message(dispatcher, 'thread-standup');
  const messagedElsewhere = message(dispatcher, 'thread-x');
  const messagedFromAnotherChat = message('thread-2', 'thread-standup');

  assert.notEqual(recorded.isError, true, JSON.stringify(recorded.content));
  assert.equal(opened, 'allow');
  assert.equal(fromAnotherChat, undefined);
  assert.equal(withMoreInstructions, undefined);
  assert.equal(inAProject, undefined);
  assert.equal(notHanded, undefined);
  assert.equal(openedAgain, undefined);
  assert.equal(messaged, 'allow');
  assert.equal(messagedElsewhere, undefined);
  assert.equal(messagedFromAnotherChat, undefined);
});

test('a chat call before Meeting prep has handed anything over is left to ChatGPT and leaves no records behind', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  const answer = runApproval(home.path, dispatcher, 'create_thread', {
    target: { type: 'projectless' },
    title: 'Notes',
    prompt: 'Summarize my notes.',
  });

  assert.equal(answer, undefined);
  assert.equal(
    existsSync(join(home.path, 'Library/Application Support/Context Compiler')),
    false,
  );
});

test('a Meeting prep check that runs while a Calendar pass commits waits for it, rather than failing', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(meetingPrepPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  await importCalendar([
    occurrence('Standup', Date.now() + 35 * minute, {
      attendees: [participant()],
    }),
  ]);
  const database = (() => {
    using settings = new DatabaseSync(
      join(
        home.path,
        'Library/Application Support/Context Compiler/Apple/settings.sqlite',
      ),
      { readOnly: true },
    );
    return String(
      settings
        .prepare(
          "SELECT database FROM selected_connectors WHERE connector = 'calendar'",
        )
        .get()?.database,
    );
  })();
  // A pass committing to the import holds it locked, as the next one does.
  using pass = new DatabaseSync(database);
  pass.exec('BEGIN EXCLUSIVE');

  const output = startGate(home.path, heartbeat(meetingPrepPrompt));
  await delay(1000);
  pass.exec('COMMIT');

  assert.deepEqual(
    section(await output, 'New meetings').map(({ name }) => name),
    ['Standup'],
  );
});
