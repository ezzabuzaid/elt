import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  Stream,
} from '@workspace/elt';
import { MarkdownDestination } from '@workspace/elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import type { EventKitDocument } from '@workspace/source-apple-eventkit/eventkit-documents';
import {
  account,
  alarm,
  at,
  calendar,
  fakeEventKit,
  list,
  participant,
  recordedDateOnlyDue,
  recordedReminders,
  reminder,
  remindersRead,
  rule,
} from '@workspace/source-apple-eventkit/testing';
import {
  appleImport,
  configured,
  readRows,
} from '@workspace/source-apple-macos/testing';

import { AppleRemindersSource } from './apple-reminders-source.ts';

test(
  'Reminders EventKit projects native records through every SQLite and Markdown stream',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleRemindersSource();
    const streams = (await source.discover()).streams;
    fakeEventKit(t, [
      [
        remindersRead,
        () => [
          recordedReminders.account,
          list(),
          reminder({ id: 'undated', name: 'undated', due: undefined }),
          reminder({
            id: 'date-only',
            name: 'date-only',
            due: recordedDateOnlyDue,
          }),
          reminder({
            id: 'timed',
            name: 'timed',
            url: 'https://example.com/reminder',
            // Hand-built: no location alarm, rule list values or attendee were
            // recorded.
            alarms: [
              alarm({
                proximity: 1,
                location: {
                  title: 'Synthetic place',
                  latitude: 31.95,
                  longitude: 35.93,
                  radius: 100,
                },
              }),
              ...recordedReminders.buyMilk.alarms,
            ],
            recurrenceRules: [
              rule({
                frequency: 3,
                interval: 2,
                daysOfTheWeek: [{ day: 2, weekNumber: -1 }],
                daysOfTheMonth: [-1],
                monthsOfTheYear: [9],
                weeksOfTheYear: [1],
                daysOfTheYear: [42],
                setPositions: [-1],
                end: { occurrenceCount: 5 },
              }),
            ],
            attendees: [
              participant({
                name: 'Synthetic attendee',
                url: 'mailto:test@example.com',
                isCurrentUser: true,
              }),
            ],
          }),
          // Hand-built: a start at a time of day without a time zone.
          reminder({
            id: 'floating',
            name: 'floating',
            due: undefined,
            start: { ...recordedDateOnlyDue, hour: 9, minute: 15 },
          }),
          {
            ...recordedReminders.filedTaxes,
            id: 'completed',
            name: 'completed',
          },
        ],
      ],
    ]);

    const records = await readRows(source, streams);
    const reminders = records(source.reminders);
    const dateComponents = records(source.dateComponents);
    const alarms = records(source.alarms);
    const recurrenceRules = records(source.recurrenceRules);
    const recurrenceRuleValues = records(source.recurrenceRuleValues);
    const byName = Object.fromEntries(
      reminders.map((row) => [String(row.name), row]),
    );
    const reminderRow = (name: string) => {
      const row = byName[name];
      assert.ok(row);
      return row;
    };
    assert.equal(reminders.length, 5);
    assert.deepEqual(reminderRow('timed'), {
      id: 'timed',
      listId: 'calendar-1',
      externalId: 'reminder-1',
      name: 'timed',
      body: 'Synthetic notes',
      location: null,
      url: 'https://example.com/reminder',
      timeZone: 'Asia/Amman',
      // EventKit's sub-millisecond precision does not survive.
      createdAt: '2026-10-01T10:41:41.628Z',
      modifiedAt: '2026-10-01T10:41:41.723Z',
      completed: false,
      completedAt: null,
      priority: 1,
    });
    assert.deepEqual(reminderRow('completed'), {
      id: 'completed',
      listId: 'calendar-1',
      externalId: 'reminder-2',
      name: 'completed',
      body: null,
      location: null,
      url: null,
      timeZone: null,
      createdAt: '2026-10-01T10:41:41.824Z',
      modifiedAt: '2026-10-01T10:41:42.411Z',
      completed: true,
      completedAt: '2026-10-01T10:41:42.411Z',
      priority: 5,
    });
    assert.ok(
      reminders.every((row) => !('flagged' in row) && !('containerId' in row)),
    );
    const date = (name: string) => {
      const row = dateComponents.find(
        (row) => row.reminderId === reminderRow(name).id,
      );
      assert.ok(row);
      return row;
    };
    assert.equal(date('date-only').hour, null);
    assert.equal(date('date-only').day, 3);
    assert.equal(date('date-only').timeZone, null);
    assert.deepEqual(date('timed'), {
      id: JSON.stringify(['timed', 'due']),
      reminderId: 'timed',
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
    assert.equal(date('floating').kind, 'start');
    assert.equal(date('floating').hour, 9);
    assert.equal(date('floating').timeZone, null);
    assert.equal(
      dateComponents.some(
        (row) => row.reminderId === reminderRow('undated').id,
      ),
      false,
    );
    const location = alarms.find((row) => row.proximity === 1);
    assert.ok(location);
    assert.equal(location.latitude, 31.95);
    assert.equal(location.longitude, 35.93);
    assert.equal(location.radius, 100);
    assert.equal(location.reminderId, reminderRow('timed').id);
    assert.equal(
      alarms.find((row) => row.absoluteAt !== null)?.absoluteAt,
      '2025-01-02T05:45:00.000Z',
    );
    assert.equal(recurrenceRules[0]?.interval, 2);
    assert.equal(recurrenceRules[0]?.occurrenceCount, 5);
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
    assert.equal(
      records(source.attendees)[0]?.reminderId,
      reminderRow('timed').id,
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
      assert.ok(rows.length > 0, stream.name);
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

test(
  'Reminders keeps each date component set intact and rejects unidentified reminders',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleRemindersSource();
    // The recorded timed due, and two hand-built variants of the recorded
    // date-only due: a start in a leap month, and a due without a calendar.
    let native: EventKitDocument[] = [
      reminder({
        id: 'both',
        start: { ...recordedDateOnlyDue, leapMonth: true },
      }),
      reminder({
        id: 'calendarless',
        due: { ...recordedDateOnlyDue, calendarIdentifier: undefined },
      }),
    ];
    fakeEventKit(t, [[remindersRead, () => native]]);
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
    // Injects unidentified reminders on purpose.
    for (const unidentified of [
      reminder({ id: '' }),
      reminder({ listId: '' }),
    ]) {
      native = [unidentified];
      await assert.rejects(
        readRows(source, [source.reminders]),
        /invalid reminders/,
      );
    }
  },
);

test(
  'Reminders rejects unsupported selections and preserves targets on invalid data or access failure',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleRemindersSource();
    // The helper must not be reached until the selections below are rejected.
    let respond: () => Iterable<EventKitDocument> = () => {
      throw new Error('The EventKit helper was reached before validation');
    };
    fakeEventKit(t, [[remindersRead, () => respond()]]);
    const streams = (await source.discover()).streams;
    assert.equal(source.identity, 'apple-reminders:eventkit');
    assert.ok(
      streams.every(
        (stream) =>
          stream.sourceDefinedCursor === true && stream.emitsDeletes === true,
      ),
    );
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'elt-reminders-errors-'),
    );
    const destination = new MarkdownDestination({
      path: join(scratch.path, 'markdown'),
    });
    const target = destination.file('reminders.md');
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
    respond = () => [reminder()];
    const run = () =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            steps: [new Copy(source.reminders, target)],
          }),
        ],
      }).run();
    await run();
    const path = join(destination.path, 'reminders.md');
    const previous = await readFile(path, 'utf8');
    // Injects malformed documents on purpose: each must fail the read.
    const { name: _name, ...unnamed } = reminder();
    for (const invalid of [
      unnamed,
      reminder({ id: '' }),
      reminder({ priority: 10 }),
      { ...reminder(), completed: 'yes' },
    ]) {
      // @ts-expect-error -- each document is malformed on purpose
      respond = () => [invalid];
      await assert.rejects(run(), /invalid reminders/);
      assert.equal(await readFile(path, 'utf8'), previous);
    }
    // Injects helper access failures on purpose, as the helper reports them on
    // stderr.
    for (const message of ['denied', 'restricted', 'pending', 'revoked']) {
      const failure = Object.assign(new Error('eventkit exited'), {
        stderr: `REMINDERS_UNAVAILABLE: ${message}\n`,
      });
      respond = function* () {
        // Revoked access fails the helper after it wrote documents.
        if (message === 'revoked') yield reminder();
        throw failure;
      };
      await assert.rejects(
        run(),
        // Opening the read fails, so every copy reports it, as the run's cause.
        (error: unknown) =>
          error instanceof PipelineError &&
          error.cause instanceof Error &&
          error.cause.name === 'RemindersUnavailableError' &&
          /full Reminders access/.test(error.cause.message) &&
          error.cause.cause === failure,
      );
      assert.equal(await readFile(path, 'utf8'), previous);
    }
    // Injects a helper failure without a marker on purpose.
    const failure = new Error(
      'eventkit exited: EventKit reminder query failed',
    );
    respond = () => {
      throw failure;
    };
    await assert.rejects(
      run(),
      (error: unknown) =>
        error instanceof PipelineError && error.cause === failure,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
    respond = () => [];
    await run();
    assert.notEqual(await readFile(path, 'utf8'), previous);
  },
);

test('Reminders snapshot incremental writes only changed reminders and deletes removed ones', async (t) => {
  const source = new AppleRemindersSource();
  const named = (id: string, name: string) => reminder({ id, name });
  let native = [named('r1', 'Buy milk'), named('r2', 'Call Ann')];
  fakeEventKit(t, [[remindersRead, () => native]]);
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
  native = [named('r1', 'Buy oat milk'), named('r3', 'Book flight')];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 1 }]);
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT id, name FROM reminders ORDER BY id')
      .all()
      .map((row) => `${row.id}:${row.name}`),
    ['r1:Buy oat milk', 'r3:Book flight'],
  );
});

test('an EventKit session reads again when a change arrives during the read', async (t) => {
  let change = () => {};
  let edited = false;
  const source = new AppleRemindersSource();
  fakeEventKit(
    t,
    [
      [
        remindersRead,
        () => {
          if (edited) return [{ ...recordedReminders.account, name: 'after' }];
          // Another app edits Reminders while the first read runs.
          edited = true;
          change();
          return [{ ...recordedReminders.account, name: 'before' }];
        },
      ],
    ],
    async function* (signal) {
      yield 'changed';
      await new Promise<void>((resolve) => {
        change = resolve;
      });
      yield 'changed';
      if (!signal.aborted) await once(signal, 'abort');
    },
  );

  const accounts = (await readRows(source, [source.accounts]))(source.accounts);

  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['after'],
  );
});

test('an EventKit session gives up when every read sees a change', async (t) => {
  const source = new AppleRemindersSource();
  let reads = 0;
  fakeEventKit(
    t,
    [
      [
        remindersRead,
        () => {
          reads++;
          return [recordedReminders.account];
        },
      ],
    ],
    async function* (signal) {
      yield 'changed';
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield 'changed';
      }
    },
  );

  await assert.rejects(readRows(source, [source.accounts]), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'EventKitChangingError');
    assert.match(error.message, /changed during each of 5 consistent reads/);
    return true;
  });
  // The message names the configured attempts; the helper saw each one.
  assert.equal(reads, 5);
});

test(
  'Reminders reads as documented views that keep date components as components',
  {
    concurrency: false,
  },
  async (t) => {
    fakeEventKit(t, [
      [
        remindersRead,
        () => [
          recordedReminders.account,
          list(),
          reminder({ id: 'due-date-only', due: recordedDateOnlyDue }),
          { ...recordedReminders.filedTaxes, id: 'undated', due: undefined },
        ],
      ],
    ]);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'rem-marts-'));
    const reminders = await appleImport(
      new AppleRemindersSource(),
      join(scratch.path, 'import'),
    );
    await reminders.load();

    assert.equal(reminders.views().length, 8);
    assert.deepEqual(
      reminders
        .read(
          `
        SELECT r.id, r.completed, d.kind, d.year, d.month, d.day, d.hour
        FROM reminders r
        LEFT JOIN date_components d ON d."reminderId" = r.id
        JOIN lists l ON l.id = r."listId"
        ORDER BY r.id`,
        )
        .map((found) => ({ ...found })),
      [
        {
          id: 'due-date-only',
          completed: 0,
          kind: 'due',
          year: 2025,
          month: 1,
          day: 3,
          hour: null,
        },
        {
          id: 'undated',
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
