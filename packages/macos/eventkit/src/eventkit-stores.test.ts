import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  type AccountDocument,
  CalendarStore,
  CalendarUnavailableError,
  EventKitChangingError,
  IcsExportUnavailableError,
  RemindersStore,
  RemindersUnavailableError,
} from './index.ts';
import {
  type HelperCalendarDocument,
  type HelperRequest,
  StubEventKitHelper,
} from './test.ts';

const execFile = promisify(execFileCallback);

// The helper this package compiles, beside this file in dist.
const helper = fileURLToPath(new URL('./eventkit-helper', import.meta.url));

const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

// Real EventKit data for one test: a temporary event calendar or reminders
// list, with its items, in the first account that accepts one, CalDAV first.
// Accounts sync, so it reaches the server until the test deletes it.
class ScratchEventKit implements AsyncDisposable {
  readonly id: string;

  private constructor(id: string) {
    this.id = id;
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
    return new ScratchEventKit(await ScratchEventKit.#run('events', events));
  }

  static async reminders(
    reminders: readonly {
      readonly title: string;
      readonly due: { year: number; month: number; day: number };
    }[],
  ): Promise<ScratchEventKit> {
    return new ScratchEventKit(
      await ScratchEventKit.#run('reminders', reminders),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await ScratchEventKit.#run('delete', this.id);
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
  if (mode === 'delete') {
    const calendar = store.calendarWithIdentifier(spec);
    if (!ObjC.unwrap(calendar.title).startsWith('context-compiler test '))
      throw new Error('Refusing to delete a calendar this test did not create');
    if (!store.removeCalendarCommitError(calendar, true, null))
      throw new Error('Could not delete the test calendar');
    return '';
  }
  const date = (iso) => $.NSDate.dateWithTimeIntervalSince1970(Date.parse(iso) / 1000);
  const entity = mode === 'events' ? 0 : 1;
  const calendar = $.EKCalendar.calendarForEntityTypeEventStore(entity, store);
  calendar.title = 'context-compiler test ' + ObjC.unwrap($.NSUUID.UUID.UUIDString);
  const sources = ObjC.unwrap(store.sources).toSorted(
    (a, b) => (Number(a.sourceType) === 2 ? 0 : 1) - (Number(b.sourceType) === 2 ? 0 : 1),
  );
  if (!sources.some((source) => {
    calendar.source = source;
    return store.saveCalendarCommitError(calendar, true, null);
  })) throw new Error('${ScratchEventKit.#noAccount}');
  for (const item of spec) {
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
  return ObjC.unwrap(calendar.calendarIdentifier);
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

test('a read repeats when the store changes while it runs', async () => {
  await using stub = await StubEventKitHelper.create();
  stub
    .answer(
      remindersRead,
      { documents: [account('before')] },
      { documents: [account('after')] },
    )
    .watch({ changeDuringFirstRead: true });

  const { accounts } = await new RemindersStore(stub.path).read({});

  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['after'],
  );
  assert.equal(stub.reads(remindersRead), 2);
});

test('a read gives up when the store changes during every attempt', async () => {
  await using stub = await StubEventKitHelper.create();
  stub
    .answer(remindersRead, { documents: [account('a1')] })
    .watch({ everyMs: 20 });

  await assert.rejects(
    new RemindersStore(stub.path).read({}),
    (error: unknown) => {
      assert.ok(error instanceof EventKitChangingError);
      assert.match(error.message, /changed during each of 5 consistent reads/);
      return true;
    },
  );
  assert.equal(stub.reads(remindersRead), 5);
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

  await assert.rejects(calendar.read({ ...january, ics: false }), (error) => {
    assert.ok(error instanceof CalendarUnavailableError);
    assert.equal(Reflect.get(Object(error.cause), 'stderr'), calendarDenied);
    return true;
  });
  await assert.rejects(calendar.watch(signal).next(), CalendarUnavailableError);
  await assert.rejects(reminders.read({}), (error) => {
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
    new CalendarStore(stub.path).read({ ...january, ics: true }),
    IcsExportUnavailableError,
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
    const { accounts, calendars } = await store.read(query);
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
  const { calendars } = await store.read({});
  assert.ok(calendars.every((calendar) => !('selected' in calendar)));
});

test('attendees and alarms come back in content order whatever order the helper writes them in', async () => {
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
    { alarmType: 0, relativeOffset: -3600, proximity: 0 },
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

  const [first] = (await store.read({})).reminders;
  const [second] = (await store.read({})).reminders;

  assert.deepEqual(first, second);
  assert.deepEqual(
    first?.attendees.map(({ name }) => name),
    ['Ann', 'Bo'],
  );
  assert.deepEqual(
    first?.alarms.map(({ relativeOffset }) => relativeOffset),
    [-3600, -600],
  );
});

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
    ).read({ ...january, ics: false, calendarIds: [calendar.id] });

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

    const { calendars, reminders } = await new RemindersStore(helper).read({
      calendarIds: [list.id],
    });

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
