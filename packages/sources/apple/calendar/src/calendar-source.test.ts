import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  Stream,
} from '@workspace/elt';
import { MarkdownDestination } from '@workspace/elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  type SQLiteTable,
} from '@workspace/elt-sqlite';
import { GaxiosError, type GoogleRequester } from '@workspace/google-auth';
import type { EventKitDocument } from '@workspace/source-apple-eventkit/eventkit-documents';
import {
  account,
  alarm,
  at,
  calendar,
  eventId,
  eventsRead,
  fakeEventKit,
  icsItem,
  january,
  list,
  occurrence,
  participant,
  recordedEvents,
  rule,
} from '@workspace/source-apple-eventkit/testing';
import { appleImport, readRows } from '@workspace/source-apple-macos/testing';

import {
  AppleCalendarSource,
  CalendarIcsUnavailableError,
} from './apple-calendar-source.ts';
import { googleCalendarAttachments } from './google-calendar-attachments.ts';

test(
  'Calendar extracts every scalar stream into SQLite and Markdown',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
    // Every stream is read without the private ICS export.
    fakeEventKit(t, [
      [
        eventsRead(january),
        () => [
          account(),
          calendar(),
          occurrence({
            attendees: [participant()],
            // Hand-built: only a weekly rule without list values was recorded.
            recurrenceRules: [rule({ frequency: 2, daysOfTheMonth: [-1] })],
          }),
        ],
      ],
    ]);

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
    const copies = streams.map(
      (stream) => new Copy(stream, sqlite.table(stream.name)),
    );
    const result = await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination: sqlite,
          steps: copies,
        }),
      ],
    }).run();

    // The recorded standup carries three alarms.
    assert.deepEqual(
      result.map(({ count }) => count),
      [1, 1, 1, 1, 3, 1, 1],
    );
    const id = eventId('item-1', '2025-01-02T06:00:00.000Z');
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
    assert.deepEqual(table(source.accounts), [
      { id: 'account-1', name: 'Default', type: 0, isDelegate: 0 },
    ]);
    assert.deepEqual(table(source.calendars), [
      {
        id: 'calendar-1',
        accountId: 'account-1',
        name: 'Synthetic calendar',
        type: 0,
        writable: 1,
        subscribed: 0,
        immutable: 0,
        colorRed: 0.7960784435272217,
        colorGreen: 0.1882352977991104,
        colorBlue: 0.8784313797950745,
        colorAlpha: 1,
        supportedAvailabilities: 0,
        allowedEntityTypes: 1,
        description: 'Synthetic calendar for recorded EventKit test data',
      },
    ]);
    assert.deepEqual(table(source.events), [
      {
        id,
        eventId: id,
        calendarId: 'calendar-1',
        calendarItemId: 'item-1',
        externalId: 'external-1',
        nativeEventId: 'account-1:external-1',
        name: 'Synthetic standup',
        body: 'Synthetic notes',
        location: 'Synthetic Room 1',
        url: 'https://example.com/standup',
        startAt: '2025-01-02T06:00:00.000Z',
        endAt: '2025-01-02T07:00:00.000Z',
        allDay: 0,
        startDate: null,
        endDate: null,
        timeZone: 'Asia/Amman',
        // EventKit's sub-millisecond precision does not survive.
        createdAt: '2026-10-01T10:41:19.941Z',
        modifiedAt: '2026-10-01T10:41:19.941Z',
        occurrenceAt: '2025-01-02T06:00:00.000Z',
        occurrenceDate: null,
        detached: 0,
        status: 0,
        availability: -1,
        birthdayContactId: null,
        locationTitle: 'Synthetic Room 1',
        latitude: null,
        longitude: null,
        radius: 0,
      },
    ]);
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
    const [event] = (await readRows(source, [source.events]))(source.events);
    const document = await readFile(join(markdown.path, 'events.md'), 'utf8');
    assert.match(document, /^## Synthetic standup$/m);
    assert.ok(
      document.includes(Buffer.from(JSON.stringify(event)).toString('base64')),
    );
  },
);

test(
  'Calendar validates its request range and preflights without the EventKit helper',
  {
    concurrency: false,
  },
  async (t) => {
    assert.throws(
      () =>
        new AppleCalendarSource({
          startAt: '2025-01-02T03:04:05.006Z',
          endAt: '2025-01-02T03:04:05.006Z',
        }),
      /startAt < endAt/,
    );
    assert.throws(
      () =>
        new AppleCalendarSource({
          startAt: '2025-01-01',
          endAt: '2025-01-02T03:04:05.006Z',
        }),
      /canonical UTC/,
    );

    const source = new AppleCalendarSource(january);
    // A rolling window keeps one checkpoint; incremental copies delete what left it.
    assert.equal(source.identity, 'apple-calendar:eventkit');
    assert.equal(
      new AppleCalendarSource({ ...january, endAt: '2025-03-01T00:00:00.000Z' })
        .identity,
      source.identity,
    );
    // Set up for no request: a read throws, so each rejection below must come
    // from validation before the helper is reached.
    fakeEventKit(t, []);
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

test(
  'Calendar rejects malformed records and preserves prior Markdown on native failures',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
    let respond: () => Iterable<EventKitDocument> = () => [occurrence()];
    fakeEventKit(t, [[eventsRead(january), () => respond()]]);
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
    // Injects malformed documents on purpose: each must fail the read.
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
      respond = () => [document];
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
    respond = () => [occurrence()];
    await sqliteRun();
    // Injects a malformed document on purpose.
    const malformed = { ...occurrence(), body: { nested: true } };
    // @ts-expect-error -- body is an object on purpose
    respond = () => [malformed];
    await assert.rejects(sqliteRun(), /invalid events\.body/);
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      {
        ...database.prepare('SELECT id, name FROM events').get(),
      },
      { id: eventId('item-1'), name: 'Synthetic standup' },
    );

    // Injects helper access failures on purpose, as the helper reports them on
    // stderr.
    const unavailable = Object.assign(new Error('eventkit exited'), {
      stderr: 'CALENDAR_UNAVAILABLE: full access is required; status=2\n',
    });
    const revoked = Object.assign(new Error('eventkit exited'), {
      stderr:
        'CALENDAR_UNAVAILABLE: access was revoked during execution; status=2\n',
    });
    for (const [failure, fail] of [
      [
        unavailable,
        () => {
          throw unavailable;
        },
      ],
      // The helper checks access again after writing every document.
      [
        revoked,
        function* () {
          yield occurrence();
          throw revoked;
        },
      ],
    ] as const) {
      respond = fail;
      await assert.rejects(
        run(),
        // Opening the read fails, so every copy reports it, as the run's cause.
        (error: unknown) =>
          error instanceof PipelineError &&
          error.cause instanceof Error &&
          error.cause.name === 'CalendarUnavailableError' &&
          /full Calendar access/.test(error.cause.message) &&
          error.cause.cause === failure,
      );
      assert.equal(await readFile(path, 'utf8'), previous);
    }

    // Injects a helper failure without a marker on purpose.
    const native = new Error('native EventKit failure');
    respond = () => {
      throw native;
    };
    await assert.rejects(
      run(),
      (error: unknown) =>
        error instanceof PipelineError && error.cause === native,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  },
);

test(
  'Calendar snapshot incremental reconciles added, changed, moved and removed rows',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
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
    let native = [event('e1', 'Standup', ['Ann', 'Bo']), event('e2', 'Review')];
    fakeEventKit(t, [[eventsRead(january), () => native]]);
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
            new Copy(
              source.attendees,
              sqlite.table('attendees'),
              snapshot('attendees'),
            ),
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
      const column = (sql: string) =>
        database
          .prepare(sql)
          .all()
          .map((row) => Object.values(row).join(':'));
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
        events: column('SELECT id, name FROM events ORDER BY id'),
        attendees: column('SELECT id, name FROM attendees ORDER BY id'),
        markdown: titles.sort(),
      };
    };

    assert.deepEqual(await run(), [
      { count: 2, deleted: 0 },
      { count: 2, deleted: 0 },
      { count: 2, deleted: 0 },
    ]);
    // e1 is renamed, e2 moved out of the window, e3 is new, and Bo left e1: the
    // positional child row vanishes like any other key.
    native = [event('e1', 'Daily', ['Ann']), event('e3', 'Planning', ['Cy'])];
    assert.deepEqual(await run(), [
      { count: 2, deleted: 1 },
      { count: 1, deleted: 1 },
      { count: 2, deleted: 1 },
    ]);
    assert.deepEqual(await loaded(), {
      events: [`${eventId('e1')}:Daily`, `${eventId('e3')}:Planning`],
      attendees: [
        `${JSON.stringify([eventId('e1'), 'attendee', 0])}:Ann`,
        `${JSON.stringify([eventId('e3'), 'attendee', 0])}:Cy`,
      ],
      markdown: ['Daily', 'Planning'],
    });
    assert.deepEqual(await run(), [
      { count: 0, deleted: 0 },
      { count: 0, deleted: 0 },
      { count: 0, deleted: 0 },
    ]);
  },
);

test(
  'Calendar keeps the first copy of an occurrence the helper returns for adjacent windows',
  {
    concurrency: false,
  },
  async (t) => {
    const window = {
      startAt: '2024-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:00:00.000Z',
    };
    const source = new AppleCalendarSource(window);
    // The helper reads one-year windows and writes an occurrence once per
    // window it overlaps: "spanning" overlaps both, "late" only the second.
    const spanning = occurrence({
      calendarItemId: 'spanning',
      attendees: [participant()],
    });
    fakeEventKit(t, [
      [
        eventsRead(window),
        () => [
          spanning,
          { ...spanning, name: 'Second window copy' },
          occurrence({ calendarItemId: 'late' }),
        ],
      ],
    ]);
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
        .prepare('SELECT id, name FROM events ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: eventId('late'), name: 'Synthetic standup' },
        { id: eventId('spanning'), name: 'Synthetic standup' },
      ],
    );
    const attendees = (await readRows(source, [source.attendees]))(
      source.attendees,
    );
    assert.deepEqual(
      attendees.map((row) => row.eventId),
      [eventId('spanning')],
    );
  },
);

test('Calendar links alarms, recurrence rules and rule values to their occurrence', async (t) => {
  const window = {
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-01-02T00:00:00.000Z',
  };
  const source = new AppleCalendarSource(window);
  fakeEventKit(t, [
    [
      eventsRead(window),
      () => [
        occurrence({
          startMs: at('2025-01-01T00:00:00.000Z'),
          endMs: at('2025-01-01T01:00:00.000Z'),
          startDay: '2025-01-01',
          endDay: '2025-01-01',
          occurrenceMs: at('2025-01-01T00:00:00.000Z'),
          occurrenceDay: '2025-01-01',
          // Hand-built: only a weekly rule without list values was recorded.
          recurrenceRules: [rule({ frequency: 2, daysOfTheMonth: [-1] })],
        }),
      ],
    ],
  ]);

  const rows = await readRows(source, [
    source.events,
    source.alarms,
    source.recurrenceRules,
    source.recurrenceRuleValues,
  ]);

  const [event] = rows(source.events);
  const alarmRow = rows(source.alarms).find(
    ({ relativeOffset }) => relativeOffset === -600,
  );
  const ruleRow = rows(source.recurrenceRules).find(
    ({ interval }) => interval === 1,
  );
  assert.ok(event);
  assert.equal(alarmRow?.eventId, event.id);
  assert.equal(ruleRow?.eventId, event.id);
  assert.equal(ruleRow?.occurrenceCount, 3);
  const value = rows(source.recurrenceRuleValues).find(
    ({ component }) => component === 'daysOfTheMonth',
  );
  assert.equal(value?.value, -1);
  assert.equal(value?.ruleId, ruleRow?.id);
});

test('Calendar numbers attendees and alarms the same whatever order EventKit returns them in', async (t) => {
  const source = new AppleCalendarSource(january);
  const attendee = (address: string, status: number) =>
    participant({ name: address, url: `mailto:${address}`, status });
  let attendees = [attendee('a@example.com', 2), attendee('b@example.com', 1)];
  let alarms = recordedEvents.standup.alarms;
  fakeEventKit(t, [
    [eventsRead(january), () => [occurrence({ attendees, alarms })]],
  ]);
  const read = async () => {
    const rows = await readRows(source, [source.attendees, source.alarms]);
    return { attendees: rows(source.attendees), alarms: rows(source.alarms) };
  };
  const rows = (records: Record<string, unknown>[], field: string) =>
    records.map((record) => [record.id, record[field]]);

  const before = await read();
  // A reply changes status, so the replying attendee keeps its row.
  attendees = [attendee('b@example.com', 2), attendee('a@example.com', 2)];
  alarms = alarms.toReversed();
  const after = await read();

  assert.deepEqual(
    rows(after.alarms, 'relativeOffset'),
    rows(before.alarms, 'relativeOffset'),
  );
  assert.deepEqual(rows(after.attendees, 'url'), rows(before.attendees, 'url'));
  assert.deepEqual(
    after.attendees.map(({ status }) => status),
    [2, 2],
  );
});

test('Calendar occurrence keys survive rescheduling and preserve all-day dates', async (t) => {
  const source = new AppleCalendarSource(january);
  const original = recordedEvents.weekly;
  let native: EventKitDocument[] = [original];
  fakeEventKit(t, [[eventsRead(january), () => native]]);
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

  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 0 }]);
  native = [
    {
      ...original,
      detached: true,
      startMs: at('2025-01-05T08:00:00.000Z'),
      endMs: at('2025-01-05T08:30:00.000Z'),
      startDay: '2025-01-05',
      endDay: '2025-01-05',
    },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 0 }]);
  {
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT id, startAt, detached FROM events')
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: eventId('item-3', '2025-01-04T06:00:00.000Z'),
          startAt: '2025-01-05T08:00:00.000Z',
          detached: 1,
        },
      ],
    );
  }

  // Hand-built from the recorded all-day event, which was read with TZ=UTC
  // and does not repeat: here it repeats and a process in Asia/Amman (UTC+3)
  // reads it, so the day starts at 21:00Z the day before, and saved all-day
  // events end one second before the next local midnight (verified live
  // before this recording).
  native = [
    {
      ...recordedEvents.holiday,
      startMs: at('2024-12-31T21:00:00.000Z'),
      endMs: at('2025-01-01T20:59:59.000Z'),
      startDay: '2025-01-01',
      endDay: '2025-01-01',
      occurrenceMs: at('2024-12-31T21:00:00.000Z'),
      occurrenceDay: '2025-01-01',
      recurrenceRules: [rule()],
    },
  ];
  const [day] = (await readRows(source, [source.events]))(source.events);
  assert.ok(day);
  assert.equal(day.startDate, '2025-01-01');
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
});

test(
  'iCalendar parsing unfolds lines, keeps parameters and vendor properties, and nests components',
  {
    concurrency: false,
  },
  async (t) => {
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

    const source = new AppleCalendarSource(january);
    // The same export twice: once with CRLF line endings, once with bare LF.
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [
          { ...icsItem('windows', ''), ics: ics.toString('base64') },
          {
            ...icsItem('unix', ''),
            ics: Buffer.from(
              ics.toString('latin1').replaceAll('\r\n', '\n'),
              'latin1',
            ).toString('base64'),
          },
        ],
      ],
    ]);

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
  async (t) => {
    const source = new AppleCalendarSource(january);
    // Injects malformed exports on purpose.
    let ics = Buffer.alloc(0);
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [{ ...icsItem('malformed', ''), ics: ics.toString('base64') }],
      ],
    ]);
    const parse = (content: string | Buffer) => {
      ics = Buffer.from(content);
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

const seriesICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:series@example.com',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'EXDATE;TZID=Asia/Amman:20250115T090000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series@example.com',
  'RECURRENCE-ID;TZID=Asia/Amman:20250108T090000',
  'SUMMARY:Moved',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

test(
  'an unchanged Calendar item writes nothing when the export lists its exceptions and alarms in another order',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
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
    let reversed = false;
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [icsItem('series', exported(reversed), true)],
      ],
    ]);
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
    reversed = true;
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
  'Calendar ICS streams load components, raw properties and parameters with exact event links',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [
          icsItem('meeting', meetingICS),
          icsItem('series', seriesICS, true),
        ],
      ],
    ]);
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
      [5, 12, 4],
    );
    using database = new DatabaseSync(sqlite.path, { readOnly: true });
    const components = database
      .prepare(
        'SELECT calendarItemId, name, uid, recurrenceId, recurrenceIdTimeZone, eventId FROM icsComponents ORDER BY id',
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(components, [
      {
        calendarItemId: 'meeting',
        name: 'VCALENDAR',
        uid: null,
        recurrenceId: null,
        recurrenceIdTimeZone: null,
        eventId: null,
      },
      {
        calendarItemId: 'meeting',
        name: 'VEVENT',
        uid: 'meeting@example.com',
        recurrenceId: null,
        recurrenceIdTimeZone: null,
        eventId: JSON.stringify(['calendar-1', 'meeting', null]),
      },
      {
        calendarItemId: 'series',
        name: 'VCALENDAR',
        uid: null,
        recurrenceId: null,
        recurrenceIdTimeZone: null,
        eventId: null,
      },
      // Sibling components are numbered in content order, not export order.
      {
        calendarItemId: 'series',
        name: 'VEVENT',
        uid: 'series@example.com',
        recurrenceId: '20250108T090000',
        recurrenceIdTimeZone: 'Asia/Amman',
        eventId: null,
      },
      {
        calendarItemId: 'series',
        name: 'VEVENT',
        uid: 'series@example.com',
        recurrenceId: null,
        recurrenceIdTimeZone: null,
        eventId: null,
      },
    ]);
    const value = (name: string) =>
      database
        .prepare('SELECT value FROM icsProperties WHERE name = ?')
        .get(name)?.value;
    assert.equal(
      value('X-GOOGLE-CONFERENCE'),
      'https://meet.google.com/abc-defg-hij',
    );
    assert.equal(value('X-MICROSOFT-CDO-BUSYSTATUS'), 'BUSY');
    assert.equal(value('ATTACH'), 'https://example.com/agenda');
    assert.equal(value('EXDATE'), '20250115T090000');
    // DTSTAMP is the export time, not event data.
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
  },
);

test(
  'Calendar ICS rejects exports without events and reports a missing private export',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
    // Injects an export without events on purpose.
    let respond: () => Iterable<EventKitDocument> = () => [
      icsItem('empty', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
    ];
    // Only a read with the private ICS export is answered.
    fakeEventKit(t, [[eventsRead(january, true), () => respond()]]);
    await assert.rejects(
      readRows(source, [source.icsComponents]),
      /returned no VEVENT for saved item empty/,
    );
    // Injects the helper's missing-export failure on purpose.
    const cause = Object.assign(new Error('eventkit exited'), {
      stderr:
        'CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version\n',
    });
    respond = () => {
      throw cause;
    };
    // Every ICS stream must reach the export, alone or not.
    for (const stream of [
      source.icsComponents,
      source.icsProperties,
      source.icsParameters,
      source.icsAttachments,
    ])
      await assert.rejects(readRows(source, [stream]), (error) => {
        assert.ok(error instanceof CalendarIcsUnavailableError);
        assert.equal(error.cause, cause);
        return true;
      });
  },
);

test(
  'Calendar ICS snapshots delete a removed property with its parameters',
  {
    concurrency: false,
  },
  async (t) => {
    const source = new AppleCalendarSource(january);
    let ics = meetingICS;
    fakeEventKit(t, [
      [eventsRead(january, true), () => [icsItem('meeting', ics)]],
    ]);
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
    ics = meetingICS.replace(/ATTACH[^\r]*\r\n/, '');
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
  async (t) => {
    const fetched: string[] = [];
    const source = new AppleCalendarSource({
      ...january,
      attachments: async ({ uri, filename, formatType }, path) => {
        fetched.push(`${filename}:${formatType}`);
        if (uri.includes('denied')) return false;
        await writeFile(path, `bytes of ${filename}`);
        return true;
      },
    });
    fakeEventKit(t, [
      [eventsRead(january, true), () => [icsItem('files', attachmentsICS)]],
    ]);
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
          'SELECT filename, formatType, inline, (SELECT c.bytes FROM "_elt_files_attachments_bytes" c WHERE c.file = a.bytes AND c.n = 0) AS bytes FROM attachments a ORDER BY a.rowid',
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
  async (t) => {
    const source = new AppleCalendarSource(january);
    fakeEventKit(t, [
      [eventsRead(january, true), () => [icsItem('files', attachmentsICS)]],
    ]);
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
  async (t) => {
    let ics = attachmentsICS;
    let fetches = 0;
    const source = new AppleCalendarSource({
      ...january,
      attachments: async (_attachment, path) => {
        fetches++;
        await writeFile(path, 'bytes');
        return true;
      },
    });
    fakeEventKit(t, [
      [eventsRead(january, true), () => [icsItem('files', ics)]],
    ]);
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
    ics = attachmentsICS.replace(/ATTACH;FMTTYPE=text\/plain[^\r]*\r\n/, '');
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
  requester: GoogleRequester,
  directory: string,
) {
  mkdirSync(directory, { recursive: true });
  const source = new AppleCalendarSource({
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
  async (t) => {
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
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [icsItem('google', googleAttachmentsICS(Object.keys(expected)))],
      ],
    ]);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-att-'));

    const saved = await googleAttachmentFiles(requester, scratch.path);

    assert.deepEqual(saved, expected);
  },
);

test(
  'Calendar attachment downloads fail on a disabled API, a missing scope or a server error',
  {
    concurrency: false,
  },
  async (t) => {
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [
          icsItem(
            'google',
            googleAttachmentsICS(['https://drive.google.com/file/d/abc/view']),
          ),
        ],
      ],
    ]);
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
        googleAttachmentFiles(requester, join(scratch.path, String(index))),
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
  async (t) => {
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [
          icsItem(
            'google',
            googleAttachmentsICS(['https://drive.google.com/file/d/abc/view']),
          ),
        ],
      ],
    ]);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-rate-'));
    for (const reason of ['userRateLimitExceeded', 'rateLimitExceeded']) {
      const { requester } = googleRecorder(() => {
        throw googleError(403, { error: { errors: [{ reason }] } });
      });
      await assert.rejects(
        googleAttachmentFiles(requester, join(scratch.path, reason)),
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
  async (t) => {
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
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [icsItem('google', googleAttachmentsICS([shortcut, shared]))],
      ],
    ]);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-sc-'));

    const saved = await googleAttachmentFiles(requester, scratch.path);

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
  {
    concurrency: false,
  },
  async (t) => {
    // Hand-built times and attendee on the recorded standup and weekly rule.
    const weekly = [rule()];
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
        recurrenceRules: weekly,
      });
    // The warehouse loads every stream, ICS included, from one read.
    fakeEventKit(t, [
      [
        eventsRead(january, true),
        () => [
          account(),
          calendar(),
          standup('01'),
          icsItem('series', seriesICS, true),
          standup('08'),
        ],
      ],
    ]);
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'cal-marts-'));
    const imported = await appleImport(
      new AppleCalendarSource(january),
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
      [{ occurrences: 2, components: 4 }],
    );
  },
);
