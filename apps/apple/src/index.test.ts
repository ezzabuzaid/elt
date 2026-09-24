import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import {
  mkdtempDisposable,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import {
  Copy,
  type CopyConfiguration,
  MarkdownDestination,
  Pipeline,
  PipelineError,
  SQLiteCheckpointStore,
  SQLiteDestination,
  Stream,
} from 'elt';
import {
  AppleCalendarSource,
  AppleNotesSource,
  AppleRemindersSource,
  CalendarIcsUnavailableError,
  CalendarUnavailableError,
  NotesUnavailableError,
  RemindersUnavailableError,
} from './index.ts';
import { EventKit } from './platform/macos/eventkit.ts';
import osa from './platform/macos/osa.ts';
import { calendarScript } from './sources/apple-calendar/calendar-script.ts';
import { parseICalendar } from './sources/apple-calendar/icalendar.ts';
import { AttachmentsStream } from './sources/apple-notes/attachments-stream.ts';
import { remindersScript } from './sources/apple-reminders/reminders-script.ts';

const execFile = promisify(execFileCallback);

type Field = {
  readonly type: string | readonly string[];
  readonly format?: string;
  readonly minimum?: number;
};

const timestamp = '2025-01-02T03:04:05.006Z';

function recordFor(
  stream: Stream,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const fields = stream.jsonSchema.properties as Record<string, Field>;
  const record = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const types = typeof field.type === 'string' ? [field.type] : field.type;
      const nullable = types.includes('null');
      if (nullable) return [name, null];
      if (field.format === 'date-time') return [name, timestamp];
      if (field.format === 'date') return [name, '2025-01-02'];
      if (types.includes('boolean')) return [name, false];
      if (types.includes('integer')) return [name, field.minimum ?? 0];
      if (types.includes('number')) return [name, field.minimum ?? 0];
      const foreignKeys: Record<string, string> = {
        accountId: 'account-1',
        calendarId: 'calendar-1',
        eventId: 'event-1',
        calendarItemId: 'calendar-item-1',
        ruleId: 'recurrence-rule-1',
      };
      return [name, foreignKeys[name] ?? `${stream.name}-${name}`];
    }),
  );
  return { ...record, id: `${stream.name}-1`, ...overrides };
}

function calendarEvents(source: AppleCalendarSource): Record<string, unknown> {
  return recordFor(source.events, {
    id: 'event-1',
    eventId: 'event-1',
    calendarId: 'calendar-1',
    calendarItemId: 'calendar-item-1',
    startAt: timestamp,
    endAt: '2025-01-02T04:04:05.006Z',
    allDay: false,
  });
}

function streamName(script: string): string {
  const name = /read(?:Calendar|Reminders)\(store, "([^"]+)"/.exec(script)?.[1];
  assert.ok(name, 'EventKit extraction did not call its reader');
  return name;
}

test('Notes adapts its records to the ELT pipeline', async () => {
  class Notes extends AppleNotesSource {
    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'account-1', name: 'Test account', upgraded: true },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-test-'));
  const source = new Notes();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const copy = new Copy(source.accounts, destination.table('accounts'));
  const results = await new Pipeline({
    source,
    destination,
    steps: [copy],
  }).run();

  assert.deepEqual(results, [{ copy, count: 1, deleted: 0 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const row = database.prepare('SELECT id, name FROM accounts').get();
  assert.ok(row);
  assert.deepEqual({ ...row }, { id: 'account-1', name: 'Test account' });
});

test('Notes uses native file availability and rolls back actual export failures', async (t) => {
  const source = new AppleNotesSource();
  const nativeError = Object.assign(new Error('Command failed: osascript'), {
    stderr:
      'execution error: Error: Error: AppleEvent handler failed. (-10000)\n',
  });
  const records = [
    recordFor(source.attachments, { id: 'file-1', name: 'example.txt' }),
    recordFor(source.attachments, { id: 'embedded-1', name: null }),
    recordFor(source.attachments, { id: 'url-1', url: 'https://example.com' }),
    recordFor(source.attachments, { id: 'locked-1' }),
  ];
  const stagedPaths: string[] = [];
  t.mock.method(osa, 'execute', async (script: string) => {
    if (!script.includes('app.save')) return JSON.stringify(records);
    return runInNewContext(script, {
      Application: () => ({
        running: () => true,
        attachments: {
          byId: (id: string) => ({
            id,
            container: () => ({ passwordProtected: () => id === 'locked-1' }),
            url: () => (id === 'url-1' ? 'https://example.com' : null),
            contents: () => (id === 'embedded-1' ? null : {}),
          }),
        },
        save: (attachment: { id: string }, options: { in: string }) => {
          if (attachment.id !== 'file-1') throw nativeError;
          writeFileSync(options.in, 'example');
        },
      }),
      Path: (path: string) => {
        stagedPaths.push(path);
        return path;
      },
    }) as string;
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const copy = new Copy(
    source.attachments,
    destination.table('attachments', (c) => [
      c.text('id'),
      c.blob('bytes').from(source.attachments.file),
    ]),
  );
  const pipeline = new Pipeline({ source, destination, steps: [copy] });
  assert.deepEqual(await pipeline.run(), [{ copy, count: 4, deleted: 0 }]);
  using database = new DatabaseSync(destination.path);
  const rows = () =>
    database
      .prepare('SELECT id, bytes FROM attachments')
      .all()
      .map((row) => ({ ...row }));
  const expected = [
    { id: 'file-1', bytes: new Uint8Array(Buffer.from('example')) },
    ...['embedded-1', 'url-1', 'locked-1'].map((id) => ({ id, bytes: null })),
  ];
  assert.deepEqual(rows(), expected);
  records.push(
    recordFor(source.attachments, { id: 'broken-1', name: 'broken.txt' }),
  );
  await assert.rejects(pipeline.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.failedCopy, copy);
    assert.equal(error.cause, nativeError);
    return true;
  });
  assert.deepEqual(rows(), expected);
  for (const path of stagedPaths)
    await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('Notes becoming unavailable during attachment export retains its actionable error', async (t) => {
  const cause = Object.assign(new Error('Command failed: osascript'), {
    stderr: 'execution error: Error: NOTES_UNAVAILABLE (-2700)\n',
  });
  t.mock.method(osa, 'execute', async () => {
    throw cause;
  });
  await assert.rejects(
    new AttachmentsStream().save('attachment-1', '/unused'),
    (error) => {
      assert.ok(error instanceof NotesUnavailableError);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test('Notes incremental copies skip unchanged notes, catch backdated edits and delete removed notes', async (t) => {
  const source = new AppleNotesSource();
  const note = (id: string, body: string, modifiedAt = timestamp) =>
    recordFor(source.notes, { id, body, modifiedAt });
  let notes = [note('first', 'one'), note('second', 'two')];
  t.mock.method(osa, 'execute', async () => JSON.stringify(notes));
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const copy = new Copy(source.notes, destination.table('notes'), {
    id: 'notes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
  });
  const rows = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, body FROM notes ORDER BY id')
      .all()
      .map((row) => `${row.id}:${row.body}`);
  };

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  // second changes without advancing modifiedAt, which a cursor would miss.
  notes = [
    note('first', 'one'),
    note('second', 'two, edited', '2020-01-01T00:00:00.000Z'),
    note('third', 'three'),
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  notes = [
    note('second', 'two, edited', '2020-01-01T00:00:00.000Z'),
    note('third', 'three'),
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 1 }]);
  assert.deepEqual(rows(), ['second:two, edited', 'third:three']);
  assert.throws(
    () =>
      new Copy(source.notes, destination.table('notes'), {
        id: 'notes',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        primaryKey: ['id'],
        cursorField: 'modifiedAt',
      }).validate(source, destination, checkpoints),
    /defines its own cursor; omit cursorField/,
  );
});

test('Notes incremental attachment copies export files only for changed attachments', async (t) => {
  const source = new AppleNotesSource();
  const unchanged = recordFor(source.attachments, { id: 'a1', name: 'a.txt' });
  let attachments = [
    unchanged,
    recordFor(source.attachments, { id: 'a2', name: 'b.txt' }),
  ];
  const saved: string[] = [];
  t.mock.method(osa, 'execute', async (script: string) => {
    if (!script.includes('app.save')) return JSON.stringify(attachments);
    return runInNewContext(script, {
      Application: () => ({
        running: () => true,
        attachments: {
          byId: (id: string) => ({
            id,
            container: () => ({ passwordProtected: () => false }),
            url: () => null,
            contents: () => ({}),
          }),
        },
        save: (attachment: { id: string }, options: { in: string }) => {
          saved.push(attachment.id);
          writeFileSync(options.in, `bytes of ${attachment.id}`);
        },
      }),
      Path: (path: string) => path,
    }) as string;
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const copy = new Copy(
    source.attachments,
    destination.table('attachments', (c) => [
      c.text('id'),
      c.blob('bytes').from(source.attachments.file),
    ]),
    {
      id: 'attachments',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      primaryKey: ['id'],
    },
  );
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [copy],
  });

  await pipeline.run();
  attachments = [
    unchanged,
    recordFor(source.attachments, { id: 'a2', name: 'b-renamed.txt' }),
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 0 }]);
  assert.deepEqual(saved, ['a1', 'a2', 'a2']);
});

test('Notes rejects malformed native records and keeps unavailability actionable on read', async (t) => {
  const source = new AppleNotesSource();
  let response: unknown;
  const unavailable = Object.assign(new Error('Command failed: osascript'), {
    stderr: 'execution error: Error: NOTES_UNAVAILABLE (-2700)\n',
  });
  let failure: Error | undefined;
  t.mock.method(osa, 'execute', async () => {
    if (failure) throw failure;
    return JSON.stringify(response);
  });
  const destination = new MarkdownDestination({ path: '/unused' });
  const read = (stream: Stream) =>
    Array.fromAsync(
      source.read(
        new Copy(stream, destination.file(`${stream.name}.md`)).configuration,
        null,
      ),
    );

  for (const stream of [
    source.accounts,
    source.folders,
    source.notes,
    source.attachments,
  ]) {
    response = [recordFor(stream)];
    assert.equal((await read(stream)).length, 1);
    for (const [malformed, message] of [
      [{}, `Notes returned invalid ${stream.name} records`],
      [[null], `Notes returned an invalid ${stream.name} record`],
      [
        [recordFor(stream, { id: 1 })],
        `Notes returned invalid ${stream.name}.id`,
      ],
      [
        [{ ...recordFor(stream), extra: true }],
        `Notes returned an invalid ${stream.name} record`,
      ],
    ] as const) {
      response = malformed;
      await assert.rejects(read(stream), { message });
    }
  }
  for (const stream of [source.notes, source.attachments]) {
    response = [recordFor(stream, { createdAt: '2025-01-02T03:04:05Z' })];
    await assert.rejects(read(stream), {
      message: `Notes returned invalid ${stream.name}.createdAt`,
    });
  }
  failure = unavailable;
  await assert.rejects(read(source.notes), (error) => {
    assert.ok(error instanceof NotesUnavailableError);
    assert.equal(error.cause, unavailable);
    return true;
  });
});

test('Notes JXA projection omits protected content and preserves absent attachment metadata', async (t) => {
  const source = new AppleNotesSource();
  const date = new Date(timestamp);
  const note = (id: string, passwordProtected: boolean) => ({
    id: () => id,
    name: () => id,
    container: () => ({ id: () => 'folder-1' }),
    passwordProtected: () => passwordProtected,
    body: () => '<p>secret</p>',
    plaintext: () => 'secret',
    creationDate: () => date,
    modificationDate: () => date,
    shared: () => false,
  });
  t.mock.method(
    osa,
    'execute',
    async (script: string) =>
      runInNewContext(script, {
        Application: () => ({
          running: () => true,
          notes: () => [note('open', false), note('locked', true)],
          attachments: () => [
            {
              id: () => 'attachment-1',
              name: () => undefined,
              container: () => ({ id: () => 'open' }),
              contentIdentifier: () => undefined,
              url: () => undefined,
              creationDate: () => date,
              modificationDate: () => date,
              shared: () => true,
            },
          ],
        }),
      }) as string,
  );
  const destination = new MarkdownDestination({ path: '/unused' });
  const read = (stream: Stream) =>
    Array.fromAsync(
      source.read(
        new Copy(stream, destination.file('x.md')).configuration,
        null,
      ),
    );
  const projected = (id: string, passwordProtected: boolean) => ({
    stream: 'notes',
    data: {
      id,
      name: id,
      containerId: 'folder-1',
      body: passwordProtected ? null : '<p>secret</p>',
      plaintext: passwordProtected ? null : 'secret',
      createdAt: timestamp,
      modifiedAt: timestamp,
      passwordProtected,
      shared: false,
    },
  });

  assert.deepEqual(await read(source.notes), [
    projected('open', false),
    projected('locked', true),
  ]);
  assert.deepEqual(await read(source.attachments), [
    {
      stream: 'attachments',
      data: {
        id: 'attachment-1',
        name: null,
        containerId: 'open',
        contentId: null,
        url: null,
        createdAt: timestamp,
        modifiedAt: timestamp,
        shared: true,
      },
    },
  ]);
});

test('Notes rejects an attachment export that is not a regular file', async (t) => {
  const source = new AppleNotesSource();
  t.mock.method(osa, 'execute', async (script: string) => {
    if (!script.includes('app.save'))
      return JSON.stringify([
        recordFor(source.attachments, { id: 'bundle-1', name: 'a.pages' }),
      ]);
    return runInNewContext(script, {
      Application: () => ({
        running: () => true,
        attachments: {
          byId: () => ({
            container: () => ({ passwordProtected: () => false }),
            url: () => null,
            contents: () => ({}),
          }),
        },
        save: (_attachment: unknown, options: { in: string }) =>
          mkdirSync(options.in),
      }),
      Path: (path: string) => path,
    }) as string;
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const copy = new Copy(
    source.attachments,
    destination.table('attachments', (c) => [
      c.text('id'),
      c.blob('bytes').from(source.attachments.file),
    ]),
  );

  await assert.rejects(
    new Pipeline({ source, destination, steps: [copy] }).run(),
    (error) => {
      assert.ok(error instanceof PipelineError);
      assert.match(String(error.cause), /regular attachment file/);
      return true;
    },
  );
});

test('Calendar extracts every scalar stream into SQLite and Markdown', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const records: Record<string, Record<string, unknown>[]> = {
    accounts: [recordFor(source.accounts, { id: 'account-1' })],
    calendars: [recordFor(source.calendars, { id: 'calendar-1' })],
    events: [calendarEvents(source)],
    eventMetadata: [
      recordFor(source.eventMetadata, {
        id: 'calendar-item-metadata-1',
        calendarId: 'calendar-1',
        calendarItemId: 'calendar-item-1',
        scriptingUid: 'series-item-1',
        rawRecurrence: 'RRULE:FREQ=WEEKLY',
        sequence: 7,
      }),
    ],
    excludedDates: [
      recordFor(source.excludedDates, {
        id: 'calendar-item-metadata-1-excluded-0',
        eventMetadataId: 'calendar-item-metadata-1',
        excludedAt: timestamp,
        excludedDate: null,
      }),
    ],
    attendees: [recordFor(source.attendees)],
    alarms: [recordFor(source.alarms)],
    recurrenceRules: [recordFor(source.recurrenceRules)],
    recurrenceRuleValues: [recordFor(source.recurrenceRuleValues)],
  };
  const scripts: string[] = [];
  t.mock.method(osa, 'execute', async (script: string) => {
    scripts.push(script);
    const name = streamName(script);
    return JSON.stringify(
      name === 'eventMetadata' || name === 'excludedDates'
        ? { records: records[name], nextCursor: null }
        : records[name],
    );
  });

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
    source.eventMetadata,
    source.excludedDates,
    source.attendees,
    source.alarms,
    source.recurrenceRules,
    source.recurrenceRuleValues,
  ];
  const copies = streams.map(
    (stream) => new Copy(stream, sqlite.table(stream.name)),
  );
  const result = await new Pipeline({
    source,
    destination: sqlite,
    steps: copies,
  }).run();

  assert.deepEqual(
    result.map(({ count }) => count),
    Array(9).fill(1),
  );
  assert.equal(scripts.length, 9);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT calendarItemId, scriptingUid, rawRecurrence, sequence FROM eventMetadata',
        )
        .get(),
    },
    {
      calendarItemId: 'calendar-item-1',
      scriptingUid: 'series-item-1',
      rawRecurrence: 'RRULE:FREQ=WEEKLY',
      sequence: 7,
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT eventMetadataId, excludedAt, excludedDate FROM excludedDates',
        )
        .get(),
    },
    {
      eventMetadataId: 'calendar-item-metadata-1',
      excludedAt: timestamp,
      excludedDate: null,
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT id, calendarId, startAt, endAt, allDay, startDate FROM events',
        )
        .get(),
    },
    {
      id: 'event-1',
      calendarId: 'calendar-1',
      startAt: timestamp,
      endAt: '2025-01-02T04:04:05.006Z',
      allDay: 0,
      startDate: null,
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT eventId, ruleId, component, position, value FROM recurrenceRuleValues',
        )
        .get(),
    },
    {
      eventId: 'event-1',
      ruleId: 'recurrence-rule-1',
      component: 'recurrenceRuleValues-component',
      position: 0,
      value: 0,
    },
  );

  const markdown = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  await new Pipeline({
    source,
    destination: markdown,
    steps: [
      new Copy(source.events, markdown.file('events.md', { title: 'name' })),
    ],
  }).run();
  const document = await readFile(join(markdown.path, 'events.md'), 'utf8');
  assert.match(
    document,
    new RegExp(
      Buffer.from(JSON.stringify(calendarEvents(source))).toString('base64'),
    ),
  );
});

test('Calendar validates its request range and preflights without OSA', {
  concurrency: false,
}, async (t) => {
  assert.throws(
    () => new AppleCalendarSource({ startAt: timestamp, endAt: timestamp }),
    /startAt < endAt/,
  );
  assert.throws(
    () => new AppleCalendarSource({ startAt: '2025-01-01', endAt: timestamp }),
    /canonical UTC/,
  );

  const january = {
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  };
  const source = new AppleCalendarSource(january);
  // A rolling window keeps one checkpoint; incremental copies delete what left it.
  assert.equal(source.identity, 'apple-calendar:eventkit');
  assert.equal(
    new AppleCalendarSource({ ...january, endAt: '2025-03-01T00:00:00.000Z' })
      .identity,
    source.identity,
  );
  let calls = 0;
  t.mock.method(osa, 'execute', async () => {
    calls++;
    return '[]';
  });
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
    primaryKey: ['id'],
    id: 'events',
  } as const;
  for (const [options, message] of [
    [
      { destinationSyncMode: 'overwrite_dedup' },
      /cannot use overwrite loading/,
    ],
    [
      { destinationSyncMode: 'append', primaryKey: undefined },
      /require append_dedup/,
    ],
    [{ cursorField: 'modifiedAt' }, /defines its own cursor; omit cursorField/],
    [{ dedupPolicy: 'cursor_newer' }, /no cursor field to compare/],
    [{ primaryKey: ['eventId'] }, /select primaryKey \["id"\]/],
  ] as const)
    await assert.rejects(
      new Pipeline({
        source,
        destination: sqlite,
        checkpoints,
        steps: [
          new Copy(source.events, sqlite.table('events'), {
            ...snapshotCopy,
            ...options,
          } as ConstructorParameters<typeof Copy>[2]),
        ],
      }).run(),
      message,
    );
  const forged = new Stream({
    name: 'events',
    jsonSchema: source.events.jsonSchema,
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  await assert.rejects(
    new Pipeline({
      source,
      destination: sqlite,
      steps: [new Copy(forged, sqlite.table('forged-events'))],
    }).run(),
    /discovered catalog/,
  );
  assert.throws(() => source.events.file, /does not support file extraction/);
  assert.equal(calls, 0);
});

test('Calendar rejects malformed records and preserves prior Markdown on native failures', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  let response: (script: string) => Promise<string> = async () =>
    JSON.stringify([calendarEvents(source)]);
  t.mock.method(osa, 'execute', (script: string) => response(script));
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-calendar-'),
  );
  const markdown = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  const run = () =>
    new Pipeline({
      source,
      destination: markdown,
      steps: [new Copy(source.events, markdown.file('events.md'))],
    }).run();

  await run();
  const path = join(markdown.path, 'events.md');
  const previous = await readFile(path, 'utf8');
  const malformed = [
    null,
    (() => {
      const record = calendarEvents(source);
      delete record.name;
      return record;
    })(),
    { ...calendarEvents(source), body: { nested: true } },
    {
      ...calendarEvents(source),
      allDay: true,
      startDate: 'not-a-date',
      endDate: '2025-01-02',
    },
  ];
  for (const record of malformed) {
    response = async () => JSON.stringify([record]);
    await assert.rejects(run(), /invalid events/);
    assert.equal(await readFile(path, 'utf8'), previous);
  }

  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const sqliteRun = () =>
    new Pipeline({
      source,
      destination: sqlite,
      steps: [new Copy(source.events, sqlite.table('events'))],
    }).run();
  response = async () => JSON.stringify([calendarEvents(source)]);
  await sqliteRun();
  response = async () =>
    JSON.stringify([{ ...calendarEvents(source), body: { nested: true } }]);
  await assert.rejects(sqliteRun(), /invalid events\.body/);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database.prepare('SELECT id, name FROM events').get(),
    },
    { id: 'event-1', name: 'events-name' },
  );

  const unavailable = Object.assign(new Error('Calendar unavailable'), {
    stderr: 'CALENDAR_UNAVAILABLE: denied',
  });
  response = async () => {
    throw unavailable;
  };
  await assert.rejects(
    run(),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof CalendarUnavailableError &&
      error.cause.cause === unavailable,
  );
  assert.equal(await readFile(path, 'utf8'), previous);

  const native = new Error('native EventKit failure');
  response = async () => {
    throw native;
  };
  await assert.rejects(
    run(),
    (error: unknown) => error instanceof Error && error.cause === native,
  );
  assert.equal(await readFile(path, 'utf8'), previous);
});

test('Calendar snapshot incremental reconciles added, changed, moved and removed rows', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const event = (id: string, name: string) => ({
    ...calendarEvents(source),
    id,
    eventId: id,
    name,
  });
  const attendee = (eventId: string, position: number, name: string) =>
    recordFor(source.attendees, {
      id: JSON.stringify([eventId, 'attendee', position]),
      eventId,
      position,
      kind: 'attendee',
      name,
    });
  let native: Record<string, Record<string, unknown>[]> = {
    events: [event('e1', 'Standup'), event('e2', 'Review')],
    attendees: [attendee('e1', 0, 'Ann'), attendee('e1', 1, 'Bo')],
  };
  t.mock.method(osa, 'execute', async (script: string) =>
    JSON.stringify(native[streamName(script)]),
  );
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
      primaryKey: ['id'],
    }) as const;
  const toSQLite = new Pipeline({
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
  });
  const toMarkdown = new Pipeline({
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
            /^## (.+)$/m.exec(await readFile(join(folder, file), 'utf8'))?.[1],
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
  native = {
    events: [event('e1', 'Daily'), event('e3', 'Planning')],
    attendees: [attendee('e1', 0, 'Ann'), attendee('e3', 0, 'Cy')],
  };
  assert.deepEqual(await run(), [
    { count: 2, deleted: 1 },
    { count: 1, deleted: 1 },
    { count: 2, deleted: 1 },
  ]);
  assert.deepEqual(await loaded(), {
    events: ['e1:Daily', 'e3:Planning'],
    attendees: [
      `${JSON.stringify(['e1', 'attendee', 0])}:Ann`,
      `${JSON.stringify(['e3', 'attendee', 0])}:Cy`,
    ],
    markdown: ['Daily', 'Planning'],
  });
  assert.deepEqual(await run(), [
    { count: 0, deleted: 0 },
    { count: 0, deleted: 0 },
    { count: 0, deleted: 0 },
  ]);
});

test('Calendar snapshots span every extraction window without spurious deletions', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2024-01-01T00:00:00.000Z',
    endAt: '2026-01-01T00:00:00.000Z',
  });
  const event = (id: string) => ({
    ...calendarEvents(source),
    id,
    eventId: id,
  });
  // "spanning" overlaps both 365-day windows; "late" exists only in the second.
  t.mock.method(osa, 'execute', async (script: string) => {
    const [, windowStart] =
      /readCalendar\(store, "events", "([^"]+)"/.exec(script) ?? [];
    return JSON.stringify(
      windowStart === '2024-01-01T00:00:00.000Z'
        ? [event('spanning')]
        : [event('spanning'), event('late')],
    );
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
  const copy = new Copy(source.events, sqlite.table('events'), {
    id: 'events',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
  });
  const pipeline = new Pipeline({
    source,
    destination: sqlite,
    checkpoints: new SQLiteCheckpointStore({ path: statePath }),
    steps: [copy],
  });

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  using state = new DatabaseSync(statePath, { readOnly: true });
  const rows = state.prepare('SELECT state FROM checkpoints').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(String(rows[0]?.state)).snapshot), [
    '["late"]',
    '["spanning"]',
  ]);
});

test('Calendar deduplicates an event returned by adjacent extraction windows', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2024-01-01T00:00:00.000Z',
    endAt: '2026-01-01T00:00:00.000Z',
  });
  const windows: Array<[string, string]> = [];
  t.mock.method(osa, 'execute', async (script: string) => {
    assert.equal(streamName(script), 'events');
    const bounds = /readCalendar\(store, "events", ("[^"]+"), ("[^"]+")\)/.exec(
      script,
    );
    assert.ok(bounds?.[1] && bounds[2]);
    windows.push([JSON.parse(bounds[1]), JSON.parse(bounds[2])]);
    return JSON.stringify([calendarEvents(source)]);
  });
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-calendar-'),
  );
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const copy = new Copy(source.events, sqlite.table('events'));
  const result = await new Pipeline({
    source,
    destination: sqlite,
    steps: [copy],
  }).run();
  assert.deepEqual(
    result.map(({ count }) => count),
    [1],
  );
  assert.ok(windows.length > 1);
  assert.equal(windows[0]?.[0], source.startAt);
  assert.equal(windows.at(-1)?.[1], source.endAt);
  for (const [index, [start, end]] of windows.entries()) {
    assert.ok(start < end);
    assert.ok(Date.parse(end) - Date.parse(start) <= 365 * 24 * 60 * 60 * 1000);
    if (index > 0) assert.equal(start, windows[index - 1]?.[1]);
  }
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    { ...database.prepare('SELECT count(*) AS count FROM events').get() },
    { count: 1 },
  );
});

test('Calendar continues empty metadata pages and rejects a stalled cursor', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  let stalled = false;
  const calls: string[] = [];
  t.mock.method(osa, 'execute', async (script: string) => {
    const name = streamName(script);
    const first = script.includes(', undefined, null)');
    if (!first) assert.ok(script.includes(', undefined, "page-1")'));
    calls.push(name);
    return JSON.stringify({
      records:
        name === 'excludedDates' && first
          ? []
          : [
              recordFor(
                name === 'eventMetadata'
                  ? source.eventMetadata
                  : source.excludedDates,
                {
                  id: first ? 'item-1' : 'item-2',
                },
              ),
            ],
      nextCursor: first || stalled ? 'page-1' : null,
    });
  });
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-calendar-'),
  );
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const run = () =>
    new Pipeline({
      source,
      destination: sqlite,
      steps: [source.eventMetadata, source.excludedDates].map(
        (stream) => new Copy(stream, sqlite.table(stream.name)),
      ),
    }).run();
  assert.deepEqual(
    (await run()).map(({ count }) => count),
    [2, 1],
  );
  assert.deepEqual(calls, [
    'eventMetadata',
    'eventMetadata',
    'excludedDates',
    'excludedDates',
  ]);
  stalled = true;
  await assert.rejects(run(), /invalid metadata page/);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM eventMetadata').get()
      ?.count,
    2,
  );
});

test('Calendar JXA projects unsaved EventKit objects without reading Calendar data', {
  concurrency: false,
}, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('EventKit is available only on macOS');
    return;
  }
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${calendarScript}
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(0, nativeStore);
    calendar.title = 'Test calendar';
    const event = $.EKEvent.eventWithEventStore(nativeStore);
    event.title = 'Unsaved event';
    event.startDate = $.NSDate.dateWithTimeIntervalSince1970(1735689600);
    event.endDate = $.NSDate.dateWithTimeIntervalSince1970(1735693200);
    event.calendar = calendar;
    event.addAlarm($.EKAlarm.alarmWithRelativeOffset(-600));
    event.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalDaysOfTheWeekDaysOfTheMonthMonthsOfTheYearWeeksOfTheYearDaysOfTheYearSetPositionsEnd(
      2, 1, $(), $([-1]), $(), $(), $(), $(), $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(3),
    ));
    const store = {
      sources: $([]),
      calendarsForEntityType: () => $([calendar]),
      predicateForEventsWithStartDateEndDateCalendars: () => $(),
      eventsMatchingPredicate: () => $([event]),
    };
    JSON.stringify({
      events: readCalendar(
        store,
        'events',
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
      ),
      alarms: readCalendar(
        store,
        'alarms',
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
      ),
      recurrenceRules: readCalendar(
        store,
        'recurrenceRules',
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
      ),
      recurrenceRuleValues: readCalendar(
        store,
        'recurrenceRuleValues',
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
      ),
    });
  `);
  const records: {
    events: Array<Record<string, unknown>>;
    alarms: Array<Record<string, unknown>>;
    recurrenceRules: Array<Record<string, unknown>>;
    recurrenceRuleValues: Array<Record<string, unknown>>;
  } = JSON.parse(output);
  const event = records.events.find(({ startAt }) => startAt !== undefined);
  const alarm = records.alarms.find(
    ({ relativeOffset }) => relativeOffset === -600,
  );
  const rule = records.recurrenceRules.find(({ interval }) => interval === 1);
  assert.ok(event);
  assert.equal(alarm?.eventId, event.id);
  assert.equal(rule?.eventId, event.id);
  assert.equal(rule?.occurrenceCount, 3);
  const value = records.recurrenceRuleValues.find(
    ({ component }) => component === 'daysOfTheMonth',
  );
  assert.equal(value?.value, -1);
  assert.equal(value?.ruleId, rule?.id);
});

test('Calendar JXA rejects scripting data that disagrees with EventKit and ranges beyond 366 days', {
  concurrency: false,
}, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('EventKit is available only on macOS');
    return;
  }
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${calendarScript}
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(0, nativeStore);
    calendar.title = 'Test calendar';
    const event = $.EKEvent.eventWithEventStore(nativeStore);
    event.title = 'Unsaved event';
    event.startDate = $.NSDate.dateWithTimeIntervalSince1970(1735689600);
    event.endDate = $.NSDate.dateWithTimeIntervalSince1970(1735693200);
    event.calendar = calendar;
    const store = {
      sources: $([]),
      calendarsForEntityType: () => $([calendar]),
      predicateForEventsWithStartDateEndDateCalendars: () => $(),
      eventsMatchingPredicate: () => $([event]),
      calendarItemWithIdentifier: () => event,
    };
    const scripting = (overrides) => ({
      calendars: {
        byId: () => ({
          name: () => overrides.name ?? 'Test calendar',
          description: () => {
            if (overrides.description) throw new Error(overrides.description);
            return 'About';
          },
          events: {
            byId: () => ({
              properties: () => ({
                uid: eventKit.string(event.calendarItemIdentifier),
                startDate: new Date(1735689600000),
                endDate: new Date(1735693200000),
                recurrence: null,
                sequence: 0,
                excludedDates: [],
                ...overrides.event,
              }),
            }),
          },
        }),
      },
    });
    const attempt = (stream, overrides = {}, endAt = '2025-01-02T00:00:00.000Z') => {
      try {
        readCalendar(store, stream, '2025-01-01T00:00:00.000Z', endAt, scripting(overrides));
        return 'ok';
      } catch (error) {
        return error.message;
      }
    };
    JSON.stringify({
      metadata: attempt('eventMetadata'),
      name: attempt('eventMetadata', { name: 'Renamed calendar' }),
      emptyUid: attempt('eventMetadata', { event: { uid: '' } }),
      uid: attempt('eventMetadata', { event: { uid: 'another-item' } }),
      invalidDate: attempt('eventMetadata', { event: { startDate: 'soon' } }),
      date: attempt('eventMetadata', { event: { startDate: new Date(0) } }),
      recurrence: attempt('eventMetadata', { event: { recurrence: 1 } }),
      sequence: attempt('eventMetadata', { event: { sequence: 1.5 } }),
      excluded: attempt('excludedDates', { event: { excludedDates: 'none' } }),
      description: attempt('calendars', { description: 'description lookup failed' }),
      range: attempt('events', {}, '2026-01-03T00:00:00.000Z'),
      unknown: attempt('tasks'),
    });
  `);

  const { name, ...failures } = JSON.parse(output);
  assert.match(
    name,
    /^Calendar scripting lookup did not match EventKit calendar \S+$/,
  );
  assert.deepEqual(failures, {
    metadata: 'ok',
    emptyUid: 'Calendar scripting returned an invalid event UID',
    uid: 'Calendar scripting event UID did not match EventKit item',
    invalidDate: 'Calendar scripting returned an invalid date',
    date: 'Calendar scripting event did not match EventKit dates',
    recurrence: 'Calendar scripting returned an invalid recurrence',
    sequence: 'Calendar scripting returned an invalid event sequence',
    excluded: 'Calendar scripting returned invalid excluded dates',
    description: 'description lookup failed',
    range: 'Calendar range must be positive and no longer than 366 days',
    unknown: 'Unknown calendar stream: tasks',
  });
});

test('Calendar occurrence keys survive rescheduling and preserve all-day dates', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('EventKit is available only on macOS');
    return;
  }
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${calendarScript}
    $.NSTimeZone.setDefaultTimeZone($.NSTimeZone.timeZoneWithName('Asia/Amman'));
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(0, nativeStore);
    const event = $.EKEvent.eventWithEventStore(nativeStore);
    event.calendar = calendar;
    event.title = 'Unsaved recurrence';
    event.startDate = $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-01T09:00:00.000Z') / 1000);
    event.endDate = $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-01T10:00:00.000Z') / 1000);
    event.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalEnd(0, 1, $()));
    const store = {
      calendarsForEntityType: () => $([calendar]),
      predicateForEventsWithStartDateEndDateCalendars: () => $(),
      eventsMatchingPredicate: () => ({count: selected.length, objectAtIndex: i => selected[i]}),
    };
    const read = () => readCalendar(store, 'events', '2025-01-01T00:00:00.000Z', '2025-01-04T00:00:00.000Z');
    let selected = [event];
    const original = read()[0];
    const originalDate = event.occurrenceDate;
    selected = [new Proxy(event, {get(target, key) {
      if (key === 'isDetached') return true;
      if (key === 'occurrenceDate') return originalDate;
      if (key === 'startDate') return $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-02T11:00:00.000Z') / 1000);
      if (key === 'endDate') return $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-02T12:00:00.000Z') / 1000);
      return target[key];
    }})];
    const moved = read()[0];
    const scriptingEvent = {
      // A detached Calendar scripting object keeps its master UID and recurrence,
      // while its sequence and dates belong to the detached native item.
      properties: () => ({
        uid: 'master-script-item',
        startDate: new Date(Number(event.startDate.timeIntervalSince1970) * 1000),
        endDate: new Date(Number(event.endDate.timeIntervalSince1970) * 1000),
        recurrence: 'RRULE:FREQ=DAILY',
        sequence: 7,
        excludedDates: [new Date('2025-01-03T09:00:00.000Z')],
      }),
    };
    const scriptingApplication = {
      calendars: {
        byId: () => ({
          name: () => ObjC.unwrap(calendar.title),
          events: {byId: () => scriptingEvent},
        }),
      },
    };
    const storedItem = new Proxy(event, {get(target, key) {
      if (key === 'isDetached') return true;
      if (key === 'calendarItemExternalIdentifier') return $('detached-external');
      return target[key];
    }});
    const parentItem = new Proxy(event, {get(target, key) {
      if (key === 'calendarItemIdentifier') return $('master-script-item');
      if (key === 'calendarItemExternalIdentifier') return $('parent-external');
      return target[key];
    }});
    const metadataStore = {
      ...store,
      calendarItemWithIdentifier: identifier =>
        identifier === 'master-script-item' ? parentItem : storedItem,
    };
    const metadata = readCalendar(
      metadataStore,
      'eventMetadata',
      '2025-01-01T00:00:00.000Z',
      '2025-01-04T00:00:00.000Z',
      scriptingApplication,
    );
    const excluded = readCalendar(
      metadataStore,
      'excludedDates',
      '2025-01-01T00:00:00.000Z',
      '2025-01-04T00:00:00.000Z',
      scriptingApplication,
    );
    const pagedItems = new Map(Array.from({length: 101}, (_, index) => {
      const id = 'item-' + String(index).padStart(3, '0');
      return [id, new Proxy(storedItem, {get(target, key) {
        return key === 'calendarItemIdentifier' ? $(id) : target[key];
      }})];
    }));
    selected = [...pagedItems.values()].reverse();
    selected.push(selected[0]);
    const pagedStore = {
      ...store,
      calendarItemWithIdentifier: id => id === 'master-script-item' ? parentItem : pagedItems.get(id),
    };
    let propertyReads = 0;
    const pagedApplication = {
      calendars: {byId: () => ({
        name: () => ObjC.unwrap(calendar.title),
        events: {byId: () => ({properties: () => {
          propertyReads += 1;
          return scriptingEvent.properties();
        }})},
      })},
    };
    const firstPage = readCalendar(pagedStore, 'eventMetadata', '2025-01-01T00:00:00.000Z', '2025-01-04T00:00:00.000Z', pagedApplication);
    const firstPageReads = propertyReads;
    const secondPage = readCalendar(pagedStore, 'eventMetadata', '2025-01-01T00:00:00.000Z', '2025-01-04T00:00:00.000Z', pagedApplication, firstPage.nextCursor);
    const paging = {firstPage, secondPage, firstPageReads, propertyReads};
    const allDay = $.EKEvent.eventWithEventStore(nativeStore);
    allDay.calendar = calendar;
    allDay.title = 'Unsaved all-day event';
    allDay.allDay = true;
    allDay.startDate = $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2024-12-31T21:00:00.000Z') / 1000);
    // Saved all-day events end one second before the next local midnight (verified live).
    allDay.endDate = $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-01T20:59:59.000Z') / 1000);
    allDay.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalEnd(0, 1, $()));
    selected = [allDay];
    const day = read()[0];
    selected = [new Proxy(event, {get(target, key) {
      if (key === 'startDate' || key === 'endDate') return $.NSDate.dateWithTimeIntervalSince1970(Date.parse('2025-01-04T00:00:00.000Z') / 1000);
      return target[key];
    }})];
    JSON.stringify({original, moved, metadata, excluded, paging, day, outside: read()});
  `);
  const { original, moved, metadata, excluded, paging, day, outside } =
    JSON.parse(output);
  assert.equal(original.id, moved.id);
  assert.notEqual(original.startAt, moved.startAt);
  assert.equal(moved.detached, true);
  assert.equal(metadata.records[0].scriptingUid, 'master-script-item');
  assert.equal(metadata.records[0].rawRecurrence, 'RRULE:FREQ=DAILY');
  assert.equal(metadata.records[0].sequence, 7);
  assert.equal(metadata.nextCursor, null);
  assert.equal(excluded.records[0].excludedAt, '2025-01-03T09:00:00.000Z');
  assert.equal(paging.firstPage.records.length, 100);
  assert.equal(paging.firstPageReads, 100);
  assert.equal(paging.firstPage.nextCursor, paging.firstPage.records.at(-1).id);
  assert.equal(paging.secondPage.records.length, 1);
  assert.equal(paging.secondPage.nextCursor, null);
  assert.equal(paging.propertyReads, 101);
  assert.equal(
    new Set(
      [...paging.firstPage.records, ...paging.secondPage.records].map(
        (row) => row.id,
      ),
    ).size,
    101,
  );
  assert.equal(day.startDate, '2025-01-01');
  assert.equal(day.endDate, '2025-01-01');
  assert.equal(day.startAt, '2024-12-31T21:00:00.000Z');
  assert.equal(day.occurrenceAt, '2024-12-31T21:00:00.000Z');
  assert.equal(day.occurrenceDate, '2025-01-01');
  assert.equal(JSON.parse(day.id).at(-1), '2025-01-01');
  assert.deepEqual(outside, []);
});

test('Reminders EventKit projects native records through every SQLite and Markdown stream', {
  concurrency: false,
}, async (t) => {
  if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
  const source = new AppleRemindersSource();
  const streams = (await source.discover()).streams;
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${remindersScript}
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(1, nativeStore);
    calendar.title = 'Synthetic list';
    calendar.color = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.2, 0.4, 0.6, 1);
    const collection = values => ({count: values.length, objectAtIndex: i => values[i]});
    const account = {sourceIdentifier: $('account-1'), title: $('Synthetic account'), sourceType: 0, isDelegate: false};
    const makeReminder = title => {
      const reminder = $.EKReminder.reminderWithEventStore(nativeStore);
      reminder.title = title;
      reminder.calendar = calendar;
      return reminder;
    };
    const components = () => {
      const value = $.NSDateComponents.alloc.init;
      value.calendar = $.NSCalendar.alloc.initWithCalendarIdentifier('gregorian');
      value.year = 2026; value.month = 9; value.day = 21;
      return value;
    };
    const undated = makeReminder('undated');
    const dateOnly = makeReminder('date-only');
    dateOnly.dueDateComponents = components();
    const timed = makeReminder('timed');
    const due = components();
    due.hour = 0; due.minute = 30; due.second = 0;
    due.timeZone = $.NSTimeZone.timeZoneWithName('Asia/Amman');
    timed.dueDateComponents = due;
    timed.notes = 'Native body';
    timed.URL = $.NSURL.URLWithString('https://example.com/reminder');
    timed.priority = 1;
    const floating = makeReminder('floating');
    const start = components();
    start.hour = 9; start.minute = 15;
    floating.startDateComponents = start;
    const completed = makeReminder('completed');
    completed.completed = true;
    const selected = [undated, dateOnly, timed, floating, new Proxy(completed, {get(target, key) {
      if (key === 'completionDate') return $();
      return target[key];
    }})];
    const alarm = $.EKAlarm.alarmWithRelativeOffset(-600);
    const place = $.EKStructuredLocation.locationWithTitle('Synthetic place');
    // CLLocation is absent from JXA's exports; public Objective-C lookup still resolves it.
    place.geoLocation = $.NSClassFromString('CLLocation').alloc.initWithLatitudeLongitude(31.95, 35.93);
    place.radius = 100;
    alarm.structuredLocation = place;
    alarm.proximity = 1;
    timed.addAlarm(alarm);
    timed.addAlarm($.EKAlarm.alarmWithAbsoluteDate($.NSDate.dateWithTimeIntervalSince1970(1735689600)));
    timed.addRecurrenceRule($.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalDaysOfTheWeekDaysOfTheMonthMonthsOfTheYearWeeksOfTheYearDaysOfTheYearSetPositionsEnd(
      3, 2, $([$.EKRecurrenceDayOfWeek.dayOfWeekWeekNumber(2, -1)]), $([-1]), $([9]), $([1]), $([42]), $([-1]),
      $.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount(5)
    ));
    const attendee = {name: $('Synthetic attendee'), URL: $.NSURL.URLWithString('mailto:test@example.com'),
      participantStatus: 2, participantRole: 1, participantType: 1, isCurrentUser: true};
    selected[2] = new Proxy(timed, {get(target, key) {
      if (key === 'attendees') return collection([attendee]);
      return target[key];
    }});
    const store = {
      sources: collection([account]),
      calendarsForEntityType: type => {
        if (type !== 1) throw new Error('Queried events instead of reminders');
        return collection([new Proxy(calendar, {get(target, key) {
          if (key === 'source') return account;
          return target[key];
        }})]);
      },
      predicateForRemindersInCalendars: calendars => {
        if (!calendars.isNil()) throw new Error('Expected all reminders including completed');
        return $();
      },
      fetchRemindersMatchingPredicateCompletion: (predicate, completion) => {
        $.NSOperationQueue.mainQueue.addOperationWithBlock(() => completion(collection(selected)));
        return 'request';
      },
      cancelFetchRequest: () => { throw new Error('Unexpected cancellation'); },
    };
    const result = {};
    for (const stream of ${JSON.stringify(streams.map((stream) => stream.name))})
      result[stream] = readReminders(store, stream);
    JSON.stringify(result);
  `);
  const records: Record<string, Array<Record<string, unknown>>> = JSON.parse(
    output,
  );
  const {
    reminders,
    dateComponents,
    alarms,
    attendees,
    recurrenceRules,
    recurrenceRuleValues,
  } = records;
  assert.ok(
    reminders &&
      dateComponents &&
      alarms &&
      attendees &&
      recurrenceRules &&
      recurrenceRuleValues,
  );
  const byName = Object.fromEntries(
    reminders.map((row) => [String(row.name), row]),
  );
  const reminder = (name: string) => {
    const row = byName[name];
    assert.ok(row);
    return row;
  };
  assert.equal(reminders.length, 5);
  assert.equal(reminder('completed').completed, true);
  assert.equal(reminder('completed').completedAt, null);
  assert.equal(reminder('undated').createdAt, null);
  assert.equal(reminder('timed').url, 'https://example.com/reminder');
  assert.ok(
    reminders.every((row) => !('flagged' in row) && !('containerId' in row)),
  );
  const date = (name: string) => {
    const row = dateComponents.find(
      (row) => row.reminderId === reminder(name).id,
    );
    assert.ok(row);
    return row;
  };
  assert.equal(date('date-only').hour, null);
  assert.equal(date('date-only').day, 21);
  assert.equal(date('date-only').timeZone, null);
  assert.equal(date('timed').hour, 0);
  assert.equal(date('timed').minute, 30);
  assert.equal(date('timed').timeZone, 'Asia/Amman');
  assert.equal(date('floating').kind, 'start');
  assert.equal(date('floating').hour, 9);
  assert.equal(date('floating').timeZone, null);
  assert.equal(
    dateComponents.some((row) => row.reminderId === reminder('undated').id),
    false,
  );
  const location = alarms.find((row) => row.proximity === 1);
  assert.ok(location);
  assert.equal(location.latitude, 31.95);
  assert.equal(location.longitude, 35.93);
  assert.equal(location.radius, 100);
  assert.equal(location.reminderId, reminder('timed').id);
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
  assert.equal(attendees[0]?.reminderId, reminder('timed').id);

  t.mock.method(osa, 'execute', async (script: string) => {
    assert.doesNotMatch(script, /Application\(/);
    return JSON.stringify(records[streamName(script)]);
  });
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
    source,
    destination: sqlite,
    steps: streams.map((stream) => new Copy(stream, sqlite.table(stream.name))),
  }).run();
  await new Pipeline({
    source,
    destination: markdown,
    steps: streams.map(
      (stream) =>
        new Copy(stream, markdown.file(`${stream.name.toLowerCase()}.md`)),
    ),
  }).run();
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  for (const stream of streams) {
    const rows = records[stream.name];
    assert.ok(rows);
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
        document.includes(Buffer.from(JSON.stringify(row)).toString('base64')),
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
});

test('Reminders JXA keeps each date component set intact and rejects unidentified reminders', {
  concurrency: false,
}, async (t) => {
  if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${remindersScript}
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(1, nativeStore);
    calendar.title = 'Synthetic list';
    const collection = values => ({count: values.length, objectAtIndex: i => values[i]});
    const reminder = $.EKReminder.reminderWithEventStore(nativeStore);
    reminder.title = 'Both dates';
    reminder.calendar = calendar;
    const start = $.NSDateComponents.alloc.init;
    // EKReminder accepts only nil or Gregorian date-component calendars.
    start.calendar = $.NSCalendar.alloc.initWithCalendarIdentifier('gregorian');
    start.year = 2026; start.month = 6; start.day = 1; start.leapMonth = true;
    reminder.startDateComponents = start;
    const due = $.NSDateComponents.alloc.init;
    due.year = 2026; due.month = 9; due.day = 21; due.hour = 17;
    reminder.dueDateComponents = due;
    let selected = [reminder];
    const store = {
      predicateForRemindersInCalendars: () => $(),
      fetchRemindersMatchingPredicateCompletion: (predicate, completion) => {
        $.NSOperationQueue.mainQueue.addOperationWithBlock(() => completion(collection(selected)));
        return 'request';
      },
    };
    const attempt = stream => {
      try {
        return readReminders(store, stream);
      } catch (error) {
        return error.message;
      }
    };
    const components = attempt('dateComponents');
    // macOS 14 lacks dayOfYear and isRepeatedDay; hide those selectors to model it.
    const legacy = reminderDateComponents('legacy', 'due', new Proxy(due, {get(target, key) {
      if (key === 'respondsToSelector')
        return name => name !== 'dayOfYear' && name !== 'isRepeatedDay' && target.respondsToSelector(name);
      return target[key];
    }}));
    selected = [new Proxy(reminder, {get(target, key) {
      if (key === 'calendar') return $();
      return target[key];
    }})];
    JSON.stringify({
      components,
      legacy,
      unlisted: attempt('reminders'),
      unknown: attempt('tasks'),
    });
  `);
  const { components, legacy, unlisted, unknown } = JSON.parse(output);
  const pick = (row: Record<string, unknown>) => ({
    kind: row.kind,
    calendarIdentifier: row.calendarIdentifier,
    timeZone: row.timeZone,
    year: row.year,
    month: row.month,
    day: row.day,
    hour: row.hour,
    minute: row.minute,
    dayOfYear: row.dayOfYear,
    leapMonth: row.leapMonth,
    repeatedDay: row.repeatedDay,
  });

  assert.deepEqual(components.map(pick), [
    {
      kind: 'start',
      calendarIdentifier: 'gregorian',
      timeZone: null,
      year: 2026,
      month: 6,
      day: 1,
      hour: null,
      minute: null,
      dayOfYear: null,
      leapMonth: true,
      repeatedDay: false,
    },
    // EventKit normalizes a due time: it assigns Gregorian and fills the minute.
    {
      kind: 'due',
      calendarIdentifier: 'gregorian',
      timeZone: null,
      year: 2026,
      month: 9,
      day: 21,
      hour: 17,
      minute: 0,
      dayOfYear: null,
      leapMonth: false,
      repeatedDay: false,
    },
  ]);
  assert.equal(
    new Set(components.map((row: { reminderId: unknown }) => row.reminderId))
      .size,
    1,
  );
  assert.deepEqual(
    { dayOfYear: legacy.dayOfYear, repeatedDay: legacy.repeatedDay },
    { dayOfYear: null, repeatedDay: null },
  );
  assert.equal(
    unlisted,
    'EventKit returned a reminder without a list or item identifier',
  );
  assert.equal(unknown, 'Unknown reminders stream: tasks');
});

test('Reminders rejects unsupported selections and preserves targets on invalid data or access failure', {
  concurrency: false,
}, async (t) => {
  const source = new AppleRemindersSource();
  let response = JSON.stringify([
    recordFor(source.reminders, { id: 'reminder-1', listId: 'list-1' }),
  ]);
  let failure: Error | undefined;
  const execute = t.mock.method(osa, 'execute', async () => {
    if (failure) throw failure;
    return response;
  });
  const streams = (await source.discover()).streams;
  assert.equal(streams.length, 8);
  assert.equal(source.identity, 'apple-reminders:eventkit');
  assert.ok(
    streams.every(
      (stream) =>
        Object.isFrozen(stream) &&
        stream.sourceDefinedCursor === true &&
        stream.emitsDeletes === true,
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
    jsonSchema: {},
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
  assert.equal(execute.mock.callCount(), 0);
  const run = () =>
    new Pipeline({
      source,
      destination,
      steps: [new Copy(source.reminders, target)],
    }).run();
  await run();
  const path = join(destination.path, 'reminders.md');
  const previous = await readFile(path, 'utf8');
  for (const invalid of [
    null,
    [{ id: 'incomplete' }],
    [{ ...recordFor(source.reminders), priority: 10 }],
    [{ ...recordFor(source.reminders), modifiedAt: '2026-09-21' }],
  ]) {
    response = JSON.stringify(invalid);
    await assert.rejects(run(), /invalid reminders/);
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  for (const message of ['denied', 'restricted', 'pending', 'revoked']) {
    failure = Object.assign(new Error(message), {
      stderr: `REMINDERS_UNAVAILABLE: ${message}`,
    });
    await assert.rejects(
      run(),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof RemindersUnavailableError &&
        error.cause.cause === failure,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  failure = new Error('EventKit reminder fetch timed out');
  await assert.rejects(
    run(),
    (error: unknown) => error instanceof Error && error.cause === failure,
  );
  assert.equal(await readFile(path, 'utf8'), previous);
  failure = undefined;
  response = '[]';
  await run();
  assert.notEqual(await readFile(path, 'utf8'), previous);
});

test('Reminders distinguishes an empty fetch from nil and cancels a timed-out request', async (t) => {
  if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${remindersScript}
    let cancelled = false;
    let mode = 'empty';
    const store = {
      predicateForRemindersInCalendars: () => $(),
      fetchRemindersMatchingPredicateCompletion: (predicate, completion) => {
        if (mode !== 'timeout') completion(mode === 'empty' ? $([]) : $());
        return 'request-1';
      },
      cancelFetchRequest: request => { cancelled = request === 'request-1'; },
    };
    const empty = fetchReminders(store);
    mode = 'nil';
    let nilError;
    try { fetchReminders(store); } catch (error) { nilError = error.message; }
    mode = 'timeout';
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => (ticks += 60001);
    let timeoutError;
    try { fetchReminders(store); } catch (error) { timeoutError = error.message; }
    Date.now = realNow;
    JSON.stringify({empty, nilError, timeoutError, cancelled});
  `);
  assert.deepEqual(JSON.parse(output), {
    empty: [],
    nilError: 'EventKit reminder query failed',
    timeoutError: 'EventKit reminder fetch timed out',
    cancelled: true,
  });
});

test('EventKit executes native operations without an ELT schema and rejects revoked access', async (t) => {
  for (const [entity, entityType, Unavailable] of [
    ['events', 0, CalendarUnavailableError],
    ['reminders', 1, RemindersUnavailableError],
  ] as const) {
    let status = 3;
    const execute = t.mock.method(osa, 'execute', async (script: string) => {
      try {
        return runInNewContext(script, {
          ObjC: { import: () => {} },
          $: {
            EKEventStore: {
              alloc: { init: { respondsToSelector: () => true } },
              authorizationStatusForEntityType: (actual: number) => {
                assert.equal(actual, entityType);
                return status;
              },
            },
          },
          revoke: () => {
            status = 2;
          },
        });
      } catch (cause) {
        throw Object.assign(new Error('Native execution failed', { cause }), {
          stderr: String(cause),
        });
      }
    });
    try {
      const client = new EventKit(entity);
      assert.deepEqual(await client.execute('return { nativeValue: 42 };'), {
        nativeValue: 42,
      });
      await assert.rejects(client.execute('revoke(); return [];'), Unavailable);
    } finally {
      // Each iteration mocks osa.execute again; restore before the next one so
      // no fake survives into later tests.
      execute.mock.restore();
    }
  }
});

test('EventKit permission gate requests the correct entity and refuses incomplete access', () => {
  const gate = EventKit.runtime.slice(
    EventKit.runtime.indexOf('function requireEventKitAccess'),
  );
  const check = (
    initial: number,
    afterRequest: number,
    entity: number,
    supported = true,
  ) => {
    let status = initial;
    let ticks = 0;
    const requests: string[] = [];
    const store = {
      respondsToSelector: () => supported,
      requestFullAccessToEventsWithCompletion: () => {
        requests.push('events');
        status = afterRequest;
      },
      requestFullAccessToRemindersWithCompletion: () => {
        requests.push('reminders');
        status = afterRequest;
      },
    };
    const context = {
      $: {
        EKEventStore: {
          authorizationStatusForEntityType: (actual: number) => {
            assert.equal(actual, entity);
            return status;
          },
        },
        NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } },
        NSDate: { dateWithTimeIntervalSinceNow: () => 0 },
      },
      Date: { now: () => (ticks += 30001) },
      store,
      entity,
    };
    const run = () =>
      runInNewContext(
        `${gate}\nrequireEventKitAccess(store, entity, 'UNAVAILABLE');`,
        context,
      );
    return { requests, run };
  };
  for (const entity of [0, 1]) {
    const granted = check(3, 3, entity);
    granted.run();
    assert.deepEqual(granted.requests, []);
    for (const initial of [0, 4]) {
      const request = check(initial, 3, entity);
      request.run();
      assert.deepEqual(request.requests, [
        entity === 0 ? 'events' : 'reminders',
      ]);
    }
    for (const status of [0, 1, 2, 4]) {
      const denied = check(status, status, entity);
      assert.throws(denied.run, /full access is required/);
      if (status === 1 || status === 2) assert.deepEqual(denied.requests, []);
    }
    assert.throws(check(0, 3, entity, false).run, /macOS 14 or later/);
  }
});

test('Notes subscribes before its initial invalidation and reacts to native filesystem changes', {
  timeout: 10_000,
}, async (t) => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-watch-'));
  const nativeWatch = fs.watch;
  const source = new AppleNotesSource();
  const controller = new AbortController();
  try {
    const closed = Promise.withResolvers<void>();
    t.mock.method(
      fs,
      'watch',
      (path: fs.PathLike, options: fs.WatchOptionsWithStringEncoding) => {
        assert.match(
          String(path),
          /Library\/Group Containers\/group\.com\.apple\.notes$/,
        );
        const watcher = nativeWatch(scratch.path, options);
        watcher.once('close', () => closed.resolve());
        return watcher;
      },
    );
    await using watching = source.watch({
      streams: [source.notes],
      signal: controller.signal,
    });
    assert.deepEqual(await watching.next(), {
      value: [source.notes],
      done: false,
    });
    const [changed] = await Promise.all([
      watching.next(),
      writeFile(join(scratch.path, 'NoteStore.sqlite-wal'), 'test change'),
    ]);
    assert.deepEqual(changed, { value: [source.notes], done: false });
    controller.abort();
    // Abort may follow already queued native events, so drain until cancellation.
    await assert.rejects(
      async () => {
        for await (const _ of watching) {
        }
      },
      { name: 'AbortError' },
    );
    await closed.promise;
  } finally {
    controller.abort();
  }
});

test('Notes watcher permission failures preserve their cause and do not fall back to polling', async (t) => {
  const cause = Object.assign(new Error('Access denied'), { code: 'EPERM' });
  const start = t.mock.method(fs, 'watch', () => {
    throw cause;
  });
  const source = new AppleNotesSource();
  const watching = source.watch({
    streams: [source.notes],
    signal: new AbortController().signal,
  });
  await assert.rejects(watching.next(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Full Disk Access/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(start.mock.callCount(), 1);
});

test('Calendar and Reminders watch native EventKit notifications without reading personal data', {
  timeout: 10_000,
}, async (t) => {
  const nativeWatch = osa.watch.bind(osa);
  const marker = `eventkit-watch-probe-${process.pid}-${Date.now()}`;
  t.mock.method(osa, 'watch', (script: string, signal: AbortSignal) => {
    // Exercise the actual observer and bridge with an unsaved store. Do not request
    // access or modify Calendar/Reminders; post only a process-local notification.
    // The run loop keeps running, so only cancellation can end the native process.
    const probe = `// ${marker}
      ${script
        .replace('requireEventKitAccess(store, entityType, marker);', '')
        .replace(
          '$.NSRunLoop.currentRunLoop.run;',
          `center.postNotificationNameObject($.EKEventStoreChangedNotification, store);
       $.NSRunLoop.currentRunLoop.run;`,
        )}`;
    return nativeWatch(probe, signal);
  });
  const calendar = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const reminders = new AppleRemindersSource();
  for (const [source, stream] of [
    [calendar, calendar.events],
    [reminders, reminders.reminders],
  ] as const) {
    const controller = new AbortController();
    try {
      await using watching = source.watch({
        streams: [stream],
        signal: controller.signal,
      });
      assert.deepEqual(await watching.next(), { value: [stream], done: false });
      assert.deepEqual(await watching.next(), { value: [stream], done: false });
      controller.abort();
      assert.deepEqual(await watching.next(), { value: undefined, done: true });
      await assert.rejects(execFile('pgrep', ['-f', marker]), { code: 1 });
    } finally {
      controller.abort();
    }
  }
});

test('EventKit watching preserves permission failures and rejects invalid native notifications', async (t) => {
  for (const [entity, marker, Unavailable] of [
    ['events', 'CALENDAR_UNAVAILABLE', CalendarUnavailableError],
    ['reminders', 'REMINDERS_UNAVAILABLE', RemindersUnavailableError],
  ] as const) {
    const cause = Object.assign(new Error('Access denied'), { stderr: marker });
    t.mock.method(osa, 'watch', () => {
      throw cause;
    });
    const client = new EventKit(entity);
    await assert.rejects(
      client.watch(new AbortController().signal).next(),
      (error) => {
        assert.ok(error instanceof Unavailable);
        assert.equal(error.cause, cause);
        return true;
      },
    );
    t.mock.reset();
  }
  t.mock.method(osa, 'watch', async function* () {
    yield 'unexpected';
  });
  await assert.rejects(
    new EventKit('events').watch(new AbortController().signal).next(),
    /invalid notification/,
  );
});

test('OSA watching closes on abort or iterator return and reports native failures', {
  timeout: 10_000,
}, async () => {
  const script = `ObjC.import('Foundation');
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($('ready\\n').dataUsingEncoding($.NSUTF8StringEncoding));
    $.NSRunLoop.currentRunLoop.run;`;
  const controller = new AbortController();
  try {
    await using watching = osa.watch(script, controller.signal);
    assert.deepEqual(await watching.next(), { value: 'ready', done: false });
    const pending = watching.next();
    controller.abort();
    assert.deepEqual(await pending, { value: undefined, done: true });
  } finally {
    controller.abort();
  }
  const stopped = osa.watch(script, new AbortController().signal);
  assert.equal((await stopped.next()).value, 'ready');
  assert.deepEqual(await stopped.return(undefined), {
    value: undefined,
    done: true,
  });
  await assert.rejects(
    osa
      .watch(
        "throw new Error('native probe failure');",
        new AbortController().signal,
      )
      .next(),
    /native probe failure/,
  );
});

test('iCalendar parsing unfolds lines, keeps parameters and vendor properties, and nests components', () => {
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

  const calendar = parseICalendar(ics);
  assert.equal(calendar.name, 'VCALENDAR');
  assert.deepEqual(
    calendar.components.map((component) => component.name),
    ['VTIMEZONE', 'VEVENT'],
  );
  assert.deepEqual(
    calendar.components[0]?.components.map((component) => component.name),
    ['STANDARD', 'DAYLIGHT'],
  );
  const event = calendar.components[1];
  assert.ok(event);
  const property = (name: string) =>
    event.properties.find((candidate) => candidate.name === name);
  assert.equal(property('SUMMARY')?.value, 'Café planning');
  assert.deepEqual(property('ATTACH'), {
    name: 'ATTACH',
    parameters: [
      { name: 'FMTTYPE', values: ['application/pdf'] },
      { name: 'FILENAME', values: ['a;b:c,d.pdf'] },
    ],
    value: 'https://example.com/a',
  });
  assert.deepEqual(property('ATTENDEE')?.parameters, [
    {
      name: 'MEMBER',
      values: ['mailto:a@example.com', 'mailto:b@example.com'],
    },
    { name: 'CN', values: ['Caret^ "Q" \nline'] },
  ]);
  assert.deepEqual(property('X-GOOGLE-CONFERENCE'), {
    name: 'X-GOOGLE-CONFERENCE',
    parameters: [{ name: 'X-PARAM', values: ['1'] }],
    value: 'https://meet.google.com/abc',
  });
  assert.equal(property('DESCRIPTION')?.value, 'Raw\\, value\\nkept');
  assert.deepEqual(
    event.components.map((component) => component.name),
    ['VALARM'],
  );
  assert.ok(Object.isFrozen(event.properties));
  // Bare LF line endings parse the same way.
  assert.deepEqual(
    parseICalendar(
      Buffer.from(ics.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'),
    ),
    calendar,
  );
});

test('iCalendar parsing rejects malformed content instead of skipping it', () => {
  const parse = (text: string) => () => parseICalendar(Buffer.from(text));
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
    assert.throws(parse(text), message);
  assert.throws(
    () =>
      parseICalendar(
        Buffer.concat([
          Buffer.from('BEGIN:VCALENDAR\r\nX:'),
          Buffer.from([0xff]),
          Buffer.from('\r\nEND:VCALENDAR\r\n'),
        ]),
      ),
    /not valid UTF-8/,
  );
});

function icsPage(
  items: readonly { calendarItemId: string; recurring: boolean; ics: string }[],
) {
  return JSON.stringify({
    records: items.map(({ ics, ...item }) => ({
      calendarId: 'calendar-1',
      ...item,
      ics: Buffer.from(ics).toString('base64'),
    })),
    nextCursor: null,
  });
}

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

test('Calendar ICS streams load components, raw properties and parameters with exact event links', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  t.mock.method(osa, 'execute', async () =>
    icsPage([
      { calendarItemId: 'meeting', recurring: false, ics: meetingICS },
      { calendarItemId: 'series', recurring: true, ics: seriesICS },
    ]),
  );
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'ics.sqlite'),
  });
  const markdown = new MarkdownDestination({ path: join(scratch.path, 'md') });
  const streams = [
    source.icsComponents,
    source.icsProperties,
    source.icsParameters,
  ];

  const counts = await new Pipeline({
    source,
    destination: sqlite,
    steps: streams.map((stream) => new Copy(stream, sqlite.table(stream.name))),
  }).run();
  await new Pipeline({
    source,
    destination: markdown,
    steps: [new Copy(source.icsProperties, markdown.file('ics-properties.md'))],
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
    {
      calendarItemId: 'series',
      name: 'VEVENT',
      uid: 'series@example.com',
      recurrenceId: null,
      recurrenceIdTimeZone: null,
      eventId: null,
    },
    {
      calendarItemId: 'series',
      name: 'VEVENT',
      uid: 'series@example.com',
      recurrenceId: '20250108T090000',
      recurrenceIdTimeZone: 'Asia/Amman',
      eventId: null,
    },
  ]);
  const value = (name: string) =>
    database.prepare('SELECT value FROM icsProperties WHERE name = ?').get(name)
      ?.value;
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
});

test('Calendar ICS rejects exports without events and reports a missing private export', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const read = () =>
    Array.fromAsync(
      source.read(
        new Copy(
          source.icsComponents,
          new MarkdownDestination({ path: '/unused' }).file('c.md'),
        ).configuration,
        null,
      ),
    );
  const execute = t.mock.method(osa, 'execute', async () =>
    icsPage([
      {
        calendarItemId: 'empty',
        recurring: false,
        ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      },
    ]),
  );
  await assert.rejects(read(), /returned no VEVENT for saved item empty/);
  const cause = Object.assign(new Error('Command failed: osascript'), {
    stderr:
      'execution error: Error: CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export (-2700)\n',
  });
  execute.mock.mockImplementation(async () => {
    throw cause;
  });
  await assert.rejects(read(), (error) => {
    assert.ok(error instanceof CalendarIcsUnavailableError);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('Calendar JXA exports saved items only and names a missing ICS selector', {
  concurrency: false,
}, async (t) => {
  if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
  const output = await osa.execute(`
    ${EventKit.runtime}
    ${calendarScript}
    const nativeStore = $.EKEventStore.alloc.init;
    const calendar = $.EKCalendar.calendarForEntityTypeEventStore(0, nativeStore);
    calendar.title = 'Test calendar';
    const event = $.EKEvent.eventWithEventStore(nativeStore);
    event.title = 'Unsaved event';
    event.startDate = $.NSDate.dateWithTimeIntervalSince1970(1735689600);
    event.endDate = $.NSDate.dateWithTimeIntervalSince1970(1735693200);
    event.calendar = calendar;
    const base = {
      calendarsForEntityType: () => $([calendar]),
      predicateForEventsWithStartDateEndDateCalendars: () => $(),
      eventsMatchingPredicate: () => $([event]),
      calendarItemWithIdentifier: () => event,
    };
    const attempt = (store) => {
      try {
        return readCalendar(store, 'icsComponents', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', undefined, null);
      } catch (error) {
        return error.message;
      }
    };
    JSON.stringify({
      unsaved: attempt({
        ...base,
        respondsToSelector: (selector) => nativeStore.respondsToSelector(selector),
        ICSDataForCalendarItemsPreventLineFolding: (items, fold) =>
          nativeStore.ICSDataForCalendarItemsPreventLineFolding(items, fold),
      }),
      missing: attempt(base),
    });
  `);
  const { unsaved, missing } = JSON.parse(output);
  // EventKit exports an unsaved item as an empty calendar; the source rejects it.
  assert.equal(unsaved.records.length, 1);
  assert.doesNotMatch(
    Buffer.from(unsaved.records[0].ics, 'base64').toString('utf8'),
    /BEGIN:VEVENT/,
  );
  assert.match(missing, /^CALENDAR_ICS_UNAVAILABLE:/);
});

test('Calendar ICS snapshots delete a removed property with its parameters', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  let ics = meetingICS;
  t.mock.method(osa, 'execute', async () =>
    icsPage([{ calendarItemId: 'meeting', recurring: false, ics }]),
  );
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-ics-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'ics.sqlite'),
  });
  const pipeline = new Pipeline({
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
          primaryKey: ['id'],
        }),
    ),
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
      .prepare("SELECT count(*) AS n FROM icsProperties WHERE name = 'ATTACH'")
      .get()?.n,
    0,
  );
  assert.equal(
    database.prepare('SELECT count(*) AS n FROM icsParameters').get()?.n,
    0,
  );
});

test('Reminders snapshot incremental writes only changed reminders and deletes removed ones', async (t) => {
  const source = new AppleRemindersSource();
  const reminder = (id: string, name: string) =>
    recordFor(source.reminders, { id, listId: 'list-1', name });
  let native = [reminder('r1', 'Buy milk'), reminder('r2', 'Call Ann')];
  t.mock.method(osa, 'execute', async () => JSON.stringify(native));
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-rem-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'r.sqlite'),
  });
  const copy = new Copy(source.reminders, sqlite.table('reminders'), {
    id: 'reminders',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
  });
  const pipeline = new Pipeline({
    source,
    destination: sqlite,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 's.sqlite'),
    }),
    steps: [copy],
  });

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  native = [reminder('r1', 'Buy oat milk'), reminder('r3', 'Book flight')];
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
