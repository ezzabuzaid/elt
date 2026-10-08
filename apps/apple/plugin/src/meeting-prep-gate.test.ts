import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
// UserPromptSubmit command hook: the committed hooks/meeting-prep-gate with the
// hook's JSON on stdin, on the bundled server and Codex's bundled Node, under
// a HOME whose Apple folder holds a real Calendar import.

const root = resolve(import.meta.dirname, '../../../..');
const gateCommand = join(root, 'plugins/apple/hooks/meeting-prep-gate');
const runtime =
  process.env.CODEX_MCP_NODE_PATH ??
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
  );

// The heartbeat prompt setup-apple tells the agent to create.
const heartbeatPrompt = /`prompt` `([^`]+\$meeting-prep[^`]*)`/.exec(
  readFileSync(join(root, 'plugins/apple/skills/setup-apple/SKILL.md'), 'utf8'),
)?.[1];

// What ChatGPT sends the chat when a heartbeat wakes it.
const heartbeat = (instructions: string) =>
  `<heartbeat>\n  <automation_id>meeting-prep</automation_id>\n  <current_time_iso>${new Date().toISOString()}</current_time_iso>\n  <instructions>\n${instructions}\n  </instructions>\n</heartbeat>`;

function runGate(home: string, prompt: string) {
  const result = spawnSync(gateCommand, [], {
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

// The meetings a gate output hands the model: the JSON line of its context.
function handedOver(output: {
  hookSpecificOutput: { additionalContext: string };
}): string[] {
  const rows: { name: string }[] = JSON.parse(
    output.hookSpecificOutput.additionalContext.split('\n')[1] ?? '[]',
  );
  return rows.map(({ name }) => name);
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

test('a prompt other than a Meeting prep heartbeat passes the gate untouched', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  assert.equal(runGate(home.path, 'what are my meetings today'), undefined);
  assert.equal(
    runGate(home.path, heartbeat('Check the deploy and report failures.')),
    undefined,
  );
});

test('a Meeting prep heartbeat reaches the model only with meetings due, each once, and a moved one again', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(heartbeatPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');
  // EventKit cannot create attendees or cancel an event, so recorded
  // documents reach the Calendar connector through a stub helper.
  await using stub = await StubEventKitHelper.create();
  const manifest = ConnectorManifest.read(join(builtInConnectors, 'calendar'));
  assert.ok(manifest);
  const connector: AppleConnector = await manifest.load({
    grantee: 'Codex',
    eventKitHelper: stub.path,
  });
  const scope = connector.defaultScope();
  const { startAt, endAt } = scope;
  const selection = {
    connector: connector.name,
    scope,
    includeAttachments: false,
  };
  using settings = new Settings(
    join(home.path, 'Library/Application Support/Context Compiler/Apple'),
  );
  await settings.select([selection], {
    facts: () => connector,
    permissions: () => connector.guidance(),
  });
  const importCalendar = async (occurrences: OccurrenceDocument[]) => {
    stub.answer(
      { entity: 'events', startAt, endAt, ics: true },
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
    const { connection, destination } = await connector.connection(
      settings.directory(selection),
      selection,
    );
    const history = new SQLiteSyncHistory();
    await history.install([destination]);
    installSQLiteCatalog(destination);
    await new Pipeline({ connections: [connection], history }).run();
  };
  const now = Date.now();
  const standup = (startMs: number) =>
    occurrence('Standup', startMs, { attendees: [participant()] });
  const others = [
    occurrence('Zoom call', now + 30 * minute, {
      location: 'https://zoom.us/j/123',
    }),
    occurrence('Focus block', now + 20 * minute),
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
  ];
  await importCalendar([standup(now + 35 * minute), ...others]);

  const first = runGate(home.path, heartbeat(heartbeatPrompt));
  const second = runGate(home.path, heartbeat(heartbeatPrompt));
  await importCalendar([standup(now + 38 * minute), ...others]);
  const afterMove = runGate(home.path, heartbeat(heartbeatPrompt));

  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.deepEqual(handedOver(first), ['Zoom call', 'Standup']);
  assert.equal(second.decision, 'block');
  assert.deepEqual(handedOver(afterMove), ['Standup']);
});

test('a Meeting prep heartbeat is blocked while Calendar is not imported', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'meeting-gate-'));
  assert.ok(heartbeatPrompt, 'setup-apple names the Meeting prep prompt');
  assert.ok(existsSync(runtime), 'Open ChatGPT to install its bundled Node');

  const output = runGate(home.path, heartbeat(heartbeatPrompt));

  assert.equal(output.decision, 'block');
});
