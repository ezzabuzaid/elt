import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type {
  AccountDocument,
  AlarmDocument,
  CalendarDocument,
  DateComponentsDocument,
  EventKitDocument,
  IcsDocument,
  OccurrenceDocument,
  ParticipantDocument,
  RecurrenceRuleDocument,
  ReminderDocument,
} from './eventkit-documents.ts';
import type { EventKitRequest } from './eventkit.ts';
import nativeProcess from './native-process.ts';

// Test support shared by the EventKit sources' tests: recorded helper
// documents, factories over them, and a stand-in for the helper process.

export const at = (iso: string) => Date.parse(iso);

// Documents the eventkit helper wrote on a Mac, read with TZ=UTC from a
// synthetic calendar and reminders list made for the recording; ids are
// renamed and every value is synthetic. Each factory below starts from one, so
// every field the helper writes reaches the projections, and a test overrides
// only what its scenario needs. An override of undefined leaves the field out
// of the JSON line, as the helper leaves out a nil.
export const recordedAlarm: AlarmDocument = {
  alarmType: 0,
  relativeOffset: -600,
  proximity: 0,
};

export const recordedRule: RecurrenceRuleDocument = {
  firstDayOfWeek: 2,
  monthsOfTheYear: [],
  setPositions: [],
  weeksOfTheYear: [],
  interval: 1,
  end: { occurrenceCount: 3 },
  frequency: 1,
  calendarIdentifier: 'gregorian',
  daysOfTheWeek: [],
  daysOfTheMonth: [],
  daysOfTheYear: [],
};

export const recordedEvents: {
  readonly account: AccountDocument;
  readonly calendar: CalendarDocument;
  // Timed, with alarms, a structured location, a URL and notes.
  readonly standup: OccurrenceDocument;
  readonly standupIcs: IcsDocument;
  readonly holiday: OccurrenceDocument;
  // The first occurrence of a weekly series of three.
  readonly weekly: OccurrenceDocument;
} = {
  account: {
    name: 'Default',
    sourceType: 0,
    id: 'account-1',
    type: 'account',
    isDelegate: false,
  },
  calendar: {
    color: [0.7960784435272217, 0.1882352977991104, 0.8784313797950745, 1],
    name: 'Synthetic calendar',
    type: 'calendar',
    id: 'calendar-1',
    selected: true,
    allowedEntityTypes: 1,
    subscribed: false,
    notes: 'Synthetic calendar for recorded EventKit test data',
    immutable: false,
    writable: true,
    calendarType: 0,
    supportedAvailabilities: 0,
    accountId: 'account-1',
  },
  standup: {
    timeZone: 'Asia/Amman',
    body: 'Synthetic notes',
    calendarItemId: 'item-1',
    name: 'Synthetic standup',
    place: { title: 'Synthetic Room 1', radius: 0 },
    allDay: false,
    externalId: 'external-1',
    alarms: [
      recordedAlarm,
      { alarmType: 0, relativeOffset: -1800, proximity: 0 },
      { alarmType: 0, relativeOffset: -3600, proximity: 0 },
    ],
    type: 'occurrence',
    recurrenceRules: [],
    occurrenceDay: '2025-01-02',
    nativeEventId: 'account-1:external-1',
    endDay: '2025-01-02',
    location: 'Synthetic Room 1',
    occurrenceMs: 1735797600000,
    startMs: 1735797600000,
    availability: -1,
    url: 'https://example.com/standup',
    createdMs: 1790851279941.809,
    calendarId: 'calendar-1',
    startDay: '2025-01-02',
    modifiedMs: 1790851279941.8489,
    attendees: [],
    detached: false,
    endMs: 1735801200000,
    status: 0,
  },
  standupIcs: {
    type: 'ics',
    calendarId: 'calendar-1',
    ics: 'QkVHSU46VkNBTEVOREFSDQpDQUxTQ0FMRTpHUkVHT1JJQU4NClBST0RJRDotLy9BcHBsZSBJbmMuLy9tYWNPUyAyNy4wLy9FTg0KVkVSU0lPTjoyLjANCkJFR0lOOlZUSU1FWk9ORQ0KVFpJRDpBc2lhL0FtbWFuDQpCRUdJTjpEQVlMSUdIVA0KRFRTVEFSVDoyMDIyMDIyNVQwMDAwMDANClJEQVRFOjIwMjIwMjI1VDAwMDAwMA0KVFpOQU1FOkdNVCszDQpUWk9GRlNFVEZST006KzAyMDANClRaT0ZGU0VUVE86KzAzMDANCkVORDpEQVlMSUdIVA0KRU5EOlZUSU1FWk9ORQ0KQkVHSU46VkVWRU5UDQpDUkVBVEVEOjIwMjYxMDAxVDEwNDExOVoNCkRFU0NSSVBUSU9OOlN5bnRoZXRpYyBub3Rlcw0KRFRFTkQ7VFpJRD1Bc2lhL0FtbWFuOjIwMjUwMTAyVDEwMDAwMA0KRFRTVEFNUDoyMDI2MTAwMVQxMDQyMDJaDQpEVFNUQVJUO1RaSUQ9QXNpYS9BbW1hbjoyMDI1MDEwMlQwOTAwMDANCkxBU1QtTU9ESUZJRUQ6MjAyNjEwMDFUMTA0MTE5Wg0KTE9DQVRJT046U3ludGhldGljIFJvb20gMQ0KU0VRVUVOQ0U6MA0KU1VNTUFSWTpTeW50aGV0aWMgc3RhbmR1cA0KVFJBTlNQOk9QQVFVRQ0KVUlEOmV4dGVybmFsLTENClVSTDtWQUxVRT1VUkk6aHR0cHM6Ly9leGFtcGxlLmNvbS9zdGFuZHVwDQpYLUFQUExFLUNSRUFUT1ItSURFTlRJVFk6Y29tLmFwcGxlLmNhbGVuZGFyDQpYLUFQUExFLUNSRUFUT1ItVEVBTS1JREVOVElUWTowMDAwMDAwMDAwDQpCRUdJTjpWQUxBUk0NCkFDVElPTjpESVNQTEFZDQpERVNDUklQVElPTjpSZW1pbmRlcg0KVFJJR0dFUjotUFQzME0NClVJRDpCRDI4MkVGNS1DNzhBLTRDRUQtQTA5RC05NzU5RDhBNzY1QUMNClgtV1ItQUxBUk1VSUQ6QkQyODJFRjUtQzc4QS00Q0VELUEwOUQtOTc1OUQ4QTc2NUFDDQpFTkQ6VkFMQVJNDQpCRUdJTjpWQUxBUk0NCkFDVElPTjpESVNQTEFZDQpERVNDUklQVElPTjpSZW1pbmRlcg0KVFJJR0dFUjotUFQxSA0KVUlEOjMxMkQ4QTcyLUZENEYtNEJFRC04NjIyLUJGNDc3N0JEQzFEQw0KWC1XUi1BTEFSTVVJRDozMTJEOEE3Mi1GRDRGLTRCRUQtODYyMi1CRjQ3NzdCREMxREMNCkVORDpWQUxBUk0NCkJFR0lOOlZBTEFSTQ0KQUNUSU9OOkRJU1BMQVkNCkRFU0NSSVBUSU9OOlJlbWluZGVyDQpUUklHR0VSOi1QVDEwTQ0KVUlEOjFFQzY2MjA3LTI5MUEtNDhGRS05NzE5LUE0QzdDNzA5MjNCNw0KWC1XUi1BTEFSTVVJRDoxRUM2NjIwNy0yOTFBLTQ4RkUtOTcxOS1BNEM3QzcwOTIzQjcNCkVORDpWQUxBUk0NCkVORDpWRVZFTlQNCkVORDpWQ0FMRU5EQVINCg==',
    calendarItemId: 'item-1',
    recurring: false,
  },
  holiday: {
    attendees: [],
    startMs: 1735862400000,
    name: 'Synthetic holiday',
    alarms: [],
    recurrenceRules: [],
    status: 0,
    type: 'occurrence',
    occurrenceDay: '2025-01-03',
    calendarItemId: 'item-2',
    createdMs: 1790851280775.7612,
    calendarId: 'calendar-1',
    occurrenceMs: 1735862400000,
    startDay: '2025-01-03',
    modifiedMs: 1790851280775.793,
    detached: false,
    nativeEventId: 'account-1:external-2',
    availability: -1,
    externalId: 'external-2',
    endDay: '2025-01-03',
    endMs: 1735948799000,
    allDay: true,
  },
  weekly: {
    attendees: [],
    startMs: 1735970400000,
    name: 'Synthetic weekly',
    alarms: [],
    recurrenceRules: [recordedRule],
    status: 0,
    type: 'occurrence',
    timeZone: 'Asia/Amman',
    occurrenceDay: '2025-01-04',
    calendarItemId: 'item-3',
    createdMs: 1790851280902.925,
    calendarId: 'calendar-1',
    occurrenceMs: 1735970400000,
    startDay: '2025-01-04',
    modifiedMs: 1790851280902.947,
    detached: false,
    nativeEventId: 'account-1:external-3',
    availability: -1,
    externalId: 'external-3',
    endDay: '2025-01-04',
    endMs: 1735972200000,
    allDay: false,
  },
};

export const recordedTimedDue: DateComponentsDocument = {
  year: 2025,
  repeatedDay: false,
  calendarIdentifier: 'gregorian',
  era: 1,
  timeZone: 'Asia/Amman',
  day: 2,
  second: 0,
  minute: 45,
  leapMonth: false,
  month: 1,
  hour: 8,
};

export const recordedDateOnlyDue: DateComponentsDocument = {
  repeatedDay: false,
  calendarIdentifier: 'gregorian',
  leapMonth: false,
  month: 1,
  year: 2025,
  day: 3,
  era: 1,
};

export const recordedReminders: {
  readonly account: AccountDocument;
  readonly list: CalendarDocument;
  // Open, due at a time in a time zone, with an absolute alarm and notes.
  readonly buyMilk: ReminderDocument;
  // Completed, due on a date.
  readonly filedTaxes: ReminderDocument;
} = {
  account: {
    type: 'account',
    id: 'account-1',
    sourceType: 2,
    isDelegate: false,
    name: 'iCloud',
  },
  list: {
    selected: true,
    accountId: 'account-1',
    writable: true,
    calendarType: 1,
    immutable: false,
    subscribed: false,
    name: 'Synthetic list',
    id: 'calendar-1',
    color: [0, 0.47843137383461, 1, 1],
    supportedAvailabilities: 0,
    type: 'calendar',
    allowedEntityTypes: 2,
  },
  buyMilk: {
    alarms: [
      {
        relativeOffset: 0,
        absoluteMs: 1735796700000,
        proximity: 0,
        alarmType: 0,
      },
    ],
    id: 'reminder-1',
    timeZone: 'Asia/Amman',
    modifiedMs: 1790851301723.245,
    body: 'Synthetic notes',
    recurrenceRules: [],
    attendees: [],
    completed: false,
    listId: 'calendar-1',
    type: 'reminder',
    priority: 1,
    name: 'Synthetic buy milk',
    createdMs: 1790851301628.685,
    externalId: 'reminder-1',
    due: recordedTimedDue,
  },
  filedTaxes: {
    due: recordedDateOnlyDue,
    externalId: 'reminder-2',
    recurrenceRules: [],
    type: 'reminder',
    modifiedMs: 1790851302411.9302,
    name: 'Synthetic filed taxes',
    completedMs: 1790851302411.825,
    priority: 5,
    completed: true,
    attendees: [],
    listId: 'calendar-1',
    id: 'reminder-2',
    alarms: [],
    createdMs: 1790851301824.6108,
  },
};

export const account = (
  overrides: Partial<AccountDocument> = {},
): AccountDocument => ({ ...recordedEvents.account, ...overrides });

export const calendar = (
  overrides: Partial<CalendarDocument> = {},
): CalendarDocument => ({ ...recordedEvents.calendar, ...overrides });

export const list = (
  overrides: Partial<CalendarDocument> = {},
): CalendarDocument => ({
  ...recordedReminders.list,
  ...overrides,
});

// No recorded event or reminder had a participant, so this one is written
// from the helper's ParticipantDocument fields.
export const participant = (
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

export const alarm = (
  overrides: Partial<AlarmDocument> = {},
): AlarmDocument => ({
  ...recordedAlarm,
  ...overrides,
});

export const rule = (
  overrides: Partial<RecurrenceRuleDocument> = {},
): RecurrenceRuleDocument => ({ ...recordedRule, ...overrides });

export const occurrence = (
  overrides: Partial<OccurrenceDocument> = {},
): OccurrenceDocument => ({ ...recordedEvents.standup, ...overrides });

export const icsItem = (
  calendarItemId: string,
  ics: string,
  recurring = false,
): IcsDocument => ({
  ...recordedEvents.standupIcs,
  calendarItemId,
  recurring,
  ics: Buffer.from(ics).toString('base64'),
});

export const reminder = (
  overrides: Partial<ReminderDocument> = {},
): ReminderDocument => ({ ...recordedReminders.buyMilk, ...overrides });

// A Calendar row's event id: calendar, item and, for a recurring event, the
// occurrence it replaces.
export const eventId = (calendarItemId: string, key: string | null = null) =>
  JSON.stringify(['calendar-1', calendarItemId, key]);

export type HelperRequest = EventKitRequest & {
  readonly entity: 'events' | 'reminders';
};

// The read a Calendar source sends for its window: the private ICS export
// only when an ICS stream is selected.
export const eventsRead = (
  { startAt, endAt }: { readonly startAt: string; readonly endAt: string },
  ics = false,
): HelperRequest => ({ entity: 'events', startAt, endAt, ics });

export const remindersRead: HelperRequest = { entity: 'reminders' };

export const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

// A watcher that confirms its subscription and then reports no change, so
// reads settle on their first attempt.
export async function* quiet(signal: AbortSignal): AsyncGenerator<string> {
  yield 'changed';
  if (!signal.aborted) await once(signal, 'abort');
}

// Stands in for the eventkit helper process: each read request it is set up
// for is answered with its documents, one JSON line each, and each watch with
// the watch lines. Any other request throws, so what a source asks the helper
// for is part of every test.
export function fakeEventKit(
  t: TestContext,
  answers: readonly (readonly [
    request: HelperRequest,
    documents: () =>
      Iterable<EventKitDocument> | AsyncIterable<EventKitDocument>,
  ])[],
  watch: (signal: AbortSignal) => AsyncIterable<string> = quiet,
) {
  t.mock.method(
    nativeProcess,
    'lines',
    async function* (
      _file: string,
      args: readonly string[],
      signal?: AbortSignal,
    ) {
      if (args[0] === 'watch') {
        assert.ok(signal);
        yield* watch(signal);
        return;
      }
      const request = JSON.parse(String(args[1]));
      const answer = answers.find(([expected]) =>
        isDeepStrictEqual(request, expected),
      );
      if (answer === undefined)
        throw new Error(`The EventKit fake has no answer for ${args[1]}`);
      for await (const document of answer[1]()) yield JSON.stringify(document);
    },
  );
}
