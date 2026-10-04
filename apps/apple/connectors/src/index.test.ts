import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  type Source,
  Stream,
  StreamStatus,
} from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import {
  type AccountDocument,
  type AlarmDocument,
  CalendarStore,
  type DateComponentsDocument,
  type IcsDocument,
  type OccurrenceDocument,
  type RecurrenceRuleDocument,
  type ReminderDocument,
  RemindersStore,
} from '@workspace/macos-eventkit';
import {
  FakeEventKitHelper,
  type HelperCalendarDocument,
  type HelperRequest,
} from '@workspace/macos-eventkit/test';
import { AppleCalendarSource } from '@workspace/source-apple-calendar/apple-calendar-source';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

// Each stream's records from one full-refresh read of streams.
async function readRows(source: Source, streams: readonly Stream[]) {
  const rows = new Map<string, Record<string, unknown>[]>();
  for await (const message of source.read(
    streams.map((stream) => configured(stream)),
    new Map(),
  )) {
    if (message instanceof StreamStatus && message.status === 'FAILED')
      throw message.error;
    if ('data' in message)
      rows.set(message.stream, [
        ...(rows.get(message.stream) ?? []),
        Object(message.data),
      ]);
  }
  return (stream: Stream) => rows.get(stream.name) ?? [];
}

// The configured stream a full-refresh copy of stream reads.
const configured = (stream: Stream) =>
  new Copy(
    stream,
    new SQLiteDestination({ path: ':memory:' }).table(stream.name),
  ).configuration;

// Documents the eventkit helper wrote on a Mac, read with TZ=UTC from a
// synthetic calendar and reminders list made for the recording; ids are
// renamed and every value is synthetic. Each factory below starts from one, so
// every field the helper writes reaches the projections, and a test overrides
// only what its scenario needs. An override of undefined leaves the field out
// of the JSON line, as the helper leaves out a nil.
const recordedAlarm: AlarmDocument = {
  alarmType: 0,
  relativeOffset: -600,
  proximity: 0,
};

const recordedRule: RecurrenceRuleDocument = {
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

const recordedEvents: {
  readonly account: AccountDocument;
  readonly calendar: HelperCalendarDocument;
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

const recordedTimedDue: DateComponentsDocument = {
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

const recordedDateOnlyDue: DateComponentsDocument = {
  repeatedDay: false,
  calendarIdentifier: 'gregorian',
  leapMonth: false,
  month: 1,
  year: 2025,
  day: 3,
  era: 1,
};

const recordedReminders: {
  readonly account: AccountDocument;
  readonly list: HelperCalendarDocument;
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

const calendar = (
  overrides: Partial<HelperCalendarDocument> = {},
): HelperCalendarDocument => ({ ...recordedEvents.calendar, ...overrides });

const list = (
  overrides: Partial<HelperCalendarDocument> = {},
): HelperCalendarDocument => ({
  ...recordedReminders.list,
  ...overrides,
});

// The read a Calendar source sends for its window: the private ICS export
// only when an ICS stream is selected.
const eventsRead = (
  { startAt, endAt }: { readonly startAt: string; readonly endAt: string },
  ics = false,
): HelperRequest => ({ entity: 'events', startAt, endAt, ics });

const remindersRead: HelperRequest = { entity: 'reminders' };

const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

const execFile = promisify(execFileCallback);

const calendarStore = new CalendarStore(
  fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/macos-eventkit'),
    ),
  ),
);
const remindersStore = new RemindersStore(
  fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/macos-eventkit'),
    ),
  ),
);

test('Calendar and Reminders scope passes the chosen calendars to the helper and keeps only what it selected', async (t) => {
  const scope = { accountIds: ['account-1'], collectionIds: ['selected'] };
  const missing = { collectionIds: ['missing'] };
  const accounts = (recorded: AccountDocument) => [
    recorded,
    { ...recorded, id: 'account-2', name: 'Work' },
  ];
  // The helper writes every account and every calendar or list of the entity,
  // and marks those inside the request's scope selected.
  const collections = (factory: typeof calendar, selected: boolean) => [
    factory({ id: 'selected', selected }),
    factory({ id: 'excluded', accountId: 'account-2', selected: false }),
  ];
  // The scope reaches the helper as accountIds and collectionIds: the fake
  // answers only these four requests.
  new FakeEventKitHelper()
    .answer({ ...eventsRead(january), ...scope }, () => [
      ...accounts(recordedEvents.account),
      ...collections(calendar, true),
    ])
    .answer({ ...eventsRead(january), ...missing }, () => [
      ...accounts(recordedEvents.account),
      ...collections(calendar, false),
    ])
    .answer({ ...remindersRead, ...scope }, () => [
      ...accounts(recordedReminders.account),
      ...collections(list, true),
    ])
    .answer({ ...remindersRead, ...missing }, () => [
      ...accounts(recordedReminders.account),
      ...collections(list, false),
    ])
    .install(t);
  const listed = async (source: Source, streams: readonly Stream[]) => {
    const rows = await readRows(source, streams);
    return streams.map((stream) => rows(stream).map(({ id }) => id));
  };
  const calendars = new AppleCalendarSource({
    store: calendarStore,
    ...january,
    scope,
  });
  const noCalendars = new AppleCalendarSource({
    store: calendarStore,
    ...january,
    scope: missing,
  });
  const reminders = new AppleRemindersSource({
    store: remindersStore,
    scope: scope,
  });
  const noReminders = new AppleRemindersSource({
    store: remindersStore,
    scope: missing,
  });

  const listings = [
    await listed(calendars, [calendars.accounts, calendars.calendars]),
    await listed(noCalendars, [noCalendars.accounts, noCalendars.calendars]),
    await listed(reminders, [reminders.accounts, reminders.lists]),
    await listed(noReminders, [noReminders.accounts, noReminders.lists]),
  ];

  assert.deepEqual(listings, [
    [['account-1'], ['selected']],
    [[], []],
    [['account-1'], ['selected']],
    [[], []],
  ]);
});

test(
  'EventKit watch confirms its subscription through the native helper and stops on abort',
  {
    timeout: 120_000,
  },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    const helper = fileURLToPath(
      new URL(
        './eventkit-helper',
        import.meta.resolve('@workspace/macos-eventkit'),
      ),
    );
    const calendar = new AppleCalendarSource({
      store: calendarStore,
      ...january,
    });
    const reminders = new AppleRemindersSource({ store: remindersStore });
    for (const [entity, source, stream, unavailable] of [
      ['events', calendar, calendar.events, 'CalendarUnavailableError'],
      [
        'reminders',
        reminders,
        reminders.reminders,
        'RemindersUnavailableError',
      ],
    ] as const)
      await t.test(entity, async (t) => {
        const helperRunning = () =>
          execFile('pgrep', [
            '-P',
            String(process.pid),
            '-f',
            `${helper} watch ${entity}`,
          ]);
        const controller = new AbortController();
        try {
          const watching = source.watch({
            streams: [stream],
            signal: controller.signal,
          });
          const subscribed = await watching.next().catch((error: unknown) => {
            if (error instanceof Error && error.name === unavailable)
              return null;
            throw error;
          });
          if (subscribed === null) return t.skip(`no ${entity} access`);
          assert.deepEqual(subscribed, { value: [stream], done: false });
          const pending = watching.next();
          controller.abort();
          assert.deepEqual(await pending, { value: undefined, done: true });
          await assert.rejects(helperRunning(), { code: 1 });

          // A consumer that stops iterating also stops the helper.
          const stopped = source.watch({
            streams: [stream],
            signal: new AbortController().signal,
          });
          assert.deepEqual(await stopped.next(), {
            value: [stream],
            done: false,
          });
          await helperRunning();
          assert.deepEqual(await stopped.return(undefined), {
            value: undefined,
            done: true,
          });
          await assert.rejects(helperRunning(), { code: 1 });
        } finally {
          controller.abort();
        }
      });
  },
);

test(
  'Calendar and Reminders read this Mac’s EventKit stores into SQLite through the native helper',
  {
    timeout: 300_000,
  },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-eventkit-live-'),
    );
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const calendar = new AppleCalendarSource({
      store: calendarStore,
      startAt: new Date(now - 7 * day).toISOString(),
      endAt: new Date(now + 7 * day).toISOString(),
    });
    const reminders = new AppleRemindersSource({ store: remindersStore });
    for (const [name, source, unavailable] of [
      ['calendar', calendar, 'CalendarUnavailableError'],
      ['reminders', reminders, 'RemindersUnavailableError'],
    ] as const)
      await t.test(name, async (t) => {
        const sqlite = new SQLiteDestination({
          path: join(scratch.path, `${name}.sqlite`),
        });
        const streams = (await source.discover()).streams;
        const outcomes = await new Pipeline({
          connections: [
            new Connection({
              name: 'live',
              source,
              destination: sqlite,
              steps: streams.map(
                (stream) => new Copy(stream, sqlite.table(stream.name)),
              ),
            }),
          ],
        })
          .run()
          .catch((error: unknown) => {
            if (
              error instanceof PipelineError &&
              error.cause instanceof Error &&
              error.cause.name === unavailable
            )
              return null;
            throw error;
          });
        if (outcomes === null) return t.skip(`no ${name} access`);
        assert.equal(outcomes.length, streams.length);
        using database = new DatabaseSync(sqlite.path, { readOnly: true });
        for (const { copy, count } of outcomes) {
          assert.equal(
            database
              .prepare(`SELECT count(*) AS count FROM "${copy.from.name}"`)
              .get()?.count,
            count,
            copy.from.name,
          );
        }
      });
  },
);

test('EventKit watching preserves permission failures and rejects invalid or stopped notifications', async (t) => {
  // Injects watcher failures on purpose; nothing is read.
  const helper = new FakeEventKitHelper().install(t);
  const calendar = new AppleCalendarSource({
    store: calendarStore,
    ...january,
  });
  const reminders = new AppleRemindersSource({ store: remindersStore });
  const watching = (source: Source, stream: Stream) =>
    source.watch({ streams: [stream], signal: new AbortController().signal });
  for (const [source, stream, marker, name, access] of [
    [
      calendar,
      calendar.events,
      'CALENDAR_UNAVAILABLE',
      'CalendarUnavailableError',
      /full Calendar access/,
    ],
    [
      reminders,
      reminders.reminders,
      'REMINDERS_UNAVAILABLE',
      'RemindersUnavailableError',
      /full Reminders access/,
    ],
  ] as const) {
    const cause = Object.assign(new Error('eventkit exited'), {
      stderr: `${marker}: full access is required; status=2\n`,
    });
    helper.watchWith(() => {
      throw cause;
    });
    await assert.rejects(watching(source, stream).next(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, name);
      assert.match(error.message, access);
      assert.equal(error.cause, cause);
      return true;
    });
  }
  helper.watchWith(async function* () {
    yield 'unexpected';
  });
  await assert.rejects(
    watching(calendar, calendar.events).next(),
    /invalid notification/,
  );
  helper.watchWith(async function* () {
    yield 'changed';
  });
  const stopped = watching(reminders, reminders.reminders);
  assert.deepEqual(await stopped.next(), {
    value: [reminders.reminders],
    done: false,
  });
  await assert.rejects(stopped.next(), /stopped unexpectedly/);
});

test('Calendar declares its event window as the coverage of event streams, and none for its listings', async () => {
  const startAt = '2020-01-01T00:00:00.000Z';
  const endAt = '2021-01-01T00:00:00.000Z';
  const calendar = new AppleCalendarSource({
    store: calendarStore,
    startAt,
    endAt,
  });
  const notes = new AppleNotesSource();

  const { streams } = await calendar.discover();
  const [note] = (await notes.discover()).streams;

  for (const stream of streams)
    assert.deepEqual(
      calendar.coverage(stream).selection,
      stream === calendar.accounts || stream === calendar.calendars
        ? {}
        : { startAt, endAt },
      stream.name,
    );
  assert.match(
    calendar.coverage(calendar.events).description,
    /\[startAt, endAt\)/,
  );
  assert.ok(note);
  assert.match(notes.coverage(note).description, /local Apple store/);
});
