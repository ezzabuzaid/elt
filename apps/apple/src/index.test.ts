import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempDisposable,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  type ReadMessage,
  type Source,
  Stream,
  StreamStatus,
} from 'elt';
import { MarkdownDestination } from 'elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  type SQLiteTable,
} from 'elt-sqlite';
import { appleWarehouse } from './fixtures/apple-warehouse.ts';
import { noteBody, noteStoreFixture } from './fixtures/notes-store.ts';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import {
  ChatDatabase,
  MessagesUnavailableError,
} from './platform/macos/chat-database.ts';
import {
  CalendarUnavailableError,
  EventKit,
  EventKitChangingError,
  type EventKitRequest,
  RemindersUnavailableError,
} from './platform/macos/eventkit.ts';
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
} from './platform/macos/eventkit-documents.ts';
import nativeProcess from './platform/macos/native-process.ts';
import {
  NoteStore,
  NotesSchemaError,
  NotesUnavailableError,
} from './platform/macos/note-store.ts';
import { decodeArchive, plistJSON } from './platform/macos/plist.ts';
import { ApplePlugin } from './plugin/apple-plugin.ts';
import { setUpWithForms } from './plugin/setup-forms.ts';
import {
  AppleCalendarSource,
  CalendarIcsUnavailableError,
} from './sources/apple-calendar/apple-calendar-source.ts';
import { parseICalendar } from './sources/apple-calendar/icalendar.ts';
import { icsStreams } from './sources/apple-calendar/ics-records.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

const execFile = promisify(execFileCallback);

const at = (iso: string) => Date.parse(iso);

const account = (
  overrides: Partial<AccountDocument> = {},
): AccountDocument => ({
  type: 'account',
  id: 'account-1',
  name: 'iCloud',
  sourceType: 2,
  isDelegate: false,
  ...overrides,
});

const calendar = (
  overrides: Partial<CalendarDocument> = {},
): CalendarDocument => ({
  type: 'calendar',
  id: 'calendar-1',
  accountId: 'account-1',
  name: 'Work',
  calendarType: 1,
  writable: true,
  subscribed: false,
  immutable: false,
  color: [0.2, 0.4, 0.6, 1],
  supportedAvailabilities: 0,
  allowedEntityTypes: 1,
  notes: 'About',
  selected: true,
  ...overrides,
});

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

const alarm = (overrides: Partial<AlarmDocument> = {}): AlarmDocument => ({
  alarmType: 0,
  relativeOffset: -600,
  proximity: 0,
  ...overrides,
});

const rule = (
  overrides: Partial<RecurrenceRuleDocument> = {},
): RecurrenceRuleDocument => ({
  calendarIdentifier: 'gregorian',
  frequency: 0,
  interval: 1,
  firstDayOfWeek: 0,
  daysOfTheWeek: [],
  daysOfTheMonth: [],
  daysOfTheYear: [],
  weeksOfTheYear: [],
  monthsOfTheYear: [],
  setPositions: [],
  ...overrides,
});

const occurrence = (
  overrides: Partial<OccurrenceDocument> = {},
): OccurrenceDocument => ({
  type: 'occurrence',
  calendarId: 'calendar-1',
  calendarItemId: 'item-1',
  name: 'Standup',
  startMs: at('2025-01-02T09:00:00.000Z'),
  endMs: at('2025-01-02T10:00:00.000Z'),
  startDay: '2025-01-02',
  endDay: '2025-01-02',
  allDay: false,
  detached: false,
  status: 1,
  availability: 0,
  attendees: [],
  alarms: [],
  recurrenceRules: [],
  ...overrides,
});

const icsItem = (
  calendarItemId: string,
  ics: string,
  recurring = false,
): IcsDocument => ({
  type: 'ics',
  calendarId: 'calendar-1',
  calendarItemId,
  recurring,
  ics: Buffer.from(ics).toString('base64'),
});

const reminder = (
  overrides: Partial<ReminderDocument> = {},
): ReminderDocument => ({
  type: 'reminder',
  id: 'reminder-1',
  listId: 'calendar-1',
  name: 'Buy milk',
  completed: false,
  priority: 0,
  attendees: [],
  alarms: [],
  recurrenceRules: [],
  ...overrides,
});

// A Calendar row's event id: calendar, item and, for a recurring event, the
// occurrence it replaces.
const eventId = (calendarItemId: string, key: string | null = null) =>
  JSON.stringify(['calendar-1', calendarItemId, key]);

type HelperRequest = EventKitRequest & {
  readonly entity: 'events' | 'reminders';
};

// A watcher that confirms its subscription and then reports no change, so
// reads settle on their first attempt.
async function* quiet(signal: AbortSignal): AsyncGenerator<string> {
  yield 'changed';
  if (!signal.aborted) await once(signal, 'abort');
}

// Stands in for the eventkit helper process: each read request is answered
// with documents, one JSON line each, and each watch with the watch lines.
function fakeEventKit(
  t: TestContext,
  read: (
    request: HelperRequest,
  ) => Iterable<EventKitDocument> | AsyncIterable<EventKitDocument>,
  watch: (signal: AbortSignal) => AsyncIterable<string> = quiet,
) {
  const requests: HelperRequest[] = [];
  const mock = t.mock.method(
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
      const request: HelperRequest = JSON.parse(String(args[1]));
      requests.push(request);
      for await (const document of read(request))
        yield JSON.stringify(document);
    },
  );
  return { requests, mock };
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

const noteRows = (path: string, sql: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};

const notesPipeline = (source: AppleNotesSource, directory: string) => {
  const destination = new SQLiteDestination({
    path: join(directory, 'notes.sqlite'),
  });
  return {
    destination,
    pipeline: new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(directory, 'notes-state.sqlite'),
          }),
          steps: [
            source.accounts,
            source.folders,
            source.notes,
            source.inlineAttachments,
            source.attachments,
          ].map(
            (stream) =>
              new Copy(
                stream,
                stream.supportsFileTransfer
                  ? destination.table(stream.name, (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns.blob('bytes').from(stream.file),
                    ])
                  : destination.table(stream.name),
                {
                  id: stream.name,
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                },
              ),
          ),
        }),
      ],
    }),
  };
};

test('Apple setup asks only which apps, imports each in full or as narrowed before, reports an app macOS denied, and changes nothing when cancelled', async (t) => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-forms-'));
  const path = await noteStoreFixture(join(scratch.path, 'native'));
  const openNative = NoteStore.open;
  t.mock.method(
    NoteStore,
    'open',
    async (_path: string, required: Parameters<typeof NoteStore.open>[1]) =>
      openNative(path, required),
  );
  t.mock.method(ChatDatabase, 'open', async () => {
    throw new MessagesUnavailableError(
      'synthetic-chat.db',
      new Error('denied'),
    );
  });
  const plugin = new ApplePlugin(join(scratch.path, 'plugin'));
  const forms: ElicitRequestFormParams[] = [];
  // The user's answers, one per form.
  const setUp = async (...answers: ElicitResult[]) => {
    forms.length = 0;
    const result = await setUpWithForms(plugin, async (form) => {
      forms.push(form);
      const answer = answers.shift();
      assert.ok(answer, `unexpected form: ${form.message}`);
      return answer;
    });
    assert.deepEqual(answers, []);
    return result;
  };

  // One form, the apps: each chosen app is imported in full.
  const connected = await setUp({
    action: 'accept',
    content: { apps: ['notes', 'messages'] },
  });
  assert.equal(forms.length, 1);
  assert.deepEqual(Object.keys(forms[0]?.requestedSchema.properties ?? {}), [
    'apps',
  ]);
  assert.equal(connected.changed, true);
  assert.ok('unavailable' in connected);
  assert.deepEqual(
    connected.unavailable.map(({ app }) => app),
    ['messages'],
  );
  // Setup only saves the answers; the leading server imports them.
  const [notes] = connected.apps;
  assert.deepEqual(notes?.scope, {});
  assert.equal(notes?.includeAttachments, true);
  assert.equal(notes?.database, null);
  assert.equal(notes?.sync, null);

  // A selection the user narrowed in chat survives setting up again.
  const narrowed = { collectionIds: ['FOLDER-NOTES'] };
  plugin.configure({
    apps: [{ app: 'notes', scope: narrowed, includeAttachments: false }],
  });
  const kept = await setUp({ action: 'accept', content: { apps: ['notes'] } });
  assert.deepEqual(kept.apps[0]?.scope, narrowed);
  assert.equal(kept.apps[0]?.includeAttachments, false);

  const cancelled = await setUp({ action: 'cancel' });
  assert.equal(cancelled.changed, false);
  assert.deepEqual(cancelled.apps[0]?.scope, narrowed);
});

test('Notes scope excludes other folders from records, attachments and checkpoints', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-scope-'));
  const source = new AppleNotesSource({
    path: await noteStoreFixture(scratch.path),
    scope: {
      accountIds: ['ACCOUNT-1'],
      collectionIds: ['FOLDER-TRASH'],
      startAt: '2025-02-01T00:00:00.000Z',
      endAt: '2025-03-01T00:00:00.000Z',
    },
  });
  const { pipeline, destination } = notesPipeline(source, scratch.path);
  await pipeline.run();
  assert.deepEqual(noteRows(destination.path, 'SELECT id FROM notes'), [
    { id: 'NOTE-TRASHED' },
  ]);
  assert.deepEqual(
    noteRows(destination.path, 'SELECT id FROM attachments'),
    [],
  );
  const saved = JSON.stringify(
    noteRows(
      join(scratch.path, 'notes-state.sqlite'),
      'SELECT state FROM checkpoints',
    ),
  );
  assert.ok(saved.includes('NOTE-TRASHED'));
  assert.ok(!saved.includes('NOTE-RICH') && !saved.includes('ATT-FILE'));
});

test('Notes exports every stream from its store, skipping cloud placeholders and locked content', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const source = new AppleNotesSource({
    path: await noteStoreFixture(scratch.path),
  });
  const { destination, pipeline } = notesPipeline(source, scratch.path);

  for (const stream of (await source.discover()).streams) {
    assert.ok(
      typeof stream.jsonSchema.description === 'string' &&
        stream.jsonSchema.description.length > 0,
      stream.name,
    );
    for (const [name, field] of Object.entries(
      stream.jsonSchema.properties as Record<string, Record<string, unknown>>,
    )) {
      assert.ok(
        typeof field.description === 'string' && field.description.length > 0,
        `${stream.name}.${name}`,
      );
    }
  }

  const results = await pipeline.run();

  const rows = (sql: string) => noteRows(destination.path, sql);
  assert.deepEqual(
    results.map(({ copy, count }) => [copy.from.name, count]),
    [
      ['accounts', 1],
      ['folders', 3],
      ['notes', 3],
      ['inlineAttachments', 2],
      ['attachments', 4],
    ],
  );
  assert.deepEqual(rows('SELECT id, name, type FROM accounts'), [
    { id: 'ACCOUNT-1', name: 'iCloud', type: 1 },
  ]);
  assert.deepEqual(
    rows('SELECT id, accountId, parentId, name, type FROM folders ORDER BY id'),
    [
      {
        id: 'FOLDER-CHILD',
        accountId: 'ACCOUNT-1',
        parentId: 'FOLDER-NOTES',
        name: 'Child',
        type: 0,
      },
      {
        id: 'FOLDER-NOTES',
        accountId: 'ACCOUNT-1',
        parentId: null,
        name: 'Notes',
        type: 0,
      },
      {
        id: 'FOLDER-TRASH',
        accountId: 'ACCOUNT-1',
        parentId: null,
        name: 'Recently Deleted',
        type: 1,
      },
    ],
  );
  assert.deepEqual(
    rows(
      'SELECT id, folderId, title, text, markdown, createdAt, modifiedAt, pinned, hasChecklist, checklistInProgress, locked FROM notes ORDER BY id',
    ),
    [
      {
        id: 'NOTE-LOCKED',
        folderId: 'FOLDER-NOTES',
        title: 'Secret',
        text: null,
        markdown: null,
        createdAt: '2025-01-02T03:04:05.006Z',
        modifiedAt: '2025-02-03T04:05:06.007Z',
        pinned: 0,
        hasChecklist: 0,
        checklistInProgress: 0,
        locked: 1,
      },
      {
        id: 'NOTE-RICH',
        folderId: 'FOLDER-NOTES',
        title: 'Groceries',
        text: 'Groceries\nMilk\nEggs\nBuy fresh\nsee site\n\n\ntag #food\nlink Old',
        markdown: [
          '# Groceries',
          '- [x] Milk',
          '- [ ] Eggs',
          'Buy **fresh**',
          'see [site](<https://example.com/list>)',
          '[list.txt](attachment:ATT-FILE)',
          '',
          '| a1 | b1 |',
          '| --- | --- |',
          '| a2 | b2 |',
          '',
          'tag #food',
          'link [Old](<applenotes:note/note-trashed>)',
        ].join('\n'),
        createdAt: '2025-01-02T03:04:05.006Z',
        modifiedAt: '2025-02-03T04:05:06.007Z',
        pinned: 1,
        hasChecklist: 1,
        checklistInProgress: 1,
        locked: 0,
      },
      {
        id: 'NOTE-TRASHED',
        folderId: 'FOLDER-TRASH',
        title: 'Old',
        text: 'Old\nthrown away',
        markdown: 'Old\nthrown away',
        createdAt: '2025-01-02T03:04:05.006Z',
        modifiedAt: '2025-02-03T04:05:06.007Z',
        pinned: 0,
        hasChecklist: 0,
        checklistInProgress: 0,
        locked: 0,
      },
    ],
  );
  assert.deepEqual(
    rows(
      'SELECT id, noteId, type, text, target FROM inlineAttachments ORDER BY id',
    ),
    [
      {
        id: 'INLINE-LINK',
        noteId: 'NOTE-RICH',
        type: 'com.apple.notes.inlinetextattachment.link',
        text: 'Old',
        target: 'applenotes:note/note-trashed',
      },
      {
        id: 'INLINE-TAG',
        noteId: 'NOTE-RICH',
        type: 'com.apple.notes.inlinetextattachment.hashtag',
        text: '#food',
        target: 'FOOD',
      },
    ],
  );
  assert.deepEqual(
    rows(
      'SELECT id, noteId, type, filename, ocrText, latitude, longitude, availableLocally, CAST(bytes AS TEXT) AS content FROM attachments ORDER BY id',
    ).map(({ content, ...row }) => ({ ...row, hasBytes: content !== null })),
    [
      {
        id: 'ATT-FILE',
        noteId: 'NOTE-RICH',
        type: 'public.plain-text',
        filename: 'list.txt',
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 1,
        hasBytes: true,
      },
      {
        id: 'ATT-LOCKED',
        noteId: 'NOTE-LOCKED',
        type: 'public.jpeg',
        filename: null,
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 0,
        hasBytes: false,
      },
      {
        id: 'ATT-PHOTO',
        noteId: 'NOTE-RICH',
        type: 'public.jpeg',
        filename: 'photo.jpg',
        ocrText: 'photo words',
        latitude: 52.52,
        longitude: 13.405,
        availableLocally: 0,
        hasBytes: false,
      },
      {
        id: 'ATT-TABLE',
        noteId: 'NOTE-RICH',
        type: 'com.apple.notes.table',
        filename: null,
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 0,
        hasBytes: false,
      },
    ],
  );
});

test('Notes loads edits and deletions incrementally and a repeat run writes nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const path = await noteStoreFixture(scratch.path);
  const source = new AppleNotesSource({ path });
  const { pipeline } = notesPipeline(source, scratch.path);
  const counts = async () =>
    Object.fromEntries(
      (await pipeline.run()).map(({ copy, count, deleted }) => [
        copy.from.name,
        [count, deleted],
      ]),
    );

  await pipeline.run();
  const unchanged = await counts();
  {
    using notes = new DatabaseSync(path);
    notes
      .prepare('UPDATE ZICNOTEDATA SET ZDATA = ? WHERE Z_PK = 4')
      .run(noteBody([{ text: 'Old\nrestored\n' }]));
    notes.exec(
      "UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1 WHERE ZIDENTIFIER IN ('ATT-PHOTO', 'NOTE-LOCKED')",
    );
  }
  const changed = await counts();

  assert.deepEqual(unchanged, {
    accounts: [0, 0],
    folders: [0, 0],
    notes: [0, 0],
    inlineAttachments: [0, 0],
    attachments: [0, 0],
  });
  assert.deepEqual(changed, {
    accounts: [0, 0],
    folders: [0, 0],
    notes: [1, 1],
    inlineAttachments: [0, 0],
    attachments: [0, 2],
  });
});

// The configured stream a full-refresh copy of stream reads.
const configured = (stream: Stream) =>
  new Copy(
    stream,
    new SQLiteDestination({ path: ':memory:' }).table(stream.name),
  ).configuration;

// One read of first then second, with a write committed between them; returns
// what second read and what a later read sees.
const acrossStreams = async (
  source: Source,
  [first, second]: [Stream, Stream],
  write: () => void,
  field: string,
) => {
  const values = (messages: readonly ReadMessage[]) =>
    messages
      .flatMap((message) =>
        'data' in message && message.stream === second.name
          ? [Reflect.get(Object(message.data), field)]
          : [],
      )
      .sort();
  const pinned: ReadMessage[] = [];
  for await (const message of source.read(
    [configured(first), configured(second)],
    new Map(),
  )) {
    pinned.push(message);
    if (
      message instanceof StreamStatus &&
      message.stream === first.name &&
      message.status === 'ENDED'
    )
      write();
  }
  const later = await Array.fromAsync(
    source.read([configured(second)], new Map()),
  );
  return { during: values(pinned), after: values(later) };
};

test('one Notes read sees one moment of the store while Notes keeps writing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const path = await noteStoreFixture(scratch.path);
  const source = new AppleNotesSource({ path });

  const { during, after } = await acrossStreams(
    source,
    [source.folders, source.notes],
    () => {
      using notes = new DatabaseSync(path);
      notes.exec(
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7) VALUES (12, 'NOTE-NEW', 'New', 2, 1)",
      );
    },
    'id',
  );

  assert.ok(!during.includes('NOTE-NEW'));
  assert.deepEqual(after, [...during, 'NOTE-NEW'].sort());
});

test('Notes names Full Disk Access when its store cannot be opened and refuses an unknown layout', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const unknown = join(scratch.path, 'NoteStore.sqlite');
  {
    using database = new DatabaseSync(unknown);
    database.exec(
      'CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER, Z_NAME VARCHAR); CREATE TABLE ZICNOTEDATA (Z_PK INTEGER, ZDATA BLOB); CREATE TABLE ZICLOCATION (ZATTACHMENT INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT); CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, Z_ENT INTEGER, ZIDENTIFIER VARCHAR)',
    );
  }
  const missing = new AppleNotesSource({
    path: join(scratch.path, 'missing', 'NoteStore.sqlite'),
  });
  const other = new AppleNotesSource({ path: unknown });

  const opening = Array.fromAsync(
    missing.read([configured(missing.notes)], new Map()),
  );
  const reading = Array.fromAsync(
    other.read([configured(other.notes)], new Map()),
  );

  await assert.rejects(opening, (error) => {
    assert.ok(error instanceof NotesUnavailableError);
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  await assert.rejects(reading, (error) => {
    assert.ok(error instanceof NotesSchemaError);
    assert.match(error.message, /ZICCLOUDSYNCINGOBJECT\.ZTITLE1/);
    return true;
  });
});

test('a Notes watch keeps Notes running and loads each commit while Notes keeps its store open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const path = await noteStoreFixture(scratch.path);
  let launches = 0;
  const source = new AppleNotesSource({
    path,
    pollIntervalMs: 20,
    launchIntervalMs: 50,
    launch: async () => {
      launches++;
    },
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.notes, destination.table('notes'), {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  // Notes holds its connection, and so its WAL, open the whole time.
  using notes = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: controller.signal,
  })) {
    batches.push(outcomes[0]?.count ?? -1);
    if (batches.length === 1)
      notes.exec(
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7) VALUES (12, 'NOTE-NEW', 'New', 2, 1)",
      );
    else setTimeout(() => controller.abort(), 200);
  }

  assert.deepEqual(batches, [3, 1]);
  // Once at the start, then again on the interval while the watch runs.
  assert.ok(launches > 1);
});

test('Calendar extracts every scalar stream into SQLite and Markdown', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const { requests } = fakeEventKit(t, () => [
    account(),
    calendar(),
    occurrence({
      occurrenceMs: at('2025-01-02T09:00:00.000Z'),
      attendees: [participant()],
      alarms: [alarm()],
      recurrenceRules: [
        rule({
          frequency: 2,
          end: { occurrenceCount: 3 },
          daysOfTheMonth: [-1],
        }),
      ],
    }),
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

  assert.deepEqual(
    result.map(({ count }) => count),
    Array(7).fill(1),
  );
  // Every stream comes from one helper read, without the private ICS export.
  assert.deepEqual(requests, [
    {
      entity: 'events',
      startAt: source.startAt,
      endAt: source.endAt,
      ics: false,
    },
  ]);
  const id = eventId('item-1', '2025-01-02T09:00:00.000Z');
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT id, calendarId, name, startAt, endAt, allDay, startDate, occurrenceAt FROM events',
        )
        .get(),
    },
    {
      id,
      calendarId: 'calendar-1',
      name: 'Standup',
      startAt: '2025-01-02T09:00:00.000Z',
      endAt: '2025-01-02T10:00:00.000Z',
      allDay: 0,
      startDate: null,
      occurrenceAt: '2025-01-02T09:00:00.000Z',
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT id, accountId, name, description, colorRed FROM calendars',
        )
        .get(),
    },
    {
      id: 'calendar-1',
      accountId: 'account-1',
      name: 'Work',
      description: 'About',
      colorRed: 0.2,
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
      eventId: id,
      ruleId: JSON.stringify([id, 'recurrenceRule', 0]),
      component: 'daysOfTheMonth',
      position: 0,
      value: -1,
    },
  );

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
  assert.match(document, /^## Standup$/m);
  assert.ok(
    document.includes(Buffer.from(JSON.stringify(event)).toString('base64')),
  );
});

test('Calendar validates its request range and preflights without the EventKit helper', {
  concurrency: false,
}, async (t) => {
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
  const { mock } = fakeEventKit(t, () => []);
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
    [{ cursorField: 'modifiedAt' }, /defines its own cursor; omit cursorField/],
    [{ dedupPolicy: 'cursor_newer' }, /no cursor field to compare/],
    [
      { primaryKey: ['eventId'] },
      /defines its own primary key; omit primaryKey/,
    ],
  ] as const)
    await assert.rejects(
      async () =>
        new Pipeline({
          connections: [
            new Connection({
              name: 'test',
              source,
              destination: sqlite,
              checkpoints,
              steps: [
                new Copy(source.events, sqlite.table('events'), {
                  ...snapshotCopy,
                  ...options,
                } as ConstructorParameters<typeof Copy>[2]),
              ],
            }),
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
  assert.equal(mock.mock.callCount(), 0);
});

test('Calendar rejects malformed records and preserves prior Markdown on native failures', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  let respond: () => Iterable<EventKitDocument> = () => [occurrence()];
  fakeEventKit(t, () => respond());
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
  const { name: _name, ...unnamed } = occurrence();
  for (const [document, message] of [
    [unnamed, /invalid events/],
    [{ ...occurrence(), body: { nested: true } }, /invalid events\.body/],
    [occurrence({ allDay: true, startDay: 'not-a-date' }), /invalid events/],
    [
      occurrence({ endMs: at('2025-01-02T08:00:00.000Z') }),
      /inconsistent event dates/,
    ],
    [
      occurrence({ recurrenceRules: [rule()] }),
      /recurring event without an occurrence date/,
    ],
  ] as const) {
    respond = () => [document as unknown as EventKitDocument];
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
  respond = () => [
    { ...occurrence(), body: { nested: true } } as unknown as EventKitDocument,
  ];
  await assert.rejects(sqliteRun(), /invalid events\.body/);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database.prepare('SELECT id, name FROM events').get(),
    },
    { id: eventId('item-1'), name: 'Standup' },
  );

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
        error.cause instanceof CalendarUnavailableError &&
        error.cause.cause === failure,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }

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
});

test('Calendar snapshot incremental reconciles added, changed, moved and removed rows', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
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
  let native = [event('e1', 'Standup', ['Ann', 'Bo']), event('e2', 'Review')];
  fakeEventKit(t, () => native);
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
});

test('Calendar keeps the first copy of an occurrence the helper returns for adjacent windows', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2024-01-01T00:00:00.000Z',
    endAt: '2026-01-01T00:00:00.000Z',
  });
  // The helper reads one-year windows and writes an occurrence once per
  // window it overlaps: "spanning" overlaps both, "late" only the second.
  const spanning = occurrence({
    calendarItemId: 'spanning',
    attendees: [participant()],
  });
  fakeEventKit(t, () => [
    spanning,
    { ...spanning, name: 'Second window copy' },
    occurrence({ calendarItemId: 'late' }),
  ]);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-cal-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'calendar.sqlite'),
  });
  const statePath = join(scratch.path, 'state.sqlite');
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
        checkpoints: new SQLiteCheckpointStore({ path: statePath }),
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
      { id: eventId('late'), name: 'Standup' },
      { id: eventId('spanning'), name: 'Standup' },
    ],
  );
  using state = new DatabaseSync(statePath, { readOnly: true });
  const rows = state.prepare('SELECT state FROM checkpoints').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(String(rows[0]?.state)).snapshot),
    [eventId('late'), eventId('spanning')].map((id) => JSON.stringify([id])),
  );
  const attendees = (await readRows(source, [source.attendees]))(
    source.attendees,
  );
  assert.deepEqual(
    attendees.map((row) => row.eventId),
    [eventId('spanning')],
  );
});

test('Calendar and Reminders scope passes the chosen calendars to the helper and keeps only what it selected', async (t) => {
  const scope = { accountIds: ['account-1'], collectionIds: ['selected'] };
  const { requests } = fakeEventKit(t, (request) => [
    account(),
    account({ id: 'account-2', name: 'Work' }),
    calendar({
      id: 'selected',
      selected: request.collectionIds?.includes('selected') ?? true,
    }),
    calendar({
      id: 'excluded',
      accountId: 'account-2',
      selected: request.collectionIds?.includes('excluded') ?? true,
    }),
  ]);
  const listed = async (source: Source, streams: readonly Stream[]) => {
    const rows = await readRows(source, streams);
    return streams.map((stream) => rows(stream).map(({ id }) => id));
  };
  const window = {
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  };
  const calendars = new AppleCalendarSource({ ...window, scope });
  const noCalendars = new AppleCalendarSource({
    ...window,
    scope: { collectionIds: ['missing'] },
  });
  const reminders = new AppleRemindersSource(scope);
  const noReminders = new AppleRemindersSource({ collectionIds: ['missing'] });

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
  assert.deepEqual(
    requests.map(({ entity, accountIds, collectionIds }) => ({
      entity,
      accountIds,
      collectionIds,
    })),
    [
      { entity: 'events', ...scope },
      { entity: 'events', accountIds: undefined, collectionIds: ['missing'] },
      { entity: 'reminders', ...scope },
      {
        entity: 'reminders',
        accountIds: undefined,
        collectionIds: ['missing'],
      },
    ],
  );
});

test('Calendar links alarms, recurrence rules and rule values to their occurrence', async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-01-02T00:00:00.000Z',
  });
  fakeEventKit(t, () => [
    occurrence({
      startMs: at('2025-01-01T00:00:00.000Z'),
      endMs: at('2025-01-01T01:00:00.000Z'),
      startDay: '2025-01-01',
      endDay: '2025-01-01',
      occurrenceMs: at('2025-01-01T00:00:00.000Z'),
      alarms: [alarm({ relativeOffset: -600 })],
      recurrenceRules: [
        rule({
          frequency: 2,
          end: { occurrenceCount: 3 },
          daysOfTheMonth: [-1],
        }),
      ],
    }),
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
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const attendee = (address: string, status: number) =>
    participant({ name: address, url: `mailto:${address}`, status });
  let attendees = [attendee('a@example.com', 2), attendee('b@example.com', 1)];
  let alarms = [
    alarm({ relativeOffset: -600 }),
    alarm({ relativeOffset: -3600 }),
  ];
  fakeEventKit(t, () => [occurrence({ attendees, alarms })]);
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
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-01-04T00:00:00.000Z',
  });
  const daily = [rule()];
  const original = occurrence({
    calendarItemId: 'series',
    startMs: at('2025-01-01T09:00:00.000Z'),
    endMs: at('2025-01-01T10:00:00.000Z'),
    startDay: '2025-01-01',
    endDay: '2025-01-01',
    occurrenceMs: at('2025-01-01T09:00:00.000Z'),
    recurrenceRules: daily,
  });
  let native: EventKitDocument[] = [original];
  fakeEventKit(t, () => native);
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
      startMs: at('2025-01-02T11:00:00.000Z'),
      endMs: at('2025-01-02T12:00:00.000Z'),
      startDay: '2025-01-02',
      endDay: '2025-01-02',
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
          id: eventId('series', '2025-01-01T09:00:00.000Z'),
          startAt: '2025-01-02T11:00:00.000Z',
          detached: 1,
        },
      ],
    );
  }

  // In Asia/Amman (UTC+3) this all-day day starts at 21:00Z the day before;
  // saved all-day events end one second before the next local midnight
  // (verified live).
  native = [
    occurrence({
      calendarItemId: 'holiday',
      allDay: true,
      startMs: at('2024-12-31T21:00:00.000Z'),
      endMs: at('2025-01-01T20:59:59.000Z'),
      startDay: '2025-01-01',
      endDay: '2025-01-01',
      occurrenceMs: at('2024-12-31T21:00:00.000Z'),
      occurrenceDay: '2025-01-01',
      recurrenceRules: daily,
    }),
  ];
  const [day] = (await readRows(source, [source.events]))(source.events);
  assert.ok(day);
  assert.equal(day.startDate, '2025-01-01');
  assert.equal(day.endDate, '2025-01-01');
  assert.equal(day.startAt, '2024-12-31T21:00:00.000Z');
  assert.equal(day.occurrenceAt, '2024-12-31T21:00:00.000Z');
  assert.equal(day.occurrenceDate, '2025-01-01');
  assert.equal(JSON.parse(String(day.id)).at(-1), '2025-01-01');
});

test('Reminders EventKit projects native records through every SQLite and Markdown stream', {
  concurrency: false,
}, async (t) => {
  const source = new AppleRemindersSource();
  const streams = (await source.discover()).streams;
  const components = (
    overrides: Partial<DateComponentsDocument> = {},
  ): DateComponentsDocument => ({
    calendarIdentifier: 'gregorian',
    year: 2026,
    month: 9,
    day: 21,
    leapMonth: false,
    repeatedDay: false,
    ...overrides,
  });
  fakeEventKit(t, (request) => {
    assert.equal(request.entity, 'reminders');
    return [
      account({ name: 'Synthetic account', sourceType: 0 }),
      calendar({ name: 'Synthetic list', allowedEntityTypes: 2 }),
      reminder({ id: 'undated', name: 'undated' }),
      reminder({
        id: 'date-only',
        name: 'date-only',
        createdMs: at('2026-09-01T00:00:00.000Z'),
        due: components(),
      }),
      reminder({
        id: 'timed',
        name: 'timed',
        body: 'Native body',
        url: 'https://example.com/reminder',
        priority: 1,
        due: components({
          hour: 0,
          minute: 30,
          second: 0,
          timeZone: 'Asia/Amman',
        }),
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
          alarm({ relativeOffset: 0, absoluteMs: 1735689600000 }),
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
      reminder({
        id: 'floating',
        name: 'floating',
        start: components({ hour: 9, minute: 15 }),
      }),
      reminder({ id: 'completed', name: 'completed', completed: true }),
    ];
  });

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
  assert.equal(reminderRow('completed').completed, true);
  assert.equal(reminderRow('completed').completedAt, null);
  assert.equal(reminderRow('undated').createdAt, null);
  assert.equal(reminderRow('date-only').createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(reminderRow('timed').url, 'https://example.com/reminder');
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
  assert.equal(date('date-only').day, 21);
  assert.equal(date('date-only').timeZone, null);
  assert.equal(date('timed').hour, 0);
  assert.equal(date('timed').minute, 30);
  assert.equal(date('timed').timeZone, 'Asia/Amman');
  assert.equal(date('floating').kind, 'start');
  assert.equal(date('floating').hour, 9);
  assert.equal(date('floating').timeZone, null);
  assert.equal(
    dateComponents.some((row) => row.reminderId === reminderRow('undated').id),
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
    '2025-01-01T00:00:00.000Z',
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
            new Copy(stream, markdown.file(`${stream.name.toLowerCase()}.md`)),
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

test('Reminders keeps each date component set intact and rejects unidentified reminders', {
  concurrency: false,
}, async (t) => {
  const source = new AppleRemindersSource();
  let native: EventKitDocument[] = [
    reminder({
      id: 'both',
      start: {
        calendarIdentifier: 'gregorian',
        year: 2026,
        month: 6,
        day: 1,
        leapMonth: true,
        repeatedDay: false,
      },
      due: {
        calendarIdentifier: 'gregorian',
        year: 2026,
        month: 9,
        day: 21,
        hour: 17,
        minute: 0,
        leapMonth: false,
        repeatedDay: false,
      },
    }),
    reminder({
      id: 'calendarless',
      due: {
        year: 2026,
        month: 9,
        day: 21,
        leapMonth: false,
        repeatedDay: false,
      },
    }),
  ];
  fakeEventKit(t, () => native);
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
        year: 2026,
        month: 6,
        day: 1,
        hour: null,
        minute: null,
        dayOfYear: null,
        leapMonth: true,
        repeatedDay: false,
      },
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
    native = [unidentified];
    await assert.rejects(
      readRows(source, [source.reminders]),
      /invalid reminders/,
    );
  }
});

test('Reminders rejects unsupported selections and preserves targets on invalid data or access failure', {
  concurrency: false,
}, async (t) => {
  const source = new AppleRemindersSource();
  let respond: () => Iterable<EventKitDocument> = () => [reminder()];
  const { mock } = fakeEventKit(t, () => respond());
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
  assert.equal(mock.mock.callCount(), 0);
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
  const { name: _name, ...unnamed } = reminder();
  for (const invalid of [
    unnamed,
    reminder({ id: '' }),
    reminder({ priority: 10 }),
    { ...reminder(), completed: 'yes' },
  ]) {
    respond = () => [invalid as unknown as EventKitDocument];
    await assert.rejects(run(), /invalid reminders/);
    assert.equal(await readFile(path, 'utf8'), previous);
  }
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
        error.cause instanceof RemindersUnavailableError &&
        error.cause.cause === failure,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  const failure = new Error('eventkit exited: EventKit reminder query failed');
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
});

test('EventKit watch confirms its subscription through the native helper and stops on abort', {
  timeout: 120_000,
}, async (t) => {
  if (process.platform !== 'darwin') return t.skip('EventKit requires macOS');
  const helper = fileURLToPath(
    new URL('./platform/macos/eventkit', import.meta.url),
  );
  for (const [entity, Unavailable] of [
    ['events', CalendarUnavailableError],
    ['reminders', RemindersUnavailableError],
  ] as const)
    await t.test(entity, async (t) => {
      const controller = new AbortController();
      try {
        const watching = new EventKit(entity).watch(controller.signal);
        const subscribed = await watching.next().catch((error: unknown) => {
          if (error instanceof Unavailable) return null;
          throw error;
        });
        if (subscribed === null) return t.skip(`no ${entity} access`);
        assert.deepEqual(subscribed, { value: undefined, done: false });
        const pending = watching.next();
        controller.abort();
        assert.deepEqual(await pending, { value: undefined, done: true });
        await assert.rejects(
          execFile('pgrep', [
            '-P',
            String(process.pid),
            '-f',
            `${helper} watch ${entity}`,
          ]),
          { code: 1 },
        );
      } finally {
        controller.abort();
      }
    });
});

test('Calendar and Reminders read this Mac’s EventKit stores into SQLite through the native helper', {
  timeout: 300_000,
}, async (t) => {
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
  for (const [name, source, Unavailable] of [
    ['calendar', calendar, CalendarUnavailableError],
    ['reminders', reminders, RemindersUnavailableError],
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
            error.cause instanceof Unavailable
          )
            return null;
          throw error;
        });
      if (outcomes === null) return t.skip(`no ${name} access`);
      assert.equal(outcomes.length, streams.length);
      using database = new DatabaseSync(sqlite.path, { readOnly: true });
      for (const { copy, count } of outcomes) {
        assert.ok(count >= 0, copy.from.name);
        assert.equal(
          database
            .prepare(`SELECT count(*) AS count FROM "${copy.from.name}"`)
            .get()?.count,
          count,
          copy.from.name,
        );
      }
    });
});

test('EventKit watching preserves permission failures and rejects invalid or stopped notifications', async (t) => {
  let watch: (signal: AbortSignal) => AsyncIterable<string> = quiet;
  fakeEventKit(
    t,
    () => [],
    (signal) => watch(signal),
  );
  for (const [entity, marker, Unavailable] of [
    ['events', 'CALENDAR_UNAVAILABLE', CalendarUnavailableError],
    ['reminders', 'REMINDERS_UNAVAILABLE', RemindersUnavailableError],
  ] as const) {
    const cause = Object.assign(new Error('eventkit exited'), {
      stderr: `${marker}: full access is required; status=2\n`,
    });
    watch = () => {
      throw cause;
    };
    await assert.rejects(
      new EventKit(entity).watch(new AbortController().signal).next(),
      (error) => {
        assert.ok(error instanceof Unavailable);
        assert.equal(error.cause, cause);
        return true;
      },
    );
  }
  watch = async function* () {
    yield 'unexpected';
  };
  await assert.rejects(
    new EventKit('events').watch(new AbortController().signal).next(),
    /invalid notification/,
  );
  watch = async function* () {
    yield 'changed';
  };
  const stopped = new EventKit('reminders').watch(new AbortController().signal);
  assert.deepEqual(await stopped.next(), { value: undefined, done: false });
  await assert.rejects(stopped.next(), /stopped unexpectedly/);
});

test('native processes close on abort or iterator return and report stderr when they fail', {
  timeout: 10_000,
}, async () => {
  const waiting = ['-c', 'echo ready; exec sleep 60'];
  const controller = new AbortController();
  try {
    await using watching = nativeProcess.lines(
      '/bin/sh',
      waiting,
      controller.signal,
    );
    assert.deepEqual(await watching.next(), { value: 'ready', done: false });
    const pending = watching.next();
    controller.abort();
    assert.deepEqual(await pending, { value: undefined, done: true });
  } finally {
    controller.abort();
  }
  const stopped = nativeProcess.lines('/bin/sh', waiting);
  assert.equal((await stopped.next()).value, 'ready');
  assert.deepEqual(await stopped.return(undefined), {
    value: undefined,
    done: true,
  });
  await assert.rejects(
    nativeProcess
      .lines('/bin/sh', ['-c', 'echo native probe failure >&2; exit 3'])
      .next(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /native probe failure/);
      assert.equal(Reflect.get(error, 'stderr'), 'native probe failure\n');
      return true;
    },
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

test('an unchanged Calendar item writes nothing when the export lists its exceptions and alarms in another order', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
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
  let reversed = false;
  fakeEventKit(t, () => [icsItem('series', exported(reversed), true)]);
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
});

test('Calendar ICS streams load components, raw properties and parameters with exact event links', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  fakeEventKit(t, (request) => {
    assert.equal(request.ics, true);
    return [icsItem('meeting', meetingICS), icsItem('series', seriesICS, true)];
  });
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
  let respond: (request: HelperRequest) => Iterable<EventKitDocument> = () => [
    icsItem('empty', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
  ];
  const { requests } = fakeEventKit(t, (request) => respond(request));
  await assert.rejects(
    readRows(source, [source.icsComponents]),
    /returned no VEVENT for saved item empty/,
  );
  const cause = Object.assign(new Error('eventkit exited'), {
    stderr:
      'CALENDAR_ICS_UNAVAILABLE: EKEventStore has no ICS export on this macOS version\n',
  });
  respond = (request) => {
    if (request.ics) throw cause;
    return [];
  };
  // Every ICS stream must reach the export, alone or not.
  for (const stream of icsStreams)
    await assert.rejects(readRows(source, [source[stream]]), (error) => {
      assert.ok(error instanceof CalendarIcsUnavailableError);
      assert.equal(error.cause, cause);
      return true;
    });
  assert.deepEqual(
    requests.map(({ ics }) => ics),
    Array(icsStreams.length + 1).fill(true),
  );
});

test('Calendar ICS snapshots delete a removed property with its parameters', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  let ics = meetingICS;
  fakeEventKit(t, () => [icsItem('meeting', ics)]);
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
  const named = (id: string, name: string) => reminder({ id, name });
  let native = [named('r1', 'Buy milk'), named('r2', 'Call Ann')];
  fakeEventKit(t, () => native);
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

test('Calendar attachment files come from the fetcher, inline data, or stay null when unreachable', {
  concurrency: false,
}, async (t) => {
  const fetched: string[] = [];
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
    attachments: async ({ uri, filename, formatType }, path) => {
      fetched.push(`${filename}:${formatType}`);
      if (uri.includes('denied')) return false;
      await writeFile(path, `bytes of ${filename}`);
      return true;
    },
  });
  fakeEventKit(t, () => [icsItem('files', attachmentsICS)]);
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
      .map((row) => ({
        ...row,
        bytes:
          row.bytes === null
            ? null
            : Buffer.from(row.bytes as Uint8Array).toString(),
      })),
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
});

test('Calendar attachment files need a fetcher, but attachment metadata does not', {
  concurrency: false,
}, async (t) => {
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  fakeEventKit(t, () => [icsItem('files', attachmentsICS)]);
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
});

test('Calendar incremental attachment copies fetch only new attachments and delete removed ones', {
  concurrency: false,
}, async (t) => {
  let ics = attachmentsICS;
  let fetches = 0;
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
    attachments: async (_attachment, path) => {
      fetches++;
      await writeFile(path, 'bytes');
      return true;
    },
  });
  fakeEventKit(t, () => [icsItem('files', ics)]);
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
});

// One empty page: a valid PDF with no text layer.
const blankPdf = (() => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
})();

// A PNG of the given line of text, drawn by AppKit, or a blank one.
const renderedText = (path: string, text: string | null) =>
  execFileSync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import('AppKit');
    const image = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 640, 160, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(image);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(context);
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, 640, 160));
    const text = ${JSON.stringify(text)};
    if (text !== null) {
      const attributes = $.NSMutableDictionary.alloc.init;
      attributes.setObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName);
      attributes.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
      $(text).drawAtPointWithAttributes($.NSMakePoint(20, 60), attributes);
    }
    context.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    image.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(${JSON.stringify(path)}, true);`,
  ]);

test('the document parser reads every attachment kind and throws only on unreadable files', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-parse-'));
  const file = async (name: string, content: string | Uint8Array) => {
    const path = join(scratch.path, name);
    await writeFile(path, content);
    return path;
  };
  const photo = join(scratch.path, 'receipt.png');
  renderedText(photo, 'Invoice 4821 due Friday');
  const heic = join(scratch.path, 'receipt.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', photo, '--out', heic]);
  const blank = join(scratch.path, 'blank.png');
  renderedText(blank, null);
  const card =
    'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD\n';
  const parser = new MacOSDocumentParser();

  const parsed = {
    photo: await parser.parse(photo),
    heic: await parser.parse(heic),
    noExtension: await parser.parse(
      await file('GroupPhotoImage', await readFile(heic)),
    ),
    blankImage: await parser.parse(blank),
    blankPdf: await parser.parse(await file('blank.pdf', blankPdf)),
    text: await parser.parse(await file('note.txt', 'hello')),
    card: await parser.parse(await file('Ada.vcf', card)),
    location: await parser.parse(await file('CL.loc.vcf', card)),
    video: await parser.parse(await file('clip.mov', Uint8Array.of(0, 1, 2))),
    unknown: await parser.parse(
      await file('pluginPayloadAttachment', Uint8Array.of(9, 9, 9, 9)),
    ),
  };
  const corruptPdf = parser.parse(await file('corrupt.pdf', 'not a pdf'));
  const corruptImage = parser.parse(
    await file('corrupt.heic', Uint8Array.of(0, 1, 2)),
  );

  assert.deepEqual(parsed, {
    photo: 'Invoice 4821 due Friday',
    heic: 'Invoice 4821 due Friday',
    noExtension: 'Invoice 4821 due Friday',
    blankImage: null,
    blankPdf: null,
    text: 'hello',
    card,
    location: card,
    video: null,
    unknown: null,
  });
  await assert.rejects(corruptPdf, /Cannot read PDF/);
  await assert.rejects(corruptImage, /Cannot read image/);
});

// A chat.db with Messages' own table definitions, captured from macOS 26.6.2
// (schema only, no data), in WAL mode like the real file.
const chatSchema = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER, engram_id TEXT, server_change_token TEXT, ck_sync_state INTEGER DEFAULT 0, original_group_id TEXT, last_read_message_timestamp INTEGER DEFAULT 0, cloudkit_record_id TEXT, last_addressed_sim_id TEXT, is_blackholed INTEGER DEFAULT 0, syndication_date INTEGER DEFAULT 0, syndication_type INTEGER DEFAULT 0, is_recovered INTEGER DEFAULT 0, is_deleting_incoming_messages INTEGER DEFAULT 0, is_pending_review INTEGER DEFAULT 0);
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service) );
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0, is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0, message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER, message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT, ck_record_change_tag TEXT, destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER, is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT, thread_originator_part TEXT, syndication_ranges TEXT, synced_syndication_ranges TEXT, was_delivered_quietly INTEGER DEFAULT 0, did_notify_recipient INTEGER DEFAULT 0, date_retracted INTEGER, date_edited INTEGER, was_detonated INTEGER DEFAULT 0, part_count INTEGER, is_stewie INTEGER DEFAULT 0, is_sos INTEGER DEFAULT 0, is_critical INTEGER DEFAULT 0, bia_reference_id TEXT, is_kt_verified INTEGER DEFAULT 0, fallback_hash TEXT, associated_message_emoji TEXT, is_pending_satellite_send INTEGER DEFAULT 0, needs_relay INTEGER DEFAULT 0, schedule_type INTEGER DEFAULT 0, schedule_state INTEGER DEFAULT 0, sent_or_received_off_grid INTEGER DEFAULT 0, date_recovered INTEGER DEFAULT 0, is_time_sensitive INTEGER DEFAULT 0, ck_chat_id TEXT, index_state INTEGER DEFAULT 0);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0, ck_sync_state INTEGER DEFAULT 0, ck_server_change_token_blob BLOB, ck_record_id TEXT, original_guid TEXT UNIQUE NOT NULL, is_commsafety_sensitive INTEGER DEFAULT 0, emoji_image_content_identifier TEXT, emoji_image_short_description TEXT, preview_generation_state INTEGER DEFAULT 0);
  CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, index_state INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
  CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
  CREATE TABLE chat_recoverable_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, delete_date INTEGER, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id), CHECK (delete_date != 0));
  CREATE TABLE recoverable_message_part (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, part_index INTEGER, delete_date INTEGER, part_text BLOB NOT NULL, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id, part_index), CHECK (delete_date != 0));
  CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, priority INTEGER DEFAULT 0, UNIQUE (identifier, domain));
  CREATE TABLE chat_service (service TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, UNIQUE (service, chat));
`;

// A binary property list, encoded by plutil from XML.
const binaryPlist = (xml: string) =>
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
    input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml}</plist>`,
  });

// A link preview as Messages stores it in payload_data, archived by
// NSKeyedArchiver around a real LPLinkMetadata.
const linkPayload = () =>
  Buffer.from(
    execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('LinkPresentation');
        const metadata = $.LPLinkMetadata.alloc.init;
        metadata.URL = $.NSURL.URLWithString('https://example.com/article');
        metadata.originalURL = $.NSURL.URLWithString('https://example.com/a');
        metadata.title = 'An article';
        metadata.siteName = 'Example';
        const root = $.NSMutableDictionary.alloc.init;
        root.setObjectForKey(metadata, 'richLinkMetadata');
        ObjC.unwrap($.NSKeyedArchiver.archivedDataWithRootObjectRequiringSecureCodingError(root, false, null).base64EncodedStringWithOptions(0));`,
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  );

// An NSAttributedString in typedstream form, as Messages archives a body.
const archivedText = (text: string) => {
  const bytes = Buffer.from(text);
  const length =
    bytes.length < 0x80
      ? [bytes.length]
      : [0x81, bytes.length & 0xff, bytes.length >> 8];
  return Buffer.concat([
    Buffer.from(
      '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+',
      'latin1',
    ),
    Buffer.from(length),
    bytes,
    Buffer.from('\x86\x84\x02iI\x01', 'latin1'),
  ]);
};

// Nanoseconds since 2001-01-01 UTC, Messages' modern time unit.
const appleNanoseconds = (iso: string) =>
  BigInt(Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1_000_000n;

const chatFixture = async (directory: string) => {
  const path = join(directory, 'chat.db');
  const attachment = join(directory, 'note.txt');
  await writeFile(attachment, 'attached words');
  using database = new DatabaseSync(path);
  database.exec(chatSchema);
  database.exec(`
    INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, group_id, style) VALUES (1, 'iMessage;-;+15550100', '+15550100', 'iMessage', '', 'group-1', 45);
    INSERT INTO handle VALUES (1, '+15550100', 'US', 'iMessage', '5550100', 'person-1');
    INSERT INTO chat_lookup VALUES ('+15550100', 'phone', 1, 0);
    INSERT INTO chat_service VALUES ('iMessage', 1);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO attachment (ROWID, guid, original_guid, created_date, filename, mime_type, transfer_name, total_bytes)
      VALUES (1, 'att-local', 'att-local', 757000000, '${attachment}', 'text/plain', 'note.txt', 14),
             (2, 'att-offloaded', 'att-offloaded', 757000000, '${join(directory, 'gone.heic')}', 'image/heic', 'gone.heic', 900);
  `);
  const insert = database.prepare(
    'INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, associated_message_guid, associated_message_type, cache_has_attachments, service) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    1,
    'm-plain',
    'hello',
    null,
    0,
    appleNanoseconds('2025-01-02T03:04:05.006Z'),
    null,
    0,
    0,
    'iMessage',
  );
  insert.run(
    2,
    'm-archived',
    null,
    archivedText('é'.repeat(100)),
    1,
    appleNanoseconds('2025-01-02T03:05:00.000Z'),
    null,
    0,
    1,
    'iMessage',
  );
  insert.run(
    3,
    'm-reaction',
    null,
    null,
    1,
    appleNanoseconds('2025-01-02T03:06:00.000Z'),
    'p:0/m-plain',
    2000,
    0,
    'iMessage',
  );
  // Histories from before macOS 10.13 stored whole seconds.
  insert.run(4, 'm-old', 'from 2016', null, 0, 500000000, null, 0, 0, 'SMS');
  insert.run(
    5,
    'm-deleted',
    'regretted',
    null,
    1,
    appleNanoseconds('2025-01-02T03:07:00.000Z'),
    null,
    0,
    0,
    'iMessage',
  );
  // Edit history as Messages keeps it: part 0's versions, each a time in
  // seconds since 2001 and an archived body. date_edited can stay 0.
  database
    .prepare(
      "UPDATE message SET message_summary_info = ? WHERE guid = 'm-plain'",
    )
    .run(
      binaryPlist(
        `<dict><key>ec</key><dict><key>0</key><array><dict><key>d</key><real>757393445.006</real><key>t</key><data>${archivedText('helo').toString('base64')}</data></dict><dict><key>d</key><real>757393460.5</real><key>t</key><data>${archivedText('hello').toString('base64')}</data></dict></array></dict><key>ust</key><true/></dict>`,
      ),
    );
  database
    .prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, balloon_bundle_id, payload_data) VALUES (6, 'm-link', 'https://example.com/a', 1, ?, 'com.apple.messages.URLBalloonProvider', ?)",
    )
    .run(appleNanoseconds('2025-01-02T03:08:00.000Z'), linkPayload());
  database.exec(`
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2), (1, 3), (1, 4), (1, 6);
    INSERT INTO message_attachment_join VALUES (2, 1), (2, 2);
  `);
  // Recently Deleted: the row stays in message, its chat link moves here.
  database
    .prepare(
      'INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (1, 5, ?)',
    )
    .run(appleNanoseconds('2025-01-02T04:00:00.000Z'));
  database
    .prepare(
      'INSERT INTO recoverable_message_part (chat_id, message_id, part_index, delete_date, part_text) VALUES (1, 5, 0, ?, ?)',
    )
    .run(
      appleNanoseconds('2025-01-02T04:00:00.000Z'),
      archivedText('regretted'),
    );
  return path;
};

const messagesRows = (path: string, sql: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};

test('Messages scope filters chat and native dates before decoding attachments and saving checkpoints', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'messages-scope-'),
  );
  const path = await chatFixture(scratch.path);
  using native = new DatabaseSync(path);
  // Invalid archived content on an excluded message must never be decoded.
  native.exec(
    "UPDATE message SET attributedBody=X'010203' WHERE guid='m-archived'",
  );
  const source = new AppleMessagesSource(path, undefined, {
    collectionIds: ['iMessage;-;+15550100'],
    startAt: '2025-01-02T03:04:05.006Z',
    endAt: '2025-01-02T03:04:05.007Z',
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  await new Pipeline({
    connections: [
      new Connection({
        name: 'scope',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  }).run();
  assert.deepEqual(
    messagesRows(destination.path, 'SELECT guid FROM messages'),
    [{ guid: 'm-plain' }],
  );
  assert.deepEqual(
    messagesRows(destination.path, 'SELECT guid FROM attachments'),
    [],
  );
  const saved = JSON.stringify(
    messagesRows(
      join(scratch.path, 'state.sqlite'),
      'SELECT state FROM checkpoints',
    ),
  );
  assert.ok(saved.includes('m-plain'));
  assert.ok(!saved.includes('m-archived') && !saved.includes('att-local'));
});

test('Messages exports every stream by guid, decodes archived text and streams local attachments', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const source = new AppleMessagesSource(await chatFixture(scratch.path));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const plain = (await source.discover()).streams
    .filter((stream) => stream !== source.attachments)
    .map((stream) => new Copy(stream, destination.table(stream.name)));
  const attachments = new Copy(
    source.attachments,
    destination.table('attachments', (c) => [
      ...SQLiteColumns.fromSchema(source.attachments.jsonSchema),
      c
        .text('content')
        .from(source.attachments.file)
        .parse(new MacOSDocumentParser()),
      c.blob('bytes').from(source.attachments.file),
    ]),
  );

  const results = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [...plain, attachments],
      }),
    ],
  }).run();

  assert.deepEqual(
    results.map(({ copy, count }) => [copy.from.name, count]),
    [
      ['chats', 1],
      ['handles', 1],
      ['chatLookups', 1],
      ['chatServices', 1],
      ['chatHandles', 1],
      ['messages', 6],
      ['chatMessages', 5],
      ['linkPreviews', 1],
      ['messageEdits', 2],
      ['recoverableMessages', 1],
      ['recoverableMessageParts', 1],
      ['messageAttachments', 2],
      ['attachments', 2],
    ],
  );
  const out = destination.path;
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT guid, text, handle, isFromMe, date, associatedMessageGuid, associatedMessageType, cacheHasAttachments, attributedBody IS NOT NULL AS archived FROM messages ORDER BY date',
    ),
    [
      {
        guid: 'm-old',
        text: 'from 2016',
        handle: '+15550100',
        isFromMe: 0,
        date: '2016-11-05T00:53:20.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-plain',
        text: 'hello',
        handle: '+15550100',
        isFromMe: 0,
        date: '2025-01-02T03:04:05.006Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:05:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 1,
        archived: 1,
      },
      {
        guid: 'm-reaction',
        text: null,
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:06:00.000Z',
        associatedMessageGuid: 'p:0/m-plain',
        associatedMessageType: 2000,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-deleted',
        text: 'regretted',
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:07:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-link',
        text: 'https://example.com/a',
        handle: '+15550100',
        isFromMe: 0,
        date: '2025-01-02T03:08:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, url, originalUrl, title, summary, siteName, json_extract(metadata, \'$."$class"\') AS class FROM linkPreviews',
    ),
    [
      {
        messageGuid: 'm-link',
        url: 'https://example.com/article',
        originalUrl: 'https://example.com/a',
        title: 'An article',
        summary: null,
        siteName: 'Example',
        class: 'LPLinkMetadata',
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, partIndex, version, editedAt, text FROM messageEdits ORDER BY version',
    ),
    [
      {
        messageGuid: 'm-plain',
        partIndex: 0,
        version: 0,
        editedAt: '2025-01-01T03:04:05.006Z',
        text: 'helo',
      },
      {
        messageGuid: 'm-plain',
        partIndex: 0,
        version: 1,
        editedAt: '2025-01-01T03:04:20.500Z',
        text: 'hello',
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      "SELECT json_extract(messageSummaryInfo, '$.ust') AS ust, json_type(messageSummaryInfo, '$.ec.0[0].t') AS body FROM messages WHERE guid = 'm-plain'",
    ),
    [{ ust: 1, body: 'text' }],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT r.chatGuid, r.messageGuid, r.deleteDate, p.partIndex, p.partText IS NOT NULL AS archivedPart FROM recoverableMessages r JOIN recoverableMessageParts p USING (messageGuid)',
    ),
    [
      {
        chatGuid: 'iMessage;-;+15550100',
        messageGuid: 'm-deleted',
        deleteDate: '2025-01-02T04:00:00.000Z',
        partIndex: 0,
        archivedPart: 1,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT a.guid, a.availableLocally, a.content, (SELECT c.bytes FROM "_elt_files_attachments_bytes" c WHERE c.file = a.bytes) AS bytes FROM attachments a ORDER BY a.guid',
    ),
    [
      {
        guid: 'att-local',
        availableLocally: 1,
        content: 'attached words',
        bytes: new Uint8Array(Buffer.from('attached words')),
      },
      {
        guid: 'att-offloaded',
        availableLocally: 0,
        content: null,
        bytes: null,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, attachmentGuid FROM messageAttachments ORDER BY attachmentGuid',
    ),
    [
      { messageGuid: 'm-archived', attachmentGuid: 'att-local' },
      { messageGuid: 'm-archived', attachmentGuid: 'att-offloaded' },
    ],
  );
});

test('Messages loads edits and unsends incrementally and deletes removed messages', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(source.messages, destination.table('messages'), {
    id: 'messages',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [copy],
      }),
    ],
  });

  await pipeline.run();
  const unchanged = await pipeline.run();
  {
    using chat = new DatabaseSync(path);
    chat
      .prepare(
        "UPDATE message SET text = 'hello again', date_edited = ? WHERE guid = 'm-plain'",
      )
      .run(appleNanoseconds('2025-01-03T00:00:00.000Z'));
    chat
      .prepare(
        "UPDATE message SET date_retracted = ? WHERE guid = 'm-archived'",
      )
      .run(appleNanoseconds('2025-01-03T00:01:00.000Z'));
    chat.exec("DELETE FROM message WHERE guid = 'm-old'");
  }
  const changed = await pipeline.run();

  assert.deepEqual(
    [unchanged, changed].map((results) =>
      results.map(({ count, deleted }) => ({ count, deleted })),
    ),
    [[{ count: 0, deleted: 0 }], [{ count: 2, deleted: 1 }]],
  );
  assert.deepEqual(
    messagesRows(
      destination.path,
      'SELECT guid, text, dateEdited, dateRetracted FROM messages ORDER BY guid',
    ),
    [
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        dateEdited: null,
        dateRetracted: '2025-01-03T00:01:00.000Z',
      },
      {
        guid: 'm-deleted',
        text: 'regretted',
        dateEdited: null,
        dateRetracted: null,
      },
      {
        guid: 'm-link',
        text: 'https://example.com/a',
        dateEdited: null,
        dateRetracted: null,
      },
      {
        guid: 'm-plain',
        text: 'hello again',
        dateEdited: '2025-01-03T00:00:00.000Z',
        dateRetracted: null,
      },
      { guid: 'm-reaction', text: null, dateEdited: null, dateRetracted: null },
    ],
  );
});

test('one Messages read sees one moment of chat.db while Messages keeps writing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const { during, after } = await acrossStreams(
    source,
    [source.handles, source.messages],
    () => {
      using chat = new DatabaseSync(path);
      chat.exec("INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')");
    },
    'guid',
  );

  assert.ok(!during.includes('m-new'));
  assert.deepEqual(after, [...during, 'm-new'].sort());
});

test('Messages names Full Disk Access when chat.db cannot be opened', async () => {
  const source = new AppleMessagesSource(join(tmpdir(), 'missing', 'chat.db'));

  const opening = Array.fromAsync(
    source.read([configured(source.messages)], new Map()),
  );

  await assert.rejects(opening, (error) => {
    assert.ok(error instanceof MessagesUnavailableError);
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('property lists decode as Foundation wrote them', () => {
  const plain = binaryPlist(
    '<dict><key>ascii</key><string>hello</string><key>unicode</key><string>é 😀</string><key>big</key><integer>9007199254740993</integer><key>negative</key><integer>-5</integer><key>real</key><real>1.5</real><key>yes</key><true/><key>when</key><date>2025-01-02T03:04:05Z</date><key>bytes</key><data>AQID</data><key>list</key><array><integer>1</integer><string>two</string></array></dict>',
  );
  const keyed = Buffer.from(
    execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `const root = $.NSMutableDictionary.alloc.init;
        root.setObjectForKey($.NSDate.dateWithTimeIntervalSince1970(1735787045), 'when');
        root.setObjectForKey($.NSUUID.alloc.initWithUUIDString('12345678-9ABC-DEF0-1234-56789ABCDEF0'), 'id');
        root.setObjectForKey($.NSArray.arrayWithArray($(['a', 'b'])), 'items');
        root.setObjectForKey($('abc').dataUsingEncoding($.NSUTF8StringEncoding), 'bytes');
        root.setObjectForKey($.NSURL.URLWithStringRelativeToURL('page', $.NSURL.URLWithString('https://example.com/dir/')), 'url');
        ObjC.unwrap($.NSKeyedArchiver.archivedDataWithRootObjectRequiringSecureCodingError(root, false, null).base64EncodedStringWithOptions(0));`,
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  );

  const decoded = [plain, keyed].map((bytes) =>
    JSON.parse(plistJSON(decodeArchive(bytes))),
  );

  assert.deepEqual(decoded, [
    {
      ascii: 'hello',
      unicode: 'é 😀',
      big: '9007199254740993',
      negative: -5,
      real: 1.5,
      yes: true,
      when: '2025-01-02T03:04:05.000Z',
      bytes: 'AQID',
      list: [1, 'two'],
    },
    {
      when: '2025-01-02T03:04:05.000Z',
      id: '12345678-9ABC-DEF0-1234-56789ABCDEF0',
      items: ['a', 'b'],
      bytes: 'YWJj',
      url: 'https://example.com/dir/page',
    },
  ]);
});

test('an EventKit session reads again when a change arrives during the read', async (t) => {
  let change = () => {};
  const reads: string[] = [];
  const source = new AppleRemindersSource();
  fakeEventKit(
    t,
    () => {
      const version = reads.length === 0 ? 'before' : 'after';
      reads.push(version);
      // Another app edits Reminders while the first read runs.
      if (version === 'before') change();
      return [account({ name: version })];
    },
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

  assert.deepEqual(reads, ['before', 'after']);
  assert.deepEqual(
    accounts.map(({ name }) => name),
    ['after'],
  );
});

test('an EventKit session gives up when every read sees a change', async (t) => {
  const source = new AppleRemindersSource();
  const { requests } = fakeEventKit(
    t,
    () => [account()],
    async function* (signal) {
      yield 'changed';
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield 'changed';
      }
    },
  );

  await assert.rejects(
    readRows(source, [source.accounts]),
    EventKitChangingError,
  );
  assert.equal(requests.length, 5);
});

test('a Messages watch loads each commit Messages makes while it keeps chat.db open', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path, 20);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.messages, destination.table('messages'), {
            id: 'messages',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  // Messages holds its connection, and so its WAL, open the whole time.
  using messages = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const { outcomes } of pipeline.watch({
    signal: controller.signal,
  })) {
    batches.push(outcomes[0]?.count ?? -1);
    if (batches.length === 1)
      messages.exec(
        "INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')",
      );
    else setTimeout(() => controller.abort(), 200);
  }

  assert.deepEqual(batches, [6, 1]);
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

test('Messages reads as documented views joined on both handle keys and counted at message grain', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'messages-marts-'),
  );
  const path = await chatFixture(scratch.path);
  {
    // The same address on SMS is another handle; one message is in two chats.
    using database = new DatabaseSync(path);
    database.exec(`
      INSERT INTO handle VALUES (2, '+15550100', 'US', 'SMS', '5550100', 'person-1');
      UPDATE message SET handle_id = 2 WHERE guid = 'm-old';
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, group_id, style) VALUES (2, 'SMS;-;+15550100', '+15550100', 'SMS', '', 'group-2', 45);
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 1);
    `);
  }
  await using warehouse = await appleWarehouse(
    'messages',
    new AppleMessagesSource(path),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  await warehouse.load();

  assert.equal(
    (
      await agent`SELECT count(*)::int AS n FROM catalog WHERE kind = 'view' AND name LIKE 'messages_%'`
    )[0]?.n,
    13,
  );
  assert.deepEqual(
    (
      await agent`
        SELECT h.service, count(m.guid)::int AS messages
        FROM messages_handles h
        LEFT JOIN messages_messages m ON m.handle = h.id AND m."handleService" = h.service
        GROUP BY h.service ORDER BY h.service`
    ).map((found) => ({ ...found })),
    [
      { service: 'iMessage', messages: 5 },
      { service: 'SMS', messages: 1 },
    ],
  );
  assert.deepEqual(
    (
      await agent`
        SELECT count(*)::int AS joined, count(DISTINCT m.guid)::int AS messages
        FROM messages_messages m JOIN messages_chat_messages c ON c."messageGuid" = m.guid`
    ).map((found) => ({ ...found })),
    [{ joined: 6, messages: 5 }],
  );
  assert.deepEqual(
    (
      await agent`
        SELECT m.guid, m.text, (SELECT count(*)::int FROM messages_message_edits e WHERE e."messageGuid" = m.guid) AS edits,
          EXISTS (SELECT FROM messages_recoverable_messages r WHERE r."messageGuid" = m.guid) AS recoverable
        FROM messages_messages m WHERE m.guid IN ('m-plain', 'm-archived', 'm-deleted') ORDER BY m.guid`
    ).map((found) => ({ ...found })),
    [
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        edits: 0,
        recoverable: false,
      },
      { guid: 'm-deleted', text: 'regretted', edits: 0, recoverable: true },
      { guid: 'm-plain', text: 'hello', edits: 2, recoverable: false },
    ],
  );
  const files = Object.fromEntries(
    (await agent`SELECT guid, "attachmentRef" FROM messages_attachments`).map(
      ({ guid, attachmentRef }) => [guid, attachmentRef],
    ),
  );
  assert.equal(await readFile(files['att-local'], 'utf8'), 'attached words');
  assert.equal(files['att-offloaded'], null);
  await assert.rejects(
    agent`SELECT * FROM apple_messages.raw_messages`,
    /permission denied for schema apple_messages/,
  );
});

test('Calendar reads as documented views where occurrences keep their own identity and series rows do not multiply them', {
  concurrency: false,
}, async (t) => {
  const daily = [rule()];
  const standup = (day: string) =>
    occurrence({
      calendarItemId: 'series',
      startMs: at(`2025-01-${day}T09:00:00.000Z`),
      endMs: at(`2025-01-${day}T10:00:00.000Z`),
      startDay: `2025-01-${day}`,
      endDay: `2025-01-${day}`,
      occurrenceMs: at(`2025-01-${day}T09:00:00.000Z`),
      attendees: [participant()],
      recurrenceRules: daily,
    });
  fakeEventKit(t, (request) => [
    account(),
    calendar(),
    standup('01'),
    standup('08'),
    ...(request.ics ? [icsItem('series', seriesICS, true)] : []),
  ]);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'cal-marts-'));
  await using warehouse = await appleWarehouse(
    'calendar',
    new AppleCalendarSource({
      startAt: '2025-01-01T00:00:00.000Z',
      endAt: '2025-02-01T00:00:00.000Z',
    }),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  await warehouse.load();

  assert.equal(
    (
      await agent`SELECT count(*)::int AS n FROM catalog WHERE kind = 'view' AND name LIKE 'calendar_%'`
    )[0]?.n,
    11,
  );
  assert.deepEqual(
    (
      await agent`
        SELECT e."eventId", (SELECT count(*)::int FROM calendar_attendees a WHERE a."eventId" = e."eventId") AS attendees
        FROM calendar_events e ORDER BY e."startAt"`
    ).map((found) => ({ ...found })),
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
    (
      await agent`
        SELECT count(*)::int AS occurrences, sum(c.components)::int AS components
        FROM calendar_events e JOIN (
          SELECT "calendarId", "calendarItemId", count(*) AS components
          FROM calendar_ics_components WHERE name = 'VEVENT' AND "eventId" IS NULL
          GROUP BY 1, 2) c USING ("calendarId", "calendarItemId")`
    ).map((found) => ({ ...found })),
    [{ occurrences: 2, components: 4 }],
  );
});

test('Reminders reads as documented views that keep date components as components', {
  concurrency: false,
}, async (t) => {
  fakeEventKit(t, () => [
    account(),
    calendar({ allowedEntityTypes: 2 }),
    reminder({
      id: 'due-date-only',
      due: {
        year: 2026,
        month: 9,
        day: 21,
        leapMonth: false,
        repeatedDay: false,
      },
    }),
    reminder({ id: 'undated', completed: true }),
  ]);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'rem-marts-'));
  await using warehouse = await appleWarehouse(
    'reminders',
    new AppleRemindersSource(),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  await warehouse.load();

  assert.equal(
    (
      await agent`SELECT count(*)::int AS n FROM catalog WHERE kind = 'view' AND name LIKE 'reminders_%'`
    )[0]?.n,
    8,
  );
  assert.deepEqual(
    (
      await agent`
        SELECT r.id, r.completed, d.kind, d.year, d.month, d.day, d.hour
        FROM reminders_reminders r
        LEFT JOIN reminders_date_components d ON d."reminderId" = r.id
        JOIN reminders_lists l ON l.id = r."listId"
        ORDER BY r.id`
    ).map((found) => ({ ...found })),
    [
      {
        id: 'due-date-only',
        completed: false,
        kind: 'due',
        year: '2026',
        month: '9',
        day: '21',
        hour: null,
      },
      {
        id: 'undated',
        completed: true,
        kind: null,
        year: null,
        month: null,
        day: null,
        hour: null,
      },
    ],
  );
});
