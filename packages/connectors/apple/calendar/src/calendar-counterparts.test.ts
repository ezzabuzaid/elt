import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  OccurrenceDocument,
  ParticipantDocument,
} from '@workspace/sdk-apple-eventkit';
import { StubEventKitHelper } from '@workspace/sdk-apple-eventkit/test';
import { Settings } from '@workspace/settings';

import CalendarConnector from './calendar-connector.ts';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

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

// EventKit cannot create attendees, so the helper is a stand-in that writes
// these documents, shaped as the helper writes them.
const participant = (
  overrides: Partial<ParticipantDocument>,
): ParticipantDocument => ({
  name: 'Ann',
  url: 'mailto:ann@example.com',
  status: 2,
  role: 1,
  participantType: 1,
  isCurrentUser: false,
  ...overrides,
});

const timed = (
  calendarItemId: string,
  start: string,
  overrides: Partial<OccurrenceDocument>,
): OccurrenceDocument => ({
  type: 'occurrence',
  calendarId: 'calendar-1',
  calendarItemId,
  name: calendarItemId,
  startMs: Date.parse(start),
  endMs: Date.parse(start) + 3_600_000,
  startDay: start.slice(0, 10),
  endDay: start.slice(0, 10),
  allDay: false,
  detached: false,
  status: 0,
  availability: -1,
  attendees: [],
  alarms: [],
  recurrenceRules: [],
  ...overrides,
});

const me = (overrides: Partial<ParticipantDocument>) =>
  participant({
    name: 'Ezz',
    url: 'mailto:me@example.com',
    isCurrentUser: true,
    ...overrides,
  });

const rana = (overrides: Partial<ParticipantDocument>) =>
  participant({
    name: 'Rana Haddad',
    url: 'mailto:rana@example.com',
    ...overrides,
  });

const range = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2100-01-01T00:00:00.000Z',
};

test('Calendar counterparts name each organizer, attendee and the user by address, keep rooms and nameless addresses apart, and time only the events that have begun', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(
    { entity: 'events', ...range, ics: true },
    {
      documents: [
        {
          type: 'account',
          id: 'account-1',
          name: 'Work',
          sourceType: 1,
          isDelegate: false,
        },
        {
          type: 'calendar',
          id: 'calendar-1',
          accountId: 'account-1',
          name: 'Calendar',
          calendarType: 1,
          writable: true,
          subscribed: false,
          immutable: false,
          supportedAvailabilities: 0,
          allowedEntityTypes: 1,
          selected: true,
        },
        // The organizer also listed among the attendees, with the address in
        // another case; a room at Google Calendar's resource domain; someone
        // EventKit gives no address.
        timed('review', '2025-03-10T09:00:00.000Z', {
          organizer: rana({
            name: 'Rana',
            url: 'mailto:Rana@Example.com',
            role: 3,
          }),
          attendees: [
            rana({
              name: 'Rana',
              url: 'MAILTO: Rana@Example.COM ',
              role: 3,
            }),
            me({}),
            participant({
              name: 'Board Room',
              url: 'mailto:board-room@resource.calendar.google.com',
              role: 4,
              participantType: 2,
            }),
            participant({
              name: 'Sam Rivera',
              url: 'invalid:nomail',
              status: 3,
              role: 2,
            }),
          ],
        }),
        // A one-to-one the user organized: EventKit lists the user as both
        // organizer and attendee.
        timed('one-to-one', '2025-04-01T12:00:00.000Z', {
          organizer: me({ name: 'Ezz Abuzaid', status: 0, role: 3 }),
          attendees: [
            me({ name: 'Ezz Abuzaid', role: 3 }),
            rana({ status: 4 }),
          ],
        }),
        // An event that reached the user through a distribution list: EventKit
        // marks the organizer's own attendee entry as the user.
        timed('town-hall', '2025-05-01T15:00:00.000Z', {
          organizer: participant({
            name: 'COO Office',
            url: 'mailto:coo-office@example.com',
            role: 3,
          }),
          attendees: [
            participant({
              name: 'COO Office',
              url: 'mailto:coo-office@example.com',
              role: 3,
              isCurrentUser: true,
            }),
          ],
        }),
        // An all-day event, read in Asia/Amman: its startMs is the local
        // midnight EventKit chose, not a time of the event. EventKit shows
        // the user's address as the user's name.
        timed('offsite', '2025-06-01T21:00:00.000Z', {
          allDay: true,
          startDay: '2025-06-02',
          endDay: '2025-06-03',
          endMs: Date.parse('2025-06-02T21:00:00.000Z'),
          attendees: [rana({}), me({ name: 'ME@example.com', status: 4 })],
        }),
        // An event that has not begun, where EventKit gives no participant
        // type.
        timed('future-sync', '2099-06-01T09:00:00.000Z', {
          attendees: [
            rana({ status: 1, participantType: 0 }),
            participant({
              name: 'Omar',
              url: 'mailto:omar@example.com',
              status: 0,
              role: 2,
            }),
          ],
        }),
      ],
    },
  );
  await using root = await mkdtempDisposable(
    join(tmpdir(), 'calendar-counterparts-'),
  );
  const { contextCompiler } = JSON.parse(
    readFileSync(join(folder, 'package.json'), 'utf8'),
  );
  const connector = new CalendarConnector(
    { grantee: 'Codex', eventKitHelper: stub.path },
    { name: contextCompiler.name, title: contextCompiler.title, folder },
  );
  using settings = new Settings(root.path);
  const selection = {
    connector: connector.name,
    scope: range,
    includeAttachments: false,
  };
  settings.select([selection], {
    facts: () => connector,
    permissions: () => connector.guidance(),
  });

  const outcome = await connector.import(settings, selection);

  assert.deepEqual(outcome, { status: 'imported' });
  const database = settings.database(selection);
  assert.deepEqual(
    read(
      database,
      'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY identifier, relation',
    ).map((row) => ({ ...row, context: JSON.parse(String(row.context)) })),
    [
      // A room stays, told apart by its type and Google Calendar's address.
      {
        relation: 'attendee',
        identifier_type: 'email',
        identifier: 'board-room@resource.calendar.google.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Board Room',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-03-10T09:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'room',
          googleCalendar: true,
          status: { accepted: 1 },
          role: { nonParticipant: 1 },
          smallest: 4,
          largest: 4,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
      },
      // Marked as the user only where the same event lists it as someone
      // else, so it is no self.
      {
        relation: 'attendee',
        identifier_type: 'email',
        identifier: 'coo-office@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'COO Office',
        first_at: '2025-05-01T15:00:00.000Z',
        last_at: '2025-05-01T15:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 1 },
          role: { chair: 1 },
          smallest: 1,
          largest: 1,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
      },
      {
        relation: 'organizer',
        identifier_type: 'email',
        identifier: 'coo-office@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'COO Office',
        first_at: '2025-05-01T15:00:00.000Z',
        last_at: '2025-05-01T15:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 1 },
          role: { chair: 1 },
          smallest: 1,
          largest: 1,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
      },
      // Someone with no address is known by EventKit's stand-in URL and the
      // name it gives, which no other app's identifier can equal. The
      // organizer listed again as attendee leaves four participants.
      {
        relation: 'attendee',
        identifier_type: 'app',
        identifier: 'invalid:nomail#Sam Rivera',
        linked_type: null,
        linked_identifier: null,
        name: 'Sam Rivera',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-03-10T09:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { declined: 1 },
          role: { optional: 1 },
          smallest: 4,
          largest: 4,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
      },
      // The all-day event counts and gives its date, not a time; the name is
      // the latest one that is not the address.
      {
        relation: 'attendee',
        identifier_type: 'email',
        identifier: 'me@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Ezz Abuzaid',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-04-01T12:00:00.000Z',
        occurrences: 3,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 2, tentative: 1 },
          role: { required: 2, chair: 1 },
          smallest: 2,
          largest: 4,
          firstDay: '2025-06-02',
          lastDay: '2025-06-02',
          upcoming: 0,
        },
      },
      {
        relation: 'organizer',
        identifier_type: 'email',
        identifier: 'me@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Ezz Abuzaid',
        first_at: '2025-04-01T12:00:00.000Z',
        last_at: '2025-04-01T12:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { unknown: 1 },
          role: { chair: 1 },
          smallest: 2,
          largest: 2,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
      },
      // The one-to-one counts once, with the user's status as attendee.
      {
        relation: 'self',
        identifier_type: 'email',
        identifier: 'me@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Ezz Abuzaid',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-04-01T12:00:00.000Z',
        occurrences: 3,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 2, tentative: 1 },
          role: { required: 2, chair: 1 },
          smallest: 2,
          largest: 4,
          firstDay: '2025-06-02',
          lastDay: '2025-06-02',
          upcoming: 0,
        },
      },
      // On an event that has not begun only: no time, no occurrence yet.
      {
        relation: 'attendee',
        identifier_type: 'email',
        identifier: 'omar@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Omar',
        first_at: null,
        last_at: null,
        occurrences: 0,
        context: {
          type: 'person',
          googleCalendar: false,
          status: {},
          role: {},
          smallest: null,
          largest: null,
          firstDay: null,
          lastDay: null,
          upcoming: 1,
        },
      },
      // Every spelling of the address is one identifier; the upcoming event
      // is left out of last_at and occurrences, and its unknown type yields
      // to the type the other events give.
      {
        relation: 'attendee',
        identifier_type: 'email',
        identifier: 'rana@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Rana Haddad',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-04-01T12:00:00.000Z',
        occurrences: 3,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 2, tentative: 1 },
          role: { required: 2, chair: 1 },
          smallest: 2,
          largest: 4,
          firstDay: '2025-06-02',
          lastDay: '2025-06-02',
          upcoming: 1,
        },
      },
      {
        relation: 'organizer',
        identifier_type: 'email',
        identifier: 'rana@example.com',
        linked_type: null,
        linked_identifier: null,
        name: 'Rana',
        first_at: '2025-03-10T09:00:00.000Z',
        last_at: '2025-03-10T09:00:00.000Z',
        occurrences: 1,
        context: {
          type: 'person',
          googleCalendar: false,
          status: { accepted: 1 },
          role: { chair: 1 },
          smallest: 4,
          largest: 4,
          firstDay: null,
          lastDay: null,
          upcoming: 0,
        },
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
