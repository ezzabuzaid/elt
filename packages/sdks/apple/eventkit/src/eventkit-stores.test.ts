import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  type AccountDocument,
  CalendarStore,
  CalendarUnavailableError,
  EventKitChangingError,
  IcsExportUnavailableError,
  type OccurrenceDocument,
  RemindersStore,
  RemindersUnavailableError,
} from './index.ts';
import {
  type HelperCalendarDocument,
  type HelperRequest,
  StubEventKitHelper,
} from './stub-eventkit-helper.ts';

const execFile = promisify(execFileCallback);

// The helper this package compiles, through its package export.
const helper = fileURLToPath(
  import.meta.resolve('@workspace/sdk-apple-eventkit/eventkit-helper'),
);

const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

// Real EventKit data for one test: the event calendar or reminders list this
// Mac's live tests share, with the test's items, in the first account that
// accepts one, CalDAV first. Each is made once and never deleted: iCloud
// brings a deleted calendar back, empty, hours later. A test holds them alone,
// across processes, and empties the one it uses before and after, so it starts
// with only its own items and leaves none, whatever a killed run left.
class ScratchEventKit implements AsyncDisposable {
  readonly id: string;
  readonly #entity: 'events' | 'reminders';
  readonly #lock: DatabaseSync;

  private constructor(
    id: string,
    entity: 'events' | 'reminders',
    lock: DatabaseSync,
  ) {
    this.id = id;
    this.#entity = entity;
    this.#lock = lock;
  }

  static async events(
    events: readonly {
      readonly title: string;
      readonly start: string;
      readonly end: string;
      readonly weekly: number;
      readonly alarmOffset: number;
    }[],
  ): Promise<ScratchEventKit> {
    return ScratchEventKit.#open('events', events);
  }

  static async reminders(
    reminders: readonly {
      readonly title: string;
      readonly due: { year: number; month: number; day: number };
    }[],
  ): Promise<ScratchEventKit> {
    return ScratchEventKit.#open('reminders', reminders);
  }

  static async #open(
    entity: 'events' | 'reminders',
    items: readonly object[],
  ): Promise<ScratchEventKit> {
    const lock = ScratchEventKit.#hold();
    try {
      const scratch = new ScratchEventKit(
        await ScratchEventKit.#run('open', entity),
        entity,
        lock,
      );
      await scratch.#empty();
      await ScratchEventKit.#run(entity, { calendarId: scratch.id, items });
      return scratch;
    } catch (error) {
      lock.close();
      throw error;
    }
  }

  // One test at a time uses the shared calendars and list, in any process: a
  // test holds this exclusive transaction until it is done, and a process
  // that dies releases it.
  static #hold(): DatabaseSync {
    const path = join(homedir(), 'Library/Caches/elt/eventkit-tests.sqlite');
    mkdirSync(dirname(path), { recursive: true });
    const lock = new DatabaseSync(path, { timeout: 600_000 });
    lock.exec('BEGIN EXCLUSIVE');
    return lock;
  }

  // Deletes every item the calendar or list holds, as the helper reads them.
  async #empty(): Promise<void> {
    const items =
      this.#entity === 'events'
        ? (
            await new CalendarStore(helper).read(
              {
                startAt: '1990-01-01T00:00:00.000Z',
                endAt: '2040-01-01T00:00:00.000Z',
                ics: false,
                calendarIds: [this.id],
              },
              undefined,
            )
          ).occurrences.map((occurrence) => occurrence.calendarItemId)
        : (
            await new RemindersStore(helper).read(
              { calendarIds: [this.id] },
              undefined,
            )
          ).reminders.map((reminder) => reminder.id);
    if (items.length > 0)
      await ScratchEventKit.#run('empty', {
        entity: this.#entity,
        items: [...new Set(items)],
      });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.#empty();
    } finally {
      this.#lock.close();
    }
  }

  // Saves a reminder in the list under a new title every 100 ms until
  // disposed, starting once the first save is done: a store that never holds
  // still for a read.
  async changing(): Promise<AsyncDisposable> {
    const changer = spawn(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        ScratchEventKit.#script,
        'changing',
        JSON.stringify({ calendarId: this.id }),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const exited = once(changer, 'exit');
    const stderr: string[] = [];
    for await (const line of createInterface({ input: changer.stderr })) {
      if (line === 'changing')
        return {
          async [Symbol.asyncDispose]() {
            changer.kill();
            await exited;
          },
        };
      stderr.push(line);
    }
    await exited;
    throw new Error(`The reminder changer stopped: ${stderr.join('\n')}`);
  }

  // Null when no account on this Mac accepts a new calendar or list.
  static async unless<T>(creating: Promise<T>): Promise<T | null> {
    try {
      return await creating;
    } catch (error) {
      if (
        String(Reflect.get(Object(error), 'stderr')).includes(
          ScratchEventKit.#noAccount,
        )
      )
        return null;
      throw error;
    }
  }

  static readonly #noAccount = 'No EventKit account accepts a new calendar';

  static async #run(mode: string, payload: unknown): Promise<string> {
    const { stdout } = await execFile('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      ScratchEventKit.#script,
      mode,
      JSON.stringify(payload),
    ]);
    return stdout.trim();
  }

  static readonly #script = `
ObjC.import('EventKit');
function run([mode, payload]) {
  const store = $.EKEventStore.alloc.init;
  const spec = JSON.parse(payload);
  if (mode === 'open') {
    const entity = spec === 'events' ? 0 : 1;
    const title = 'context-compiler tests';
    let shared = ObjC.unwrap(store.calendarsForEntityType(entity))
      .filter((each) => ObjC.unwrap(each.title) === title)
      .toSorted((a, b) => (ObjC.unwrap(a.calendarIdentifier) < ObjC.unwrap(b.calendarIdentifier) ? -1 : 1))[0];
    if (shared === undefined) {
      shared = $.EKCalendar.calendarForEntityTypeEventStore(entity, store);
      shared.title = title;
      const sources = ObjC.unwrap(store.sources).toSorted(
        (a, b) => (Number(a.sourceType) === 2 ? 0 : 1) - (Number(b.sourceType) === 2 ? 0 : 1),
      );
      if (!sources.some((source) => {
        shared.source = source;
        return store.saveCalendarCommitError(shared, true, null);
      })) throw new Error('${ScratchEventKit.#noAccount}');
    }
    return ObjC.unwrap(shared.calendarIdentifier);
  }
  if (mode === 'empty') {
    for (const id of spec.items) {
      const item = store.calendarItemWithIdentifier(id);
      if (item.isNil()) continue;
      const removed = spec.entity === 'events'
        ? store.removeEventSpanCommitError(item, 1, true, null)
        : store.removeReminderCommitError(item, true, null);
      if (!removed) throw new Error('Could not delete a test item');
    }
    return '';
  }
  if (mode === 'changing') {
    const reminder = $.EKReminder.reminderWithEventStore(store);
    reminder.calendar = store.calendarWithIdentifier(spec.calendarId);
    for (let saves = 0; ; saves++) {
      reminder.title = 'Changing ' + saves;
      if (!store.saveReminderCommitError(reminder, true, null)) throw new Error('Reminder not saved');
      if (saves === 0) console.log('changing');
      delay(0.1);
    }
  }
  const date =(iso) => $.NSDate.dateWithTimeIntervalSince1970(Date.parse(iso) / 1000);
  const calendar = store.calendarWithIdentifier(spec.calendarId);
  for (const item of spec.items) {
    if (mode === 'events') {
      const event = $.EKEvent.eventWithEventStore(store);
      event.calendar = calendar;
      event.title = item.title;
      event.startDate = date(item.start);
      event.endDate = date(item.end);
      event.addAlarm($.EKAlarm.alarmWithRelativeOffset(item.alarmOffset));
      event.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalEnd(
        1, 1, $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(item.weekly)));
      if (!store.saveEventSpanCommitError(event, 1, true, null)) throw new Error('Event not saved');
    } else {
      const reminder = $.EKReminder.reminderWithEventStore(store);
      reminder.calendar = calendar;
      reminder.title = item.title;
      const due = $.NSDateComponents.alloc.init;
      due.year = item.due.year;
      due.month = item.due.month;
      due.day = item.due.day;
      reminder.dueDateComponents = due;
      if (!store.saveReminderCommitError(reminder, true, null)) throw new Error('Reminder not saved');
    }
  }
  return '';
}`;
}

const account = (id: string): AccountDocument => ({
  type: 'account',
  id,
  name: id,
  sourceType: 2,
  isDelegate: false,
});

const list = (
  id: string,
  accountId: string,
  selected: boolean,
): HelperCalendarDocument => ({
  type: 'calendar',
  id,
  accountId,
  name: id,
  calendarType: 1,
  writable: true,
  subscribed: false,
  immutable: false,
  supportedAvailabilities: 0,
  allowedEntityTypes: 2,
  selected,
});

const remindersRead: HelperRequest = { entity: 'reminders' };
// What the helper writes when the store changed while it read.
const changed = 'EVENTKIT_CHANGED: the store changed during the read\n';

test('a read starts no watcher of its own', async () => {
  await using stub = await StubEventKitHelper.create();
  stub
    .answer(remindersRead, { documents: [account('a1')] })
    .watch({ lines: [], then: { stderr: 'a read started a watcher\n' } });

  const { accounts } = await new RemindersStore(stub.path).read({}, undefined);

  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['a1'],
  );
});

test('a read repeats when the store changes while it runs', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(
    remindersRead,
    { documents: [account('before')], stderr: changed },
    { documents: [account('after')] },
  );

  const { accounts } = await new RemindersStore(stub.path).read({}, undefined);

  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['after'],
  );
  assert.equal(stub.reads(remindersRead), 2);
});

test('a read gives up when the store changes during every attempt', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(remindersRead, { documents: [account('a1')], stderr: changed });

  await assert.rejects(
    new RemindersStore(stub.path).read({}, undefined),
    (error: unknown) => {
      assert.ok(error instanceof EventKitChangingError);
      assert.match(error.message, /changed during each of 5 consistent reads/);
      return true;
    },
  );
  assert.equal(stub.reads(remindersRead), 5);
});

// An EventKit helper that begins a read and never ends it, as a long read of
// a large store does until the store stops it: EventKit cannot be made to
// keep a read waiting, so this executable stands in for the compiled helper.
// It marks that its read began.
async function waitingHelper(directory: string) {
  const path = join(directory, 'eventkit-helper');
  const began = join(directory, 'began');
  await writeFile(path, `#!/bin/sh\n: > '${began}'\nexec sleep 10\n`, {
    mode: 0o755,
  });
  return { path, began: () => existsSync(began) };
}

test('a read its signal stops rejects with the reason at once and never resolves', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'eventkit-waiting-'),
  );
  const helper = await waitingHelper(directory.path);
  const removal = new AbortController();
  const removed = new Error('the user removed this connector');

  const reading = new RemindersStore(helper.path).read({}, removal.signal);
  while (!helper.began()) await sleep(10);
  removal.abort(removed);
  const outcome = await Promise.race([
    reading.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    sleep(5_000, 'still reading'),
  ]);

  assert.equal(outcome, removed);
});

const collectionsRead: HelperRequest = {
  entity: 'reminders',
  collectionsOnly: true,
};

test('a read of only the accounts and lists repeats when the store changes while it runs', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(
    collectionsRead,
    { documents: [account('before')], stderr: changed },
    { documents: [account('after')] },
  );

  const { accounts } = await new RemindersStore(stub.path).collections(
    {},
    undefined,
  );

  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['after'],
  );
  assert.equal(stub.reads(collectionsRead), 2);
});

test('a read of only the accounts and lists gives up when the store changes during every attempt', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(collectionsRead, {
    documents: [account('a1')],
    stderr: changed,
  });

  await assert.rejects(
    new RemindersStore(stub.path).collections({}, undefined),
    EventKitChangingError,
  );
  assert.equal(stub.reads(collectionsRead), 5);
});

test('a read of only the accounts and lists its signal stops rejects with the reason at once and never resolves', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'eventkit-waiting-'),
  );
  const helper = await waitingHelper(directory.path);
  const removal = new AbortController();
  const removed = new Error('the user removed this connector');

  const reading = new RemindersStore(helper.path).collections(
    {},
    removal.signal,
  );
  while (!helper.began()) await sleep(10);
  removal.abort(removed);
  const outcome = await Promise.race([
    reading.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    sleep(5_000, 'still reading'),
  ]);

  assert.equal(outcome, removed);
});

test('missing access fails reads and watches with the entity’s own error', async () => {
  const denied = (marker: string) =>
    `${marker}: full access is required; status=2\n`;
  await using calendarStub = await StubEventKitHelper.create();
  await using remindersStub = await StubEventKitHelper.create();
  const calendarDenied = denied('CALENDAR_UNAVAILABLE');
  const remindersDenied = denied('REMINDERS_UNAVAILABLE');
  calendarStub
    .answer(
      { entity: 'events', ...january, ics: false },
      { stderr: calendarDenied },
    )
    .watch({ lines: [], then: { stderr: calendarDenied } });
  remindersStub
    .answer(remindersRead, { stderr: remindersDenied })
    .watch({ lines: [], then: { stderr: remindersDenied } });
  const calendar = new CalendarStore(calendarStub.path);
  const reminders = new RemindersStore(remindersStub.path);
  const signal = new AbortController().signal;

  await assert.rejects(
    calendar.read({ ...january, ics: false }, undefined),
    (error) => {
      assert.ok(error instanceof CalendarUnavailableError);
      assert.equal(Reflect.get(Object(error.cause), 'stderr'), calendarDenied);
      return true;
    },
  );
  await assert.rejects(calendar.watch(signal).next(), CalendarUnavailableError);
  await assert.rejects(reminders.read({}, undefined), (error) => {
    assert.ok(error instanceof RemindersUnavailableError);
    assert.equal(Reflect.get(Object(error.cause), 'stderr'), remindersDenied);
    return true;
  });
  await assert.rejects(
    reminders.watch(signal).next(),
    RemindersUnavailableError,
  );
});

test('a watcher that writes anything but a change, or stops, fails the watch', async () => {
  await using stub = await StubEventKitHelper.create();
  const store = new RemindersStore(stub.path);
  const watching = () => store.watch(new AbortController().signal);

  stub.watch({ lines: ['unexpected'], then: 'wait' });
  await assert.rejects(watching().next(), /invalid notification/);

  stub.watch({ lines: ['changed'], then: 'exit' });
  const stopped = watching();
  assert.deepEqual(await stopped.next(), { value: undefined, done: false });
  await assert.rejects(stopped.next(), /stopped unexpectedly/);
});

test('stopping a watch stops the helper process', async () => {
  await using stub = await StubEventKitHelper.create();
  const controller = new AbortController();
  const watching = new CalendarStore(stub.path).watch(controller.signal);
  const running = () =>
    execFile('pgrep', ['-P', String(process.pid), '-f', `${stub.path} watch`]);

  assert.deepEqual(await watching.next(), { value: undefined, done: false });
  await running();
  const pending = watching.next();
  controller.abort();

  assert.deepEqual(await pending, { value: undefined, done: true });
  await assert.rejects(running(), { code: 1 });
});

test('a Calendar read without the private ICS export fails with IcsExportUnavailableError', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.answer(
    { entity: 'events', ...january, ics: true },
    {
      stderr:
        'CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version\n',
    },
  );

  await assert.rejects(
    new CalendarStore(stub.path).read({ ...january, ics: true }, undefined),
    IcsExportUnavailableError,
  );
});

test('a Calendar read keeps one all-day occurrence that EventKit expands twice in its day, at two UTC offsets', async () => {
  await using stub = await StubEventKitHelper.create();
  // What EventKit returned on 2026-10-12 for the yearly Flag Day of a United
  // States holidays calendar, read in Asia/Amman: 2016-06-14 from midnight at
  // +03:00, and again from midnight at +02:00.
  const flagDay = (startMs: number, endMs: number): OccurrenceDocument => ({
    type: 'occurrence',
    calendarId: 'holidays',
    calendarItemId: 'flag-day',
    name: 'Flag Day',
    startMs,
    endMs,
    startDay: '2016-06-14',
    endDay: '2016-06-14',
    allDay: true,
    occurrenceMs: startMs,
    occurrenceDay: '2016-06-14',
    detached: false,
    status: 0,
    availability: 1,
    attendees: [],
    alarms: [],
    recurrenceRules: [
      {
        frequency: 3,
        interval: 1,
        firstDayOfWeek: 2,
        daysOfTheWeek: [],
        daysOfTheMonth: [14],
        daysOfTheYear: [],
        weeksOfTheYear: [],
        monthsOfTheYear: [6],
        setPositions: [],
      },
    ],
  });
  const june = {
    startAt: '2016-06-01T00:00:00.000Z',
    endAt: '2016-07-01T00:00:00.000Z',
  };
  stub.answer(
    { entity: 'events', ...june, ics: false },
    {
      documents: [
        flagDay(1465851600000, 1465937999000),
        flagDay(1465855200000, 1465941599000),
      ],
    },
  );

  const { occurrences } = await new CalendarStore(stub.path).read(
    {
      ...june,
      ics: false,
    },
    undefined,
  );

  assert.deepEqual(
    occurrences.map(({ startMs }) => startMs),
    [1465851600000],
  );
});

test('a scoped read keeps the calendars the helper selected and the accounts the query names', async () => {
  await using stub = await StubEventKitHelper.create();
  // a1 owns the selected list, a2 an unselected one, a3 none.
  const documents = (selected: boolean) => [
    account('a1'),
    account('a2'),
    account('a3'),
    list('l1', 'a1', selected),
    list('l2', 'a2', false),
  ];
  stub
    .answer(remindersRead, { documents: documents(false) })
    .answer(
      { entity: 'reminders', accountIds: ['a1', 'a3'] },
      { documents: documents(true) },
    )
    .answer(
      { entity: 'reminders', collectionIds: ['l1'] },
      { documents: documents(true) },
    );
  const store = new RemindersStore(stub.path);
  const listed = async (query: Parameters<RemindersStore['read']>[0]) => {
    const { accounts, calendars } = await store.read(query, undefined);
    return [accounts.map(({ id }) => id), calendars.map(({ id }) => id)];
  };

  assert.deepEqual(await listed({}), [
    ['a1', 'a2', 'a3'],
    ['l1', 'l2'],
  ]);
  // An account scope keeps a named account that owns no calendar.
  assert.deepEqual(await listed({ accountIds: ['a1', 'a3'] }), [
    ['a1', 'a3'],
    ['l1'],
  ]);
  // A calendar scope keeps only the accounts owning a selected calendar.
  assert.deepEqual(await listed({ calendarIds: ['l1'] }), [['a1'], ['l1']]);
  const { calendars } = await store.read({}, undefined);
  assert.ok(calendars.every((calendar) => !('selected' in calendar)));
});

test('attendees come back in content order and alarms in firing order, whatever order the helper writes them in', async () => {
  await using stub = await StubEventKitHelper.create();
  const attendees = [
    {
      url: 'mailto:bo@example.com',
      name: 'Bo',
      status: 1,
      role: 1,
      participantType: 1,
      isCurrentUser: false,
    },
    {
      url: 'mailto:ann@example.com',
      name: 'Ann',
      status: 2,
      role: 1,
      participantType: 1,
      isCurrentUser: false,
    },
  ];
  const alarms = [
    { alarmType: 0, relativeOffset: -600, proximity: 0 },
    {
      alarmType: 0,
      relativeOffset: 0,
      absoluteMs: Date.parse('2025-01-02T09:00:00Z'),
      proximity: 0,
    },
    { alarmType: 0, relativeOffset: -3600, proximity: 0 },
    { alarmType: 0, relativeOffset: 600, proximity: 0 },
    { alarmType: 0, relativeOffset: -1800, proximity: 0 },
    { alarmType: 0, relativeOffset: 0, proximity: 0 },
    {
      alarmType: 0,
      relativeOffset: 0,
      absoluteMs: Date.parse('2025-01-01T09:00:00Z'),
      proximity: 0,
    },
  ];
  const reminder = (order: 'written' | 'reversed') => ({
    type: 'reminder' as const,
    id: 'r1',
    listId: 'l1',
    completed: false,
    priority: 0,
    recurrenceRules: [],
    attendees: order === 'written' ? attendees : attendees.toReversed(),
    alarms: order === 'written' ? alarms : alarms.toReversed(),
  });
  stub.answer(
    remindersRead,
    { documents: [reminder('written')] },
    { documents: [reminder('reversed')] },
  );
  const store = new RemindersStore(stub.path);

  const [first] = (await store.read({}, undefined)).reminders;
  const [second] = (await store.read({}, undefined)).reminders;

  assert.deepEqual(first, second);
  assert.deepEqual(
    first?.attendees.map(({ name }) => name),
    ['Ann', 'Bo'],
  );
  assert.deepEqual(
    first?.alarms.map(({ relativeOffset, absoluteMs }) =>
      absoluteMs === undefined ? relativeOffset : new Date(absoluteMs),
    ),
    [
      -3600,
      -1800,
      -600,
      0,
      600,
      new Date('2025-01-01T09:00:00Z'),
      new Date('2025-01-02T09:00:00Z'),
    ],
  );
});

test(
  'CalendarStore lists an occurrence that spans two of its read windows once',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    // The helper reads a year at a time from startAt, so this event crosses
    // from the first window into the second.
    await using calendar = await ScratchEventKit.unless(
      ScratchEventKit.events([
        {
          title: 'New year',
          start: '2025-12-31T23:00:00.000Z',
          end: '2026-01-01T01:00:00.000Z',
          weekly: 1,
          alarmOffset: -600,
        },
      ]),
    );
    if (calendar === null) return t.skip('no account accepts a new calendar');

    const { occurrences } = await new CalendarStore(helper).read(
      {
        startAt: '2025-01-01T00:00:00.000Z',
        endAt: '2026-06-01T00:00:00.000Z',
        ics: false,
        calendarIds: [calendar.id],
      },
      undefined,
    );

    assert.deepEqual(
      occurrences.map(({ name }) => name),
      ['New year'],
    );
  },
);

test(
  'CalendarStore reads the occurrences of a calendar on this Mac with their alarms and rules',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using calendar = await ScratchEventKit.unless(
      ScratchEventKit.events([
        {
          title: 'Store standup',
          start: '2025-01-02T06:00:00.000Z',
          end: '2025-01-02T07:00:00.000Z',
          weekly: 3,
          alarmOffset: -600,
        },
      ]),
    );
    if (calendar === null) return t.skip('no account accepts a new calendar');

    const { accounts, calendars, occurrences } = await new CalendarStore(
      helper,
    ).read({ ...january, ics: false, calendarIds: [calendar.id] }, undefined);

    assert.deepEqual(
      calendars.map(({ id }) => id),
      [calendar.id],
    );
    assert.deepEqual(
      accounts.map(({ id }) => id),
      [calendars[0]?.accountId],
    );
    assert.deepEqual(
      occurrences.map(({ name, startMs, alarms, recurrenceRules }) => [
        name,
        new Date(startMs).toISOString(),
        alarms.map(({ relativeOffset }) => relativeOffset),
        recurrenceRules.length,
      ]),
      [
        ['Store standup', '2025-01-02T06:00:00.000Z', [-600], 1],
        ['Store standup', '2025-01-09T06:00:00.000Z', [-600], 1],
        ['Store standup', '2025-01-16T06:00:00.000Z', [-600], 1],
      ],
    );
  },
);

test(
  'RemindersStore reads the reminders of a list on this Mac with their due dates',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchEventKit.unless(
      ScratchEventKit.reminders([
        { title: 'Store reminder', due: { year: 2025, month: 1, day: 3 } },
      ]),
    );
    if (list === null) return t.skip('no account accepts a new list');

    const { calendars, reminders } = await new RemindersStore(helper).read(
      {
        calendarIds: [list.id],
      },
      undefined,
    );

    assert.deepEqual(
      calendars.map(({ id }) => id),
      [list.id],
    );
    assert.deepEqual(
      reminders.map(({ name, listId, due }) => [
        name,
        listId,
        due?.year,
        due?.month,
        due?.day,
      ]),
      [['Store reminder', list.id, 2025, 1, 3]],
    );
  },
);

test(
  'a read of a list that changes all through it gives up, through the real helper',
  { timeout: 120_000 },
  async (t) => {
    if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
    await using list = await ScratchEventKit.unless(
      ScratchEventKit.reminders([]),
    );
    if (list === null) return t.skip('no account accepts a new list');
    await using _changing = await list.changing();

    await assert.rejects(
      new RemindersStore(helper).read({ calendarIds: [list.id] }, undefined),
      EventKitChangingError,
    );
  },
);

test('a quiet watch reports a check that found the store unchanged each second, once the helper confirms its subscription', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.watch({ lines: ['changed'], then: 'wait' });
  const controller = new AbortController();
  const checks = new CalendarStore(stub.path).checks(controller.signal);
  const running = () =>
    execFile('pgrep', ['-P', String(process.pid), '-f', `${stub.path} watch`]);

  const subscribed = await checks.next();
  const quiet = await checks.next();
  const pending = checks.next();
  controller.abort();

  assert.deepEqual([subscribed.value, quiet.value], ['changed', 'unchanged']);
  assert.deepEqual(await pending, { value: undefined, done: true });
  await assert.rejects(running(), { code: 1 });
});

test(
  'a consumer that stops reading checks stops the helper process',
  { timeout: 10_000 },
  async () => {
    await using stub = await StubEventKitHelper.create();
    stub.watch({ lines: ['changed'], then: 'wait' });
    const checks = new CalendarStore(stub.path).checks(
      new AbortController().signal,
    );
    const running = () =>
      execFile('pgrep', [
        '-P',
        String(process.pid),
        '-f',
        `${stub.path} watch`,
      ]);

    await checks.next();
    assert.deepEqual(await checks.next(), { value: 'unchanged', done: false });
    await running();
    const stopped = await checks.return(undefined);

    assert.deepEqual(stopped, { value: undefined, done: true });
    await assert.rejects(running(), { code: 1 });
  },
);

test('no check says the store held still before the helper confirms its subscription', async () => {
  await using stub = await StubEventKitHelper.create();
  stub.watch({ lines: [], then: 'wait' });
  const controller = new AbortController();
  const checks = new CalendarStore(stub.path).checks(controller.signal);

  const first = checks.next();
  // Longer than a check takes once subscribed.
  const seen = await Promise.race([first, sleep(1500).then(() => 'nothing')]);
  controller.abort();

  assert.equal(seen, 'nothing');
  assert.deepEqual(await first, { value: undefined, done: true });
});
