import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { once } from 'node:events';
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
import { isDeepStrictEqual, promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  type ReadMessage,
  readerCatalog,
  type Source,
  Stream,
  StreamStatus,
  syncHistoryRelations,
} from 'elt';
import { MarkdownDestination } from 'elt-markdown';
import {
  installSQLiteCatalog,
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
} from 'elt-sqlite';
import type { GoogleRequester } from 'google-auth';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import type { EventKitRequest } from './platform/macos/eventkit.ts';
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
  AppleCalendarSource,
  CalendarIcsUnavailableError,
} from './sources/apple-calendar/apple-calendar-source.ts';
import { googleCalendarAttachments } from './sources/apple-calendar/google-calendar-attachments.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

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

const execFile = promisify(execFileCallback);

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
  readonly calendar: CalendarDocument;
  // Timed, with alarms, a structured location, a URL and notes.
  readonly standup: OccurrenceDocument;
  readonly standupIcs: IcsDocument;
  readonly holiday: OccurrenceDocument;
  // The first occurrence of a weekly series of three.
  readonly weekly: OccurrenceDocument;
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
  holiday: {
    attendees: [],
    startMs: 1735862400000,
    name: 'Synthetic holiday',
    alarms: [],
    recurrenceRules: [],
    status: 0,
    type: 'occurrence',
    occurrenceDay: '2025-01-03',
    calendarItemId: 'item-2',
    createdMs: 1790851280775.7612,
    calendarId: 'calendar-1',
    occurrenceMs: 1735862400000,
    startDay: '2025-01-03',
    modifiedMs: 1790851280775.793,
    detached: false,
    nativeEventId: 'account-1:external-2',
    availability: -1,
    externalId: 'external-2',
    endDay: '2025-01-03',
    endMs: 1735948799000,
    allDay: true,
  },
  weekly: {
    attendees: [],
    startMs: 1735970400000,
    name: 'Synthetic weekly',
    alarms: [],
    recurrenceRules: [recordedRule],
    status: 0,
    type: 'occurrence',
    timeZone: 'Asia/Amman',
    occurrenceDay: '2025-01-04',
    calendarItemId: 'item-3',
    createdMs: 1790851280902.925,
    calendarId: 'calendar-1',
    occurrenceMs: 1735970400000,
    startDay: '2025-01-04',
    modifiedMs: 1790851280902.947,
    detached: false,
    nativeEventId: 'account-1:external-3',
    availability: -1,
    externalId: 'external-3',
    endDay: '2025-01-04',
    endMs: 1735972200000,
    allDay: false,
  },
};

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
  readonly list: CalendarDocument;
  // Open, due at a time in a time zone, with an absolute alarm and notes.
  readonly buyMilk: ReminderDocument;
  // Completed, due on a date.
  readonly filedTaxes: ReminderDocument;
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
  filedTaxes: {
    due: recordedDateOnlyDue,
    externalId: 'reminder-2',
    recurrenceRules: [],
    type: 'reminder',
    modifiedMs: 1790851302411.9302,
    name: 'Synthetic filed taxes',
    completedMs: 1790851302411.825,
    priority: 5,
    completed: true,
    attendees: [],
    listId: 'calendar-1',
    id: 'reminder-2',
    alarms: [],
    createdMs: 1790851301824.6108,
  },
};

const account = (
  overrides: Partial<AccountDocument> = {},
): AccountDocument => ({ ...recordedEvents.account, ...overrides });

const calendar = (
  overrides: Partial<CalendarDocument> = {},
): CalendarDocument => ({ ...recordedEvents.calendar, ...overrides });

const list = (overrides: Partial<CalendarDocument> = {}): CalendarDocument => ({
  ...recordedReminders.list,
  ...overrides,
});

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

const alarm = (overrides: Partial<AlarmDocument> = {}): AlarmDocument => ({
  ...recordedAlarm,
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

const reminder = (
  overrides: Partial<ReminderDocument> = {},
): ReminderDocument => ({ ...recordedReminders.buyMilk, ...overrides });

// A Calendar row's event id: calendar, item and, for a recurring event, the
// occurrence it replaces.
const eventId = (calendarItemId: string, key: string | null = null) =>
  JSON.stringify(['calendar-1', calendarItemId, key]);

type HelperRequest = EventKitRequest & {
  readonly entity: 'events' | 'reminders';
};

// The read a Calendar source sends for its window: the private ICS export
// only when an ICS stream is selected.
const eventsRead = (
  { startAt, endAt }: { readonly startAt: string; readonly endAt: string },
  ics = false,
): HelperRequest => ({ entity: 'events', startAt, endAt, ics });

const remindersRead: HelperRequest = { entity: 'reminders' };

const january = {
  startAt: '2025-01-01T00:00:00.000Z',
  endAt: '2025-02-01T00:00:00.000Z',
};

// A watcher that confirms its subscription and then reports no change, so
// reads settle on their first attempt.
async function* quiet(signal: AbortSignal): AsyncGenerator<string> {
  yield 'changed';
  if (!signal.aborted) await once(signal, 'abort');
}

// Stands in for the eventkit helper process: each read request it is set up
// for is answered with its documents, one JSON line each, and each watch with
// the watch lines. Any other request throws, so what a source asks the helper
// for is part of every test.
function fakeEventKit(
  t: TestContext,
  answers: readonly (readonly [
    request: HelperRequest,
    documents: () =>
      | Iterable<EventKitDocument>
      | AsyncIterable<EventKitDocument>,
  ])[],
  watch: (signal: AbortSignal) => AsyncIterable<string> = quiet,
) {
  t.mock.method(
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
      const request = JSON.parse(String(args[1]));
      const answer = answers.find(([expected]) =>
        isDeepStrictEqual(request, expected),
      );
      if (answer === undefined)
        throw new Error(`The EventKit fake has no answer for ${args[1]}`);
      for await (const document of answer[1]()) yield JSON.stringify(document);
    },
  );
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
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'NotesUnavailableError');
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  await assert.rejects(reading, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'NotesSchemaError');
    assert.match(error.message, /ZICCLOUDSYNCINGOBJECT\.ZTITLE1/);
    return true;
  });
});

test('a Notes watch keeps Notes running and loads each commit while Notes keeps its store open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const path = await noteStoreFixture(scratch.path);
  const source = new AppleNotesSource({ path });
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
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(outcomes[0]?.count ?? -1);
    if (batches.length === 1)
      notes.exec(
        "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7) VALUES (12, 'NOTE-NEW', 'New', 2, 1)",
      );
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.deepEqual(batches, [3, 1]);
  // The watch launched Notes hidden if it was closed; Notes stays open after.
  const { stdout } = await execFile('/usr/bin/lsappinfo', [
    'info',
    '-only',
    'pid',
    '-app',
    'com.apple.Notes',
  ]);
  // lsappinfo prints nothing for an app that is not running.
  assert.match(stdout, /pid/);
});

test('Calendar extracts every scalar stream into SQLite and Markdown', {
  concurrency: false,
}, async (t) => {
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
});

test('Calendar rejects malformed records and preserves prior Markdown on native failures', {
  concurrency: false,
}, async (t) => {
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
  // Injects a malformed document on purpose.
  respond = () => [
    { ...occurrence(), body: { nested: true } } as unknown as EventKitDocument,
  ];
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
});

test('Calendar snapshot incremental reconciles added, changed, moved and removed rows', {
  concurrency: false,
}, async (t) => {
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
});

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

test('Reminders EventKit projects native records through every SQLite and Markdown stream', {
  concurrency: false,
}, async (t) => {
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
        { ...recordedReminders.filedTaxes, id: 'completed', name: 'completed' },
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
    respond = () => [invalid as unknown as EventKitDocument];
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
  const calendar = new AppleCalendarSource(january);
  const reminders = new AppleRemindersSource();
  for (const [entity, source, stream, unavailable] of [
    ['events', calendar, calendar.events, 'CalendarUnavailableError'],
    ['reminders', reminders, reminders.reminders, 'RemindersUnavailableError'],
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
          if (error instanceof Error && error.name === unavailable) return null;
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
});

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

test('iCalendar parsing unfolds lines, keeps parameters and vendor properties, and nests components', {
  concurrency: false,
}, async (t) => {
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
});

test('iCalendar parsing rejects malformed content instead of skipping it', {
  concurrency: false,
}, async (t) => {
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
});

test('Calendar ICS streams load components, raw properties and parameters with exact event links', {
  concurrency: false,
}, async (t) => {
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
});

test('Calendar ICS snapshots delete a removed property with its parameters', {
  concurrency: false,
}, async (t) => {
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
});

test('Calendar incremental attachment copies fetch only new attachments and delete removed ones', {
  concurrency: false,
}, async (t) => {
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
  fakeEventKit(t, [[eventsRead(january, true), () => [icsItem('files', ics)]]]);
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

// Shaped like the GaxiosError google-auth-library throws.
function googleError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    response: { status, data },
  });
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

test('Calendar attachments download Drive files and Gmail parts, and report unreachable ones', {
  concurrency: false,
}, async (t) => {
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
      throw googleError(403, { error: { errors: [{ reason: 'forbidden' }] } });
    if (url.includes('/files/gone')) throw googleError(404);
    if (url.includes('/messages/m1?format=full'))
      return {
        id: 'm1',
        payload: {
          partId: '',
          parts: [
            { partId: '0', body: { size: 3 } },
            { partId: '1', filename: 'a.pdf', body: { attachmentId: 'att-1' } },
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
    'https://drive.google.com/file/d/image/view?usp=drive_web': new Uint8Array(
      png,
    ),
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
});

test('Calendar attachment downloads fail on a disabled API, a missing scope or a server error', {
  concurrency: false,
}, async (t) => {
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
});

test('a rate-limited Drive download rejects instead of loading no file', {
  concurrency: false,
}, async (t) => {
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
});

test('a Drive shortcut downloads its target, and a link-shared file sends its resource key', {
  concurrency: false,
}, async (t) => {
  const bytes = new TextEncoder().encode('target bytes').buffer;
  const { calls, requester } = googleRecorder(({ url }) => {
    if (url.includes('/files/shortcut?fields'))
      return {
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: { targetId: 'target', targetResourceKey: 'key-2' },
      };
    if (url.includes('/files/target?fields')) return { mimeType: 'image/png' };
    if (url.includes('/files/target?alt=media')) return bytes;
    if (url.includes('/files/shared?fields')) return { mimeType: 'image/png' };
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

test('the document parser reads every attachment kind and throws only on unreadable files', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-parse-'));
  const path = await chatFixture(scratch.path);
  const files = join(scratch.path, 'Attachments');
  mkdirSync(files);
  const file = async (name: string, content: string | Uint8Array) => {
    const at = join(files, name);
    await writeFile(at, content);
    return at;
  };
  const photo = join(files, 'receipt.png');
  renderedText(photo, 'Invoice 4821 due Friday');
  const heic = join(files, 'receipt.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', photo, '--out', heic]);
  const blank = join(files, 'blank.png');
  renderedText(blank, null);
  const card =
    'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD\n';
  using chat = new DatabaseSync(path);
  // Each file as Messages records an attachment: a row naming its path.
  const attach = (guid: string, filename: string) =>
    chat
      .prepare(
        'INSERT INTO attachment (guid, original_guid, filename) VALUES (?, ?, ?)',
      )
      .run(guid, guid, filename);
  for (const [guid, filename] of [
    ['photo', photo],
    ['heic', heic],
    ['noExtension', await file('GroupPhotoImage', await readFile(heic))],
    ['blankImage', blank],
    ['blankPdf', await file('blank.pdf', blankPdf)],
    ['text', await file('hello.txt', 'hello')],
    ['card', await file('Ada.vcf', card)],
    ['location', await file('CL.loc.vcf', card)],
    ['video', await file('clip.mov', Uint8Array.of(0, 1, 2))],
    [
      'unknown',
      await file('pluginPayloadAttachment', Uint8Array.of(9, 9, 9, 9)),
    ],
  ] as const)
    attach(guid, filename);
  const source = new AppleMessagesSource(path);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            source.attachments,
            destination.table('attachments', (c) => [
              c.text('guid'),
              c
                .text('content')
                .from(source.attachments.file)
                .parse(new MacOSDocumentParser()),
            ]),
          ),
        ],
      }),
    ],
  });

  await pipeline.run();

  assert.deepEqual(
    Object.fromEntries(
      messagesRows(
        destination.path,
        'SELECT guid, content FROM attachments',
      ).map(({ guid, content }) => [guid, content]),
    ),
    {
      'att-local': 'attached words',
      'att-offloaded': null,
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
    },
  );
  for (const [name, content, message] of [
    ['corrupt.pdf', 'not a pdf', /Cannot read PDF/],
    ['corrupt.heic', Uint8Array.of(0, 1, 2), /Cannot read image/],
  ] as const) {
    attach(name, await file(name, content));
    await assert.rejects(
      pipeline.run(),
      (error: unknown) =>
        error instanceof PipelineError &&
        error.cause instanceof Error &&
        message.test(error.cause.message),
    );
    chat.prepare('DELETE FROM attachment WHERE guid = ?').run(name);
  }
});

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
  const source = new AppleMessagesSource(path, {
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
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'MessagesUnavailableError');
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('property lists decode as Foundation wrote them', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-plist-'));
  const path = await chatFixture(scratch.path);
  const plain = binaryPlist(
    '<dict><key>ascii</key><string>hello</string><key>unicode</key><string>é 😀</string><key>big</key><integer>9007199254740993</integer><key>negative</key><integer>-5</integer><key>real</key><real>1.5</real><key>yes</key><true/><key>when</key><date>2025-01-02T03:04:05Z</date><key>bytes</key><data>AQID</data><key>list</key><array><integer>1</integer><string>two</string></array></dict>',
  );
  // A link preview whose archive also holds Foundation values Messages may
  // keep beside it, archived by NSKeyedArchiver.
  const keyed = Buffer.from(
    execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('LinkPresentation');
        const metadata = $.LPLinkMetadata.alloc.init;
        metadata.URL = $.NSURL.URLWithStringRelativeToURL('page', $.NSURL.URLWithString('https://example.com/dir/'));
        metadata.title = 'An article';
        const root = $.NSMutableDictionary.alloc.init;
        root.setObjectForKey(metadata, 'richLinkMetadata');
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
  {
    using chat = new DatabaseSync(path);
    chat
      .prepare(
        "UPDATE message SET message_summary_info = ? WHERE guid = 'm-old'",
      )
      .run(plain);
    chat
      .prepare("UPDATE message SET payload_data = ? WHERE guid = 'm-link'")
      .run(keyed);
  }
  const source = new AppleMessagesSource(path);

  const rows = await readRows(source, [source.messages, source.linkPreviews]);

  const message = (guid: string) =>
    rows(source.messages).find((row) => row.guid === guid);
  assert.deepEqual(JSON.parse(String(message('m-old')?.messageSummaryInfo)), {
    ascii: 'hello',
    unicode: 'é 😀',
    big: '9007199254740993',
    negative: -5,
    real: 1.5,
    yes: true,
    when: '2025-01-02T03:04:05.000Z',
    bytes: 'AQID',
    list: [1, 'two'],
  });
  const { richLinkMetadata, ...archived } = JSON.parse(
    String(message('m-link')?.payloadData),
  );
  assert.deepEqual(archived, {
    when: '2025-01-02T03:04:05.000Z',
    id: '12345678-9ABC-DEF0-1234-56789ABCDEF0',
    items: ['a', 'b'],
    bytes: 'YWJj',
    url: 'https://example.com/dir/page',
  });
  assert.equal(richLinkMetadata.$class, 'LPLinkMetadata');
  assert.deepEqual(
    rows(source.linkPreviews).map(({ messageGuid, url, title, metadata }) => ({
      messageGuid,
      url,
      title,
      class: JSON.parse(String(metadata)).$class,
    })),
    [
      {
        messageGuid: 'm-link',
        url: 'https://example.com/dir/page',
        title: 'An article',
        class: 'LPLinkMetadata',
      },
    ],
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

test('a Messages watch loads each commit Messages makes while it keeps chat.db open', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
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
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(outcomes[0]?.count ?? -1);
    if (batches.length === 1)
      messages.exec(
        "INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')",
      );
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
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
  const messages = await appleImport(
    new AppleMessagesSource(path),
    join(scratch.path, 'import'),
  );
  await messages.load();

  // One documented view per stream, named after the stream.
  assert.deepEqual(messages.views(), [
    'attachments',
    'chat_handles',
    'chat_lookups',
    'chat_messages',
    'chat_services',
    'chats',
    'handles',
    'link_previews',
    'message_attachments',
    'message_edits',
    'messages',
    'recoverable_message_parts',
    'recoverable_messages',
  ]);
  assert.deepEqual(
    messages
      .read(`
        SELECT h.service, count(m.guid) AS messages
        FROM handles h
        LEFT JOIN messages m ON m.handle = h.id AND m."handleService" = h.service
        GROUP BY h.service ORDER BY h.service`)
      .map((found) => ({ ...found })),
    [
      { service: 'SMS', messages: 1 },
      { service: 'iMessage', messages: 5 },
    ],
  );
  assert.deepEqual(
    messages
      .read(`
        SELECT count(*) AS joined, count(DISTINCT m.guid) AS messages
        FROM messages m JOIN chat_messages c ON c."messageGuid" = m.guid`)
      .map((found) => ({ ...found })),
    [{ joined: 6, messages: 5 }],
  );
  assert.deepEqual(
    messages
      .read(`
        SELECT m.guid, m.text, (SELECT count(*) FROM message_edits e WHERE e."messageGuid" = m.guid) AS edits,
          EXISTS (SELECT 1 FROM recoverable_messages r WHERE r."messageGuid" = m.guid) AS recoverable
        FROM messages m WHERE m.guid IN ('m-plain', 'm-archived', 'm-deleted') ORDER BY m.guid`)
      .map((found) => ({ ...found })),
    [
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        edits: 0,
        recoverable: 0,
      },
      { guid: 'm-deleted', text: 'regretted', edits: 0, recoverable: 1 },
      { guid: 'm-plain', text: 'hello', edits: 2, recoverable: 0 },
    ],
  );
  const files = Object.fromEntries(
    messages
      .read(`SELECT guid, "attachmentRef" FROM attachments`)
      .map(({ guid, attachmentRef }) => [guid, attachmentRef]),
  );
  assert.equal(await readFile(files['att-local'], 'utf8'), 'attached words');
  assert.equal(files['att-offloaded'], null);
});

test('Calendar reads as documented views where occurrences keep their own identity and series rows do not multiply them', {
  concurrency: false,
}, async (t) => {
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
      .read(`
        SELECT e."eventId", (SELECT count(*) FROM attendees a WHERE a."eventId" = e."eventId") AS attendees
        FROM events e ORDER BY e."startAt"`)
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
      .read(`
        SELECT count(*) AS occurrences, sum(c.components) AS components
        FROM events e JOIN (
          SELECT "calendarId", "calendarItemId", count(*) AS components
          FROM ics_components WHERE name = 'VEVENT' AND "eventId" IS NULL
          GROUP BY 1, 2) c USING ("calendarId", "calendarItemId")`)
      .map((found) => ({ ...found })),
    [{ occurrences: 2, components: 4 }],
  );
});

test('Reminders reads as documented views that keep date components as components', {
  concurrency: false,
}, async (t) => {
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
      .read(`
        SELECT r.id, r.completed, d.kind, d.year, d.month, d.day, d.hour
        FROM reminders r
        LEFT JOIN date_components d ON d."reminderId" = r.id
        JOIN lists l ON l.id = r."listId"
        ORDER BY r.id`)
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
});
