import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { Copy, Pipeline, Stream } from 'elt';
import { MarkdownDestination } from 'elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  type SQLiteTable,
} from 'elt-sqlite';
import {
  AppleCalendarSource,
  AppleMessagesSource,
  AppleNotesSource,
  AppleRemindersSource,
  CalendarIcsUnavailableError,
  CalendarUnavailableError,
  EventKitChangingError,
  MacOSDocumentParser,
  MessagesUnavailableError,
  NotesSchemaError,
  NotesUnavailableError,
  RemindersUnavailableError,
} from './index.ts';
import { EventKit } from './platform/macos/eventkit.ts';
import osa from './platform/macos/osa.ts';
import { decodeArchive, plistJSON } from './platform/macos/plist.ts';
import { calendarScript } from './sources/apple-calendar/calendar-script.ts';
import { parseICalendar } from './sources/apple-calendar/icalendar.ts';
import { icsStreams } from './sources/apple-calendar/ics-records.ts';
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

// NoteStore.sqlite's tables as macOS 26.6.2 creates them (schema only, no
// data), in WAL mode like the real store.
const noteStoreSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE ZICCLOUDSYNCINGOBJECT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCRYPTOITERATIONCOUNT INTEGER, ZHASMISSINGKEYCHAINITEM INTEGER, ZISPASSWORDPROTECTED INTEGER, ZISRECOVERINGFROMTRASH INTEGER, ZISSHAREDIRTY INTEGER, ZMARKEDFORDELETION INTEGER, ZMINIMUMSUPPORTEDNOTESVERSION INTEGER, ZNEEDSINITIALFETCHFROMCLOUD INTEGER, ZNEEDSTOBEFETCHEDFROMCLOUD INTEGER, ZNEEDSTOFETCHUSERSPECIFICRECORDASSETS INTEGER, ZNEEDSTOSAVEUSERSPECIFICRECORD INTEGER, ZNEEDSTOUPDATEUSERSPECIFICRECORDREFERENCEACTIONS INTEGER, ZCLOUDSTATE INTEGER, ZINVITATION INTEGER, ZLOCKEDNOTESMODE INTEGER, ZSUPPORTSV1NEO INTEGER, ZACCOUNT INTEGER, ZCHECKEDFORLOCATION INTEGER, ZDIDRUNPAPERFORMDETECTION INTEGER, ZFILESIZE INTEGER, ZHANDWRITINGSUMMARYVERSION INTEGER, ZHASMARKUPDATA INTEGER, ZHASPAPERFORM INTEGER, ZIMAGECLASSIFICATIONSUMMARYVERSION INTEGER, ZIMAGEFILTERTYPE INTEGER, ZNEEDSINITIALRELATIONSHIPSETUP INTEGER, ZNEEDSTRANSCRIPTION INTEGER, ZOCRSUMMARYVERSION INTEGER, ZORIENTATION INTEGER, ZSECTION INTEGER, ZURLEXPIRED INTEGER, ZACCOUNT1 INTEGER, ZLOCATION INTEGER, ZMEDIA INTEGER, ZNOTE INTEGER, ZNOTEUSINGTITLEFORNOTETITLE INTEGER, ZPARENTATTACHMENT INTEGER, ZAPPEARANCETYPE INTEGER, ZSCALEWHENDRAWING INTEGER, ZVERSION INTEGER, ZVERSIONOUTOFDATE INTEGER, ZATTACHMENT INTEGER, ZSTATE INTEGER, ZACCOUNT2 INTEGER, ZACCOUNT3 INTEGER, ZMENTIONNOTIFICATIONATTEMPTCOUNT INTEGER, ZMENTIONNOTIFICATIONSTATE INTEGER, ZACCOUNT4 INTEGER, ZNOTE1 INTEGER, ZPARENTATTACHMENT1 INTEGER, ZTYPE INTEGER, ZACCOUNT5 INTEGER, ZACCOUNT6 INTEGER, ZATTACHMENT1 INTEGER, ZATTACHMENTVIEWTYPE INTEGER, ZHASCHECKLIST INTEGER, ZHASCHECKLISTINPROGRESS INTEGER, ZHASEMPHASIS INTEGER, ZHASSYSTEMTEXTATTACHMENTS INTEGER, ZISPINNED INTEGER, ZISSYSTEMPAPER INTEGER, ZLEGACYNOTEWASPLAINTEXT INTEGER, ZNOTEHASCHANGES INTEGER, ZPAPERSTYLETYPE INTEGER, ZPREFERREDBACKGROUNDTYPE INTEGER, ZACCOUNT7 INTEGER, ZFOLDER INTEGER, ZNOTEDATA INTEGER, ZTITLESOURCEATTACHMENT INTEGER, ZDATEHEADERSTYPE INTEGER, ZSORTORDER INTEGER, ZOWNER INTEGER, ZACCOUNTTYPE INTEGER, ZDIDCHOOSETOMIGRATE INTEGER, ZDIDFINISHMIGRATION INTEGER, ZDIDMIGRATEONMAC INTEGER, ZSERVERSIDEUPDATETASKFAILURECOUNT INTEGER, ZSTOREDATASEPARATELY INTEGER, ZACCOUNTDATA INTEGER, ZCUSTOMNOTESORTTYPEVALUE INTEGER, ZFOLDERTYPE INTEGER, ZIMPORTEDFROMLEGACY INTEGER, ZACCOUNT8 INTEGER, ZPARENT INTEGER, ZCREATIONDATE TIMESTAMP, ZCROPPINGQUADBOTTOMLEFTX FLOAT, ZCROPPINGQUADBOTTOMLEFTY FLOAT, ZCROPPINGQUADBOTTOMRIGHTX FLOAT, ZCROPPINGQUADBOTTOMRIGHTY FLOAT, ZCROPPINGQUADTOPLEFTX FLOAT, ZCROPPINGQUADTOPLEFTY FLOAT, ZCROPPINGQUADTOPRIGHTX FLOAT, ZCROPPINGQUADTOPRIGHTY FLOAT, ZDURATION FLOAT, ZMODIFICATIONDATE TIMESTAMP, ZORIGINX FLOAT, ZORIGINY FLOAT, ZPREVIEWUPDATEDATE TIMESTAMP, ZSIZEHEIGHT FLOAT, ZSIZEWIDTH FLOAT, ZHEIGHT FLOAT, ZMODIFIEDDATE TIMESTAMP, ZSCALE FLOAT, ZWIDTH FLOAT, ZSTATEMODIFICATIONDATE TIMESTAMP, ZCREATIONDATE1 TIMESTAMP, ZCREATIONDATE2 TIMESTAMP, ZMODIFICATIONDATEATIMPORT TIMESTAMP, ZCREATIONDATE3 TIMESTAMP, ZFOLDERMODIFICATIONDATE TIMESTAMP, ZLASTACTIVITYRECENTUPDATESVIEWEDDATE TIMESTAMP, ZLASTACTIVITYSUMMARYVIEWEDDATE TIMESTAMP, ZLASTATTRIBUTIONSVIEWEDDATE TIMESTAMP, ZLASTNOTIFIEDDATE TIMESTAMP, ZLASTOPENEDDATE TIMESTAMP, ZLASTVIEWEDMODIFICATIONDATE TIMESTAMP, ZLEGACYMODIFICATIONDATEATIMPORT TIMESTAMP, ZMODIFICATIONDATE1 TIMESTAMP, ZLASTSYNCDATE TIMESTAMP, ZCUSTOMNOTESORTTYPEMODIFICATIONDATE TIMESTAMP, ZDATEFORLASTTITLEMODIFICATION TIMESTAMP, ZPARENTMODIFICATIONDATE TIMESTAMP, ZIDENTIFIER VARCHAR, ZPASSWORDHINT VARCHAR, ZZONEOWNERNAME VARCHAR, ZADDITIONALINDEXABLETEXT VARCHAR, ZFALLBACKIMAGEGENERATION VARCHAR, ZFALLBACKPDFGENERATION VARCHAR, ZFALLBACKSUBTITLEIOS VARCHAR, ZFALLBACKSUBTITLEMAC VARCHAR, ZFALLBACKTITLE VARCHAR, ZHANDWRITINGSUMMARY VARCHAR, ZIMAGECLASSIFICATIONSUMMARY VARCHAR, ZOCRSUMMARY VARCHAR, ZPAPERBUNDLEGENERATION VARCHAR, ZREMOTEFILEURLSTRING VARCHAR, ZSUMMARY VARCHAR, ZTITLE VARCHAR, ZTYPEUTI VARCHAR, ZURLSTRING VARCHAR, ZUSERTITLE VARCHAR, ZGENERATION VARCHAR, ZDEVICEIDENTIFIER VARCHAR, ZDISPLAYTEXT VARCHAR, ZSTANDARDIZEDCONTENT VARCHAR, ZALTTEXT VARCHAR, ZTOKENCONTENTIDENTIFIER VARCHAR, ZTYPEUTI1 VARCHAR, ZCONTENTHASHATIMPORT VARCHAR, ZFILENAME VARCHAR, ZGENERATION1 VARCHAR, ZHOSTAPPLICATIONIDENTIFIER VARCHAR, ZLEGACYCONTENTHASHATIMPORT VARCHAR, ZLEGACYIMPORTDEVICEIDENTIFIER VARCHAR, ZLEGACYMANAGEDOBJECTIDURIREPRESENTATION VARCHAR, ZSELECTEDINKCOLORSTRING VARCHAR, ZSELECTEDINKIDENTIFIER VARCHAR, ZSNIPPET VARCHAR, ZTHUMBNAILATTACHMENTIDENTIFIER VARCHAR, ZTITLE1 VARCHAR, ZWIDGETSNIPPET VARCHAR, ZACCOUNTNAMEFORACCOUNTLISTSORTING VARCHAR, ZNESTEDTITLEFORSORTING VARCHAR, ZNAME VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDVERSION VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDVERSION VARCHAR, ZUSERRECORDNAME VARCHAR, ZSMARTFOLDERQUERYJSON VARCHAR, ZTITLE2 VARCHAR, ZATTRIBUTEDSNIPPET BLOB, ZATTRIBUTEDTITLE BLOB, ZREPLICAIDTOBUNDLEIDENTIFIER BLOB, ZACTIVITYEVENTSDATA BLOB, ZASSETCRYPTOINITIALIZATIONVECTOR BLOB, ZASSETCRYPTOTAG BLOB, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOSALT BLOB, ZCRYPTOTAG BLOB, ZCRYPTOWRAPPEDKEY BLOB, ZENCRYPTEDVALUESJSON BLOB, ZREPLICAIDTONOTESVERSIONDATA BLOB, ZSERVERRECORDDATA BLOB, ZSERVERSHAREDATA BLOB, ZUNAPPLIEDENCRYPTEDRECORDDATA BLOB, ZUSERSPECIFICSERVERRECORDDATA BLOB, ZCRYPTOPASSPHRASEVERIFIER BLOB, ZMERGEABLEDATA BLOB, ZFALLBACKIMAGECRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKIMAGECRYPTOTAG BLOB, ZFALLBACKPDFCRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKPDFCRYPTOTAG BLOB, ZLINKPRESENTATIONARCHIVEDMETADATA BLOB, ZMARKUPMODELDATA BLOB, ZMERGEABLEDATA1 BLOB, ZMERGEABLEPREFERREDVIEWSIZE BLOB, ZMETADATADATA BLOB, ZSYNAPSEDATA BLOB, ZTEMPORARYTRANSCRIPTDATA BLOB, ZCRYPTOMETADATAINITIALIZATIONVECTOR BLOB, ZCRYPTOMETADATATAG BLOB, ZENCRYPTEDMETADATA BLOB, ZMETADATA BLOB, ZLASTNOTIFIEDTIMESTAMPDATA BLOB, ZLASTVIEWEDTIMESTAMPDATA BLOB, ZOUTLINESTATEDATA BLOB, ZREPLICAIDTOUSERIDDICTDATA BLOB, ZCRYPTOVERIFIER BLOB, ZSERVERSIDEUPDATETASKCONTINUATIONTOKEN BLOB, ZMERGEABLEDATA2 BLOB );
CREATE TABLE ZICLOCATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPLACEUPDATED INTEGER, ZATTACHMENT INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZPLACEMARKDATA BLOB );
CREATE TABLE ZICNOTEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOTAG BLOB, ZDATA BLOB );
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);`;

// Entities as the real store numbers them in Z_PRIMARYKEY.
const noteEntities = {
  ICAccount: 14,
  ICAttachment: 5,
  ICFolder: 15,
  ICInlineAttachment: 9,
  ICMedia: 11,
  ICNote: 12,
} as const;

// A 2×2 table (a1 b1 / a2 b2) as Notes saved it: a gzipped CRDT document.
const noteTable = Buffer.from(
  'H4sIAAAAAAAAE7VVW2jTYBRusq7Lss7F6DaNMjHeRsZKjXhBJzhao9OuStt5HdM0/Z2pWTLTdE4fFCuigogXHCoiMkHBPeh8UJCp+OCD0yGoTIYPvil4x9uDL3rSyzRLQcH5k/TkfOf7z5/v/On5CQf9sIxwUA7mXhnpIp3wiDGr40GCYjjCQc9kp3uzozbPT24wLgKjcS8GtgBsAdhCsARYF9hSxk2Smdzg4UxtvIbAmFkETk9jp/pCETGqIJ+mJNtUv6wjyZA1NYC2GBEtJLduNZhHWAp7gJHdGLmLDNCuD3f64GKodELzzdO2GksjGCA4k7bVOFNBEhD7AaMMeMPPHE5g5k2PB4nUq6/rAq/PNuo3jpV/3OsfXAQoRlPz0eu+/m5h/alU/3Nx4MoyejpJkbjXlOVksoVKI0WAuHLIb6xCG6sohzDuOEngUBwnjY/wcItXYPGc/7sSh1eWxluq/JcuDBh6Z/zW+UwlBrw14eYvQu0VrPOtwQ1qWY0kKCq2aHQDUjKiEiaLtLHceStRaPFcFq/I4hHMTD6TvwSyjbHkLwZk7HD+HA9mecssPPPDpIZ5zaENNB6d/U+1nAAf9PgJ2ApqbXddDy8JVfs98X3XvcsfZ7Pzo5O95+3g0Lt+4XtKPrN4W2nXS4tG2qZxnFWjOEoatwvuz5tahNS1y8/uLMB71Wz2UdJ4/dzd3qlNS8jbGzuOLG85HWcJOYZUQzZ2shWSnq9hsM4EUrawLkkPaTsSbHFTU4O/QY2hTrZY0jPcBFsiIUXJOlylpLV5xPZ2BXl8IX/EEwwHk21RpOcJhA1dVlu5clvAXIWrGAFDR0uCw1Xb8BBqlRMG0huTiiGvEZUkCiAxYXDT/oJpWx2W0RHiJuaFg1rMPiMY9ouGmB9G3OxfsKoZKOFp8PkULRkL71QlUL8qGodK10OxO2AblnbAdvyuMDdFAD3mjDBSMhsTNszkrJ0ZidQnY7IWQpKmx8zy1vyZ4xF0sbXNXHpGPnJEF9WEpMvtRhhlaJUjadnjxh6A+WaAp45i9w9Nqgt8O80Unjt4YaiZp/pmvXfseCKUX2vcPP8ANecrbzszeGpy7Fst39X47HLlmynvT/ac4G0nCE99unk1dWOgfs/xFyW7I3Vje3lbx+WpQGioap7csO9i9FX53M9Pf/C2/rtwMsmQtrekcfjvQCf/CfJmFaHRBwAA',
  'base64',
);

// Protocol Buffers encoding for note bodies: varints and length-delimited
// fields are all a topotext.String needs.
const protobuf = {
  varint(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    while (rest > 0x7f) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
    return bytes;
  },
  number(field: number, value: number): number[] {
    return [...protobuf.varint(field << 3), ...protobuf.varint(value)];
  },
  bytes(field: number, value: Uint8Array | string | number[]): number[] {
    const bytes =
      typeof value === 'string' ? [...Buffer.from(value, 'utf8')] : [...value];
    return [
      ...protobuf.varint((field << 3) | 2),
      ...protobuf.varint(bytes.length),
      ...bytes,
    ];
  },
};

type NoteRun = {
  text: string;
  style?: number;
  todo?: { id: string; done: boolean };
  bold?: boolean;
  link?: string;
  attachment?: { id: string; type: string };
};

// A note body as Notes stores it: versioned_document.Document > Version >
// topotext.String { string, attribute runs }, gzipped.
const noteBody = (runs: NoteRun[]) => {
  const text = runs.map((run) => run.text).join('');
  const string = [
    ...protobuf.bytes(2, text),
    ...runs.flatMap((run) =>
      protobuf.bytes(5, [
        ...protobuf.number(1, run.text.length),
        ...(run.style === undefined && run.todo === undefined
          ? []
          : protobuf.bytes(2, [
              ...(run.style === undefined ? [] : protobuf.number(1, run.style)),
              ...(run.todo === undefined
                ? []
                : protobuf.bytes(5, [
                    ...protobuf.bytes(1, Buffer.from(run.todo.id, 'hex')),
                    ...protobuf.number(2, run.todo.done ? 1 : 0),
                  ])),
            ])),
        ...(run.bold ? protobuf.number(5, 1) : []),
        ...(run.link === undefined ? [] : protobuf.bytes(9, run.link)),
        ...(run.attachment === undefined
          ? []
          : protobuf.bytes(12, [
              ...protobuf.bytes(1, run.attachment.id),
              ...protobuf.bytes(2, run.attachment.type),
            ])),
      ]),
    ),
  ];
  return gzipSync(
    Uint8Array.from(
      protobuf.bytes(2, [
        ...protobuf.number(1, 0),
        ...protobuf.bytes(3, string),
      ]),
    ),
  );
};

// Core Data dates: seconds since 2001-01-01.
const coreDataSeconds = (iso: string) =>
  (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

const richNote = [
  { text: 'Groceries\n', style: 0, bold: true },
  { text: 'Milk\n', style: 103, todo: { id: 'aa'.repeat(16), done: true } },
  { text: 'Eggs\n', style: 103, todo: { id: 'bb'.repeat(16), done: false } },
  { text: 'Buy ' },
  { text: 'fresh', bold: true },
  { text: '\nsee ' },
  { text: 'site', link: 'https://example.com/list' },
  { text: '\n' },
  { text: '￼', attachment: { id: 'ATT-FILE', type: 'public.plain-text' } },
  { text: '\n' },
  {
    text: '￼',
    attachment: { id: 'ATT-TABLE', type: 'com.apple.notes.table' },
  },
  { text: '\ntag ' },
  {
    text: '￼',
    attachment: {
      id: 'INLINE-TAG',
      type: 'com.apple.notes.inlinetextattachment.hashtag',
    },
  },
  { text: '\nlink ' },
  {
    text: '\ufffc',
    attachment: {
      id: 'INLINE-LINK',
      type: 'com.apple.notes.inlinetextattachment.link',
    },
  },
  { text: '\n' },
];

// A store with a formatted note (checklist, link, file, table, tag), a
// locked note, a note in Recently Deleted, a cloud placeholder and a row
// Notes marked for deletion. The file attachment's bytes sit where Notes
// keeps media; the photo's do not, as when iCloud has not downloaded it.
const noteStoreFixture = async (directory: string) => {
  const path = join(directory, 'NoteStore.sqlite');
  const media = join(
    directory,
    'Accounts',
    'ACCOUNT-1',
    'Media',
    'MEDIA-FILE',
    '1_GEN',
  );
  mkdirSync(media, { recursive: true });
  await writeFile(join(media, 'list.txt'), 'attached words');
  using database = new DatabaseSync(path);
  database.exec(noteStoreSchema);
  const entity = database.prepare(
    'INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME) VALUES (?, ?)',
  );
  for (const [name, id] of Object.entries(noteEntities)) entity.run(id, name);
  const created = coreDataSeconds('2025-01-02T03:04:05.006Z');
  const modified = coreDataSeconds('2025-02-03T04:05:06.007Z');
  database.exec(`
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME, ZACCOUNTTYPE) VALUES (1, 14, 'ACCOUNT-1', 'iCloud', 1);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZFOLDERTYPE, ZPARENT) VALUES
      (2, 15, 'FOLDER-NOTES', 'Notes', 1, 0, NULL),
      (3, 15, 'FOLDER-TRASH', 'Recently Deleted', 1, 1, NULL),
      (4, 15, 'FOLDER-CHILD', 'Child', 1, 0, 2);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7, ZNOTEDATA, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZISPINNED, ZISPASSWORDPROTECTED, ZHASCHECKLIST, ZHASCHECKLISTINPROGRESS) VALUES
      (5, 12, 'NOTE-RICH', 'Groceries', 2, 1, 1, ${created}, ${modified}, 1, 0, 1, 1),
      (6, 12, 'NOTE-LOCKED', 'Secret', 2, 1, 2, ${created}, ${modified}, 0, 1, 0, 0),
      (7, 12, 'NOTE-PLACEHOLDER', NULL, NULL, 1, 3, NULL, NULL, 0, 0, 0, 0),
      (8, 12, 'NOTE-TRASHED', 'Old', 3, 1, 4, ${created}, ${modified}, 0, 0, 0, 0);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNOTE, ZACCOUNT1, ZMEDIA, ZTYPEUTI, ZFILESIZE, ZCREATIONDATE, ZMODIFICATIONDATE, ZOCRSUMMARY, ZMARKEDFORDELETION) VALUES
      (9, 5, 'ATT-FILE', 5, 1, 10, 'public.plain-text', 14, ${created}, ${modified}, NULL, 0),
      (11, 5, 'ATT-TABLE', 5, 1, NULL, 'com.apple.notes.table', 0, ${created}, ${modified}, NULL, 0),
      (12, 5, 'ATT-PHOTO', 5, 1, 13, 'public.jpeg', 2048, ${created}, ${modified}, 'photo words', 0),
      (14, 5, 'ATT-LOCKED', 6, 1, NULL, 'public.jpeg', 10, ${created}, ${modified}, 'secret words', 0),
      (16, 5, 'ATT-PURGED', 5, 1, NULL, 'public.jpeg', 10, ${created}, ${modified}, NULL, 1);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1, ZACCOUNT6, ZATTACHMENT1) VALUES
      (10, 11, 'MEDIA-FILE', 'list.txt', '1_GEN', 1, 9),
      (13, 11, 'MEDIA-PHOTO', 'photo.jpg', '1_GEN', 1, 12);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNOTE1, ZTYPEUTI1, ZALTTEXT, ZTOKENCONTENTIDENTIFIER, ZCREATIONDATE2) VALUES
      (15, 9, 'INLINE-TAG', 5, 'com.apple.notes.inlinetextattachment.hashtag', '#food', 'FOOD', ${created}),
      (17, 9, 'INLINE-LINK', 5, 'com.apple.notes.inlinetextattachment.link', 'Old', 'applenotes:note/note-trashed', ${created});
    INSERT INTO ZICLOCATION (ZATTACHMENT, ZLATITUDE, ZLONGITUDE) VALUES (12, 52.52, 13.405);
  `);
  database
    .prepare(
      'UPDATE ZICCLOUDSYNCINGOBJECT SET ZMERGEABLEDATA1 = ? WHERE Z_PK = 11',
    )
    .run(noteTable);
  const data = database.prepare(
    'INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)',
  );
  data.run(1, 5, noteBody(richNote));
  data.run(2, 6, Uint8Array.from([1, 2, 3]));
  data.run(3, 7, noteBody([{ text: 'not downloaded\n' }]));
  data.run(4, 8, noteBody([{ text: 'Old\nthrown away\n' }]));
  return path;
};

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
              primaryKey: [...stream.primaryKey],
            },
          ),
      ),
    }),
  };
};

test('Notes exports every stream from its store, skipping cloud placeholders and locked content', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const source = new AppleNotesSource({
    path: await noteStoreFixture(scratch.path),
  });
  const { destination, pipeline } = notesPipeline(source, scratch.path);

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

test('a Notes session reads one snapshot while Notes keeps writing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const path = await noteStoreFixture(scratch.path);
  const source = new AppleNotesSource({ path });
  const copy = new Copy(
    source.notes,
    new SQLiteDestination({ path: join(scratch.path, 'out.sqlite') }).table(
      'notes',
    ),
  );
  const ids = async (session: Awaited<ReturnType<typeof source.session>>) =>
    (await Array.fromAsync(source.read(copy.configuration, null, session)))
      .map((message) =>
        'data' in message ? Reflect.get(Object(message.data), 'id') : null,
      )
      .sort();

  const pinned = await (async () => {
    await using session = await source.session();
    const before = await ids(session);
    {
      using notes = new DatabaseSync(path);
      notes.exec(
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7) VALUES (12, 'NOTE-NEW', 'New', 2, 1)",
      );
    }
    return { before, during: await ids(session) };
  })();
  const after = await (async () => {
    await using session = await source.session();
    return ids(session);
  })();

  assert.deepEqual(pinned.during, pinned.before);
  assert.deepEqual(after, [...pinned.before, 'NOTE-NEW'].sort());
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

  const opening = missing.session();
  const reading = other.session();

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
        primaryKey: ['id'],
      }),
    ],
  });
  // Notes holds its connection, and so its WAL, open the whole time.
  using notes = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const results of pipeline.watch({ signal: controller.signal })) {
    batches.push(results[0]?.count ?? -1);
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

test('the Notes exporter loads every stream end to end and a second run writes nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const store = await noteStoreFixture(scratch.path);
  const out = join(scratch.path, 'out');
  const exporter = fileURLToPath(new URL('./main.js', import.meta.url));
  const run = () =>
    execFile(process.execPath, [exporter, '--note-store', store, '--out', out]);
  const tables = () =>
    noteRows(
      join(out, 'apple-notes.sqlite'),
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name",
    ).map(({ name }) => {
      const [row] = noteRows(
        join(out, 'apple-notes.sqlite'),
        `SELECT count(*) AS rows, max(loaded_at) AS loadedAt FROM "${String(name)}"`,
      );
      return { name, rows: row?.rows, loadedAt: row?.loadedAt };
    });

  const first = await run();
  const loaded = tables();
  const second = await run();

  assert.match(first.stdout, /Loaded Apple Notes/);
  assert.deepEqual(
    loaded.map(({ name, rows }) => [name, rows]),
    [
      ['raw_accounts', 1],
      ['raw_attachments', 4],
      ['raw_folders', 3],
      ['raw_inlineAttachments', 2],
      ['raw_notes', 3],
    ],
  );
  assert.match(second.stdout, /Loaded Apple Notes/);
  assert.deepEqual(tables(), loaded);
  assert.deepEqual(
    noteRows(
      join(out, 'apple-notes.sqlite'),
      'SELECT id, content FROM raw_attachments WHERE bytes IS NOT NULL',
    ),
    [{ id: 'ATT-FILE', content: 'attached words' }],
  );
});

test('Calendar extracts every scalar stream into SQLite and Markdown', {
  concurrency: false,
}, async (t) => {
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
    // The session reads before any copy starts, so nothing wraps the error.
    (error: unknown) =>
      error instanceof CalendarUnavailableError && error.cause === unavailable,
  );
  assert.equal(await readFile(path, 'utf8'), previous);

  const native = new Error('native EventKit failure');
  response = async () => {
    throw native;
  };
  await assert.rejects(run(), (error: unknown) => error === native);
  assert.equal(await readFile(path, 'utf8'), previous);
});

test('Calendar snapshot incremental reconciles added, changed, moved and removed rows', {
  concurrency: false,
}, async (t) => {
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
      // The session reads before any copy starts, so nothing wraps the error.
      (error: unknown) =>
        error instanceof RemindersUnavailableError && error.cause === failure,
    );
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  failure = new Error('EventKit reminder fetch timed out');
  await assert.rejects(run(), (error: unknown) => error === failure);
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
  quietEventKit(t);
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
  quietEventKit(t);
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  const read = async () => {
    await using session = await source.session([source.icsComponents]);
    return await Array.fromAsync(
      source.read(
        new Copy(
          source.icsComponents,
          new MarkdownDestination({ path: '/unused' }).file('c.md'),
        ).configuration,
        null,
        session,
      ),
    );
  };
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
      // Every ICS stream must reach the export, not fail as an unknown stream.
      streams: ${JSON.stringify(icsStreams)}.map((stream) => {
        try {
          readCalendar(base, stream, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', undefined, null);
          return stream + ': exported';
        } catch (error) {
          return stream + ': ' + error.message.split(':')[0];
        }
      }),
    });
  `);
  const { unsaved, missing, streams } = JSON.parse(output);
  assert.deepEqual(
    streams,
    icsStreams.map((stream) => `${stream}: CALENDAR_ICS_UNAVAILABLE`),
  );
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
  quietEventKit(t);
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
  quietEventKit(t);
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
  quietEventKit(t);
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
  t.mock.method(osa, 'execute', async () =>
    icsPage([
      { calendarItemId: 'files', recurring: false, ics: attachmentsICS },
    ]),
  );
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
    await new Pipeline({ source, destination: sqlite, steps: [copy] }).run(),
    [{ copy, count: 3, deleted: 0 }],
  );
  // Inline content never reaches the fetcher.
  assert.deepEqual(fetched, ['diagram.png:image/png', 'private.pdf:null']);
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare(
        'SELECT filename, formatType, inline, (SELECT c.bytes FROM "_mac_elt_files_attachments_bytes" c WHERE c.file = a.bytes AND c.n = 0) AS bytes FROM attachments a ORDER BY a.rowid',
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
  quietEventKit(t);
  const source = new AppleCalendarSource({
    startAt: '2025-01-01T00:00:00.000Z',
    endAt: '2025-02-01T00:00:00.000Z',
  });
  t.mock.method(osa, 'execute', async () =>
    icsPage([
      { calendarItemId: 'files', recurring: false, ics: attachmentsICS },
    ]),
  );
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-att-'));
  const sqlite = new SQLiteDestination({
    path: join(scratch.path, 'a.sqlite'),
  });
  const run = (copy: Copy<SQLiteTable>) =>
    new Pipeline({ source, destination: sqlite, steps: [copy] }).run();

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
  quietEventKit(t);
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
  t.mock.method(osa, 'execute', async () =>
    icsPage([{ calendarItemId: 'files', recurring: false, ics }]),
  );
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
      primaryKey: ['id'],
    },
  );
  const pipeline = new Pipeline({
    source,
    destination: sqlite,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 's.sqlite'),
    }),
    steps: [copy],
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
    source,
    destination,
    steps: [...plain, attachments],
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
      'SELECT a.guid, a.availableLocally, a.content, (SELECT c.bytes FROM "_mac_elt_files_attachments_bytes" c WHERE c.file = a.bytes) AS bytes FROM attachments a ORDER BY a.guid',
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
    primaryKey: ['guid'],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [copy],
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

test('a Messages session reads one snapshot while Messages keeps writing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const copy = new Copy(
    source.messages,
    new SQLiteDestination({ path: join(scratch.path, 'out.sqlite') }).table(
      'messages',
    ),
  );
  const guids = async (session: Awaited<ReturnType<typeof source.session>>) =>
    (await Array.fromAsync(source.read(copy.configuration, null, session)))
      .map((message) =>
        'data' in message ? Reflect.get(Object(message.data), 'guid') : null,
      )
      .sort();

  const pinned = await (async () => {
    await using session = await source.session();
    const before = await guids(session);
    {
      using chat = new DatabaseSync(path);
      chat.exec("INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')");
    }
    return { before, during: await guids(session) };
  })();
  const after = await (async () => {
    await using session = await source.session();
    return guids(session);
  })();

  assert.deepEqual(pinned.during, pinned.before);
  assert.deepEqual(after, [...pinned.before, 'm-new'].sort());
});

test('Messages names Full Disk Access when chat.db cannot be opened', async () => {
  const source = new AppleMessagesSource(join(tmpdir(), 'missing', 'chat.db'));

  const opening = source.session();

  await assert.rejects(opening, (error) => {
    assert.ok(error instanceof MessagesUnavailableError);
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

// EventKit sessions subscribe to change notifications; this one reports the
// subscription and then no change, so reads settle on the first attempt.
const quietEventKit = (t: TestContext) =>
  t.mock.method(
    osa,
    'watch',
    async function* (_script: string, signal: AbortSignal) {
      yield 'changed';
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    },
  );

const execFileAsync = promisify(execFileCallback);

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
  t.mock.method(
    osa,
    'watch',
    async function* (_script: string, signal: AbortSignal) {
      yield 'changed';
      await new Promise<void>((resolve) => {
        change = resolve;
      });
      yield 'changed';
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    },
  );
  const reads: string[] = [];
  const source = new AppleRemindersSource();
  t.mock.method(osa, 'execute', async () => {
    const version = reads.length === 0 ? 'before' : 'after';
    reads.push(version);
    // Another app edits Reminders while the first read runs.
    if (version === 'before') change();
    return JSON.stringify([{ ...recordFor(source.accounts), name: version }]);
  });

  await using snapshot = await source.session([source.accounts]);

  assert.deepEqual(reads, ['before', 'after']);
  assert.deepEqual(
    snapshot.of('accounts').map((account) => account.name),
    ['after'],
  );
});

test('an EventKit session gives up when every read sees a change', async (t) => {
  t.mock.method(
    osa,
    'watch',
    async function* (_script: string, signal: AbortSignal) {
      yield 'changed';
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield 'changed';
      }
    },
  );
  const source = new AppleRemindersSource();
  const execute = t.mock.method(osa, 'execute', async () =>
    JSON.stringify([recordFor(source.accounts)]),
  );

  const opening = source.session([source.accounts]);

  await assert.rejects(opening, EventKitChangingError);
  assert.equal(execute.mock.callCount(), 5);
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
        primaryKey: ['guid'],
      }),
    ],
  });
  // Messages holds its connection, and so its WAL, open the whole time.
  using messages = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const results of pipeline.watch({ signal: controller.signal })) {
    batches.push(results[0]?.count ?? -1);
    if (batches.length === 1)
      messages.exec(
        "INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')",
      );
    else setTimeout(() => controller.abort(), 200);
  }

  assert.deepEqual(batches, [6, 1]);
});

test('the Messages exporter loads every stream end to end and a second run writes nothing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const chatDb = await chatFixture(scratch.path);
  const out = join(scratch.path, 'out');
  const exporter = fileURLToPath(new URL('./messages.js', import.meta.url));
  const run = () =>
    execFileAsync(process.execPath, [
      exporter,
      '--chat-db',
      chatDb,
      '--out',
      out,
    ]);
  const tables = () =>
    messagesRows(
      join(out, 'apple-messages.sqlite'),
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name",
    ).map(({ name }) => {
      const [row] = messagesRows(
        join(out, 'apple-messages.sqlite'),
        `SELECT count(*) AS rows, max(loaded_at) AS loadedAt FROM "${String(name)}"`,
      );
      return { name, rows: row?.rows, loadedAt: row?.loadedAt };
    });

  const first = await run();
  const loaded = tables();
  const second = await run();

  assert.match(first.stdout, /Loaded Apple Messages/);
  assert.deepEqual(
    loaded.map(({ name, rows }) => [name, rows]),
    [
      ['raw_attachments', 2],
      ['raw_chatHandles', 1],
      ['raw_chatLookups', 1],
      ['raw_chatMessages', 5],
      ['raw_chatServices', 1],
      ['raw_chats', 1],
      ['raw_handles', 1],
      ['raw_linkPreviews', 1],
      ['raw_messageAttachments', 2],
      ['raw_messageEdits', 2],
      ['raw_messages', 6],
      ['raw_recoverableMessageParts', 1],
      ['raw_recoverableMessages', 1],
    ],
  );
  assert.match(second.stdout, /Loaded Apple Messages/);
  assert.deepEqual(tables(), loaded);
  assert.deepEqual(
    messagesRows(
      join(out, 'apple-messages.sqlite'),
      'SELECT guid, content FROM raw_attachments WHERE bytes IS NOT NULL',
    ),
    [{ guid: 'att-local', content: 'attached words' }],
  );
});
