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
} from '@workspace/elt';
import { SQLiteDestination } from '@workspace/elt-sqlite';
import { AppleCalendarSource } from '@workspace/source-apple-calendar/apple-calendar-source';
import type { AccountDocument } from '@workspace/source-apple-eventkit/eventkit-documents';
import {
  account,
  calendar,
  eventsRead,
  fakeEventKit,
  january,
  list,
  quiet,
  recordedEvents,
  recordedReminders,
  remindersRead,
} from '@workspace/source-apple-eventkit/testing';
import { readRows } from '@workspace/source-apple-macos/testing';
import { AppleNotesSource } from '@workspace/source-apple-notes/apple-notes-source';
import { AppleRemindersSource } from '@workspace/source-apple-reminders/apple-reminders-source';

const execFile = promisify(execFileCallback);

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
  fakeEventKit(t, [
    [
      { ...eventsRead(january), ...scope },
      () => [
        ...accounts(recordedEvents.account),
        ...collections(calendar, true),
      ],
    ],
    [
      { ...eventsRead(january), ...missing },
      () => [
        ...accounts(recordedEvents.account),
        ...collections(calendar, false),
      ],
    ],
    [
      { ...remindersRead, ...scope },
      () => [
        ...accounts(recordedReminders.account),
        ...collections(list, true),
      ],
    ],
    [
      { ...remindersRead, ...missing },
      () => [
        ...accounts(recordedReminders.account),
        ...collections(list, false),
      ],
    ],
  ]);
  const listed = async (source: Source, streams: readonly Stream[]) => {
    const rows = await readRows(source, streams);
    return streams.map((stream) => rows(stream).map(({ id }) => id));
  };
  const calendars = new AppleCalendarSource({ ...january, scope });
  const noCalendars = new AppleCalendarSource({ ...january, scope: missing });
  const reminders = new AppleRemindersSource(scope);
  const noReminders = new AppleRemindersSource(missing);

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
        './eventkit',
        import.meta.resolve('@workspace/source-apple-eventkit/eventkit'),
      ),
    );
    const calendar = new AppleCalendarSource(january);
    const reminders = new AppleRemindersSource();
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
      startAt: new Date(now - 7 * day).toISOString(),
      endAt: new Date(now + 7 * day).toISOString(),
    });
    const reminders = new AppleRemindersSource();
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
  let watch: (signal: AbortSignal) => AsyncIterable<string> = quiet;
  fakeEventKit(t, [], (signal) => watch(signal));
  const calendar = new AppleCalendarSource(january);
  const reminders = new AppleRemindersSource();
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
    watch = () => {
      throw cause;
    };
    await assert.rejects(watching(source, stream).next(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, name);
      assert.match(error.message, access);
      assert.equal(error.cause, cause);
      return true;
    });
  }
  watch = async function* () {
    yield 'unexpected';
  };
  await assert.rejects(
    watching(calendar, calendar.events).next(),
    /invalid notification/,
  );
  watch = async function* () {
    yield 'changed';
  };
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
  const calendar = new AppleCalendarSource({ startAt, endAt });
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
