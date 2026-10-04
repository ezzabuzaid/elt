import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import {
  type AccountDocument,
  type DateComponentsDocument,
  type ParticipantDocument,
  type ReminderDocument,
  RemindersStore,
} from '@workspace/macos-eventkit';
import {
  type HelperCalendarDocument,
  type HelperRead,
  type HelperRequest,
  StubEventKitHelper,
} from '@workspace/macos-eventkit/test';

import { AppleRemindersSource } from './apple-reminders-source.ts';

const execFile = promisify(execFileCallback);

// The helper @workspace/macos-eventkit compiles, which the live tests read
// this Mac's reminders through.
const helper = fileURLToPath(
  new URL('eventkit-helper', import.meta.resolve('@workspace/macos-eventkit')),
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

// Documents the eventkit helper wrote on a Mac, read with TZ=UTC from a
// synthetic reminders list made for the recording; ids are renamed and every
// value is synthetic. The stub tests start from them for what EventKit cannot
// produce; an override of undefined leaves the field out of the JSON line, as
// the helper leaves out a nil.
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
};

// No recorded reminder had a participant, so this one is written from the
// helper's ParticipantDocument fields.
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

const reminder = (
  overrides: Partial<ReminderDocument> = {},
): ReminderDocument => ({ ...recordedReminders.buyMilk, ...overrides });

const remindersRead: HelperRequest = { entity: 'reminders' };

// A date component set a live test writes; EventKit fills in the Gregorian
// calendar and era.
type ScratchComponents = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
  readonly timeZone?: string;
};

// One reminder a live test creates.
type ScratchReminder = {
  readonly title: string;
  readonly notes?: string;
  readonly url?: string;
  readonly priority?: number;
  readonly completed?: boolean;
  readonly start?: ScratchComponents;
  readonly due?: ScratchComponents;
  // A UTC instant.
  readonly absoluteAlarm?: string;
  readonly locationAlarm?: {
    readonly title: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly radius: number;
    // EKAlarmProximity: 1 entering, 2 leaving.
    readonly proximity: number;
  };
  readonly rule?: {
    // EKRecurrenceFrequency: 3 yearly.
    readonly frequency: number;
    readonly interval: number;
    readonly count: number;
    readonly daysOfTheWeek?: readonly {
      readonly day: number;
      readonly weekNumber: number;
    }[];
    readonly daysOfTheMonth?: readonly number[];
    readonly monthsOfTheYear?: readonly number[];
    readonly weeksOfTheYear?: readonly number[];
    readonly daysOfTheYear?: readonly number[];
    readonly setPositions?: readonly number[];
  };
};

// A temporary reminders list in this Mac's EventKit store, in the first
// account that accepts one (CalDAV before Exchange), deleted with the test.
// Accounts sync, so it reaches the server until then.
class ScratchList implements AsyncDisposable {
  readonly id: string;

  private constructor(id: string) {
    this.id = id;
  }

  // Null when no account on this Mac accepts a new reminders list.
  static async create(): Promise<ScratchList | null> {
    try {
      return new ScratchList(await ScratchList.#run('create', {}));
    } catch (error) {
      if (
        String(Reflect.get(Object(error), 'stderr')).includes(
          ScratchList.#noAccount,
        )
      )
        return null;
      throw error;
    }
  }

  // The calendar item identifier of each reminder, in order.
  async add(...reminders: readonly ScratchReminder[]): Promise<string[]> {
    return JSON.parse(
      await ScratchList.#run('add', { listId: this.id, reminders }),
    );
  }

  async rename(itemId: string, title: string): Promise<void> {
    await ScratchList.#run('rename', { itemId, title });
  }

  async remove(itemId: string): Promise<void> {
    await ScratchList.#run('remove', { itemId });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await ScratchList.#run('delete', { listId: this.id });
  }

  static async #run(mode: string, payload: object): Promise<string> {
    const { stdout } = await execFile('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      ScratchList.#script,
      mode,
      JSON.stringify(payload),
    ]);
    return stdout.trim();
  }

  static readonly #noAccount = 'No EventKit account accepts a new list';

  static readonly #script = `
ObjC.import('EventKit');
function run([mode, payload]) {
  const spec = JSON.parse(payload);
  const store = $.EKEventStore.alloc.init;
  const list = () => store.calendarWithIdentifier(spec.listId);
  const gregorian = $.NSCalendar.calendarWithIdentifier($.NSCalendarIdentifierGregorian);
  const components = (values) => {
    const set = $.NSDateComponents.alloc.init;
    set.calendar = gregorian;
    if (values.timeZone !== undefined)
      set.timeZone = $.NSTimeZone.timeZoneWithName(values.timeZone);
    for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second'])
      if (values[key] !== undefined) set[key] = values[key];
    return set;
  };
  const array = (values) => (values === undefined ? $() : $(values));
  const save = (reminder) => {
    if (!store.saveReminderCommitError(reminder, true, null)) throw new Error('Reminder not saved');
  };
  if (mode === 'create') {
    const created = $.EKCalendar.calendarForEntityTypeEventStore(1, store);
    created.title = 'context-compiler test ' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    const sources = ObjC.unwrap(store.sources).toSorted(
      (a, b) => (Number(a.sourceType) === 2 ? 0 : 1) - (Number(b.sourceType) === 2 ? 0 : 1),
    );
    if (!sources.some((source) => {
      created.source = source;
      return store.saveCalendarCommitError(created, true, null);
    })) throw new Error('${ScratchList.#noAccount}');
    return ObjC.unwrap(created.calendarIdentifier);
  }
  if (mode === 'delete') {
    if (!ObjC.unwrap(list().title).startsWith('context-compiler test '))
      throw new Error('Refusing to delete a list this test did not create');
    if (!store.removeCalendarCommitError(list(), true, null))
      throw new Error('Could not delete the test list');
    return '';
  }
  if (mode === 'add')
    return JSON.stringify(spec.reminders.map((item) => {
      const reminder = $.EKReminder.reminderWithEventStore(store);
      reminder.calendar = list();
      reminder.title = item.title;
      if (item.notes !== undefined) reminder.notes = item.notes;
      if (item.url !== undefined) reminder.URL = $.NSURL.URLWithString(item.url);
      if (item.priority !== undefined) reminder.priority = item.priority;
      if (item.start !== undefined) reminder.startDateComponents = components(item.start);
      if (item.due !== undefined) reminder.dueDateComponents = components(item.due);
      if (item.completed === true) reminder.completed = true;
      if (item.absoluteAlarm !== undefined)
        reminder.addAlarm($.EKAlarm.alarmWithAbsoluteDate(
          $.NSDate.dateWithTimeIntervalSince1970(Date.parse(item.absoluteAlarm) / 1000)));
      if (item.locationAlarm !== undefined) {
        const alarm = $.EKAlarm.alarmWithRelativeOffset(0);
        const place = $.EKStructuredLocation.locationWithTitle(item.locationAlarm.title);
        // ObjC.import does not expose CoreLocation's classes to JXA.
        place.geoLocation = $.NSClassFromString('CLLocation').alloc.initWithLatitudeLongitude(
          item.locationAlarm.latitude, item.locationAlarm.longitude);
        place.radius = item.locationAlarm.radius;
        alarm.structuredLocation = place;
        alarm.proximity = item.locationAlarm.proximity;
        reminder.addAlarm(alarm);
      }
      if (item.rule !== undefined)
        reminder.addRecurrenceRule(
          $.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalDaysOfTheWeekDaysOfTheMonthMonthsOfTheYearWeeksOfTheYearDaysOfTheYearSetPositionsEnd(
            item.rule.frequency, item.rule.interval,
            item.rule.daysOfTheWeek === undefined ? $() : $(item.rule.daysOfTheWeek.map(
              (day) => $.EKRecurrenceDayOfWeek.dayOfWeekWeekNumber(day.day, day.weekNumber))),
            array(item.rule.daysOfTheMonth), array(item.rule.monthsOfTheYear),
            array(item.rule.weeksOfTheYear), array(item.rule.daysOfTheYear),
            array(item.rule.setPositions),
            $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(item.rule.count),
          ),
        );
      save(reminder);
      return ObjC.unwrap(reminder.calendarItemIdentifier);
    }));
  if (mode === 'rename') {
    const reminder = store.calendarItemWithIdentifier(spec.itemId);
    reminder.title = spec.title;
    save(reminder);
    return '';
  }
  if (mode === 'remove') {
    if (!store.removeReminderCommitError(store.calendarItemWithIdentifier(spec.itemId), true, null))
      throw new Error('Reminder not removed');
    return '';
  }
  throw new Error('Unknown mode ' + mode);
}`;
}

// A Reminders source over one scratch list, read by the compiled helper.
const liveSource = (list: ScratchList) =>
  new AppleRemindersSource({
    store: new RemindersStore(helper),
    scope: { collectionIds: [list.id] },
  });

test(
  'Reminders extracts every stream of a list on this Mac into SQLite and Markdown',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchList.create();
    if (list === null) return t.skip('no account accepts a new list');
    await list.add(
      { title: 'undated' },
      { title: 'date-only', due: { year: 2025, month: 1, day: 3 } },
      {
        title: 'timed',
        notes: 'Live notes',
        url: 'https://example.com/reminder',
        priority: 1,
        due: {
          year: 2025,
          month: 1,
          day: 2,
          hour: 8,
          minute: 45,
          second: 0,
          timeZone: 'Asia/Amman',
        },
        absoluteAlarm: '2025-01-02T05:45:00.000Z',
        locationAlarm: {
          title: 'Live place',
          latitude: 31.95,
          longitude: 35.93,
          radius: 100,
          proximity: 1,
        },
        rule: {
          frequency: 3,
          interval: 2,
          count: 5,
          daysOfTheWeek: [{ day: 2, weekNumber: -1 }],
          daysOfTheMonth: [-1],
          monthsOfTheYear: [9],
          weeksOfTheYear: [1],
          daysOfTheYear: [42],
          setPositions: [-1],
        },
      },
      {
        title: 'floating',
        start: { year: 2025, month: 1, day: 3, hour: 9, minute: 15 },
      },
      {
        title: 'completed',
        priority: 5,
        completed: true,
        due: { year: 2025, month: 1, day: 3 },
      },
    );
    const source = liveSource(list);
    const streams = (await source.discover()).streams;

    const records = await readRows(source, streams);

    const reminders = records(source.reminders);
    const dateComponents = records(source.dateComponents);
    const alarms = records(source.alarms);
    const recurrenceRuleValues = records(source.recurrenceRuleValues);
    const [listRow] = records(source.lists);
    assert.equal(listRow?.id, list.id);
    assert.deepEqual(
      records(source.accounts).map(({ id }) => id),
      [listRow?.accountId],
    );
    const reminderRow = (name: string) => {
      const row = reminders.find((found) => found.name === name);
      assert.ok(row, name);
      return row;
    };
    assert.equal(reminders.length, 5);
    const timed = reminderRow('timed');
    assert.ok(typeof timed.externalId === 'string');
    assert.match(String(timed.createdAt), /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(String(timed.modifiedAt), /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.deepEqual(
      {
        listId: timed.listId,
        body: timed.body,
        location: timed.location,
        url: timed.url,
        timeZone: timed.timeZone,
        completed: timed.completed,
        completedAt: timed.completedAt,
        priority: timed.priority,
      },
      {
        listId: list.id,
        body: 'Live notes',
        // EventKit keeps no location on a reminder; places live on alarms.
        location: null,
        url: 'https://example.com/reminder',
        timeZone: 'Asia/Amman',
        completed: false,
        completedAt: null,
        priority: 1,
      },
    );
    const completed = reminderRow('completed');
    assert.equal(completed.completed, true);
    assert.match(String(completed.completedAt), /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(completed.priority, 5);
    assert.ok(
      reminders.every((row) => !('flagged' in row) && !('containerId' in row)),
    );
    const components = (name: string, kind: 'start' | 'due') =>
      dateComponents.find(
        (row) => row.reminderId === reminderRow(name).id && row.kind === kind,
      );
    assert.deepEqual(
      [
        components('date-only', 'due')?.day,
        components('date-only', 'due')?.hour,
        components('date-only', 'due')?.timeZone,
      ],
      [3, null, null],
    );
    assert.deepEqual(components('timed', 'due'), {
      id: JSON.stringify([timed.id, 'due']),
      reminderId: timed.id,
      kind: 'due',
      calendarIdentifier: 'gregorian',
      timeZone: 'Asia/Amman',
      era: 1,
      year: 2025,
      month: 1,
      day: 2,
      hour: 8,
      minute: 45,
      second: 0,
      nanosecond: null,
      weekday: null,
      weekdayOrdinal: null,
      quarter: null,
      weekOfMonth: null,
      weekOfYear: null,
      yearForWeekOfYear: null,
      dayOfYear: null,
      leapMonth: false,
      repeatedDay: false,
    });
    assert.deepEqual(
      [
        components('floating', 'start')?.hour,
        components('floating', 'start')?.minute,
        components('floating', 'start')?.timeZone,
        components('floating', 'due'),
      ],
      [9, 15, null, undefined],
    );
    assert.equal(
      dateComponents.some(
        (row) => row.reminderId === reminderRow('undated').id,
      ),
      false,
    );
    const located = alarms.find((row) => row.proximity === 1);
    assert.deepEqual(
      [
        located?.reminderId,
        located?.locationTitle,
        located?.latitude,
        located?.longitude,
        located?.radius,
      ],
      [timed.id, 'Live place', 31.95, 35.93, 100],
    );
    assert.equal(
      alarms.find((row) => row.absoluteAt !== null)?.absoluteAt,
      '2025-01-02T05:45:00.000Z',
    );
    const [rule] = records(source.recurrenceRules);
    assert.deepEqual(
      [
        rule?.reminderId,
        rule?.frequency,
        rule?.interval,
        rule?.occurrenceCount,
      ],
      [timed.id, 3, 2, 5],
    );
    assert.equal(
      recurrenceRuleValues.find((row) => row.component === 'daysOfTheWeek')
        ?.weekNumber,
      -1,
    );
    assert.deepEqual(
      new Set(recurrenceRuleValues.map((row) => row.component)),
      new Set([
        'daysOfTheWeek',
        'daysOfTheMonth',
        'daysOfTheYear',
        'weeksOfTheYear',
        'monthsOfTheYear',
        'setPositions',
      ]),
    );

    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-reminders-'),
    );
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'reminders.sqlite'),
    });
    const markdown = new MarkdownDestination({
      path: join(scratch.path, 'markdown'),
    });
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
    await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: markdown,
          steps: streams.map(
            (stream) =>
              new Copy(
                stream,
                markdown.file(`${stream.name.toLowerCase()}.md`),
              ),
          ),
        }),
      ],
    }).run();
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    for (const stream of streams) {
      const rows = records(stream);
      // Attendees need participants, which only the stub test can give.
      if (stream !== source.attendees) assert.ok(rows.length > 0, stream.name);
      assert.equal(
        database.prepare(`SELECT count(*) AS count FROM "${stream.name}"`).get()
          ?.count,
        rows.length,
      );
      const document = await readFile(
        join(markdown.path, `${stream.name.toLowerCase()}.md`),
        'utf8',
      );
      for (const row of rows)
        assert.ok(
          document.includes(
            Buffer.from(JSON.stringify(row)).toString('base64'),
          ),
        );
    }
    assert.equal(
      database
        .prepare(
          'SELECT count(*) AS count FROM reminders r JOIN lists l ON l.id = r.listId JOIN accounts a ON a.id = l.accountId',
        )
        .get()?.count,
      5,
    );
  },
);

test('Reminders extracts the attendees EventKit returns, which a test cannot create', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(remindersRead, {
    documents: [
      recordedReminders.account,
      recordedReminders.list,
      reminder({
        attendees: [
          participant({
            name: 'Synthetic attendee',
            url: 'mailto:test@example.com',
            isCurrentUser: true,
          }),
        ],
      }),
    ],
  });
  const source = new AppleRemindersSource({
    store: new RemindersStore(stub.path),
  });

  const attendees = (await readRows(source, [source.attendees]))(
    source.attendees,
  );

  assert.deepEqual(attendees, [
    {
      id: JSON.stringify(['reminder-1', 'attendee', 0]),
      reminderId: 'reminder-1',
      position: 0,
      kind: 'attendee',
      name: 'Synthetic attendee',
      url: 'mailto:test@example.com',
      status: 2,
      role: 1,
      type: 1,
      isCurrentUser: true,
    },
  ]);
});

test(
  'Reminders keeps the start and due component sets of a reminder on this Mac apart',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchList.create();
    if (list === null) return t.skip('no account accepts a new list');
    const [id] = await list.add({
      title: 'both',
      start: { year: 2025, month: 1, day: 1 },
      due: { year: 2025, month: 1, day: 2, hour: 8, minute: 45, second: 0 },
    });
    const source = liveSource(list);

    const components = (await readRows(source, [source.dateComponents]))(
      source.dateComponents,
    );

    assert.deepEqual(
      components.map(
        ({ id, reminderId, kind, year, month, day, hour, minute }) => ({
          id,
          reminderId,
          kind,
          year,
          month,
          day,
          hour,
          minute,
        }),
      ),
      [
        {
          id: JSON.stringify([id, 'start']),
          reminderId: id,
          kind: 'start',
          year: 2025,
          month: 1,
          day: 1,
          // EventKit stores a start without a time at midnight.
          hour: 0,
          minute: 0,
        },
        {
          id: JSON.stringify([id, 'due']),
          reminderId: id,
          kind: 'due',
          year: 2025,
          month: 1,
          day: 2,
          hour: 8,
          minute: 45,
        },
      ],
    );
  },
);

test('Reminders keeps a leap-month start and a due without a calendar, and rejects unidentified reminders, which EventKit does not write', async () => {
  await using stub = await StubEventKitHelper.create();
  // A leap-month start and a due without a calendar: EventKit drops the first
  // and fills in the second on a Gregorian list, so only the stub returns them.
  stub.answer(remindersRead, {
    documents: [
      reminder({
        id: 'both',
        start: { ...recordedDateOnlyDue, leapMonth: true },
      }),
      reminder({
        id: 'calendarless',
        due: { ...recordedDateOnlyDue, calendarIdentifier: undefined },
      }),
    ],
  });
  const source = new AppleRemindersSource({
    store: new RemindersStore(stub.path),
  });
  const pick = (row: Record<string, unknown>) => ({
    kind: row.kind,
    calendarIdentifier: row.calendarIdentifier,
    timeZone: row.timeZone,
    era: row.era,
    year: row.year,
    month: row.month,
    day: row.day,
    hour: row.hour,
    minute: row.minute,
    second: row.second,
    dayOfYear: row.dayOfYear,
    leapMonth: row.leapMonth,
    repeatedDay: row.repeatedDay,
  });

  const components = (await readRows(source, [source.dateComponents]))(
    source.dateComponents,
  );

  assert.deepEqual(
    components.filter(({ reminderId }) => reminderId === 'both').map(pick),
    [
      {
        kind: 'start',
        calendarIdentifier: 'gregorian',
        timeZone: null,
        era: 1,
        year: 2025,
        month: 1,
        day: 3,
        hour: null,
        minute: null,
        second: null,
        dayOfYear: null,
        leapMonth: true,
        repeatedDay: false,
      },
      {
        kind: 'due',
        calendarIdentifier: 'gregorian',
        timeZone: 'Asia/Amman',
        era: 1,
        year: 2025,
        month: 1,
        day: 2,
        hour: 8,
        minute: 45,
        second: 0,
        dayOfYear: null,
        leapMonth: false,
        repeatedDay: false,
      },
    ],
  );
  const calendarless = components.find(
    ({ reminderId }) => reminderId === 'calendarless',
  );
  assert.deepEqual(
    {
      calendarIdentifier: calendarless?.calendarIdentifier,
      dayOfYear: calendarless?.dayOfYear,
    },
    { calendarIdentifier: null, dayOfYear: null },
  );
  for (const unidentified of [reminder({ id: '' }), reminder({ listId: '' })]) {
    stub.answer(remindersRead, { documents: [unidentified] });
    await assert.rejects(
      readRows(source, [source.reminders]),
      /invalid reminders/,
    );
  }
});

test('Reminders rejects unsupported selections without the EventKit helper', async () => {
  // No helper exists here: starting one would fail, so each rejection below
  // must come from validation before the helper is reached.
  await using missing = await mkdtempDisposable(join(tmpdir(), 'no-helper-'));
  const source = new AppleRemindersSource({
    store: new RemindersStore(join(missing.path, 'eventkit-helper')),
  });
  const streams = (await source.discover()).streams;
  const destination = new MarkdownDestination({
    path: join(missing.path, 'markdown'),
  });
  const target = destination.file('reminders.md');

  assert.equal(source.identity, 'apple-reminders:eventkit');
  assert.ok(
    streams.every(
      (stream) =>
        stream.sourceDefinedCursor === true && stream.emitsDeletes === true,
    ),
  );
  assert.throws(
    () =>
      new Copy(source.reminders, target, {
        syncMode: 'incremental',
        destinationSyncMode: 'append',
      }).validate(source, destination),
    /emits deletions; incremental copies require append_dedup/,
  );
  const forged = new Stream({
    name: 'reminders',
    jsonSchema: { type: 'object', properties: {} },
    supportedSyncModes: ['full_refresh'],
  });
  assert.throws(
    () => new Copy(forged, target).validate(source, destination),
    /discovered catalog/,
  );
  assert.throws(
    () => source.reminders.file,
    /does not support file extraction/,
  );
});

test('Reminders rejects malformed records and preserves its target on access or helper failures', async () => {
  await using stub = await StubEventKitHelper.create();
  const answer = (read: HelperRead) => stub.answer(remindersRead, read);
  const source = new AppleRemindersSource({
    store: new RemindersStore(stub.path),
  });
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-reminders-errors-'),
  );
  const destination = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  const run = () =>
    new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(source.reminders, destination.file('reminders.md'))],
        }),
      ],
    }).run();
  answer({ documents: [reminder()] });
  await run();
  const path = join(destination.path, 'reminders.md');
  const previous = await readFile(path, 'utf8');

  // Malformed documents on purpose: each must fail the read.
  const { name: _name, ...unnamed } = reminder();
  for (const invalid of [
    unnamed,
    reminder({ id: '' }),
    reminder({ priority: 10 }),
    { ...reminder(), completed: 'yes' },
  ]) {
    // @ts-expect-error -- each document is malformed on purpose
    answer({ documents: [invalid] });
    await assert.rejects(run(), /invalid reminders/);
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  // Access failures as the helper reports them on stderr; revoked access fails
  // the helper after it wrote documents.
  for (const message of ['denied', 'restricted', 'pending', 'revoked']) {
    const stderr = `REMINDERS_UNAVAILABLE: ${message}\n`;
    answer({
      documents: message === 'revoked' ? [reminder()] : [],
      stderr,
    });
    await assert.rejects(
      run(),
      // Opening the read fails, so every copy reports it, as the run's cause.
      (error: unknown) =>
        error instanceof PipelineError &&
        error.cause instanceof Error &&
        error.cause.name === 'RemindersUnavailableError' &&
        /full Reminders access/.test(error.cause.message) &&
        Reflect.get(Object(error.cause.cause), 'stderr') === stderr,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  // A helper failure without a marker keeps its own error.
  answer({ stderr: 'EventKit reminder query failed\n' });
  await assert.rejects(
    run(),
    (error: unknown) =>
      error instanceof PipelineError &&
      error.cause instanceof Error &&
      error.cause.name !== 'RemindersUnavailableError' &&
      /EventKit reminder query failed/.test(error.cause.message),
  );
  assert.equal(await readFile(path, 'utf8'), previous);

  answer({ documents: [] });
  await run();
  assert.notEqual(await readFile(path, 'utf8'), previous);
});

test(
  'Reminders snapshot incremental writes only changed reminders of a list on this Mac and deletes removed ones',
  { timeout: 180_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchList.create();
    if (list === null) return t.skip('no account accepts a new list');
    const [milk, ann] = await list.add(
      { title: 'Buy milk' },
      { title: 'Call Ann' },
    );
    assert.ok(milk && ann);
    const source = liveSource(list);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-rem-'));
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'r.sqlite'),
    });
    const copy = new Copy(source.reminders, sqlite.table('reminders'), {
      id: 'reminders',
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
            path: join(scratch.path, 's.sqlite'),
          }),
          steps: [copy],
        }),
      ],
    });

    assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
    await list.rename(milk, 'Buy oat milk');
    await list.remove(ann);
    await list.add({ title: 'Book flight' });
    assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 1 }]);
    assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);

    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT name FROM reminders ORDER BY name')
        .all()
        .map(({ name }) => name),
      ['Book flight', 'Buy oat milk'],
    );
  },
);

test(
  'Reminders reads a list on this Mac as documented views that keep date components as components',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchList.create();
    if (list === null) return t.skip('no account accepts a new list');
    await list.add(
      { title: 'due-date-only', due: { year: 2025, month: 1, day: 3 } },
      { title: 'undated', completed: true },
    );
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'rem-marts-'));
    const reminders = await appleImport(
      liveSource(list),
      join(scratch.path, 'import'),
    );

    await reminders.load();

    assert.equal(reminders.views().length, 8);
    // EventKit also writes a start at midnight for a due date without a time;
    // the due set is the one asserted here.
    assert.deepEqual(
      reminders
        .read(
          `
        SELECT r.name, r.completed, d.kind, d.year, d.month, d.day, d.hour
        FROM reminders r
        LEFT JOIN date_components d ON d."reminderId" = r.id AND d.kind = 'due'
        JOIN lists l ON l.id = r."listId"
        ORDER BY r.name`,
        )
        .map((found) => ({ ...found })),
      [
        {
          name: 'due-date-only',
          completed: 0,
          kind: 'due',
          year: 2025,
          month: 1,
          day: 3,
          hour: null,
        },
        {
          name: 'undated',
          completed: 1,
          kind: null,
          year: null,
          month: null,
          day: null,
          hour: null,
        },
      ],
    );
  },
);

test(
  'Reminders scope keeps only the chosen list of this Mac and its account',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchList.create();
    if (list === null) return t.skip('no account accepts a new list');
    const scoped = liveSource(list);
    const missing = new AppleRemindersSource({
      store: new RemindersStore(helper),
      scope: { collectionIds: [`missing-${randomUUID()}`] },
    });

    const rows = await readRows(scoped, [scoped.accounts, scoped.lists]);
    const none = await readRows(missing, [missing.accounts, missing.lists]);

    const [listRow] = rows(scoped.lists);
    assert.deepEqual(
      rows(scoped.lists).map(({ id }) => id),
      [list.id],
    );
    assert.deepEqual(
      rows(scoped.accounts).map(({ id }) => id),
      [listRow?.accountId],
    );
    assert.deepEqual([none(missing.accounts), none(missing.lists)], [[], []]);
  },
);

test(
  'Reminders watch confirms its subscription through the native helper and stops it on abort or return',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    const source = new AppleRemindersSource({
      store: new RemindersStore(helper),
    });
    const helperRunning = () =>
      execFile('pgrep', [
        '-P',
        String(process.pid),
        '-f',
        `${helper} watch reminders`,
      ]);
    const controller = new AbortController();
    try {
      const watching = source.watch({
        streams: [source.reminders],
        signal: controller.signal,
      });
      const subscribed = await watching.next().catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.name === 'RemindersUnavailableError'
        )
          return null;
        throw error;
      });
      if (subscribed === null) return t.skip('no Reminders access');
      assert.deepEqual(subscribed, { value: [source.reminders], done: false });
      const pending = watching.next();
      controller.abort();
      assert.deepEqual(await pending, { value: undefined, done: true });
      await assert.rejects(helperRunning(), { code: 1 });

      // A consumer that stops iterating also stops the helper.
      const stopped = source.watch({
        streams: [source.reminders],
        signal: new AbortController().signal,
      });
      assert.deepEqual(await stopped.next(), {
        value: [source.reminders],
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
  'Reminders reads this Mac’s reminders store into SQLite through the native helper',
  { timeout: 300_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-eventkit-live-'),
    );
    const source = new AppleRemindersSource({
      store: new RemindersStore(helper),
    });
    const sqlite = new SQLiteDestination({
      path: join(scratch.path, 'reminders.sqlite'),
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
          error.cause.name === 'RemindersUnavailableError'
        )
          return null;
        throw error;
      });
    if (outcomes === null) return t.skip('no Reminders access');

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
