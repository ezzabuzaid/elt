import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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

// The Apple gardener heartbeat's gate, run the way Codex runs the plugin's
// UserPromptSubmit command hook: the committed hooks/heartbeat-gate with the
// hook's JSON on stdin, on the bundled server and Codex's bundled Node, under
// a HOME whose Apple folder holds real imports. The dispatcher and the
// gardener record their work through the plugin's own MCP tools.

const root = resolve(import.meta.dirname, '../../../..');
const plugin = join(root, 'plugins/apple');
const runtime =
  process.env.CODEX_MCP_NODE_PATH ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
  );
const setupSkill = readFileSync(
  join(plugin, 'skills/setup-apple/SKILL.md'),
  'utf8',
);

// The heartbeat prompts setup-apple tells the agent to create.
const gardenPrompt = /`prompt` `(Tend[^`]*\$garden-apple[^`]*)`/.exec(
  setupSkill,
)?.[1];
const meetingPrepPrompt = /`prompt` `([^`]+\$meeting-prep[^`]*)`/.exec(
  setupSkill,
)?.[1];

// What ChatGPT sends the chat when a heartbeat wakes it.
const heartbeat = (instructions: string) =>
  `<heartbeat>\n  <automation_id>apple-gardener</automation_id>\n  <current_time_iso>${new Date().toISOString()}</current_time_iso>\n  <instructions>\n${instructions}\n  </instructions>\n</heartbeat>`;

function runGate(home: string, prompt: string) {
  const result = spawnSync(join(plugin, 'hooks/heartbeat-gate'), [], {
    input: JSON.stringify({
      session_id: 'thread-1',
      turn_id: 'turn-1',
      transcript_path: null,
      cwd: home,
      hook_event_name: 'UserPromptSubmit',
      model: 'gpt-6',
      permission_mode: 'default',
      prompt,
    }),
    env: { HOME: home, CODEX_MCP_NODE_PATH: runtime, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return result.stdout === '' ? undefined : JSON.parse(result.stdout);
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
  const client = new Client({ name: 'garden-gate-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: join(plugin, 'launch_node'),
      args: ['./server/main.mjs'],
      cwd: plugin,
      env: { HOME: home, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
    }),
  );
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
    },
    [Symbol.asyncDispose]: () => client.close(),
  };
}

const minute = 60_000;
const dayMs = 24 * 60 * minute;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const appleFolder = (home: string) =>
  join(home, 'Library/Application Support/Context Compiler/Apple');

const participant = (
  name: string,
  overrides: Partial<ParticipantDocument> = {},
): ParticipantDocument => ({
  name,
  url: `mailto:${name.toLowerCase()}@example.com`,
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
  createdMs: startMs - 7 * dayMs,
  modifiedMs: startMs - 7 * dayMs,
  availability: -1,
  status: 0,
  detached: false,
  alarms: [],
  attendees: [],
  recurrenceRules: [],
  ...overrides,
});

async function builtIn(name: string, eventKitHelper: string) {
  const manifest = ConnectorManifest.read(join(builtInConnectors, name));
  assert.ok(manifest);
  const connector: AppleConnector = await manifest.load({
    grantee: 'Codex',
    eventKitHelper,
  });
  return connector;
}

// Selects Calendar under HOME's Apple folder and returns a function that
// imports the given occurrences into it, as the plugin imports Calendar.
// EventKit cannot create attendees, so recorded documents reach the Calendar
// connector through a stub helper.
async function calendarUnder(home: string, stub: StubEventKitHelper) {
  const connector = await builtIn('calendar', stub.path);
  const scope = connector.defaultScope();
  const selection = {
    connector: connector.name,
    scope,
    includeAttachments: false,
  };
  {
    using settings = new Settings(appleFolder(home));
    await settings.select([selection], {
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
    using settings = new Settings(appleFolder(home));
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

test('an Apple gardener heartbeat is blocked before Apple is set up, and other prompts pass untouched', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'garden-gate-'));
  assert.ok(gardenPrompt, 'setup-apple names the Apple gardener prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  const gardener = runGate(home.path, heartbeat(gardenPrompt));
  const other = runGate(home.path, `Use $garden-apple now.`);

  assert.equal(gardener.decision, 'block');
  assert.equal(other, undefined);
});

test('the gardener hands a meeting chat over for archiving once Calendar says its meeting is over', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'garden-gate-'));
  assert.ok(gardenPrompt && meetingPrepPrompt);
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  const now = Date.now();
  const standup = (startMs: number) =>
    occurrence('Standup', startMs, { attendees: [participant('Ann')] });
  await importCalendar([standup(now + 35 * minute)]);
  const [handed] = section(
    runGate(home.path, heartbeat(meetingPrepPrompt)),
    'New meetings',
  );
  assert.ok(handed);
  {
    await using tools = await pluginTools(home.path);
    await tools.call('apple_meeting_chat', {
      eventId: handed.eventId,
      threadId: 'thread-standup',
    });
  }

  const beforeItEnds = runGate(home.path, heartbeat(gardenPrompt));
  await importCalendar([standup(now - 3 * 60 * minute)]);
  const afterItEnds = runGate(home.path, heartbeat(gardenPrompt));
  const later = runGate(home.path, heartbeat(gardenPrompt));

  assert.deepEqual(section(beforeItEnds, 'Meeting chats to archive'), []);
  assert.deepEqual(section(afterItEnds, 'Meeting chats to archive'), [
    {
      threadId: 'thread-standup',
      name: 'Standup',
      startAt: new Date(now + 35 * minute).toISOString(),
    },
  ]);
  assert.equal(later.decision, 'block');
});

test('the gardener reports an import problem once, and again when it clears and comes back', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'garden-gate-'));
  assert.ok(gardenPrompt);
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const notes = await builtIn('notes', stub.path);
  const selection = {
    connector: notes.name,
    scope: notes.defaultScope(),
    includeAttachments: false,
  };
  using settings = new Settings(appleFolder(home.path));
  await settings.select([selection], {
    facts: () => notes,
    permissions: () => 'Turn on Full Disk Access for ChatGPT.',
  });

  settings.saveConnectionFailure(selection, 'Full Disk Access is off.');
  const first = runGate(home.path, heartbeat(gardenPrompt));
  const second = runGate(home.path, heartbeat(gardenPrompt));
  settings.clearConnectionFailure(selection);
  const cleared = runGate(home.path, heartbeat(gardenPrompt));
  settings.saveConnectionFailure(selection, 'Full Disk Access is off.');
  const back = runGate(home.path, heartbeat(gardenPrompt));

  const problem = {
    connector: 'notes',
    problem: 'Full Disk Access is off.',
    permissions: 'Turn on Full Disk Access for ChatGPT.',
  };
  assert.deepEqual(section(first, 'Import problems to report'), [problem]);
  assert.equal(second.decision, 'block');
  assert.equal(cleared.decision, 'block');
  assert.deepEqual(section(back, 'Import problems to report'), [problem]);
});

test('the gardener asks for a note about everyone the user meets over its runs, and a saved note reaches the next brief', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'garden-gate-'));
  assert.ok(gardenPrompt && meetingPrepPrompt);
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  await using stub = await StubEventKitHelper.create();
  const importCalendar = await calendarUnder(home.path, stub);
  const now = Date.now();
  const invited = ['Ann', 'Bob', 'Dan', 'Eve', 'Fay', 'Gil'];
  await importCalendar([
    occurrence('Old sync', now - 10 * dayMs, {
      attendees: [participant('Carol')],
    }),
    occurrence('Design review', now + 35 * minute, {
      attendees: invited.map((name) => participant(name)),
    }),
  ]);

  const first = section(
    runGate(home.path, heartbeat(gardenPrompt)),
    'People to write notes about',
  );
  const second = section(
    runGate(home.path, heartbeat(gardenPrompt)),
    'People to write notes about',
  );
  const third = runGate(home.path, heartbeat(gardenPrompt));
  {
    await using tools = await pluginTools(home.path);
    await tools.call('apple_person_note', {
      email: 'Ann@Example.com',
      name: 'Ann',
      note: 'Leads design at Example. Owes the budget numbers.',
    });
  }
  const [brief] = section(
    runGate(home.path, heartbeat(meetingPrepPrompt)),
    'New meetings',
  );

  const everyone = ['carol', ...invited.map((name) => name.toLowerCase())].map(
    (name) => `${name}@example.com`,
  );
  assert.equal(first.length, 5);
  assert.equal(second.length, 2);
  assert.deepEqual(
    [...first, ...second].map(({ email }) => email).toSorted(),
    everyone.toSorted(),
  );
  assert.equal(third.decision, 'block');
  assert.deepEqual(
    z
      .array(z.object({ email: z.string(), note: z.string().nullable() }))
      .parse(brief?.attendees)
      .map(({ email, note }) => [email, note])
      .toSorted(),
    invited
      .map((name) => [
        `${name.toLowerCase()}@example.com`,
        name === 'Ann'
          ? 'Leads design at Example. Owes the budget numbers.'
          : null,
      ])
      .toSorted(),
  );
});
