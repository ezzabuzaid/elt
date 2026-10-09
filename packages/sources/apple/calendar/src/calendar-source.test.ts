import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Source,
  Stream,
  StreamStatus,
  readerCatalog,
  syncHistoryRelations,
} from '@workspace/elt';
import { MarkdownDestination } from '@workspace/elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import { GaxiosError, type GoogleRequester } from '@workspace/google-auth';
import {
  type AccountDocument,
  type AlarmDocument,
  CalendarStore,
  type IcsDocument,
  IcsExportUnavailableError,
  type OccurrenceDocument,
  type ParticipantDocument,
  type RecurrenceRuleDocument,
} from '@workspace/sdk-apple-eventkit';
import {
  type HelperCalendarDocument,
  type HelperRead,
  type HelperRequest,
  StubEventKitHelper,
} from '@workspace/sdk-apple-eventkit/test';

import {
  AppleCalendarSource,
  CalendarIcsUnavailableError,
} from './apple-calendar-source.ts';
import { googleCalendarAttachments } from './google-calendar-attachments.ts';

// A file column's chunk table, by the documented rule: _elt_files_ and the
// first 40 hex digits of SHA-256 over the JSON of [table, column], both in
// ASCII lower case.
const chunkTable = (table: string, column: string) =>
  `"_elt_files_${createHash('sha256')
    .update(JSON.stringify([table.toLowerCase(), column.toLowerCase()]))
    .digest('hex')
    .slice(0, 40)}"`;

const execFile = promisify(execFileCallback);

// The helper @workspace/sdk-apple-eventkit compiles, which the live tests read
// this Mac's calendars through.
const helper = fileURLToPath(
  new URL(
    'eventkit-helper',
    import.meta.resolve('@workspace/sdk-apple-eventkit'),
  ),
);

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One Apple source loaded as the hosts load it: every stream incrementally
// into raw_<stream> of one SQLite file, read through its documented
// <snake_stream> view, with files kept beside it.
async function appleImport(source: Source, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const connection = new Connection({
    name: 'apple',
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, 'checkpoints.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          destination
            .table(
              `raw_${stream.name}`,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            )
            .withReaderView(snake(stream.name)),
          {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog({ path });
  const read = (sql: string) => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database.prepare(sql).all();
  };
  return {
    load: () => new Pipeline({ history, connections: [connection] }).run(),
    read,
    // The documented views the streams publish, beside the catalog and the
    // sync history every SQLite load has.
    views: () =>
      read(`SELECT name FROM catalog WHERE kind = 'view' ORDER BY name`)
        .map(({ name }) => name)
        .filter(
          (name) =>
            name !== readerCatalog.name &&
            !Object.values(syncHistoryRelations).some(
              (relation) => relation.name === name,
            ),
        ),
  };
}

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

const at = (iso: string) => Date.parse(iso);

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
};

const account = (
  overrides: Partial<AccountDocument> = {},
): AccountDocument => ({ ...recordedEvents.account, ...overrides });

const calendar = (
  overrides: Partial<HelperCalendarDocument> = {},
): HelperCalendarDocument => ({ ...recordedEvents.calendar, ...overrides });

// No recorded event or reminder had a participant, so this one is written
// from the helper's ParticipantDocument fields.
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

const rule = (
  overrides: Partial<RecurrenceRuleDocument> = {},
): RecurrenceRuleDocument => ({ ...recordedRule, ...overrides });

const occurrence = (
  overrides: Partial<OccurrenceDocument> = {},
): OccurrenceDocument => ({ ...recordedEvents.standup, ...overrides });

const icsItem = (
  calendarItemId: string,
  ics: string,
  recurring = false,
): IcsDocument => ({
  ...recordedEvents.standupIcs,
  calendarItemId,
  recurring,
  ics: Buffer.from(ics).toString('base64'),
});

// The read a Calendar source sends for its window: the private ICS export
// only when an ICS stream is selected.
const eventsRead = (
  { startAt, endAt }: { readonly startAt: string; readonly endAt: string },
  ics = false,
): HelperRequest => ({ entity: 'events', startAt, endAt, ics });

const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

// A Calendar row's event id: calendar, item and, for a recurring event, the
// occurrence it replaces.
const eventId = (calendarItemId: string, key: string | null = null) =>
  JSON.stringify(['calendar-1', calendarItemId, key]);

// One event a live test creates; times are UTC instants.
type ScratchEvent = {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay?: boolean;
  readonly timeZone?: string;
  readonly notes?: string;
  readonly location?: string;
  readonly url?: string;
  // Relative offsets in seconds.
  readonly alarms?: readonly number[];
  // EKRecurrenceFrequency: 1 weekly, 2 monthly.
  readonly rule?: {
    readonly frequency: number;
    readonly count: number;
    readonly daysOfTheMonth?: readonly number[];
  };
};

// The event calendar this Mac's live tests share, in the first account that
// accepts one (CalDAV before Exchange), made once and never deleted: iCloud
// brings a deleted calendar back, empty, hours later. A test holds it alone,
// across processes, and empties it before and after, so it starts with no
// events and leaves none, whatever a killed run left. EventKit writes run in
// Asia/Amman, so an all-day event falls on an Amman day.
class ScratchCalendar implements AsyncDisposable {
  readonly id: string;
  readonly title: string;
  readonly #lock: DatabaseSync;

  private constructor(
    { id, title }: { id: string; title: string },
    lock: DatabaseSync,
  ) {
    this.id = id;
    this.title = title;
    this.#lock = lock;
  }

  // Null when no account on this Mac accepts a new calendar.
  static async create(): Promise<ScratchCalendar | null> {
    const lock = ScratchCalendar.#hold();
    try {
      const calendar = new ScratchCalendar(
        JSON.parse(await ScratchCalendar.#run('open', {})),
        lock,
      );
      await calendar.#empty();
      return calendar;
    } catch (error) {
      lock.close();
      if (
        String(Reflect.get(Object(error), 'stderr')).includes(
          ScratchCalendar.#noAccount,
        )
      )
        return null;
      throw error;
    }
  }

  // One test at a time uses the shared calendar, in any process: a test holds
  // this exclusive transaction until it is done, and a process that dies
  // releases it.
  static #hold(): DatabaseSync {
    const path = join(
      homedir(),
      'Library/Caches/context-compiler/eventkit-tests.sqlite',
    );
    mkdirSync(dirname(path), { recursive: true });
    const lock = new DatabaseSync(path, { timeout: 600_000 });
    lock.exec('BEGIN EXCLUSIVE');
    return lock;
  }

  // Deletes every event the calendar holds, as the helper reads them.
  async #empty(): Promise<void> {
    const { occurrences } = await new CalendarStore(helper).read({
      startAt: '1990-01-01T00:00:00.000Z',
      endAt: '2040-01-01T00:00:00.000Z',
      ics: false,
      calendarIds: [this.id],
    });
    const items = [...new Set(occurrences.map((item) => item.calendarItemId))];
    if (items.length > 0) await ScratchCalendar.#run('empty', { items });
  }

  // The calendar item identifier of each event, in order.
  async add(...events: readonly ScratchEvent[]): Promise<string[]> {
    return JSON.parse(
      await ScratchCalendar.#run('add', { calendarId: this.id, events }),
    );
  }

  // Renames or moves a nonrecurring event.
  async edit(
    itemId: string,
    changes: { title?: string; start?: string; end?: string },
  ): Promise<void> {
    await ScratchCalendar.#run('edit', {
      calendarId: this.id,
      itemId,
      ...changes,
    });
  }

  // Moves the occurrence of a series that starts at occurrence, which
  // detaches it from the series.
  async detach(
    itemId: string,
    occurrence: string,
    start: string,
    end: string,
  ): Promise<void> {
    await ScratchCalendar.#run('detach', {
      calendarId: this.id,
      itemId,
      occurrence,
      start,
      end,
    });
  }

  // Deletes the occurrence of a series that starts at occurrence.
  async skip(itemId: string, occurrence: string): Promise<void> {
    await ScratchCalendar.#run('skip', {
      calendarId: this.id,
      itemId,
      occurrence,
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.#empty();
    } finally {
      this.#lock.close();
    }
  }

  static async #run(mode: string, payload: object): Promise<string> {
    const { stdout } = await execFile(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        ScratchCalendar.#script,
        mode,
        JSON.stringify(payload),
      ],
      { env: { ...process.env, TZ: 'Asia/Amman' } },
    );
    return stdout.trim();
  }

  static readonly #noAccount = 'No EventKit account accepts a new calendar';

  static readonly #script = `
ObjC.import('EventKit');
function run([mode, payload]) {
  const spec = JSON.parse(payload);
  const store = $.EKEventStore.alloc.init;
  const date = (iso) => $.NSDate.dateWithTimeIntervalSince1970(Date.parse(iso) / 1000);
  const calendar = () => store.calendarWithIdentifier(spec.calendarId);
  const save = (event) => {
    if (!store.saveEventSpanCommitError(event, 0, true, null)) throw new Error('Event not saved');
  };
  // The occurrence of a series that starts at the instant at.
  const occurrence = (itemId, at) => {
    const ms = Date.parse(at);
    const window = store.predicateForEventsWithStartDateEndDateCalendars(
      $.NSDate.dateWithTimeIntervalSince1970(ms / 1000 - 1),
      $.NSDate.dateWithTimeIntervalSince1970(ms / 1000 + 1),
      $([calendar()]),
    );
    const found = ObjC.unwrap(store.eventsMatchingPredicate(window)).find(
      (event) => ObjC.unwrap(event.calendarItemIdentifier) === itemId,
    );
    if (found === undefined) throw new Error('No occurrence at ' + at);
    return found;
  };
  if (mode === 'open') {
    const title = 'context-compiler tests';
    let shared = ObjC.unwrap(store.calendarsForEntityType(0))
      .filter((each) => ObjC.unwrap(each.title) === title)
      .toSorted((a, b) => (ObjC.unwrap(a.calendarIdentifier) < ObjC.unwrap(b.calendarIdentifier) ? -1 : 1))[0];
    if (shared === undefined) {
      shared = $.EKCalendar.calendarForEntityTypeEventStore(0, store);
      shared.title = title;
      const sources = ObjC.unwrap(store.sources).toSorted(
        (a, b) => (Number(a.sourceType) === 2 ? 0 : 1) - (Number(b.sourceType) === 2 ? 0 : 1),
      );
      if (!sources.some((source) => {
        shared.source = source;
        return store.saveCalendarCommitError(shared, true, null);
      })) throw new Error('${ScratchCalendar.#noAccount}');
    }
    return JSON.stringify({ id: ObjC.unwrap(shared.calendarIdentifier), title });
  }
  if (mode === 'empty') {
    for (const id of spec.items) {
      const item = store.calendarItemWithIdentifier(id);
      if (!item.isNil() && !store.removeEventSpanCommitError(item, 1, true, null))
        throw new Error('Could not delete a test event');
    }
    return '';
  }
  if (mode === 'add')
    return JSON.stringify(spec.events.map((item) => {
      const event = $.EKEvent.eventWithEventStore(store);
      event.calendar = calendar();
      event.title = item.title;
      event.allDay = item.allDay === true;
      event.startDate = date(item.start);
      event.endDate = date(item.end);
      if (item.timeZone !== undefined)
        event.timeZone = $.NSTimeZone.timeZoneWithName(item.timeZone);
      if (item.notes !== undefined) event.notes = item.notes;
      if (item.location !== undefined)
        event.structuredLocation = $.EKStructuredLocation.locationWithTitle(item.location);
      if (item.url !== undefined) event.URL = $.NSURL.URLWithString(item.url);
      for (const offset of item.alarms ?? [])
        event.addAlarm($.EKAlarm.alarmWithRelativeOffset(offset));
      if (item.rule !== undefined)
        event.addRecurrenceRule(
          $.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalDaysOfTheWeekDaysOfTheMonthMonthsOfTheYearWeeksOfTheYearDaysOfTheYearSetPositionsEnd(
            item.rule.frequency, 1, $(),
            item.rule.daysOfTheMonth === undefined ? $() : $(item.rule.daysOfTheMonth),
            $(), $(), $(), $(),
            $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(item.rule.count),
          ),
        );
      save(event);
      return ObjC.unwrap(event.calendarItemIdentifier);
    }));
  if (mode === 'edit') {
    const event = store.calendarItemWithIdentifier(spec.itemId);
    if (spec.title !== undefined) event.title = spec.title;
    if (spec.start !== undefined) {
      event.startDate = date(spec.start);
      event.endDate = date(spec.end);
    }
    save(event);
    return '';
  }
  if (mode === 'detach') {
    const event = occurrence(spec.itemId, spec.occurrence);
    event.startDate = date(spec.start);
    event.endDate = date(spec.end);
    save(event);
    return '';
  }
  if (mode === 'skip') {
    if (!store.removeEventSpanCommitError(occurrence(spec.itemId, spec.occurrence), 0, true, null))
      throw new Error('Occurrence not removed');
    return '';
  }
  throw new Error('Unknown mode ' + mode);
}`;
}

// A Calendar source over one scratch calendar, read by the compiled helper.
const liveSource = (
  calendar: ScratchCalendar,
  window: { readonly startAt: string; readonly endAt: string } = january,
) =>
  new AppleCalendarSource({
    store: new CalendarStore(helper),
    ...window,
    scope: { collectionIds: [calendar.id] },
  });

// A Calendar row's event id for a scratch calendar's item.
const liveEventId = (
  calendar: ScratchCalendar,
  itemId: string,
  key: string | null = null,
) => JSON.stringify([calendar.id, itemId, key]);

// Each kind of failure a run's copies reported, once.
function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

test(
  'Calendar extracts every scalar stream of a calendar on this Mac into SQLite and Markdown',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    // The last day of each month: January holds one occurrence.
    const [itemId] = await calendar.add({
      title: 'Live standup',
      start: '2025-01-31T06:00:00.000Z',
      end: '2025-01-31T07:00:00.000Z',
      timeZone: 'Asia/Amman',
      notes: 'Live notes',
      location: 'Live room',
      url: 'https://example.com/standup',
      alarms: [-600, -1800, -3600],
      rule: { frequency: 2, count: 3, daysOfTheMonth: [-1] },
    });
    assert.ok(itemId);
    const source = liveSource(calendar);
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-calendar-'),
    );
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
    });
    const streams = [
      source.accounts,
      source.calendars,
      source.events,
      source.attendees,
      source.alarms,
      source.recurrenceRules,
      source.recurrenceRuleValues,
    ];
    const result = await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          steps: streams.map(
            (stream) => new Copy(stream, sqlite.table(stream.name)),
          ),
        }),
      ],
    }).run();

    // EventKit cannot create attendees; the next test loads them.
    assert.deepEqual(
      result.map(({ count }) => count),
      [1, 1, 1, 0, 3, 1, 1],
    );
    const id = liveEventId(calendar, itemId, '2025-01-31T06:00:00.000Z');
    const ruleId = JSON.stringify([id, 'recurrenceRule', 0]);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    // Every column the stream documents.
    const table = (stream: Stream) => {
      const columns = Object.keys(Object(stream.jsonSchema.properties));
      return database
        .prepare(
          `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${stream.name}" ORDER BY rowid`,
        )
        .all()
        .map((row) => ({ ...row }));
    };
    const [account] = table(source.accounts);
    const [calendarRow] = table(source.calendars);
    const [event] = table(source.events);
    assert.ok(account && calendarRow && event);
    // Type, color and availability belong to whichever account took the
    // calendar; these values hold for every one.
    assert.deepEqual(calendarRow, {
      ...calendarRow,
      id: calendar.id,
      accountId: account.id,
      name: calendar.title,
      writable: 1,
      subscribed: 0,
      immutable: 0,
      // Calendar.app's description is private API: nothing set one.
      description: '',
    });
    assert.deepEqual(event, {
      ...event,
      id,
      eventId: id,
      calendarId: calendar.id,
      calendarItemId: itemId,
      name: 'Live standup',
      body: 'Live notes',
      location: 'Live room',
      url: 'https://example.com/standup',
      startAt: '2025-01-31T06:00:00.000Z',
      endAt: '2025-01-31T07:00:00.000Z',
      allDay: 0,
      startDate: null,
      endDate: null,
      timeZone: 'Asia/Amman',
      occurrenceAt: '2025-01-31T06:00:00.000Z',
      occurrenceDate: null,
      detached: 0,
      birthdayContactId: null,
      locationTitle: 'Live room',
      latitude: null,
      longitude: null,
      radius: 0,
    });
    for (const field of [
      'externalId',
      'nativeEventId',
      'createdAt',
      'modifiedAt',
    ])
      assert.equal(typeof Reflect.get(event, field), 'string', field);
    // Alarms are numbered in the content order of their values.
    assert.deepEqual(
      table(source.alarms),
      [-1800, -3600, -600].map((relativeOffset, position) => ({
        id: JSON.stringify([id, position]),
        eventId: id,
        position,
        type: 0,
        relativeOffset,
        absoluteAt: null,
        emailAddress: null,
        soundName: null,
        proximity: 0,
        locationTitle: null,
        latitude: null,
        longitude: null,
        radius: null,
      })),
    );
    assert.deepEqual(table(source.recurrenceRules), [
      {
        id: ruleId,
        eventId: id,
        position: 0,
        calendarIdentifier: 'gregorian',
        frequency: 2,
        interval: 1,
        firstDayOfWeek: 2,
        endAt: null,
        occurrenceCount: 3,
      },
    ]);
    assert.deepEqual(table(source.recurrenceRuleValues), [
      {
        id: JSON.stringify([ruleId, 'daysOfTheMonth', 0]),
        eventId: id,
        ruleId,
        component: 'daysOfTheMonth',
        position: 0,
        value: -1,
        weekNumber: null,
      },
    ]);

    const markdown = new MarkdownDestination({
      path: join(scratch.path, 'markdown'),
    });
    await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: markdown,
          steps: [
            new Copy(
              source.events,
              markdown.file('events.md', { title: 'name' }),
            ),
          ],
        }),
      ],
    }).run();
    const [read] = (await readRows(source, [source.events]))(source.events);
    const document = await readFile(join(markdown.path, 'events.md'), 'utf8');
    assert.match(document, /^## Live standup$/m);
    assert.ok(
      document.includes(Buffer.from(JSON.stringify(read)).toString('base64')),
    );
  },
);

test('Calendar extracts the organizer and attendees EventKit returns, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(eventsRead(january), {
    documents: [
      account(),
      calendar(),
      occurrence({
        organizer: participant({
          name: 'Org',
          url: 'mailto:org@example.com',
          role: 3,
        }),
        attendees: [participant()],
      }),
    ],
  });
  const source = new AppleCalendarSource({
    store: new CalendarStore(stub.path),
    ...january,
  });

  const attendees = (await readRows(source, [source.attendees]))(
    source.attendees,
  );

  const id = eventId('item-1');
  assert.deepEqual(attendees, [
    {
      id: JSON.stringify([id, 'organizer', 0]),
      eventId: id,
      position: 0,
      kind: 'organizer',
      name: 'Org',
      url: 'mailto:org@example.com',
      status: 2,
      role: 3,
      type: 1,
      isCurrentUser: false,
    },
    {
      id: JSON.stringify([id, 'attendee', 0]),
      eventId: id,
      position: 0,
      kind: 'attendee',
      name: 'Ann',
      url: 'mailto:ann@example.com',
      status: 2,
      role: 1,
      type: 1,
      isCurrentUser: false,
    },
  ]);
});

test(
  'Calendar validates its request range and preflights without the EventKit helper',
  {
    concurrency: false,
  },
  async () => {
    // No helper exists here: starting one would fail, so each rejection below
    // must come from validation before the helper is reached.
    await using missing = await mkdtempDisposable(join(tmpdir(), 'no-helper-'));
    const store = new CalendarStore(join(missing.path, 'eventkit-helper'));
    assert.throws(
      () =>
        new AppleCalendarSource({
          store,
          startAt: '2025-01-02T03:04:05.006Z',
          endAt: '2025-01-02T03:04:05.006Z',
        }),
      /startAt < endAt/,
    );
    assert.throws(
      () =>
        new AppleCalendarSource({
          store,
          startAt: '2025-01-01',
          endAt: '2025-01-02T03:04:05.006Z',
        }),
      /canonical UTC/,
    );

    const source = new AppleCalendarSource({
      store,
      ...january,
    });
    // A rolling window keeps one checkpoint; incremental copies delete what left it.
    assert.equal(source.identity, 'apple-calendar:eventkit');
    assert.equal(
      new AppleCalendarSource({
        store,
        ...january,
        endAt: '2025-03-01T00:00:00.000Z',
      }).identity,
      source.identity,
    );
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-calendar-'),
    );
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
    });
    const checkpoints = new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    });
    const snapshotCopy = {
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      id: 'events',
    } as const;
    for (const [options, message] of [
      [
        { destinationSyncMode: 'overwrite_dedup' },
        /cannot use overwrite loading/,
      ],
      [{ destinationSyncMode: 'append' }, /require append_dedup/],
      [
        { cursorField: 'modifiedAt' },
        /defines its own cursor; omit cursorField/,
      ],
      [{ dedupPolicy: 'cursor_newer' }, /no cursor field to compare/],
      [
        { primaryKey: ['eventId'] },
        /defines its own primary key; omit primaryKey/,
      ],
    ] as const) {
      const modes: ConstructorParameters<typeof Copy>[2] = {
        ...snapshotCopy,
        ...options,
      };
      await assert.rejects(
        async () =>
          new Pipeline({
            connections: [
              new Connection({
                name: 'test',
                source,
                destination: sqlite,
                checkpoints,
                steps: [new Copy(source.events, sqlite.table('events'), modes)],
              }),
            ],
          }).run(),
        message,
      );
    }
    const forged = new Stream({
      name: 'events',
      jsonSchema: source.events.jsonSchema,
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
    await assert.rejects(
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination: sqlite,
            steps: [new Copy(forged, sqlite.table('forged-events'))],
          }),
        ],
      }).run(),
      /discovered catalog/,
    );
    assert.throws(() => source.events.file, /does not support file extraction/);
  },
);

test('Calendar rejects malformed records and preserves prior Markdown on native failures', async () => {
  await using stub = await StubEventKitHelper.create();
  const source = new AppleCalendarSource({
    store: new CalendarStore(stub.path),
    ...january,
  });
  const answer = (read: HelperRead) => stub.answer(eventsRead(january), read);
  answer({ documents: [occurrence()] });
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-calendar-'),
  );
  const markdown = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  const run = () =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: markdown,
          steps: [new Copy(source.events, markdown.file('events.md'))],
        }),
      ],
    }).run();

  await run();
  const path = join(markdown.path, 'events.md');
  const previous = await readFile(path, 'utf8');
  // Malformed documents on purpose: each must fail the read.
  const { name: _name, ...unnamed } = occurrence();
  for (const [document, message] of [
    [unnamed, /invalid events/],
    [{ ...occurrence(), body: { nested: true } }, /invalid events\.body/],
    [occurrence({ allDay: true, startDay: 'not-a-date' }), /invalid events/],
    [
      occurrence({ endMs: at('2025-01-02T05:00:00.000Z') }),
      /inconsistent event dates/,
    ],
    [
      occurrence({ recurrenceRules: [rule()], occurrenceMs: undefined }),
      /recurring event without an occurrence date/,
    ],
  ] as const) {
    // @ts-expect-error -- each document is malformed on purpose
    answer({ documents: [document] });
    await assert.rejects(run(), message);
    assert.equal(await readFile(path, 'utf8'), previous);
  }

  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const sqliteRun = () =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          steps: [new Copy(source.events, sqlite.table('events'))],
        }),
      ],
    }).run();
  answer({ documents: [occurrence()] });
  await sqliteRun();
  const malformed = { ...occurrence(), body: { nested: true } };
  // @ts-expect-error -- body is an object on purpose
  answer({ documents: [malformed] });
  await assert.rejects(sqliteRun(), /invalid events\.body/);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database.prepare('SELECT id, name FROM events').get(),
    },
    { id: eventId('item-1'), name: 'Synthetic standup' },
  );

  // Access failures as the helper reports them on stderr; it checks access
  // again after writing every document.
  for (const failure of [
    { stderr: 'CALENDAR_UNAVAILABLE: full access is required; status=2\n' },
    {
      documents: [occurrence()],
      stderr:
        'CALENDAR_UNAVAILABLE: access was revoked during execution; status=2\n',
    },
  ]) {
    answer(failure);
    await assert.rejects(
      run(),
      // Opening the read fails, so every copy reports it, as the run's cause.
      (error: unknown) =>
        error instanceof PipelineError &&
        error.cause instanceof Error &&
        error.cause.name === 'CalendarUnavailableError' &&
        /full Calendar access/.test(error.cause.message) &&
        Reflect.get(Object(error.cause.cause), 'stderr') === failure.stderr &&
        failureTypes(error).join() === 'config',
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }

  // A helper failure without a marker keeps its own error.
  answer({ stderr: 'native EventKit failure\n' });
  await assert.rejects(
    run(),
    (error: unknown) =>
      error instanceof PipelineError &&
      error.cause instanceof Error &&
      error.cause.name !== 'CalendarUnavailableError' &&
      /native EventKit failure/.test(error.cause.message) &&
      failureTypes(error).join() === 'system',
  );
  assert.equal(await readFile(path, 'utf8'), previous);
});

test(
  'Calendar snapshot incremental reconciles renamed, moved, added and removed events of a calendar on this Mac',
  { timeout: 180_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const [standup, review] = await calendar.add(
      {
        title: 'Standup',
        start: '2025-01-06T06:00:00.000Z',
        end: '2025-01-06T07:00:00.000Z',
      },
      {
        title: 'Review',
        start: '2025-01-07T06:00:00.000Z',
        end: '2025-01-07T07:00:00.000Z',
      },
    );
    assert.ok(standup && review);
    const source = liveSource(calendar);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
    });
    const markdown = new MarkdownDestination({
      path: join(scratch.path, 'markdown'),
    });
    const checkpoints = new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    });
    const snapshot = (id: string) =>
      ({
        id,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      }) as const;
    const toSQLite = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints,
          steps: [
            new Copy(source.events, sqlite.table('events'), snapshot('events')),
          ],
        }),
      ],
    });
    const toMarkdown = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: markdown,
          checkpoints,
          steps: [
            new Copy(
              source.events,
              markdown.folder('events', { title: 'name' }),
              snapshot('events-md'),
            ),
          ],
        }),
      ],
    });
    const run = async () =>
      [...(await toSQLite.run()), ...(await toMarkdown.run())].map(
        ({ count, deleted }) => ({ count, deleted }),
      );
    const loaded = async () => {
      using database = new DatabaseSync(sqlite.path, { readOnly: true });
      const folder = join(markdown.path, 'events');
      const titles = await Promise.all(
        (await readdir(folder))
          .filter((file) => file.endsWith('.md'))
          .map(
            async (file) =>
              /^## (.+)$/m.exec(
                await readFile(join(folder, file), 'utf8'),
              )?.[1],
          ),
      );
      return {
        events: database
          .prepare('SELECT id, name FROM events ORDER BY name')
          .all()
          .map((row) => ({ ...row })),
        markdown: titles.sort(),
      };
    };

    assert.deepEqual(await run(), [
      { count: 2, deleted: 0 },
      { count: 2, deleted: 0 },
    ]);
    // Standup is renamed, Review moves out of the window, Planning is new.
    await calendar.edit(standup, { title: 'Daily' });
    await calendar.edit(review, {
      start: '2025-02-03T06:00:00.000Z',
      end: '2025-02-03T07:00:00.000Z',
    });
    const [planning] = await calendar.add({
      title: 'Planning',
      start: '2025-01-08T06:00:00.000Z',
      end: '2025-01-08T07:00:00.000Z',
    });
    assert.ok(planning);
    assert.deepEqual(await run(), [
      { count: 2, deleted: 1 },
      { count: 2, deleted: 1 },
    ]);
    assert.deepEqual(await loaded(), {
      events: [
        { id: liveEventId(calendar, standup), name: 'Daily' },
        { id: liveEventId(calendar, planning), name: 'Planning' },
      ],
      markdown: ['Daily', 'Planning'],
    });
    assert.deepEqual(await run(), [
      { count: 0, deleted: 0 },
      { count: 0, deleted: 0 },
    ]);
  },
);

test('Calendar snapshot incremental reconciles attendees who join and leave, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  const source = new AppleCalendarSource({
    store: new CalendarStore(stub.path),
    ...january,
  });
  const event = (itemId: string, name: string, attendees: string[] = []) =>
    occurrence({
      calendarItemId: itemId,
      name,
      attendees: attendees.map((attendee) =>
        participant({
          name: attendee,
          url: `mailto:${attendee.toLowerCase()}@example.com`,
        }),
      ),
    });
  stub.answer(eventsRead(january), {
    documents: [event('e1', 'Standup', ['Ann', 'Bo']), event('e2', 'Review')],
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination: sqlite,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.attendees, sqlite.table('attendees'), {
            id: 'attendees',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const run = async () =>
    (await pipeline.run()).map(({ count, deleted }) => ({ count, deleted }));

  assert.deepEqual(await run(), [{ count: 2, deleted: 0 }]);
  // Bo left e1 and Cy is on the new e3: the positional child row vanishes
  // like any other key.
  stub.answer(eventsRead(january), {
    documents: [event('e1', 'Daily', ['Ann']), event('e3', 'Planning', ['Cy'])],
  });
  assert.deepEqual(await run(), [{ count: 1, deleted: 1 }]);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT id, name FROM attendees ORDER BY id')
      .all()
      .map((row) => Object.values(row).join(':')),
    [
      `${JSON.stringify([eventId('e1'), 'attendee', 0])}:Ann`,
      `${JSON.stringify([eventId('e3'), 'attendee', 0])}:Cy`,
    ],
  );
  assert.deepEqual(await run(), [{ count: 0, deleted: 0 }]);
});

test(
  'Calendar loads an occurrence of a calendar on this Mac that spans two of the helper read windows once',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const window = {
      startAt: '2024-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:00:00.000Z',
    };
    // The helper reads one-year windows, here split at 2024-12-31T00:00Z:
    // "Spanning" overlaps both, "Late" only the second.
    const [spanning, late] = await calendar.add(
      {
        title: 'Spanning',
        start: '2024-12-30T23:00:00.000Z',
        end: '2024-12-31T01:00:00.000Z',
      },
      {
        title: 'Late',
        start: '2025-06-02T06:00:00.000Z',
        end: '2025-06-02T07:00:00.000Z',
      },
    );
    assert.ok(spanning && late);
    const source = liveSource(calendar, window);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
    });
    const copy = new Copy(source.events, sqlite.table('events'), {
      id: 'events',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [copy],
        }),
      ],
    });

    assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
    assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT id, name FROM events ORDER BY name')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: liveEventId(calendar, late), name: 'Late' },
        { id: liveEventId(calendar, spanning), name: 'Spanning' },
      ],
    );
  },
);

test(
  'Calendar links alarms, recurrence rules and rule values to their occurrence',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    await calendar.add({
      title: 'Month end',
      start: '2025-01-31T06:00:00.000Z',
      end: '2025-01-31T07:00:00.000Z',
      alarms: [-600],
      rule: { frequency: 2, count: 3, daysOfTheMonth: [-1] },
    });
    const source = liveSource(calendar, {
      startAt: '2025-01-31T00:00:00.000Z',
      endAt: '2025-02-01T00:00:00.000Z',
    });

    const rows = await readRows(source, [
      source.events,
      source.alarms,
      source.recurrenceRules,
      source.recurrenceRuleValues,
    ]);

    const [event] = rows(source.events);
    const [alarm] = rows(source.alarms);
    const [rule] = rows(source.recurrenceRules);
    const [value] = rows(source.recurrenceRuleValues);
    assert.ok(event);
    assert.equal(alarm?.eventId, event.id);
    assert.equal(alarm?.relativeOffset, -600);
    assert.equal(rule?.eventId, event.id);
    assert.equal(rule?.occurrenceCount, 3);
    assert.equal(value?.component, 'daysOfTheMonth');
    assert.equal(value?.value, -1);
    assert.equal(value?.ruleId, rule?.id);
  },
);

test(
  'Calendar numbers alarms the same in every helper process, whatever order EventKit returns them in',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    await calendar.add({
      title: 'Alarmed',
      start: '2025-01-10T06:00:00.000Z',
      end: '2025-01-10T07:00:00.000Z',
      alarms: [-600, -1800, -3600, -7200],
    });
    const source = liveSource(calendar);
    const read = async () =>
      (await readRows(source, [source.alarms]))(source.alarms).map(
        ({ id, relativeOffset }) => [id, relativeOffset],
      );

    const reads = [await read(), await read(), await read()];

    assert.deepEqual(reads[1], reads[0]);
    assert.deepEqual(reads[2], reads[0]);
    assert.deepEqual(
      reads[0]?.map(([, offset]) => offset),
      [-1800, -3600, -600, -7200],
    );
  },
);

test('Calendar numbers attendees the same when EventKit reorders them or one replies, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  const source = new AppleCalendarSource({
    store: new CalendarStore(stub.path),
    ...january,
  });
  const attendee = (address: string, status: number) =>
    participant({ name: address, url: `mailto:${address}`, status });
  stub.answer(
    eventsRead(january),
    {
      documents: [
        occurrence({
          attendees: [
            attendee('a@example.com', 2),
            attendee('b@example.com', 1),
          ],
        }),
      ],
    },
    // b replied: a reply changes status, so status does not order attendees.
    {
      documents: [
        occurrence({
          attendees: [
            attendee('b@example.com', 2),
            attendee('a@example.com', 2),
          ],
        }),
      ],
    },
  );
  const read = async () =>
    (await readRows(source, [source.attendees]))(source.attendees);

  const before = await read();
  const after = await read();

  assert.deepEqual(
    after.map(({ id, url }) => [id, url]),
    before.map(({ id, url }) => [id, url]),
  );
  assert.deepEqual(
    after.map(({ status }) => status),
    [2, 2],
  );
});

test(
  'Calendar occurrence keys survive rescheduling',
  // EventKit gives a moved (detached) occurrence its own
  // calendarItemIdentifier; its key still names the series' item.
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const [weekly] = await calendar.add({
      title: 'Weekly',
      start: '2025-01-04T06:00:00.000Z',
      end: '2025-01-04T06:30:00.000Z',
      timeZone: 'Asia/Amman',
      rule: { frequency: 1, count: 3 },
    });
    assert.ok(weekly);
    const source = liveSource(calendar);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
    });
    const copy = new Copy(source.events, sqlite.table('events'), {
      id: 'events',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [copy],
        }),
      ],
    });
    const rescheduled = liveEventId(
      calendar,
      weekly,
      '2025-01-11T06:00:00.000Z',
    );

    assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
    // Moving one occurrence detaches it; its key keeps the time it replaces.
    await calendar.detach(
      weekly,
      '2025-01-11T06:00:00.000Z',
      '2025-01-12T08:00:00.000Z',
      '2025-01-12T08:30:00.000Z',
    );
    const [{ deleted } = { deleted: -1 }] = await pipeline.run();

    assert.equal(deleted, 0);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      {
        ...database
          .prepare('SELECT id, startAt, detached FROM events WHERE id = ?')
          .get(rescheduled),
      },
      { id: rescheduled, startAt: '2025-01-12T08:00:00.000Z', detached: 1 },
    );
    // The moved occurrence still shares the series' iCalendar UID.
    assert.equal(
      database
        .prepare(
          'SELECT count(DISTINCT externalId) AS n FROM events WHERE externalId IS NOT NULL',
        )
        .get()?.n,
      1,
    );
  },
);

test(
  'Calendar keeps the local dates of an all-day series read in a time zone ahead of UTC',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    // An all-day series on Amman days (UTC+3): a day starts at 21:00Z the
    // day before.
    await calendar.add({
      title: 'Holiday',
      allDay: true,
      start: '2024-12-31T21:00:00.000Z',
      end: '2025-01-01T20:59:59.000Z',
      rule: { frequency: 1, count: 3 },
    });
    const source = liveSource(calendar);
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Amman';
    let rows: Record<string, unknown>[];
    try {
      rows = (await readRows(source, [source.events]))(source.events);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }

    const day = rows.find(({ startDate }) => startDate === '2025-01-01');
    assert.ok(day);
    assert.equal(day.endDate, '2025-01-01');
    assert.equal(day.startAt, '2024-12-31T21:00:00.000Z');
    assert.equal(day.occurrenceAt, '2024-12-31T21:00:00.000Z');
    assert.equal(day.occurrenceDate, '2025-01-01');
    assert.equal(JSON.parse(String(day.id)).at(-1), '2025-01-01');
    // EventKit has no time zone or place for a floating all-day event.
    assert.deepEqual(
      [day.timeZone, day.locationTitle, day.radius],
      [null, null, null],
    );
  },
);

test(
  'iCalendar parsing unfolds lines, keeps parameters and vendor properties, and nests components',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const bytes = (...parts: (string | number[])[]) =>
      Buffer.concat(
        parts.map((part) =>
          typeof part === 'string' ? Buffer.from(part) : Buffer.from(part),
        ),
      );
    const ics = bytes(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n',
      'BEGIN:VTIMEZONE\r\nTZID:Asia/Amman\r\n',
      'BEGIN:STANDARD\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\n',
      'BEGIN:DAYLIGHT\r\nTZOFFSETTO:+0300\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n',
      'BEGIN:VEVENT\r\nUID:event-1\r\n',
      // A fold inside "é" (0xC3 0xA9) and a tab fold.
      'SUMMARY:Caf',
      [0xc3],
      '\r\n ',
      [0xa9],
      ' plan\r\n\tning\r\n',
      'ATTACH;FMTTYPE=application/pdf;FILENAME="a;b:c,d.pdf":https://example.com/a\r\n',
      'ATTENDEE;MEMBER="mailto:a@example.com","mailto:b@example.com";CN=Caret^^ ^\'Q^\' ^nline:mailto:c@example.com\r\n',
      'X-GOOGLE-CONFERENCE;X-PARAM=1:https://meet.google.com/abc\r\n',
      'DESCRIPTION:Raw\\, value\\nkept\r\n',
      'BEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\n',
      'END:VEVENT\r\nEND:VCALENDAR\r\n',
    );

    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    // The same export twice: once with CRLF line endings, once with bare LF.
    stub.answer(eventsRead(january, true), {
      documents: [
        { ...icsItem('windows', ''), ics: ics.toString('base64') },
        {
          ...icsItem('unix', ''),
          ics: Buffer.from(
            ics.toString('latin1').replaceAll('\r\n', '\n'),
            'latin1',
          ).toString('base64'),
        },
      ],
    });

    const rows = await readRows(source, [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
    ]);

    const of = (stream: Stream, item: string) =>
      rows(stream).filter(({ calendarItemId }) => calendarItemId === item);
    const components = of(source.icsComponents, 'windows');
    const named = new Map(components.map(({ id, name }) => [id, name]));
    assert.deepEqual(
      components
        .map(({ parentId, name }) => `${named.get(parentId) ?? '-'} > ${name}`)
        .sort(),
      [
        '- > VCALENDAR',
        'VCALENDAR > VEVENT',
        'VCALENDAR > VTIMEZONE',
        'VEVENT > VALARM',
        'VTIMEZONE > DAYLIGHT',
        'VTIMEZONE > STANDARD',
      ],
    );
    const properties = of(source.icsProperties, 'windows');
    const property = (name: string) => {
      const found = properties.find((candidate) => candidate.name === name);
      assert.ok(found, name);
      return {
        value: found.value,
        parameters: rows(source.icsParameters)
          .filter(({ propertyId }) => propertyId === found.id)
          .map(({ position, valuePosition, name, value }) => ({
            at: `${position}.${valuePosition}`,
            name,
            value,
          })),
      };
    };
    assert.equal(property('SUMMARY').value, 'Café planning');
    assert.deepEqual(property('ATTACH'), {
      value: 'https://example.com/a',
      parameters: [
        { at: '0.0', name: 'FMTTYPE', value: 'application/pdf' },
        { at: '1.0', name: 'FILENAME', value: 'a;b:c,d.pdf' },
      ],
    });
    assert.deepEqual(property('ATTENDEE').parameters, [
      { at: '0.0', name: 'MEMBER', value: 'mailto:a@example.com' },
      { at: '0.1', name: 'MEMBER', value: 'mailto:b@example.com' },
      { at: '1.0', name: 'CN', value: 'Caret^ "Q" \nline' },
    ]);
    assert.deepEqual(property('X-GOOGLE-CONFERENCE'), {
      value: 'https://meet.google.com/abc',
      parameters: [{ at: '0.0', name: 'X-PARAM', value: '1' }],
    });
    assert.equal(property('DESCRIPTION').value, 'Raw\\, value\\nkept');
    // Bare LF line endings load the same rows.
    for (const stream of [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
    ])
      assert.equal(
        JSON.stringify(of(stream, 'unix')).replaceAll('unix', 'item'),
        JSON.stringify(of(stream, 'windows')).replaceAll('windows', 'item'),
        stream.name,
      );
  },
);

test(
  'iCalendar parsing rejects malformed content instead of skipping it',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    // Injects malformed exports on purpose.
    const parse = (content: string | Buffer) => {
      stub.answer(eventsRead(january, true), {
        documents: [
          {
            ...icsItem('malformed', ''),
            ics: Buffer.from(content).toString('base64'),
          },
        ],
      });
      return readRows(source, [source.icsComponents]);
    };
    for (const [text, message] of [
      ['', /no VCALENDAR/],
      ['VERSION:2.0\r\n', /property outside a component/],
      ['BEGIN:VEVENT\r\nEND:VEVENT\r\n', /must start with BEGIN:VCALENDAR/],
      ['BEGIN:VCALENDAR\r\nVERSION 2.0\r\nEND:VCALENDAR\r\n', /missing colon/],
      ['BEGIN:VCALENDAR\r\n:2.0\r\nEND:VCALENDAR\r\n', /missing property name/],
      ['BEGIN:VCALENDAR\r\nX;=1:v\r\nEND:VCALENDAR\r\n', /invalid parameter/],
      [
        'BEGIN:VCALENDAR\r\nX;P="open:v\r\nEND:VCALENDAR\r\n',
        /unterminated quoted/,
      ],
      ['BEGIN:VCALENDAR\r\nX;P=a"b:v\r\nEND:VCALENDAR\r\n', /misplaced quote/],
      [
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VTODO\r\n',
        /END:VTODO does not close VEVENT/,
      ],
      ['BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n', /VEVENT is not closed/],
      [
        'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\n',
        /content after the calendar ended/,
      ],
    ] as const)
      await assert.rejects(parse(text), message);
    await assert.rejects(
      parse(
        Buffer.concat([
          Buffer.from('BEGIN:VCALENDAR\r\nX:'),
          Buffer.from([0xff]),
          Buffer.from('\r\nEND:VCALENDAR\r\n'),
        ]),
      ),
      /not valid UTF-8/,
    );
  },
);

const meetingICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:meeting@example.com',
  'DTSTAMP:20260924T100000Z',
  'SUMMARY:Review',
  'ATTACH;FMTTYPE=application/pdf;FILENAME=agenda.pdf:https://example.com/agenda',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

test(
  'an unchanged Calendar item writes nothing when the export lists its exceptions and alarms in another order',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    const exception = (day: string, alarms: readonly string[]) => [
      'BEGIN:VEVENT',
      'UID:series@example.com',
      `RECURRENCE-ID;TZID=Asia/Amman:202501${day}T090000`,
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@example.com',
      ...alarms.flatMap((alarm) => [
        'BEGIN:VALARM',
        `X-WR-ALARMUID:${alarm}`,
        'END:VALARM',
      ]),
      'END:VEVENT',
    ];
    // EventKit returns the same item with its siblings in a per-process order.
    const exported = (reversed: boolean) => {
      const order = <T>(values: T[]) => (reversed ? values.reverse() : values);
      return [
        'BEGIN:VCALENDAR',
        ...order([
          exception('08', order(['first-1', 'first-2'])),
          exception('15', order(['second-1', 'second-2'])),
        ]).flat(),
        'END:VCALENDAR',
        '',
      ].join('\r\n');
    };
    stub.answer(
      eventsRead(january, true),
      { documents: [icsItem('series', exported(false), true)] },
      { documents: [icsItem('series', exported(true), true)] },
    );
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'ics.sqlite'),
    });
    const streams = [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
    ];
    const run = () =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination: sqlite,
            checkpoints: new SQLiteCheckpointStore({
              path: join(scratch.path, 'state.sqlite'),
            }),
            steps: streams.map(
              (stream) =>
                new Copy(stream, sqlite.table(stream.name), {
                  id: stream.name,
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                }),
            ),
          }),
        ],
      }).run();

    const first = await run();
    const second = await run();

    assert.deepEqual(
      first.map(({ count }) => count),
      [7, 10, 4],
    );
    assert.deepEqual(
      second.map(({ count, deleted }) => [count, deleted]),
      [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    );
  },
);

test(
  'Calendar ICS streams load a series with a moved and a deleted occurrence, and link a single event, from a calendar on this Mac',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const [series, single] = await calendar.add(
      {
        title: 'Series',
        start: '2025-01-01T06:00:00.000Z',
        end: '2025-01-01T07:00:00.000Z',
        timeZone: 'Asia/Amman',
        rule: { frequency: 1, count: 4 },
      },
      {
        title: 'Single',
        start: '2025-01-20T06:00:00.000Z',
        end: '2025-01-20T07:00:00.000Z',
        timeZone: 'Asia/Amman',
      },
    );
    assert.ok(series && single);
    await calendar.detach(
      series,
      '2025-01-08T06:00:00.000Z',
      '2025-01-08T09:00:00.000Z',
      '2025-01-08T10:00:00.000Z',
    );
    // A deleted middle occurrence; deleting the last one shortens COUNT instead.
    await calendar.skip(series, '2025-01-15T06:00:00.000Z');
    const source = liveSource(calendar);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'ics.sqlite'),
    });
    const streams = [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
    ];

    await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          steps: streams.map(
            (stream) => new Copy(stream, sqlite.table(stream.name)),
          ),
        }),
      ],
    }).run();

    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    const events = (itemId: string) =>
      database
        .prepare(
          "SELECT recurrenceId, recurrenceIdTimeZone, eventId FROM icsComponents WHERE calendarItemId = ? AND name = 'VEVENT' ORDER BY recurrenceId",
        )
        .all(itemId)
        .map((row) => ({ ...row }));
    // Only a nonrecurring item's VEVENT names its occurrence; the moved
    // occurrence is its own VEVENT, keyed by the time it replaces.
    assert.deepEqual(events(single), [
      {
        recurrenceId: null,
        recurrenceIdTimeZone: null,
        eventId: liveEventId(calendar, single),
      },
    ]);
    assert.deepEqual(events(series), [
      { recurrenceId: null, recurrenceIdTimeZone: null, eventId: null },
      {
        recurrenceId: '20250108T090000',
        recurrenceIdTimeZone: 'Asia/Amman',
        eventId: null,
      },
    ]);
    const value = (name: string) =>
      database
        .prepare(
          'SELECT value FROM icsProperties WHERE calendarItemId = ? AND name = ?',
        )
        .get(series, name)?.value;
    assert.match(String(value('RRULE')), /FREQ=WEEKLY/);
    assert.equal(value('EXDATE'), '20250115T090000');
    // DTSTAMP is the export time, not event data.
    assert.equal(value('DTSTAMP'), undefined);
  },
);

test('Calendar ICS streams keep attachments and vendor properties, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  const source = new AppleCalendarSource({
    store: new CalendarStore(stub.path),
    ...january,
  });
  stub.answer(eventsRead(january, true), {
    documents: [icsItem('meeting', meetingICS)],
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'ics.sqlite'),
  });
  const markdown = new MarkdownDestination({
    path: join(scratch.path, 'md'),
  });
  const streams = [
    source.icsComponents,
    source.icsProperties,
    source.icsParameters,
  ];

  const counts = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination: sqlite,
        steps: streams.map(
          (stream) => new Copy(stream, sqlite.table(stream.name)),
        ),
      }),
    ],
  }).run();
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination: markdown,
        steps: [
          new Copy(source.icsProperties, markdown.file('ics-properties.md')),
        ],
      }),
    ],
  }).run();

  assert.deepEqual(
    counts.map(({ count }) => count),
    [2, 6, 2],
  );
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT name, uid, eventId FROM icsComponents ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { name: 'VCALENDAR', uid: null, eventId: null },
      {
        name: 'VEVENT',
        uid: 'meeting@example.com',
        eventId: eventId('meeting'),
      },
    ],
  );
  const value = (name: string) =>
    database.prepare('SELECT value FROM icsProperties WHERE name = ?').get(name)
      ?.value;
  assert.equal(
    value('X-GOOGLE-CONFERENCE'),
    'https://meet.google.com/abc-defg-hij',
  );
  assert.equal(value('X-MICROSOFT-CDO-BUSYSTATUS'), 'BUSY');
  assert.equal(value('ATTACH'), 'https://example.com/agenda');
  assert.equal(value('DTSTAMP'), undefined);
  assert.deepEqual(
    database
      .prepare(
        "SELECT p.name AS property, q.name, q.value FROM icsParameters q JOIN icsProperties p ON p.id = q.propertyId WHERE p.name = 'ATTACH' ORDER BY q.position",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { property: 'ATTACH', name: 'FMTTYPE', value: 'application/pdf' },
      { property: 'ATTACH', name: 'FILENAME', value: 'agenda.pdf' },
    ],
  );
  assert.match(
    await readFile(join(markdown.path, 'ics-properties.md'), 'utf8'),
    /X\\-GOOGLE\\-CONFERENCE/,
  );
});

test(
  'Calendar ICS rejects exports without events and reports a missing private export',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    // Injects an export without events on purpose.
    // Only a read with the private ICS export is answered.
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('empty', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')],
    });
    await assert.rejects(
      readRows(source, [source.icsComponents]),
      /returned no VEVENT for saved item empty/,
    );
    // The helper's missing-export failure.
    const stderr =
      'CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version\n';
    stub.answer(eventsRead(january, true), { stderr });
    // Every ICS stream must reach the export, alone or not.
    for (const stream of [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
      source.icsAttachments,
    ])
      await assert.rejects(readRows(source, [stream]), (error) => {
        assert.ok(error instanceof CalendarIcsUnavailableError);
        assert.ok(error.cause instanceof IcsExportUnavailableError);
        assert.equal(Reflect.get(Object(error.cause.cause), 'stderr'), stderr);
        return true;
      });
  },
);

test(
  'Calendar ICS snapshots delete a removed property with its parameters',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('meeting', meetingICS)],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'ics.sqlite'),
    });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [source.icsProperties, source.icsParameters].map(
            (stream) =>
              new Copy(stream, sqlite.table(stream.name), {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              }),
          ),
        }),
      ],
    });

    await pipeline.run();
    // The attachment is gone: everything after it shifts one position.
    stub.answer(eventsRead(january, true), {
      documents: [
        icsItem('meeting', meetingICS.replace(/ATTACH[^\r]*\r\n/, '')),
      ],
    });
    assert.deepEqual(
      (await pipeline.run()).map(({ count, deleted }) => ({ count, deleted })),
      [
        { count: 2, deleted: 1 },
        { count: 0, deleted: 2 },
      ],
    );
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM icsProperties WHERE name = 'ATTACH'",
        )
        .get()?.n,
      0,
    );
    assert.equal(
      database.prepare('SELECT count(*) AS n FROM icsParameters').get()?.n,
      0,
    );
  },
);

const attachmentsICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:files@example.com',
  'ATTACH;FMTTYPE=image/png;VALUE=URI;X-APPLE-FILENAME=diagram.png:https://drive.google.com/file/d/abc/view',
  'ATTACH;VALUE=URI;X-APPLE-FILENAME=private.pdf:https://drive.google.com/file/d/denied/view',
  `ATTACH;FMTTYPE=text/plain;ENCODING=BASE64;VALUE=BINARY:${Buffer.from('inline bytes').toString('base64')}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

test(
  'Calendar attachment files come from the fetcher, inline data, or stay null when unreachable',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const fetched: string[] = [];
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
      attachments: async ({ uri, filename, formatType }, path) => {
        fetched.push(`${filename}:${formatType}`);
        if (uri.includes('denied')) return false;
        await writeFile(path, `bytes of ${filename}`);
        return true;
      },
    });
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('files', attachmentsICS)],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-att-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'a.sqlite'),
    });
    const copy = new Copy(
      source.icsAttachments,
      sqlite.table('attachments', (c) => [
        c.text('filename'),
        c.text('formatType'),
        c.boolean('inline'),
        c.blob('bytes').from(source.icsAttachments.file),
      ]),
    );

    assert.deepEqual(
      await new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination: sqlite,
            steps: [copy],
          }),
        ],
      }).run(),
      [{ copy, count: 3, deleted: 0 }],
    );
    // Inline content never reaches the fetcher.
    assert.deepEqual(fetched, ['diagram.png:image/png', 'private.pdf:null']);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare(
          `SELECT filename, formatType, inline, (SELECT c.bytes FROM ${chunkTable('attachments', 'bytes')} c WHERE c.file = a.bytes AND c.n = 0) AS bytes FROM attachments a ORDER BY a.rowid`,
        )
        .all()
        .map(({ bytes, ...row }) => {
          assert.ok(bytes === null || bytes instanceof Uint8Array);
          return {
            ...row,
            bytes: bytes === null ? null : Buffer.from(bytes).toString(),
          };
        }),
      [
        {
          filename: 'diagram.png',
          formatType: 'image/png',
          inline: 0,
          bytes: 'bytes of diagram.png',
        },
        { filename: 'private.pdf', formatType: null, inline: 0, bytes: null },
        {
          filename: null,
          formatType: 'text/plain',
          inline: 1,
          bytes: 'inline bytes',
        },
      ],
    );
  },
);

test(
  'Calendar attachment files need a fetcher, but attachment metadata does not',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    });
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('files', attachmentsICS)],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-att-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'a.sqlite'),
    });
    const run = (copy: Copy<SQLiteTable>) =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination: sqlite,
            steps: [copy],
          }),
        ],
      }).run();

    const metadata = new Copy(source.icsAttachments, sqlite.table('metadata'));
    assert.deepEqual(await run(metadata), [
      { copy: metadata, count: 3, deleted: 0 },
    ]);
    await assert.rejects(
      run(
        new Copy(
          source.icsAttachments,
          sqlite.table('files', (c) => [
            c.text('uri'),
            c.blob('bytes').from(source.icsAttachments.file),
          ]),
        ),
      ),
      /requires an attachments fetcher/,
    );
  },
);

test(
  'Calendar incremental attachment copies fetch only new attachments and delete removed ones',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    let fetches = 0;
    const source = new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
      attachments: async (_attachment, path) => {
        fetches++;
        await writeFile(path, 'bytes');
        return true;
      },
    });
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('files', attachmentsICS)],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-att-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'a.sqlite'),
    });
    const copy = new Copy(
      source.icsAttachments,
      sqlite.table('attachments', (c) => [
        c.text('id').notNull(),
        c.blob('bytes').from(source.icsAttachments.file),
      ]),
      {
        id: 'attachments',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      },
    );
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 's.sqlite'),
          }),
          steps: [copy],
        }),
      ],
    });

    assert.deepEqual(await pipeline.run(), [{ copy, count: 3, deleted: 0 }]);
    assert.equal(fetches, 2);
    assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
    assert.equal(fetches, 2);
    // The inline attachment is removed; the remote ones keep their positions.
    stub.answer(eventsRead(january, true), {
      documents: [
        icsItem(
          'files',
          attachmentsICS.replace(/ATTACH;FMTTYPE=text\/plain[^\r]*\r\n/, ''),
        ),
      ],
    });
    assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 1 }]);
    assert.equal(fetches, 2);
  },
);

type GoogleCall = { url: string; headers?: Readonly<Record<string, string>> };

// Plays Google's APIs at the requester seam and records each request.
function googleRecorder(reply: (call: GoogleCall) => unknown) {
  const calls: GoogleCall[] = [];
  const requester: GoogleRequester = {
    async request({ url, headers }) {
      const call: GoogleCall = { url, ...(headers ? { headers } : {}) };
      calls.push(call);
      return { data: reply(call) };
    },
  };
  return { calls, requester };
}

// Built as gaxios builds one: from a response whose body it has already read
// into `data`. GaxiosError drops `data` from a response with an unread body.
function googleError(status: number, data: unknown = {}) {
  const config = {
    url: new URL('https://www.googleapis.com/'),
    headers: new Headers(),
  };
  const response = new Response(JSON.stringify(data), { status });
  void response.text();
  return new GaxiosError(
    `Request failed with status code ${status}`,
    config,
    Object.assign(response, { config, data }),
  );
}

// One Calendar item whose ATTACH lines point into Google, as Calendar stores
// Drive files and Gmail attachments.
const googleAttachmentsICS = (uris: readonly string[]) =>
  [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:google@example.com',
    ...uris.map((uri) => `ATTACH:${uri}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

// Loads Calendar's attachment files through the Google fetcher the app
// composes, and returns each URI's saved bytes, or null when none were saved.
async function googleAttachmentFiles(
  store: CalendarStore,
  requester: GoogleRequester,
  directory: string,
) {
  mkdirSync(directory, { recursive: true });
  const source = new AppleCalendarSource({
    store,
    ...january,
    attachments: googleCalendarAttachments(requester),
  });
  const destination = new SQLiteDestination({
    path: join(directory, 'calendar.sqlite'),
  });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            source.icsAttachments,
            destination.table('attachments', (c) => [
              c.text('uri'),
              c
                .text('attachmentRef')
                .from(source.icsAttachments.file.store(files)),
            ]),
          ),
        ],
      }),
    ],
  }).run();
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const saved: Record<string, Uint8Array | null> = {};
  for (const { uri, attachmentRef } of database
    .prepare('SELECT uri, attachmentRef FROM attachments ORDER BY rowid')
    .all())
    saved[String(uri)] =
      attachmentRef === null
        ? null
        : new Uint8Array(await readFile(String(attachmentRef)));
  return saved;
}

test(
  'Calendar attachments download Drive files and Gmail parts, and report unreachable ones',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const pdf = new TextEncoder().encode('%PDF-1.7').buffer;
    const { requester } = googleRecorder(({ url }) => {
      if (url.includes('/files/image?fields')) return { mimeType: 'image/png' };
      if (url.includes('/files/image?alt=media')) return png;
      if (url.includes('/files/doc?fields'))
        return { mimeType: 'application/vnd.google-apps.document' };
      if (url.includes('/files/doc/export?mimeType=application%2Fpdf'))
        return pdf;
      if (url.includes('/files/private'))
        throw googleError(403, {
          error: { errors: [{ reason: 'forbidden' }] },
        });
      if (url.includes('/files/gone')) throw googleError(404);
      if (url.includes('/messages/m1?format=full'))
        return {
          id: 'm1',
          payload: {
            partId: '',
            parts: [
              { partId: '0', body: { size: 3 } },
              {
                partId: '1',
                filename: 'a.pdf',
                body: { attachmentId: 'att-1' },
              },
            ],
          },
        };
      if (url.includes('/messages/m1/attachments/att-1'))
        return { data: Buffer.from('mail bytes').toString('base64url') };
      if (url.includes('/messages/t1?format=full')) throw googleError(404);
      if (url.includes('/threads/t1?format=full'))
        return {
          messages: [
            {
              id: 'm2',
              payload: {
                parts: [
                  {
                    partId: '2',
                    body: { data: Buffer.from('inline').toString('base64url') },
                  },
                ],
              },
            },
          ],
        };
      throw new Error(`unexpected ${url}`);
    });
    const expected = {
      'https://drive.google.com/file/d/image/view?usp=drive_web':
        new Uint8Array(png),
      'https://drive.google.com/open?id=doc&authuser=0': new Uint8Array(pdf),
      '?view=att&th=m1&attid=0.1&disp=safe&zw': new Uint8Array(
        Buffer.from('mail bytes'),
      ),
      '?view=att&th=t1&attid=0.2&disp=safe&zw': new Uint8Array(
        Buffer.from('inline'),
      ),
      'https://drive.google.com/file/d/private/view': null,
      'https://drive.google.com/file/d/gone/view': null,
      'https://example.com/file.pdf': null,
      '?view=att&th=m1&attid=0.9': null,
    };
    stub.answer(eventsRead(january, true), {
      documents: [
        icsItem('google', googleAttachmentsICS(Object.keys(expected))),
      ],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-att-'));

    const saved = await googleAttachmentFiles(
      new CalendarStore(stub.path),
      requester,
      scratch.path,
    );

    assert.deepEqual(saved, expected);
  },
);

test(
  'Calendar attachment downloads fail on a disabled API, a missing scope or a server error',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    stub.answer(eventsRead(january, true), {
      documents: [
        icsItem(
          'google',
          googleAttachmentsICS(['https://drive.google.com/file/d/abc/view']),
        ),
      ],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-err-'));
    for (const [index, [error, message]] of (
      [
        [
          googleError(403, {
            error: { errors: [{ reason: 'accessNotConfigured' }] },
          }),
          /403/,
        ],
        [
          googleError(403, {
            error: {
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          }),
          /403/,
        ],
        [googleError(500), /500/],
      ] as const
    ).entries()) {
      const { requester } = googleRecorder(() => {
        throw error;
      });
      await assert.rejects(
        googleAttachmentFiles(
          new CalendarStore(stub.path),
          requester,
          join(scratch.path, String(index)),
        ),
        (failure: unknown) =>
          failure instanceof PipelineError &&
          failure.cause instanceof Error &&
          message.test(failure.cause.message),
      );
    }
  },
);

test(
  'a rate-limited Drive download rejects instead of loading no file',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    stub.answer(eventsRead(january, true), {
      documents: [
        icsItem(
          'google',
          googleAttachmentsICS(['https://drive.google.com/file/d/abc/view']),
        ),
      ],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-rate-'));
    for (const reason of ['userRateLimitExceeded', 'rateLimitExceeded']) {
      const { requester } = googleRecorder(() => {
        throw googleError(403, { error: { errors: [{ reason }] } });
      });
      await assert.rejects(
        googleAttachmentFiles(
          new CalendarStore(stub.path),
          requester,
          join(scratch.path, reason),
        ),
        (failure: unknown) =>
          failure instanceof PipelineError &&
          failure.cause instanceof Error &&
          /403/.test(failure.cause.message),
      );
    }
  },
);

test(
  'a Drive shortcut downloads its target, and a link-shared file sends its resource key',
  {
    concurrency: false,
  },
  async () => {
    await using stub = await StubEventKitHelper.create();
    const bytes = new TextEncoder().encode('target bytes').buffer;
    const { calls, requester } = googleRecorder(({ url }) => {
      if (url.includes('/files/shortcut?fields'))
        return {
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutDetails: { targetId: 'target', targetResourceKey: 'key-2' },
        };
      if (url.includes('/files/target?fields'))
        return { mimeType: 'image/png' };
      if (url.includes('/files/target?alt=media')) return bytes;
      if (url.includes('/files/shared?fields'))
        return { mimeType: 'image/png' };
      if (url.includes('/files/shared?alt=media')) return bytes;
      throw new Error(`unexpected ${url}`);
    });
    const shortcut = 'https://drive.google.com/file/d/shortcut/view';
    const shared =
      'https://drive.google.com/file/d/shared/view?resourcekey=key-1';
    stub.answer(eventsRead(january, true), {
      documents: [icsItem('google', googleAttachmentsICS([shortcut, shared]))],
    });
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-sc-'));

    const saved = await googleAttachmentFiles(
      new CalendarStore(stub.path),
      requester,
      scratch.path,
    );

    assert.deepEqual(saved, {
      [shortcut]: new Uint8Array(bytes),
      [shared]: new Uint8Array(bytes),
    });
    assert.deepEqual(
      calls
        .filter(({ url }) => !url.includes('/files/shortcut'))
        .map(({ headers }) => headers?.['X-Goog-Drive-Resource-Keys']),
      ['target/key-2', 'target/key-2', 'shared/key-1', 'shared/key-1'],
    );
  },
);

test(
  'Calendar reads as documented views where occurrences keep their own identity and series rows do not multiply them',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const [series] = await calendar.add({
      title: 'Series',
      start: '2025-01-01T09:00:00.000Z',
      end: '2025-01-01T10:00:00.000Z',
      rule: { frequency: 1, count: 3 },
    });
    assert.ok(series);
    // A moved occurrence gives the series' export a second VEVENT.
    await calendar.detach(
      series,
      '2025-01-15T09:00:00.000Z',
      '2025-01-15T11:00:00.000Z',
      '2025-01-15T12:00:00.000Z',
    );
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'cal-marts-'));
    // The warehouse loads every stream, ICS included, from one read.
    const imported = await appleImport(
      liveSource(calendar),
      join(scratch.path, 'import'),
    );
    await imported.load();

    // One documented view per stream, named after the stream.
    assert.deepEqual(imported.views(), [
      'accounts',
      'alarms',
      'attendees',
      'calendars',
      'events',
      'ics_attachments',
      'ics_components',
      'ics_parameters',
      'ics_properties',
      'recurrence_rule_values',
      'recurrence_rules',
    ]);
    // Each occurrence is keyed by the time it replaces, the moved one too.
    assert.deepEqual(
      imported
        .read('SELECT "eventId" FROM events ORDER BY "occurrenceAt"')
        .map(({ eventId }) => JSON.parse(String(eventId)).at(-1)),
      [
        '2025-01-01T09:00:00.000Z',
        '2025-01-08T09:00:00.000Z',
        '2025-01-15T09:00:00.000Z',
      ],
    );
    // Series components relate at (calendarId, calendarItemId): joining them
    // row by row would repeat each occurrence, so aggregate them first.
    assert.deepEqual(
      imported
        .read(
          `
        SELECT count(*) AS occurrences, sum(c.components) AS components
        FROM events e JOIN (
          SELECT "calendarId", "calendarItemId", count(*) AS components
          FROM ics_components WHERE name = 'VEVENT' AND "eventId" IS NULL
          GROUP BY 1, 2) c USING ("calendarId", "calendarItemId")`,
        )
        .map((found) => ({ ...found })),
      [{ occurrences: 3, components: 6 }],
    );
  },
);

test('Calendar views join each occurrence to its own attendees, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  const standup = (day: string) =>
    occurrence({
      calendarItemId: 'series',
      startMs: at(`2025-01-${day}T09:00:00.000Z`),
      endMs: at(`2025-01-${day}T10:00:00.000Z`),
      startDay: `2025-01-${day}`,
      endDay: `2025-01-${day}`,
      occurrenceMs: at(`2025-01-${day}T09:00:00.000Z`),
      occurrenceDay: `2025-01-${day}`,
      attendees: [participant()],
      recurrenceRules: [rule()],
    });
  // The warehouse reads every stream, so the private ICS export is asked for.
  stub.answer(eventsRead(january, true), {
    documents: [account(), calendar(), standup('01'), standup('08')],
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'cal-marts-'));
  const imported = await appleImport(
    new AppleCalendarSource({
      store: new CalendarStore(stub.path),
      ...january,
    }),
    join(scratch.path, 'import'),
  );
  await imported.load();

  assert.deepEqual(
    imported
      .read(
        `
        SELECT e."eventId", (SELECT count(*) FROM attendees a WHERE a."eventId" = e."eventId") AS attendees
        FROM events e ORDER BY e."startAt"`,
      )
      .map((found) => ({ ...found })),
    [
      {
        eventId: eventId('series', '2025-01-01T09:00:00.000Z'),
        attendees: 1,
      },
      {
        eventId: eventId('series', '2025-01-08T09:00:00.000Z'),
        attendees: 1,
      },
    ],
  );
});

test(
  'Calendar scope keeps only the chosen calendar of this Mac and its account',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchCalendar.create();
    if (calendar === null) return t.skip('no account accepts a new calendar');
    const scoped = liveSource(calendar);
    const missing = new AppleCalendarSource({
      store: new CalendarStore(helper),
      ...january,
      scope: { collectionIds: [`missing-${randomUUID()}`] },
    });

    const rows = await readRows(scoped, [scoped.accounts, scoped.calendars]);
    const none = await readRows(missing, [missing.accounts, missing.calendars]);

    const [calendarRow] = rows(scoped.calendars);
    assert.deepEqual(
      rows(scoped.calendars).map(({ id }) => id),
      [calendar.id],
    );
    assert.deepEqual(
      rows(scoped.accounts).map(({ id }) => id),
      [calendarRow?.accountId],
    );
    assert.deepEqual(
      [none(missing.accounts), none(missing.calendars)],
      [[], []],
    );
  },
);

test(
  'Calendar watch confirms its subscription through the native helper and stops it on abort or return',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    const source = new AppleCalendarSource({
      store: new CalendarStore(helper),
      ...january,
    });
    const helperRunning = () =>
      execFile('pgrep', [
        '-P',
        String(process.pid),
        '-f',
        `${helper} watch events`,
      ]);
    const controller = new AbortController();
    try {
      const watching = source.watch({
        streams: [source.events],
        signal: controller.signal,
      });
      const subscribed = await watching.next().catch((error: unknown) => {
        if (error instanceof Error && error.name === 'CalendarUnavailableError')
          return null;
        throw error;
      });
      if (subscribed === null) return t.skip('no Calendar access');
      assert.deepEqual(subscribed, { value: [source.events], done: false });
      const pending = watching.next();
      controller.abort();
      assert.deepEqual(await pending, { value: undefined, done: true });
      await assert.rejects(helperRunning(), { code: 1 });

      // A consumer that stops iterating also stops the helper.
      const stopped = source.watch({
        streams: [source.events],
        signal: new AbortController().signal,
      });
      assert.deepEqual(await stopped.next(), {
        value: [source.events],
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
  },
);

test(
  'Calendar reads this Mac’s event store into SQLite through the native helper',
  { timeout: 300_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-eventkit-live-'),
    );
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const source = new AppleCalendarSource({
      store: new CalendarStore(helper),
      startAt: new Date(now - 7 * day).toISOString(),
      endAt: new Date(now + 7 * day).toISOString(),
    });
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'calendar.sqlite'),
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
          error.cause.name === 'CalendarUnavailableError'
        )
          return null;
        throw error;
      });
    if (outcomes === null) return t.skip('no Calendar access');

    assert.equal(outcomes.length, streams.length);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    for (const { copy, count } of outcomes)
      assert.equal(
        database
          .prepare(`SELECT count(*) AS count FROM "${copy.from.name}"`)
          .get()?.count,
        count,
        copy.from.name,
      );
  },
);

test('Calendar declares its event window as the coverage of event streams, and none for its listings', async () => {
  const startAt = '2020-01-01T00:00:00.000Z';
  const endAt = '2021-01-01T00:00:00.000Z';
  // No helper exists here: coverage must not need one.
  await using missing = await mkdtempDisposable(join(tmpdir(), 'no-helper-'));
  const calendar = new AppleCalendarSource({
    store: new CalendarStore(join(missing.path, 'eventkit-helper')),
    startAt,
    endAt,
  });

  const { streams } = await calendar.discover();

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
});
