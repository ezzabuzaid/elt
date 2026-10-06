import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Source,
  type Stream,
  StreamStatus,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import {
  BooksSchemaError,
  BooksUnavailableError,
  booksContainer,
  booksGroupContainer,
} from '@workspace/sdk-apple-books';

import { AppleBooksSource } from './apple-books-source.ts';

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
  return {
    load: () => new Pipeline({ history, connections: [connection] }).run(),
    read: (sql: string) => {
      using database = new DatabaseSync(path, { readOnly: true });
      return database.prepare(sql).all();
    },
  };
}

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

function xml(value: unknown): string {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'bigint') return `<integer>${value}</integer>`;
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`;
  if (value instanceof Date)
    return `<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
  if (value instanceof Uint8Array)
    return `<data>${Buffer.from(value).toString('base64')}</data>`;
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  if (value === null || typeof value !== 'object')
    throw new TypeError(`A property list cannot hold ${String(value)}`);
  return `<dict>${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `<key>${escapeXml(key)}</key>${xml(item)}`)
    .join('')}</dict>`;
}

// A property list as Safari writes it: binary, converted by plutil.
async function writePlist(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml(value)}</plist>`,
  );
  await run('/usr/bin/plutil', ['-convert', 'binary1', path]);
}

// Seconds since 2001-01-01, as Safari's databases store times.
const appleSeconds = (iso: string) =>
  (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

// Books' own CREATE TABLE statements, as its stores declare them (Books 8 on
// macOS 27); fixtures insert synthetic rows only.
const librarySchema = `
CREATE TABLE ZBKLIBRARYASSET ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZAUTHORCOUNT INTEGER, ZCANREDOWNLOAD INTEGER, ZCOMBINEDSTATE INTEGER, ZCOMPUTEDRATING INTEGER, ZCONTENTTYPE INTEGER, ZDESKTOPSUPPORTLEVEL INTEGER, ZDIDRUNFORYOUENDOFBOOKEXPERIENCE INTEGER, ZDIDWARNABOUTDESKTOPSUPPORT INTEGER, ZFILESIZE INTEGER, ZFINISHEDDATEKIND INTEGER, ZGENERATION INTEGER, ZHASRACSUPPORT INTEGER, ZHASTOOMANYAUTHORS INTEGER, ZHASTOOMANYNARRATORS INTEGER, ZISDEVELOPMENT INTEGER, ZISDOWNLOADINGSUPPLEMENTALCONTENT INTEGER, ZISEPHEMERAL INTEGER, ZISEXPLICIT INTEGER, ZISFINISHED INTEGER, ZISHIDDEN INTEGER, ZISLOCKED INTEGER, ZISNEW INTEGER, ZISPROOF INTEGER, ZISSAMPLE INTEGER, ZISSTOREAUDIOBOOK INTEGER, ZISSUPPLEMENTALCONTENT INTEGER, ZISTRACKEDASRECENT INTEGER, ZMAPPEDASSETCONTENTTYPE INTEGER, ZMETADATAMIGRATIONVERSION INTEGER, ZNARRATORCOUNT INTEGER, ZNOTFINISHED INTEGER, ZPAGECOUNT INTEGER, ZRATING INTEGER, ZSERIESFILTERMODE INTEGER, ZSERIESISCLOUDONLY INTEGER, ZSERIESISHIDDEN INTEGER, ZSERIESISORDERED INTEGER, ZSERIESNEXTFLAG INTEGER, ZSERIESSORTKEY INTEGER, ZSERIESSORTMODE INTEGER, ZSORTKEY INTEGER, ZSTATE INTEGER, ZTASTE INTEGER, ZTASTESYNCEDTOSTORE INTEGER, ZLOCALONLYSERIESITEMSPARENT INTEGER, ZPURCHASEDANDLOCALPARENT INTEGER, ZSERIESCONTAINER INTEGER, ZSUPPLEMENTALCONTENTPARENT INTEGER, ZASSETDETAILSMODIFICATIONDATE TIMESTAMP, ZBOOKHIGHWATERMARKPROGRESS FLOAT, ZBOOKMARKSSERVERMAXMODIFICATIONDATE TIMESTAMP, ZCOVERASPECTRATIO FLOAT, ZCREATIONDATE TIMESTAMP, ZDATEFINISHED TIMESTAMP, ZDURATION FLOAT, ZEXPECTEDDATE TIMESTAMP, ZFILEONDISKLASTTOUCHDATE TIMESTAMP, ZLASTENGAGEDDATE TIMESTAMP, ZLASTOPENDATE TIMESTAMP, ZLOCATIONSERVERMAXMODIFICATIONDATE TIMESTAMP, ZMODIFICATIONDATE TIMESTAMP, ZPURCHASEDATE TIMESTAMP, ZREADINGPROGRESS FLOAT, ZRELEASEDATE TIMESTAMP, ZUPDATEDATE TIMESTAMP, ZVERSIONNUMBER FLOAT, ZSEQUENCENUMBER DECIMAL, ZACCOUNTID VARCHAR, ZASSETGUID VARCHAR, ZASSETID VARCHAR, ZAUTHOR VARCHAR, ZBOOKDESCRIPTION VARCHAR, ZBOOKMARKSSERVERVERSION VARCHAR, ZCOMMENTS VARCHAR, ZCOVERURL VARCHAR, ZCOVERWRITINGMODE VARCHAR, ZDATASOURCEIDENTIFIER VARCHAR, ZDOWNLOADEDDSID VARCHAR, ZEPUBID VARCHAR, ZFAMILYID VARCHAR, ZGENRE VARCHAR, ZGROUPING VARCHAR, ZKIND VARCHAR, ZLANGUAGE VARCHAR, ZLOCATIONSERVERVERSION VARCHAR, ZMAPPEDASSETID VARCHAR, ZPAGEPROGRESSIONDIRECTION VARCHAR, ZPATH VARCHAR, ZPERMLINK VARCHAR, ZPURCHASEDDSID VARCHAR, ZSEQUENCEDISPLAYNAME VARCHAR, ZSERIESID VARCHAR, ZSERIESSTACKIDS VARCHAR, ZSORTAUTHOR VARCHAR, ZSORTTITLE VARCHAR, ZSTOREID VARCHAR, ZSTOREPLAYLISTID VARCHAR, ZTEMPORARYASSETID VARCHAR, ZTITLE VARCHAR, ZVERSIONNUMBERHUMANREADABLE VARCHAR, ZYEAR VARCHAR, ZURL VARCHAR, ZAUTHORNAMES BLOB, ZGENRES BLOB, ZNARRATORNAMES BLOB );
CREATE TABLE ZBKCOLLECTION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZHIDDEN INTEGER, ZPLACEHOLDER INTEGER, ZSORTKEY INTEGER, ZSORTMODE INTEGER, ZVIEWMODE INTEGER, ZLASTMODIFICATION TIMESTAMP, ZLOCALMODDATE TIMESTAMP, ZCOLLECTIONID VARCHAR, ZDETAILS VARCHAR, ZTITLE VARCHAR );
CREATE TABLE ZBKCOLLECTIONMEMBER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORTKEY INTEGER, ZASSET INTEGER, ZCOLLECTION INTEGER, ZLOCALMODDATE TIMESTAMP, ZASSETID VARCHAR, ZTEMPORARYASSETID VARCHAR );
`;

const annotationsSchema = `
CREATE TABLE ZAEANNOTATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANNOTATIONDELETED INTEGER, ZANNOTATIONISUNDERLINE INTEGER, ZANNOTATIONSTYLE INTEGER, ZANNOTATIONTYPE INTEGER, ZPLABSOLUTEPHYSICALLOCATION INTEGER, ZPLLOCATIONRANGEEND INTEGER, ZPLLOCATIONRANGESTART INTEGER, ZANNOTATIONCREATIONDATE TIMESTAMP, ZANNOTATIONMODIFICATIONDATE TIMESTAMP, ZANNOTATIONASSETID VARCHAR, ZANNOTATIONCREATORIDENTIFIER VARCHAR, ZANNOTATIONLOCATION VARCHAR, ZANNOTATIONNOTE VARCHAR, ZANNOTATIONREPRESENTATIVETEXT VARCHAR, ZANNOTATIONSELECTEDTEXT VARCHAR, ZANNOTATIONUUID VARCHAR, ZFUTUREPROOFING1 VARCHAR, ZFUTUREPROOFING10 VARCHAR, ZFUTUREPROOFING11 VARCHAR, ZFUTUREPROOFING12 VARCHAR, ZFUTUREPROOFING2 VARCHAR, ZFUTUREPROOFING3 VARCHAR, ZFUTUREPROOFING4 VARCHAR, ZFUTUREPROOFING5 VARCHAR, ZFUTUREPROOFING6 VARCHAR, ZFUTUREPROOFING7 VARCHAR, ZFUTUREPROOFING8 VARCHAR, ZFUTUREPROOFING9 VARCHAR, ZPLSTORAGEUUID VARCHAR, ZPLUSERDATA BLOB );
`;

const assetDataSchema = `
CREATE TABLE ZBCASSETDETAIL ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZFINISHEDDATEKIND INTEGER, ZISFINISHED INTEGER, ZISTRACKEDASRECENT INTEGER, ZNOTFINISHED INTEGER, ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION INTEGER, ZREADINGPOSITIONLOCATIONRANGEEND INTEGER, ZREADINGPOSITIONLOCATIONRANGESTART INTEGER, ZSTARRATING INTEGER, ZSYNCGENERATION INTEGER, ZTASTE INTEGER, ZTASTESYNCEDTOSTORE INTEGER, ZBOOKMARKTIME FLOAT, ZDATEFINISHED TIMESTAMP, ZDATEPLAYBACKTIMEUPDATED TIMESTAMP, ZLASTENGAGEDDATE TIMESTAMP, ZLASTOPENDATE TIMESTAMP, ZMODIFICATIONDATE TIMESTAMP, ZREADINGPOSITIONLOCATIONUPDATEDATE TIMESTAMP, ZREADINGPROGRESS FLOAT, ZREADINGPROGRESSHIGHWATERMARK FLOAT, ZASSETID VARCHAR, ZREADINGPOSITIONANNOTATIONVERSION VARCHAR, ZREADINGPOSITIONASSETVERSION VARCHAR, ZREADINGPOSITIONCFISTRING VARCHAR, ZREADINGPOSITIONSTORAGEUUID VARCHAR, ZSALTEDHASHEDID VARCHAR, ZCKSYSTEMFIELDS BLOB, ZREADINGPOSITIONUSERDATA BLOB );
CREATE TABLE ZBCASSETREVIEW ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZSTARRATING INTEGER, ZSYNCGENERATION INTEGER, ZMODIFICATIONDATE TIMESTAMP, ZASSETREVIEWID VARCHAR, ZREVIEWBODY VARCHAR, ZREVIEWTITLE VARCHAR, ZSALTEDHASHEDID VARCHAR, ZUSERID VARCHAR, ZCKSYSTEMFIELDS BLOB );
`;

const readingHistorySchema = `
CREATE TABLE ZCRDTMODELSYNCENTITY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZSYNCGENERATION INTEGER, ZMODIFICATIONDATE TIMESTAMP, ZSALTEDHASHEDID VARCHAR, ZTYPE VARCHAR, ZCKSYSTEMFIELDS BLOB, ZPROTODATA BLOB );
`;

const purchasesSchema = `
CREATE TABLE ZBLJALISCOSERVERITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTAINSAUDIO INTEGER, ZISAUDIOBOOK INTEGER, ZISDISABLED INTEGER, ZISEXPLICIT INTEGER, ZISHIDDEN INTEGER, ZISPICTUREBOOK INTEGER, ZISREADALOUD INTEGER, ZNEEDSIMPORT INTEGER, ZPURCHASEHISTORYID INTEGER, ZSTOREACCOUNTID INTEGER, ZDATABASE INTEGER, ZEXPECTEDDATE TIMESTAMP, ZPURCHASEDAT TIMESTAMP, ZARTIST VARCHAR, ZARTWORKTOKENCODE VARCHAR, ZARTWORKURLSTRING VARCHAR, ZCHAPTERMETADATAURLSTRING VARCHAR, ZCLOUDID VARCHAR, ZDISPLAYVERSION VARCHAR, ZFILEEXTENSION VARCHAR, ZGENRE VARCHAR, ZHLSPLAYLISTURLSTRING VARCHAR, ZPURCHASEDTOKENCODE VARCHAR, ZSORTEDAUTHOR VARCHAR, ZSORTEDTITLE VARCHAR, ZSTOREDOWNLOADPARAMETERS VARCHAR, ZSTOREID VARCHAR, ZTITLE VARCHAR, ZADDITIONALAUDIOBOOKINFO BLOB );
`;

const themesSchema = `
CREATE TABLE ZBOOKTHEME ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZHASCUSTOMLAYOUT INTEGER, ZISFONTBOLDED INTEGER, ZJUSTIFY INTEGER, ZMULTIPLECOLUMNMODE INTEGER, ZLETTERSPACING FLOAT, ZLINEHEIGHT FLOAT, ZMARGINADJUSTMENT FLOAT, ZWORDSPACING FLOAT, ZIDENTIFIER VARCHAR, ZFONTSBYLANGUAGE BLOB );
`;

// Protocol Buffers wire encoding, enough to build a Coherence document.
const varint = (value: bigint | number) => {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest > 0n ? byte | 0x80 : byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
};
const field = (number: number, value: bigint | number | Uint8Array | string) =>
  typeof value === 'number' || typeof value === 'bigint'
    ? Buffer.concat([varint(number << 3), varint(value)])
    : (() => {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        return Buffer.concat([
          varint((number << 3) | 2),
          varint(bytes.length),
          bytes,
        ]);
      })();
const message = (...fields: Uint8Array[]) => Buffer.concat(fields);

const uuid = (seed: number) => Buffer.alloc(16, seed);
const replica = uuid(0xaa);
const timestamp = message(field(1, replica), field(2, 1));
const register = (value: Uint8Array) =>
  message(field(1, message(field(2, timestamp), field(3, value))));
const int = (value: number) => message(field(1, value));
const date = (seconds: number) => message(field(5, message(field(1, seconds))));
const reference = (id: Uint8Array) =>
  message(field(6, message(field(1, id), field(2, message()))));
const dictionary = (entries: readonly [number, Uint8Array][]) =>
  message(
    field(
      3,
      message(
        field(1, uuid(0xdd)),
        field(2, message()),
        ...entries.map(([key, value]) =>
          field(
            3,
            message(
              field(1, int(key)),
              field(2, register(value)),
              field(3, message()),
            ),
          ),
        ),
      ),
    ),
  );
const struct = (fields: Readonly<Record<string, Uint8Array>>) =>
  message(
    field(
      4,
      message(
        ...Object.entries(fields).map(([name, value]) =>
          field(1, message(field(1, name), field(2, value))),
        ),
      ),
    ),
  );
// A counter where each replica records [decrements, increments].
const counter = (contributions: readonly [number, number][]) =>
  message(
    field(
      7,
      message(
        field(1, uuid(0xcc)),
        field(
          2,
          message(
            ...contributions.map(([decrements, increments], index) =>
              field(
                1,
                message(
                  field(1, uuid(0xb0 + index)),
                  field(
                    2,
                    Buffer.concat([varint(decrements), varint(increments)]),
                  ),
                ),
              ),
            ),
          ),
        ),
        field(3, Buffer.alloc(0)),
      ),
    ),
  );

type HistoryMonth = {
  readonly key: number;
  readonly totalTime?: number;
  readonly lastDayStreakOrdinal: number;
  readonly days: readonly {
    readonly day: number;
    readonly reading: readonly [number, number][];
    readonly goal: number;
  }[];
};

// A ReadingHistoryModel document as bookdatastored syncs it: "crdt", format
// version 4, then the protobuf document.
function readingHistoryDocument(
  months: readonly HistoryMonth[],
  streaks: readonly [number, number][],
  version = 4,
): Uint8Array {
  const objects: Uint8Array[] = [];
  let next = 1;
  const object = (value: Uint8Array) => {
    const id = uuid(next++);
    objects.push(field(2, message(field(1, id), field(3, value))));
    return id;
  };
  const monthEntries = months.map(
    ({ key, totalTime, lastDayStreakOrdinal, days }) => {
      const dayEntries = days.map(
        ({ day, reading, goal }) =>
          [
            day,
            reference(
              object(
                struct({
                  readingTime: counter(reading),
                  readingGoal: register(int(goal)),
                }),
              ),
            ),
          ] satisfies [number, Uint8Array],
      );
      const fields: Record<string, Uint8Array> = {
        days: dictionary(dayEntries),
        lastDayStreakOrdinal: register(int(lastDayStreakOrdinal)),
      };
      if (totalTime !== undefined) fields.totalTime = register(int(totalTime));
      return [key, reference(object(struct(fields)))] satisfies [
        number,
        Uint8Array,
      ];
    },
  );
  const root = struct({
    months: dictionary(monthEntries),
    streakRecords: dictionary(
      streaks.map(([days, seconds]) => [days, date(seconds)]),
    ),
  });
  const header = Buffer.alloc(8);
  header.write('crdt', 0, 'latin1');
  header.writeUInt32LE(version, 4);
  return Buffer.concat([header, field(1, root), ...objects]);
}

const defaultHistory = {
  months: [
    { key: 202208, totalTime: 9531, lastDayStreakOrdinal: 0, days: [] },
    {
      key: 202609,
      lastDayStreakOrdinal: -1,
      days: [
        { day: 8, reading: [[0, 1296]], goal: 1800 },
        {
          day: 14,
          reading: [
            [0, 1239],
            [0, 41768],
          ],
          goal: 1800,
        },
      ],
    },
  ],
  streaks: [
    [1, Date.parse('2021-12-09T22:00:00.000Z') / 1000],
    [7, Date.parse('2023-02-06T21:00:00.000Z') / 1000],
  ],
} satisfies {
  months: HistoryMonth[];
  streaks: [number, number][];
};

const at = (iso: string) => appleSeconds(iso);

type BooksFixture = AppleBooksSource['location'] & {
  // Where the fixture's book files live, standing in for iCloud Drive.
  readonly documents: string;
  readonly files: {
    readonly library: string;
    readonly annotations: string;
    readonly assetData: string;
    readonly readingHistory: string;
    readonly purchases: string;
    readonly themes: string;
    readonly appPreferences: string;
    readonly sharedPreferences: string;
  };
};

function database(path: string, schema: string): DatabaseSync {
  const store = new DatabaseSync(path);
  // Core Data keeps a persistent WAL; read-only readers must see it.
  store.exec('PRAGMA journal_mode = WAL');
  store.exec(schema);
  return store;
}

// One library with an EPUB package, a PDF, and a book whose file is gone; its
// annotations, collections, synced reading state, a store review, reading
// history, a store purchase, a custom theme, and the reading goal preferences.
async function booksFixture(root: string): Promise<BooksFixture> {
  const container = join(root, 'container');
  const groupContainer = join(root, 'group');
  const documents = join(root, 'iCloud Books');
  const files = {
    library: join(
      container,
      'Documents/BKLibrary/BKLibrary-1-091020131601.sqlite',
    ),
    annotations: join(
      container,
      'Documents/AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite',
    ),
    assetData: join(
      groupContainer,
      'Documents/BCCloudData-BookDataStoreService/BCAssetData/BCAssetData',
    ),
    readingHistory: join(
      groupContainer,
      'Documents/BCCloudData-BookDataStoreService/CRDTModelSync-ReadingHistoryModel/CRDTModelSync-ReadingHistoryModel',
    ),
    purchases: join(
      groupContainer,
      'Documents/BKJaliscoServerSource/BKJaliscoServerSource-v09182016.sqlite',
    ),
    themes: join(
      container,
      'Library/Application Support/Books/BookTheme.sqlite',
    ),
    appPreferences: join(
      container,
      'Library/Preferences/com.apple.iBooksX.plist',
    ),
    sharedPreferences: join(
      groupContainer,
      'Library/Preferences/group.com.apple.iBooks.plist',
    ),
  };
  for (const path of [...Object.values(files), join(documents, 'x')])
    await mkdir(join(path, '..'), { recursive: true });

  const epub = join(documents, 'Design.epub');
  await mkdir(join(epub, 'META-INF'), { recursive: true });
  await mkdir(join(epub, 'OEBPS'), { recursive: true });
  await writeFile(join(epub, 'mimetype'), 'application/epub+zip');
  await writeFile(
    join(epub, 'META-INF/container.xml'),
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  await writeFile(join(epub, 'OEBPS/content.opf'), '<package/>');
  await writeFile(
    join(epub, 'OEBPS/chapter.xhtml'),
    '<html>Grids and rhythm</html>',
  );
  const pdf = join(documents, 'Notes.pdf');
  await writeFile(pdf, '%PDF-1.7\n%fixture\n');
  // An EPUB added as a zipped file rather than a package directory.
  const packed = join(documents, 'Packed.epub');
  await writeFile(packed, 'PK zipped epub fixture');

  {
    using store = database(files.library, librarySchema);
    const asset = store.prepare(
      'INSERT INTO ZBKLIBRARYASSET (Z_PK, Z_ENT, Z_OPT, ZASSETID, ZTITLE, ZAUTHOR, ZCONTENTTYPE, ZPATH, ZREADINGPROGRESS, ZBOOKHIGHWATERMARKPROGRESS, ZISFINISHED, ZDATEFINISHED, ZLASTOPENDATE, ZFILESIZE, ZDATASOURCEIDENTIFIER, ZISHIDDEN, ZISSAMPLE, ZSERIESCONTAINER) VALUES (?, 5, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)',
    );
    asset.run(
      1,
      'A1',
      'Design for Developers',
      'Stephanie Stimac',
      1,
      epub,
      0.5,
      0.75,
      0,
      null,
      at('2026-09-14T11:38:00.000Z'),
      7_000_000,
      'com.apple.ibooks.datasource.ubiquity',
      null,
    );
    asset.run(
      2,
      'P2',
      'Notes',
      null,
      3,
      pdf,
      1,
      1,
      1,
      at('2023-08-21T10:00:00.000Z'),
      at('2023-08-21T10:00:00.000Z'),
      18,
      'com.apple.ibooks.datasource.ubiquity',
      null,
    );
    asset.run(
      3,
      'G3',
      'Gone',
      'Someone',
      1,
      join(documents, 'Gone.epub'),
      0,
      0,
      0,
      null,
      null,
      null,
      'com.apple.ibooks.datasource.ubiquity',
      1,
    );
    asset.run(
      4,
      'Z4',
      'Packed',
      null,
      1,
      packed,
      0,
      0,
      0,
      null,
      null,
      22,
      'com.apple.ibooks.datasource.ubiquity',
      null,
    );
    const collection = store.prepare(
      'INSERT INTO ZBKCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZCOLLECTIONID, ZTITLE, ZDELETEDFLAG, ZHIDDEN, ZPLACEHOLDER, ZSORTKEY, ZLASTMODIFICATION) VALUES (?, 2, 1, ?, ?, 0, 0, 0, ?, ?)',
    );
    collection.run(
      1,
      'Finished_Collection_ID',
      'Finished',
      1,
      at('2025-07-28T00:00:00.000Z'),
    );
    collection.run(
      2,
      '4F1E-WANT',
      'Want to Read',
      2,
      at('2025-07-28T00:00:00.000Z'),
    );
    const member = store.prepare(
      'INSERT INTO ZBKCOLLECTIONMEMBER (Z_PK, Z_ENT, Z_OPT, ZCOLLECTION, ZASSET, ZASSETID, ZSORTKEY, ZLOCALMODDATE) VALUES (?, 3, 1, ?, ?, ?, ?, ?)',
    );
    member.run(1, 1, 2, 'P2', 1, at('2023-08-21T10:00:00.000Z'));
    // A member whose asset left the library keeps its asset identifier.
    member.run(2, 2, null, 'LEFT', 2, at('2025-07-28T00:00:00.000Z'));
  }
  {
    using store = database(files.annotations, annotationsSchema);
    const annotation = store.prepare(
      'INSERT INTO ZAEANNOTATION (Z_PK, Z_ENT, Z_OPT, ZANNOTATIONUUID, ZANNOTATIONASSETID, ZANNOTATIONTYPE, ZANNOTATIONSTYLE, ZANNOTATIONISUNDERLINE, ZANNOTATIONDELETED, ZANNOTATIONSELECTEDTEXT, ZANNOTATIONNOTE, ZANNOTATIONLOCATION, ZFUTUREPROOFING5, ZANNOTATIONCREATORIDENTIFIER, ZANNOTATIONCREATIONDATE, ZANNOTATIONMODIFICATIONDATE) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    annotation.run(
      1,
      'H-1',
      'A1',
      2,
      3,
      0,
      0,
      'Grids and rhythm',
      'Use a baseline',
      'epubcfi(/6/4!/4/2,/1:0,/1:16)',
      'Chapter 4',
      'com~apple~iBooks',
      at('2026-09-14T11:35:27.000Z'),
      at('2026-09-14T11:35:27.000Z'),
    );
    annotation.run(
      2,
      'U-2',
      'A1',
      2,
      0,
      1,
      0,
      'underlined',
      null,
      'epubcfi(/6/8!/4/2,/1:0,/1:10)',
      'Chapter 5',
      'com~apple~iBooks',
      at('2026-09-14T11:36:00.000Z'),
      at('2026-09-14T11:36:00.000Z'),
    );
    annotation.run(
      3,
      'R-3',
      'A1',
      3,
      0,
      0,
      0,
      null,
      null,
      'epubcfi(/6/10!/4/2/1:0)',
      null,
      'com~apple~iBooks',
      at('2026-09-14T11:38:00.000Z'),
      at('2026-09-14T11:38:00.000Z'),
    );
    // A deletion marker keeps no book, text or location.
    annotation.run(
      4,
      'D-4',
      '',
      0,
      0,
      0,
      1,
      null,
      null,
      null,
      null,
      'com~apple~iBooks',
      at('2023-01-01T00:00:00.000Z'),
      at('2023-01-01T00:00:00.000Z'),
    );
  }
  {
    using store = database(files.assetData, assetDataSchema);
    const detail = store.prepare(
      'INSERT INTO ZBCASSETDETAIL (Z_PK, Z_ENT, Z_OPT, ZASSETID, ZDELETEDFLAG, ZREADINGPROGRESS, ZREADINGPROGRESSHIGHWATERMARK, ZISFINISHED, ZNOTFINISHED, ZSTARRATING, ZLASTOPENDATE, ZREADINGPOSITIONCFISTRING, ZMODIFICATIONDATE) VALUES (?, 2, 1, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?)',
    );
    detail.run(
      1,
      'A1',
      0.5,
      0.75,
      0,
      1,
      at('2026-09-14T11:38:00.000Z'),
      'epubcfi(/6/10!/4/2/1:0)',
      at('2026-09-14T11:38:00.000Z'),
    );
    // Read on another device; not in this Mac's library.
    detail.run(
      2,
      'ELSEWHERE',
      0.2,
      0.2,
      0,
      null,
      at('2024-01-01T00:00:00.000Z'),
      null,
      at('2024-01-01T00:00:00.000Z'),
    );
    store
      .prepare(
        'INSERT INTO ZBCASSETREVIEW (Z_PK, Z_ENT, Z_OPT, ZASSETREVIEWID, ZDELETEDFLAG, ZSTARRATING, ZREVIEWTITLE, ZREVIEWBODY, ZUSERID, ZMODIFICATIONDATE) VALUES (1, 3, 1, ?, 0, 4, ?, ?, ?, ?)',
      )
      .run(
        'REVIEW-9',
        'Worth it',
        'Clear and practical.',
        '1234567',
        at('2025-01-02T03:04:05.000Z'),
      );
  }
  {
    using store = database(files.readingHistory, readingHistorySchema);
    store
      .prepare(
        "INSERT INTO ZCRDTMODELSYNCENTITY (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZDELETEDFLAG, ZPROTODATA, ZMODIFICATIONDATE) VALUES (1, 4, 1, 'ReadingHistoryModel', 0, ?, ?)",
      )
      .run(
        readingHistoryDocument(defaultHistory.months, defaultHistory.streaks),
        at('2026-09-14T11:38:00.000Z'),
      );
  }
  {
    using store = database(files.purchases, purchasesSchema);
    store
      .prepare(
        "INSERT INTO ZBLJALISCOSERVERITEM (Z_PK, Z_ENT, Z_OPT, ZSTOREID, ZTITLE, ZARTIST, ZFILEEXTENSION, ZPURCHASEDAT, ZISAUDIOBOOK, ZPURCHASEDTOKENCODE, ZSTOREDOWNLOADPARAMETERS) VALUES (1, 4, 1, '1587320271', 'Bought', 'An Author', 'epub', ?, 0, 'SECRET-TOKEN', 'SECRET-PARAMS')",
      )
      .run(at('2022-05-01T00:00:00.000Z'));
  }
  {
    using store = database(files.themes, themesSchema);
    store.exec(
      "INSERT INTO ZBOOKTHEME (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZISFONTBOLDED, ZJUSTIFY, ZLINEHEIGHT) VALUES (1, 1, 1, 'Quiet', 1, 0, 1.4)",
    );
  }
  await writePlist(files.appPreferences, {
    'ReadingGoals.StreakDay': { goal: 1800 },
    'ReadingHistory.CurrentStreak': 0,
  });
  await writePlist(files.sharedPreferences, {
    BKReadingGoalsUserDefaultsKey: true,
    streakDatUserDefaultsKey: {
      date: new Date('2022-03-05T08:02:05.000Z'),
      goal: 1800,
    },
  });
  return { container, groupContainer, documents, files };
}

const run = promisify(execFile);
const rows = <T extends object>(found: Iterable<T>) =>
  [...found].map((row) => ({ ...row }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The records one full-refresh read of a stream yields, in the order Books
// yields them.
async function readStream(
  source: AppleBooksSource,
  stream: Stream,
): Promise<Record<string, unknown>[]> {
  const messages = await Array.fromAsync(
    source.read(
      [
        new Copy(
          stream,
          new SQLiteDestination({ path: ':memory:' }).table(stream.name),
        ).configuration,
      ],
      new Map(),
    ),
  );
  for (const message of messages)
    if (message instanceof StreamStatus && message.status === 'FAILED')
      throw message.error;
  return messages.flatMap((message) =>
    'data' in message && isRecord(message.data) ? [message.data] : [],
  );
}

// The fields of the record whose key field holds the given value.
const fieldsOf = (
  records: readonly Record<string, unknown>[],
  key: string,
  value: unknown,
  fields: readonly string[],
) => {
  const found = records.find((record) => record[key] === value);
  assert.ok(found, `no record with ${key} ${String(value)}`);
  return Object.fromEntries(fields.map((field) => [field, found[field]]));
};

// The streams one load of a fresh fixture under root fails after a change to
// it, each with its error as text.
async function failedAfter(
  root: string,
  change: (location: BooksFixture) => Promise<void>,
): Promise<Record<string, string>> {
  const location = await booksFixture(root);
  await change(location);
  const books = await appleImport(
    new AppleBooksSource(location),
    join(root, 'import'),
  );
  const failure = await books.load().then(
    () => null,
    (error: unknown) => error,
  );
  if (failure === null) return {};
  assert.ok(failure instanceof PipelineError);
  return Object.fromEntries(
    failure.results
      .filter(({ failures }) => failures.length > 0)
      .map(({ copy, failures }) => [
        copy.configuration.stream.name,
        String(failures[0]?.error),
      ]),
  );
}

// Rebuilds a table the way a later Books might lay it out: the same columns
// and rows, without its Z_PK.
function withoutPrimaryKey(path: string, table: string): void {
  using store = new DatabaseSync(path);
  const columns = store
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .flatMap(({ name }) =>
      typeof name === 'string' && name !== 'Z_PK' ? [name] : [],
    );
  store.exec(`CREATE TABLE rebuilt AS SELECT ${columns.join(', ')} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE rebuilt RENAME TO ${table}`);
}

// NSDate's distantPast and distantFuture in seconds since 2001-01-01, which
// Core Data and property lists store to mean "none".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;
const fromAppleSeconds = (seconds: number) =>
  new Date(Date.UTC(2001, 0, 1) + seconds * 1000);

test('Books reads its library, annotations, synced reading state and reading history as documented views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  const books = await appleImport(source, join(scratch.path, 'import'));

  await books.load();

  const described = new Set(
    books
      .read(
        `SELECT name FROM catalog WHERE kind = 'view' AND description <> ''`,
      )
      .map(({ name }) => name),
  );
  const views = (await source.discover()).streams
    .map(({ name }) => snake(name))
    .sort();
  assert.deepEqual(views, [
    'annotations',
    'asset_details',
    'book_files',
    'collection_members',
    'collections',
    'library_assets',
    'purchases',
    'reading_days',
    'reading_goal',
    'reading_months',
    'reviews',
    'streak_records',
    'themes',
  ]);
  assert.deepEqual(
    views.filter((view) => !described.has(view)),
    [],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT "assetId", title, "contentType", "readingProgress" AS progress, "isFinished", "finishedAt", "seriesContainerAssetId" FROM library_assets ORDER BY "assetId"`,
      ),
    ),
    [
      {
        assetId: 'A1',
        title: 'Design for Developers',
        contentType: 'epub',
        progress: 0.5,
        isFinished: 0,
        finishedAt: null,
        seriesContainerAssetId: null,
      },
      {
        assetId: 'G3',
        title: 'Gone',
        contentType: 'epub',
        progress: 0,
        isFinished: 0,
        finishedAt: null,
        seriesContainerAssetId: 'A1',
      },
      {
        assetId: 'P2',
        title: 'Notes',
        contentType: 'pdf',
        progress: 1,
        isFinished: 1,
        finishedAt: '2023-08-21T10:00:00.000Z',
        seriesContainerAssetId: null,
      },
      {
        assetId: 'Z4',
        title: 'Packed',
        contentType: 'epub',
        progress: 0,
        isFinished: 0,
        finishedAt: null,
        seriesContainerAssetId: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT "collectionId", "assetId" FROM collection_members ORDER BY "collectionId"`,
      ),
    ),
    [
      { collectionId: '4F1E-WANT', assetId: 'LEFT' },
      { collectionId: 'Finished_Collection_ID', assetId: 'P2' },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT id, "assetId", kind, style, underline, deleted, "selectedText", note, chapter FROM annotations ORDER BY id`,
      ),
    ),
    [
      {
        id: 'D-4',
        assetId: null,
        kind: null,
        style: 0,
        underline: 0,
        deleted: 1,
        selectedText: null,
        note: null,
        chapter: null,
      },
      {
        id: 'H-1',
        assetId: 'A1',
        kind: 'highlight',
        style: 3,
        underline: 0,
        deleted: 0,
        selectedText: 'Grids and rhythm',
        note: 'Use a baseline',
        chapter: 'Chapter 4',
      },
      {
        id: 'R-3',
        assetId: 'A1',
        kind: 'readingPosition',
        style: 0,
        underline: 0,
        deleted: 0,
        selectedText: null,
        note: null,
        chapter: null,
      },
      {
        id: 'U-2',
        assetId: 'A1',
        kind: 'highlight',
        style: 0,
        underline: 1,
        deleted: 0,
        selectedText: 'underlined',
        note: null,
        chapter: 'Chapter 5',
      },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT "assetId", "notFinished", position FROM asset_details ORDER BY "assetId"`,
      ),
    ),
    [
      {
        assetId: 'A1',
        notFinished: 1,
        position: 'epubcfi(/6/10!/4/2/1:0)',
      },
      { assetId: 'ELSEWHERE', notFinished: null, position: null },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT month, "summarizedSeconds" AS summarized, "lastDayStreakOrdinal" AS streak, "dayCount" AS days FROM reading_months ORDER BY month`,
      ),
    ),
    [
      { month: '2022-08', summarized: 9531, streak: 0, days: 0 },
      { month: '2026-09', summarized: null, streak: -1, days: 2 },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT date, month, "readingSeconds" AS seconds, "goalSeconds" AS goal FROM reading_days ORDER BY date`,
      ),
    ),
    [
      { date: '2026-09-08', month: '2026-09', seconds: 1296, goal: 1800 },
      // Two devices' contributions add up.
      { date: '2026-09-14', month: '2026-09', seconds: 43007, goal: 1800 },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(`SELECT days, "reachedAt" FROM streak_records ORDER BY days`),
    ),
    [
      { days: 1, reachedAt: '2021-12-09T22:00:00.000Z' },
      { days: 7, reachedAt: '2023-02-06T21:00:00.000Z' },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT enabled, "dailyGoalSeconds" AS goal, "goalSetAt", "currentStreakDays" AS streak FROM reading_goal`,
      ),
    ),
    [
      {
        enabled: 1,
        goal: 1800,
        goalSetAt: '2022-03-05T08:02:05.000Z',
        streak: 0,
      },
    ],
  );
  // Download tokens and DRM parameters never reach the import.
  const purchase = rows(books.read('SELECT * FROM purchases'));
  assert.equal(purchase.length, 1);
  assert.equal(purchase[0]?.storeId, '1587320271');
  assert.doesNotMatch(JSON.stringify(purchase), /SECRET/);
  assert.deepEqual(
    rows(
      books.read(`SELECT id, "boldText", "lineHeight" AS height FROM themes`),
    ),
    [{ id: 'Quiet', boldText: 1, height: 1.4 }],
  );
});

test('Books stores each book on this Mac as one file, packing an EPUB directory into an .epub, and reports a missing one without a file', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const books = await appleImport(
    new AppleBooksSource(location),
    join(scratch.path, 'import'),
  );

  await books.load();
  const files = rows(
    books.read(
      `SELECT "assetId", format, "availableLocally", "fileCount" AS count, "attachmentRef" FROM book_files ORDER BY "assetId"`,
    ),
  );
  await books.load();
  const again = rows(
    books.read(`SELECT "attachmentRef" FROM book_files ORDER BY "assetId"`),
  );

  assert.deepEqual(
    files.map(({ attachmentRef, ...file }) => ({
      ...file,
      stored: attachmentRef !== null,
    })),
    [
      {
        assetId: 'A1',
        format: 'epub-package',
        availableLocally: 1,
        count: 4,
        stored: true,
      },
      {
        assetId: 'G3',
        format: 'epub-package',
        availableLocally: 0,
        count: null,
        stored: false,
      },
      {
        assetId: 'P2',
        format: 'file',
        availableLocally: 1,
        count: 1,
        stored: true,
      },
      // A zipped .epub is a single file, exported as it is.
      {
        assetId: 'Z4',
        format: 'file',
        availableLocally: 1,
        count: 1,
        stored: true,
      },
    ],
  );
  const [epub, , pdf, zipped] = files.map(({ attachmentRef }) => attachmentRef);
  assert.ok(typeof epub === 'string');
  assert.match(epub, /\.epub$/);
  const listing = (await run('/usr/bin/unzip', ['-Z1', epub])).stdout
    .trim()
    .split('\n');
  assert.deepEqual(listing, [
    'mimetype',
    'META-INF/container.xml',
    'OEBPS/chapter.xhtml',
    'OEBPS/content.opf',
  ]);
  await run('/usr/bin/unzip', ['-tq', epub]);
  // The mimetype is the first entry's stored bytes, right after its header.
  assert.equal(
    (await readFile(epub)).subarray(38, 58).toString(),
    'application/epub+zip',
  );
  assert.ok(typeof pdf === 'string');
  assert.equal(await readFile(pdf, 'utf8'), '%PDF-1.7\n%fixture\n');
  assert.ok(typeof zipped === 'string');
  assert.equal(await readFile(zipped, 'utf8'), 'PK zipped epub fixture');
  // The same package yields the same bytes, so a rerun keeps the same copy.
  assert.deepEqual(
    again,
    files.map(({ attachmentRef }) => ({ attachmentRef })),
  );
});

test('Books follows each store on its own: a rerun writes nothing, and edits, deletions and changed book files land', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const books = await appleImport(
    new AppleBooksSource(location),
    join(scratch.path, 'import'),
  );
  // What a load committed to the annotations, library and book files it copied.
  const written = (loaded: Awaited<ReturnType<typeof books.load>>) =>
    Object.fromEntries(
      loaded
        .filter(({ copy }) =>
          ['annotations', 'libraryAssets', 'bookFiles'].includes(
            copy.from.name,
          ),
        )
        .map(({ copy, count, deleted }) => [
          copy.from.name,
          { count, deleted },
        ]),
    );
  const first = written(await books.load());
  const epubBefore = books.read(
    `SELECT "attachmentRef" FROM book_files WHERE "assetId" = 'A1'`,
  )[0]?.attachmentRef;

  const unchanged = written(await books.load());
  {
    using store = new DatabaseSync(location.files.annotations);
    store.exec("DELETE FROM ZAEANNOTATION WHERE ZANNOTATIONUUID = 'U-2'");
    store.exec(
      "UPDATE ZAEANNOTATION SET ZANNOTATIONNOTE = 'Rhythm first' WHERE ZANNOTATIONUUID = 'H-1'",
    );
  }
  {
    using store = new DatabaseSync(location.files.readingHistory);
    store.prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?').run(
      readingHistoryDocument(
        [
          ...defaultHistory.months.slice(0, 1),
          {
            key: 202609,
            lastDayStreakOrdinal: -1,
            days: [{ day: 8, reading: [[0, 1400]], goal: 1800 }],
          },
        ],
        defaultHistory.streaks,
      ),
    );
  }
  await writeFile(
    join(location.documents, 'Design.epub/OEBPS/chapter.xhtml'),
    '<html>Grids, rhythm and type</html>',
  );
  const edited = written(await books.load());

  assert.deepEqual(first, {
    libraryAssets: { count: 4, deleted: 0 },
    bookFiles: { count: 4, deleted: 0 },
    annotations: { count: 4, deleted: 0 },
  });
  assert.deepEqual(unchanged, {
    libraryAssets: { count: 0, deleted: 0 },
    bookFiles: { count: 0, deleted: 0 },
    annotations: { count: 0, deleted: 0 },
  });
  assert.deepEqual(
    rows(books.read('SELECT id, note FROM annotations ORDER BY id')),
    [
      { id: 'D-4', note: null },
      { id: 'H-1', note: 'Rhythm first' },
      { id: 'R-3', note: null },
    ],
  );
  assert.deepEqual(
    rows(
      books.read(
        `SELECT date, "readingSeconds" AS seconds FROM reading_days ORDER BY date`,
      ),
    ),
    [{ date: '2026-09-08', seconds: 1400 }],
  );
  // Only the changed book file is written again; the library is untouched.
  assert.deepEqual(edited, {
    libraryAssets: { count: 0, deleted: 0 },
    bookFiles: { count: 1, deleted: 0 },
    annotations: { count: 1, deleted: 1 },
  });
  const epubAfter = books.read(
    `SELECT "attachmentRef" FROM book_files WHERE "assetId" = 'A1'`,
  )[0]?.attachmentRef;
  assert.notEqual(epubAfter, epubBefore);
  assert.match(
    (
      await run('/usr/bin/unzip', [
        '-p',
        String(epubAfter),
        'OEBPS/chapter.xhtml',
      ])
    ).stdout,
    /Grids, rhythm and type/,
  );
});

test('Books names Full Disk Access for an unreadable store, refuses an unknown layout or reading history format, and keeps the rows it had', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  const books = await appleImport(source, join(scratch.path, 'import'));
  await books.load();
  await rm(location.files.appPreferences);
  {
    using store = new DatabaseSync(location.files.assetData);
    store.exec('ALTER TABLE ZBCASSETDETAIL DROP COLUMN ZREADINGPROGRESS');
  }
  {
    using store = new DatabaseSync(location.files.readingHistory);
    store
      .prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?')
      .run(
        readingHistoryDocument(
          defaultHistory.months,
          defaultHistory.streaks,
          6,
        ),
      );
  }

  const failure = await books.load().then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof PipelineError);
  const failed = Object.fromEntries(
    failure.results
      .filter(({ failures }) => failures.length > 0)
      .map(({ copy, failures }) => [
        copy.configuration.stream.name,
        String(failures[0]?.error),
      ]),
  );
  // Each store fails only its own streams.
  assert.deepEqual(Object.keys(failed).sort(), [
    'assetDetails',
    'readingDays',
    'readingGoal',
    'readingMonths',
    'reviews',
    'streakRecords',
  ]);
  assert.match(
    failed.readingGoal ?? '',
    /com\.apple\.iBooksX\.plist cannot be read\. Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access/,
  );
  assert.match(
    failed.assetDetails ?? '',
    /missing ZBCASSETDETAIL\.ZREADINGPROGRESS/,
  );
  assert.match(
    failed.readingDays ?? '',
    /missing reading history format version 6/,
  );
  assert.deepEqual(
    rows(
      books.read(`SELECT (SELECT count(*) FROM asset_details) AS details,
        (SELECT count(*) FROM reading_days) AS days,
        (SELECT count(*) FROM reading_goal) AS goal,
        (SELECT count(*) FROM annotations) AS annotations`),
    ),
    [{ details: 2, days: 2, goal: 1, annotations: 4 }],
  );
  const messages = await Array.fromAsync(
    source.read(
      [
        new Copy(
          source.readingGoal,
          new SQLiteDestination({
            path: join(scratch.path, 'goal.sqlite'),
          }).table('goal'),
        ).configuration,
      ],
      new Map(),
    ),
  );
  const status = messages.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(status instanceof StreamStatus);
  assert.ok(status.error instanceof BooksUnavailableError);
  const history = await Array.fromAsync(
    source.read(
      [
        new Copy(
          source.readingMonths,
          new SQLiteDestination({
            path: join(scratch.path, 'months.sqlite'),
          }).table('months'),
        ).configuration,
      ],
      new Map(),
    ),
  );
  const historyStatus = history.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(historyStatus instanceof StreamStatus);
  assert.ok(historyStatus.error instanceof BooksSchemaError);
});

test('a Books watch wakes only the streams of the store that changed, while Books keeps its databases open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  const streams = [
    source.libraryAssets,
    source.annotations,
    source.assetDetails,
    source.readingGoal,
  ];
  // Books and bookdatastored hold their connections, and so their WALs, open.
  using annotations = new DatabaseSync(location.files.annotations);
  using assetData = new DatabaseSync(location.files.assetData);
  const controller = new AbortController();
  const woken: string[][] = [];

  for await (const batch of source.watch({
    streams,
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    woken.push(batch.map((stream) => stream.name));
    if (woken.length === 1)
      annotations.exec(
        "UPDATE ZAEANNOTATION SET ZANNOTATIONNOTE = 'Watched' WHERE ZANNOTATIONUUID = 'H-1'",
      );
    else if (woken.length === 2)
      await writePlist(location.files.appPreferences, {
        'ReadingGoals.StreakDay': { goal: 600 },
        'ReadingHistory.CurrentStreak': 1,
      });
    else if (woken.length === 3)
      assetData.exec(
        "UPDATE ZBCASSETDETAIL SET ZREADINGPROGRESS = 0.6 WHERE ZASSETID = 'A1'",
      );
    else controller.abort();
  }

  assert.deepEqual(woken, [
    ['libraryAssets', 'annotations', 'assetDetails', 'readingGoal'],
    ['annotations'],
    ['readingGoal'],
    ['assetDetails'],
  ]);
});

test('a malformed or missing Books store, column or value fails only the streams that read it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  // The failures one load has after running sql on one store of a fresh
  // fixture.
  const afterSql = (
    name: string,
    store: keyof BooksFixture['files'],
    sql: string,
  ) =>
    failedAfter(join(scratch.path, name), async ({ files }) => {
      using database = new DatabaseSync(files[store]);
      database.exec(sql);
    });
  const withoutKey = (
    name: string,
    store: keyof BooksFixture['files'],
    table: string,
  ) =>
    failedAfter(join(scratch.path, name), async ({ files }) =>
      withoutPrimaryKey(files[store], table),
    );
  const library = [
    'bookFiles',
    'collectionMembers',
    'collections',
    'libraryAssets',
  ];
  const reading = ['readingDays', 'readingMonths', 'streakRecords'];

  const viewMode = await afterSql(
    'view-mode',
    'library',
    'ALTER TABLE ZBKCOLLECTION DROP COLUMN ZVIEWMODE',
  );
  const note = await afterSql(
    'note',
    'annotations',
    'ALTER TABLE ZAEANNOTATION DROP COLUMN ZANNOTATIONNOTE',
  );
  const justify = await afterSql(
    'justify',
    'themes',
    'ALTER TABLE ZBOOKTHEME DROP COLUMN ZJUSTIFY',
  );
  const genre = await afterSql(
    'genre',
    'purchases',
    'ALTER TABLE ZBLJALISCOSERVERITEM DROP COLUMN ZGENRE',
  );
  const unkeyed = {
    collectionMembers: await withoutKey(
      'members',
      'library',
      'ZBKCOLLECTIONMEMBER',
    ),
    annotations: await withoutKey(
      'annotations',
      'annotations',
      'ZAEANNOTATION',
    ),
    assetDetails: await withoutKey('details', 'assetData', 'ZBCASSETDETAIL'),
    reviews: await withoutKey('reviews', 'assetData', 'ZBCASSETREVIEW'),
    purchases: await withoutKey(
      'purchases',
      'purchases',
      'ZBLJALISCOSERVERITEM',
    ),
    themes: await withoutKey('themes', 'themes', 'ZBOOKTHEME'),
  };
  // A column no stream maps, holding an integer JavaScript cannot represent.
  const generation = await afterSql(
    'generation',
    'library',
    "UPDATE ZBKLIBRARYASSET SET ZGENERATION = 9007199254740993 WHERE ZASSETID = 'A1'",
  );
  const blobId = await afterSql(
    'blob-id',
    'assetData',
    "UPDATE ZBCASSETDETAIL SET ZASSETID = x'454c5345' WHERE ZASSETID = 'ELSEWHERE'",
  );
  const noGroup = await failedAfter(
    join(scratch.path, 'no-group'),
    async ({ groupContainer }) => {
      await rm(groupContainer, { recursive: true });
    },
  );
  const emptyHistory = await afterSql(
    'empty-history',
    'readingHistory',
    "UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = x''",
  );
  const badMonth = await failedAfter(
    join(scratch.path, 'bad-month'),
    async ({ files }) => {
      using database = new DatabaseSync(files.readingHistory);
      database
        .prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?')
        .run(
          readingHistoryDocument(
            [{ key: 202613, lastDayStreakOrdinal: -1, days: [] }],
            [],
          ),
        );
    },
  );

  // A store missing a column a stream reads fails every stream of that store.
  assert.deepEqual(Object.keys(viewMode).sort(), library);
  for (const error of Object.values(viewMode)) {
    assert.match(error, /^BooksSchemaError: /);
    assert.match(error, /BKLibrary-1-091020131601\.sqlite /);
    assert.match(error, /missing ZBKCOLLECTION\.ZVIEWMODE/);
  }
  assert.deepEqual(Object.keys(note), ['annotations']);
  assert.match(note.annotations ?? '', /^BooksSchemaError: /);
  assert.match(
    note.annotations ?? '',
    /AEAnnotation_v10312011_1727_local\.sqlite /,
  );
  assert.match(
    note.annotations ?? '',
    /missing ZAEANNOTATION\.ZANNOTATIONNOTE/,
  );
  assert.deepEqual(Object.keys(justify), ['themes']);
  assert.match(justify.themes ?? '', /^BooksSchemaError: /);
  assert.match(justify.themes ?? '', /BookTheme\.sqlite /);
  assert.match(justify.themes ?? '', /missing ZBOOKTHEME\.ZJUSTIFY/);
  assert.deepEqual(Object.keys(genre), ['purchases']);
  assert.match(genre.purchases ?? '', /^BooksSchemaError: /);
  assert.match(
    genre.purchases ?? '',
    /BKJaliscoServerSource-v09182016\.sqlite /,
  );
  assert.match(genre.purchases ?? '', /missing ZBLJALISCOSERVERITEM\.ZGENRE/);
  // Z_PK only orders rows, so a table without it fails only its own stream,
  // when its query runs, and the store's other streams load.
  for (const [stream, failed] of Object.entries(unkeyed)) {
    assert.deepEqual(Object.keys(failed), [stream]);
    assert.match(failed[stream] ?? '', /no such column: (member\.)?Z_PK/);
  }
  assert.deepEqual(Object.keys(generation), ['libraryAssets']);
  assert.match(generation.libraryAssets ?? '', /9007199254740993/);
  assert.deepEqual(Object.keys(blobId), ['assetDetails']);
  assert.match(blobId.assetDetails ?? '', /invalid assetDetails\.assetId/);
  // Without the group container, everything bookdatastored keeps fails, and
  // each failure names its own file and the grant.
  assert.deepEqual(Object.keys(noGroup).sort(), [
    'assetDetails',
    'purchases',
    'readingDays',
    'readingGoal',
    'readingMonths',
    'reviews',
    'streakRecords',
  ]);
  for (const error of Object.values(noGroup)) {
    assert.match(error, /^BooksUnavailableError: /);
    assert.match(error, /Full Disk Access/);
  }
  assert.match(noGroup.assetDetails ?? '', /BCAssetData cannot be read/);
  assert.match(noGroup.reviews ?? '', /BCAssetData cannot be read/);
  for (const stream of reading)
    assert.match(
      noGroup[stream] ?? '',
      /CRDTModelSync-ReadingHistoryModel cannot be read/,
    );
  assert.match(
    noGroup.purchases ?? '',
    /BKJaliscoServerSource-v09182016\.sqlite cannot be read/,
  );
  assert.match(
    noGroup.readingGoal ?? '',
    /group\.com\.apple\.iBooks\.plist cannot be read/,
  );
  assert.deepEqual(Object.keys(emptyHistory).sort(), reading);
  for (const error of Object.values(emptyHistory)) {
    assert.match(error, /^BooksSchemaError: /);
    assert.match(error, /CRDTModelSync-ReadingHistoryModel /);
    assert.match(error, /missing reading history signature/);
  }
  assert.deepEqual(Object.keys(badMonth).sort(), reading);
  for (const error of Object.values(badMonth)) {
    assert.match(error, /^BooksSchemaError: /);
    assert.match(error, /CRDTModelSync-ReadingHistoryModel /);
    assert.match(error, /missing reading history month key 202613/);
  }
});

test('Books names the preference file it cannot read, and only readingGoal fails', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  // The app's preferences as an XML property list, which Books never writes.
  const xmlPreferences = (path: string) =>
    writeFile(
      path,
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml({
        'ReadingGoals.StreakDay': { goal: 1800 },
        'ReadingHistory.CurrentStreak': 0,
      })}</plist>`,
    );

  const sharedMissing = await failedAfter(
    join(scratch.path, 'shared-missing'),
    async ({ files }) => {
      await rm(files.sharedPreferences);
    },
  );
  const appXml = await failedAfter(
    join(scratch.path, 'app-xml'),
    async ({ files }) => {
      await xmlPreferences(files.appPreferences);
    },
  );
  const both = await failedAfter(
    join(scratch.path, 'both'),
    async ({ files }) => {
      await xmlPreferences(files.appPreferences);
      await rm(files.sharedPreferences);
    },
  );

  assert.deepEqual(Object.keys(sharedMissing), ['readingGoal']);
  assert.match(sharedMissing.readingGoal ?? '', /^BooksUnavailableError: /);
  assert.match(
    sharedMissing.readingGoal ?? '',
    /group\.com\.apple\.iBooks\.plist cannot be read\..*Full Disk Access/,
  );
  // The app's file is read first, so its layout fails the read even when the
  // shared file is gone.
  for (const failed of [appXml, both]) {
    assert.deepEqual(Object.keys(failed), ['readingGoal']);
    assert.match(failed.readingGoal ?? '', /^BooksSchemaError: /);
    assert.match(failed.readingGoal ?? '', /com\.apple\.iBooksX\.plist /);
    assert.match(failed.readingGoal ?? '', /binary property list/);
  }
});

test('a Books watch fails before its first batch when a watched database is missing, and wakes the streams of each store and preference file that changes', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const missing = await booksFixture(join(scratch.path, 'missing'));
  await rm(missing.files.themes);
  const withoutThemes = new AppleBooksSource(missing);
  const location = await booksFixture(join(scratch.path, 'watched'));
  const source = new AppleBooksSource(location);
  const streams = [
    source.libraryAssets,
    source.collections,
    source.collectionMembers,
    source.bookFiles,
    source.readingMonths,
    source.readingDays,
    source.streakRecords,
    source.purchases,
    source.themes,
    source.readingGoal,
  ];
  // Books and bookdatastored hold their connections, and so their WALs, open.
  using library = new DatabaseSync(location.files.library);
  using history = new DatabaseSync(location.files.readingHistory);
  using purchases = new DatabaseSync(location.files.purchases);
  using themes = new DatabaseSync(location.files.themes);
  const controller = new AbortController();
  const before: string[][] = [];
  const woken: string[][] = [];

  const failure = await (async () => {
    for await (const batch of withoutThemes.watch({
      streams: [withoutThemes.libraryAssets, withoutThemes.themes],
      signal: AbortSignal.timeout(10_000),
    }))
      before.push(batch.map((stream) => stream.name));
  })().then(
    () => null,
    (error: unknown) => error,
  );
  for await (const batch of source.watch({
    streams,
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
  })) {
    woken.push(batch.map((stream) => stream.name));
    if (woken.length === 1)
      await writePlist(location.files.sharedPreferences, {
        BKReadingGoalsUserDefaultsKey: false,
        streakDatUserDefaultsKey: {
          date: new Date('2026-09-20T08:00:00.000Z'),
          goal: 2400,
        },
      });
    else if (woken.length === 2) await rm(location.files.appPreferences);
    else if (woken.length === 3)
      await writePlist(location.files.appPreferences, {
        'ReadingGoals.StreakDay': { goal: 1800 },
        'ReadingHistory.CurrentStreak': 2,
      });
    else if (woken.length === 4)
      history
        .prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?')
        .run(readingHistoryDocument(defaultHistory.months.slice(0, 1), []));
    else if (woken.length === 5)
      library.exec(
        "UPDATE ZBKLIBRARYASSET SET ZTITLE = 'Watched' WHERE ZASSETID = 'A1'",
      );
    else if (woken.length === 6)
      purchases.exec("UPDATE ZBLJALISCOSERVERITEM SET ZTITLE = 'Watched'");
    else if (woken.length === 7)
      themes.exec('UPDATE ZBOOKTHEME SET ZLINEHEIGHT = 1.6');
    else controller.abort();
  }

  assert.deepEqual(before, []);
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, 'BooksUnavailableError');
  assert.match(failure.message, /BookTheme\.sqlite cannot be read/);
  assert.deepEqual(woken, [
    streams.map((stream) => stream.name),
    // The shared preference file is rewritten, then the app's goes and
    // comes back.
    ['readingGoal'],
    ['readingGoal'],
    ['readingGoal'],
    ['readingMonths', 'readingDays', 'streakRecords'],
    ['libraryAssets', 'collections', 'collectionMembers', 'bookFiles'],
    ['purchases'],
    ['themes'],
  ]);
});

test('Books reads no reading history when Books holds no live document, and loads the reading streams empty', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  // Each reading stream's records, read on its own.
  const readHistory = async () =>
    Object.fromEntries(
      await Promise.all(
        [source.readingMonths, source.readingDays, source.streakRecords].map(
          async (stream): Promise<[string, Record<string, unknown>[]]> => [
            stream.name,
            await readStream(source, stream),
          ],
        ),
      ),
    );
  // bookdatastored holds its connection open.
  using history = new DatabaseSync(location.files.readingHistory);

  const live = await readHistory();
  history.exec('UPDATE ZCRDTMODELSYNCENTITY SET ZDELETEDFLAG = 1');
  const deleted = await readHistory();
  history.exec(
    'UPDATE ZCRDTMODELSYNCENTITY SET ZDELETEDFLAG = 0, ZPROTODATA = NULL',
  );
  const noData = await readHistory();
  history.exec('DELETE FROM ZCRDTMODELSYNCENTITY');
  const noRow = await readHistory();

  const empty = { readingMonths: [], readingDays: [], streakRecords: [] };
  // The same document reads while it is live.
  assert.deepEqual(
    Object.values(live).map((records) => records.length),
    [2, 2, 2],
  );
  assert.deepEqual(deleted, empty);
  assert.deepEqual(noData, empty);
  assert.deepEqual(noRow, empty);
});

// Each stream's primary keys, joined by |, in the order Books yields them for
// booksFixture with the rows the order test adds: Z_PK order, which differs
// from key order, and reading history in its document's order.
const PRIMARY_KEY_ORDER: Readonly<Record<string, readonly string[]>> = {
  libraryAssets: ['A1', 'P2', 'G3', 'Z4'],
  collections: ['Finished_Collection_ID', '4F1E-WANT'],
  collectionMembers: [
    'Finished_Collection_ID|P2',
    '4F1E-WANT|LEFT',
    'Finished_Collection_ID|A1',
  ],
  bookFiles: ['A1', 'P2', 'G3', 'Z4'],
  annotations: ['H-1', 'U-2', 'R-3', 'D-4'],
  assetDetails: ['A1', 'ELSEWHERE', '0-ELSEWHERE'],
  reviews: ['REVIEW-9', 'REVIEW-1'],
  readingMonths: ['2026-09', '2022-08'],
  readingDays: ['2026-09-14', '2026-09-08'],
  streakRecords: ['7', '1'],
  readingGoal: ['current'],
  purchases: ['1587320271', '1000000001'],
  themes: ['Quiet', 'Calm'],
};

test('Books writes every stream with its fields in schema order and its rows in store order', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  {
    using library = new DatabaseSync(location.files.library);
    library.exec(
      "INSERT INTO ZBKCOLLECTIONMEMBER (Z_PK, Z_ENT, Z_OPT, ZCOLLECTION, ZASSET, ZASSETID, ZSORTKEY) VALUES (3, 3, 1, 1, 1, 'A1', 2)",
    );
  }
  {
    using assetData = new DatabaseSync(location.files.assetData);
    assetData.exec(`
      INSERT INTO ZBCASSETDETAIL (Z_PK, Z_ENT, Z_OPT, ZASSETID, ZDELETEDFLAG) VALUES (3, 2, 1, '0-ELSEWHERE', 0);
      INSERT INTO ZBCASSETREVIEW (Z_PK, Z_ENT, Z_OPT, ZASSETREVIEWID, ZDELETEDFLAG) VALUES (2, 3, 1, 'REVIEW-1', 0)`);
  }
  {
    using purchases = new DatabaseSync(location.files.purchases);
    purchases.exec(
      "INSERT INTO ZBLJALISCOSERVERITEM (Z_PK, Z_ENT, Z_OPT, ZSTOREID, ZTITLE) VALUES (2, 4, 1, '1000000001', 'Bought earlier')",
    );
  }
  {
    using themes = new DatabaseSync(location.files.themes);
    themes.exec(
      "INSERT INTO ZBOOKTHEME (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER) VALUES (2, 1, 1, 'Calm')",
    );
  }
  {
    // A document whose months, days and streaks are not in key order.
    using history = new DatabaseSync(location.files.readingHistory);
    history
      .prepare('UPDATE ZCRDTMODELSYNCENTITY SET ZPROTODATA = ?')
      .run(
        readingHistoryDocument(
          defaultHistory.months
            .map((month) => ({ ...month, days: month.days.toReversed() }))
            .toReversed(),
          defaultHistory.streaks.toReversed(),
        ),
      );
  }
  const source = new AppleBooksSource(location);
  const { streams } = await source.discover();

  const read = await Promise.all(
    streams.map(async (stream) => ({
      stream,
      records: await readStream(source, stream),
    })),
  );

  for (const { stream, records } of read)
    for (const record of records)
      assert.deepEqual(
        Object.keys(record),
        Object.keys(stream.jsonSchema.properties ?? {}),
        stream.name,
      );
  assert.deepEqual(
    Object.fromEntries(
      read.map(({ stream, records }) => [
        stream.name,
        records.map((record) =>
          stream.primaryKey.map((key) => record[key]).join('|'),
        ),
      ]),
    ),
    PRIMARY_KEY_ORDER,
  );
});

test('Books keeps each stored value as Books means it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const lastRead = at('2026-09-14T11:38:00.000Z');
  {
    using library = new DatabaseSync(location.files.library);
    // A supplement of P2 with empty text, an unverified content type, a
    // fractional rating, archived names, every flag value, and times at the
    // edges of what Core Data means by none.
    library
      .prepare(
        "INSERT INTO ZBKLIBRARYASSET (Z_PK, Z_ENT, Z_OPT, ZASSETID, ZTITLE, ZSTOREID, ZCONTENTTYPE, ZRATING, ZAUTHORNAMES, ZGENRES, ZISFINISHED, ZISSAMPLE, ZISHIDDEN, ZNOTFINISHED, ZISEXPLICIT, ZISLOCKED, ZISNEW, ZSUPPLEMENTALCONTENTPARENT, ZDATEFINISHED, ZLASTOPENDATE, ZLASTENGAGEDDATE, ZCREATIONDATE, ZMODIFICATIONDATE, ZPURCHASEDATE) VALUES (5, 5, 1, 'T5', '', '', 2, 2.5, x'0102', x'', NULL, 2, 1, NULL, 0, 1, 2, 2, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        distantPast,
        distantPast + 1,
        distantFuture,
        distantFuture - 1,
        // Each rounds differently when the parts are rounded or truncated
        // apart from the sum.
        lastRead + 0.0005,
        lastRead + 0.0055,
      );
    library.exec(
      "INSERT INTO ZBKCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZCOLLECTIONID, ZTITLE, ZDELETEDFLAG, ZHIDDEN, ZPLACEHOLDER) VALUES (3, 2, 1, 'DELETED-C', '', 1, NULL, 2)",
    );
  }
  {
    using themes = new DatabaseSync(location.files.themes);
    themes.exec(
      "INSERT INTO ZBOOKTHEME (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZHASCUSTOMLAYOUT, ZISFONTBOLDED, ZJUSTIFY, ZMULTIPLECOLUMNMODE, ZLETTERSPACING, ZLINEHEIGHT, ZMARGINADJUSTMENT, ZWORDSPACING) VALUES (2, 1, 1, 'Calm', 1, 0, 2, 1, 0.05, 2, -1, 0)",
    );
  }
  const source = new AppleBooksSource(location);

  const assets = await readStream(source, source.libraryAssets);
  const collections = await readStream(source, source.collections);
  const reviews = await readStream(source, source.reviews);
  const annotations = await readStream(source, source.annotations);
  const themes = await readStream(source, source.themes);

  assert.deepEqual(
    fieldsOf(assets, 'assetId', 'T5', [
      'title',
      'storeId',
      'contentType',
      'contentTypeCode',
      'rating',
      'authorNames',
      'genres',
      'narratorNames',
      'isFinished',
      'isSample',
      'isHidden',
      'notFinished',
      'isExplicit',
      'isLocked',
      'isNew',
      'supplementalContentParentAssetId',
      'seriesContainerAssetId',
      'finishedAt',
      'lastOpenedAt',
      'lastEngagedAt',
      'createdAt',
      'modifiedAt',
      'purchasedAt',
    ]),
    {
      title: null,
      storeId: null,
      contentType: null,
      contentTypeCode: 2,
      rating: null,
      authorNames: 'AQI=',
      genres: null,
      narratorNames: null,
      // Flags: NULL and 2 are false; Core Data booleans that may be unset
      // keep NULL.
      isFinished: false,
      isSample: false,
      isHidden: true,
      notFinished: null,
      isExplicit: false,
      isLocked: true,
      isNew: false,
      supplementalContentParentAssetId: 'P2',
      seriesContainerAssetId: null,
      // distantPast and distantFuture mean none; a second inside is a time.
      finishedAt: null,
      lastOpenedAt: '0000-12-30T00:00:01.000Z',
      lastEngagedAt: null,
      createdAt: '4000-12-31T23:59:59.000Z',
      modifiedAt: '2026-09-14T11:38:00.001Z',
      purchasedAt: '2026-09-14T11:38:00.005Z',
    },
  );
  assert.deepEqual(
    fieldsOf(assets, 'assetId', 'G3', [
      'isFinished',
      'seriesContainerAssetId',
      'supplementalContentParentAssetId',
    ]),
    {
      isFinished: false,
      seriesContainerAssetId: 'A1',
      supplementalContentParentAssetId: null,
    },
  );
  assert.deepEqual(
    fieldsOf(collections, 'collectionId', 'DELETED-C', [
      'title',
      'deleted',
      'hidden',
      'placeholder',
    ]),
    { title: null, deleted: true, hidden: false, placeholder: false },
  );
  assert.deepEqual(reviews, [
    {
      id: 'REVIEW-9',
      deleted: false,
      starRating: 4,
      title: 'Worth it',
      body: 'Clear and practical.',
      userId: '1234567',
      modifiedAt: '2025-01-02T03:04:05.000Z',
    },
  ]);
  assert.deepEqual(
    ['D-4', 'H-1', 'R-3'].map((id) =>
      fieldsOf(annotations, 'id', id, ['assetId', 'kind', 'kindCode']),
    ),
    [
      // A deletion marker's empty book is none, and its kind has no name.
      { assetId: null, kind: null, kindCode: 0 },
      { assetId: 'A1', kind: 'highlight', kindCode: 2 },
      { assetId: 'A1', kind: 'readingPosition', kindCode: 3 },
    ],
  );
  assert.deepEqual(themes, [
    {
      id: 'Quiet',
      hasCustomLayout: null,
      boldText: true,
      justify: false,
      multipleColumns: null,
      letterSpacing: null,
      lineHeight: 1.4,
      marginAdjustment: null,
      wordSpacing: null,
    },
    {
      id: 'Calm',
      hasCustomLayout: true,
      boldText: false,
      justify: false,
      multipleColumns: true,
      letterSpacing: 0.05,
      lineHeight: 2,
      marginAdjustment: -1,
      wordSpacing: 0,
    },
  ]);
});

test('Books takes the reading goal from whichever preference file holds it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  const location = await booksFixture(scratch.path);
  const source = new AppleBooksSource(location);
  const sharedDate = new Date('2022-03-05T08:02:05.000Z');
  const appDate = new Date('2024-06-01T09:00:00.000Z');
  // The goal one read yields after Books writes both preference files.
  const goalWith = async (app: unknown, shared: unknown) => {
    await writePlist(location.files.appPreferences, app);
    await writePlist(location.files.sharedPreferences, shared);
    return readStream(source, source.readingGoal);
  };

  const both = await goalWith(
    {
      'ReadingGoals.StreakDay': { goal: 900, date: appDate },
      'ReadingHistory.CurrentStreak': 3,
    },
    {
      BKReadingGoalsUserDefaultsKey: true,
      streakDatUserDefaultsKey: { goal: 1800, date: sharedDate },
    },
  );
  const sharedOnly = await goalWith(
    { 'ReadingGoals.StreakDay': { date: appDate } },
    {
      BKReadingGoalsUserDefaultsKey: 1,
      streakDatUserDefaultsKey: {
        goal: 1800,
        date: fromAppleSeconds(distantPast),
      },
    },
  );
  const zero = await goalWith(
    { 'ReadingGoals.StreakDay': { goal: 0, date: appDate } },
    {
      streakDatUserDefaultsKey: {
        goal: 1800,
        date: fromAppleSeconds(distantFuture),
      },
    },
  );
  const appArray = await goalWith(
    [{ 'ReadingGoals.StreakDay': { goal: 900, date: appDate } }],
    {
      BKReadingGoalsUserDefaultsKey: false,
      streakDatUserDefaultsKey: { goal: 1800, date: sharedDate },
    },
  );

  // The app's goal and streak win; the shared file's date does.
  assert.deepEqual(both, [
    {
      id: 'current',
      enabled: true,
      dailyGoalSeconds: 900,
      goalSetAt: '2022-03-05T08:02:05.000Z',
      currentStreakDays: 3,
    },
  ]);
  // Without an app goal the shared one counts, and a shared date at
  // distantPast falls back to the app's; enabled is a boolean or nothing.
  assert.deepEqual(sharedOnly, [
    {
      id: 'current',
      enabled: null,
      dailyGoalSeconds: 1800,
      goalSetAt: '2024-06-01T09:00:00.000Z',
      currentStreakDays: null,
    },
  ]);
  // A goal of 0 is a goal; a shared date in year 4001 is none.
  assert.deepEqual(zero, [
    {
      id: 'current',
      enabled: null,
      dailyGoalSeconds: 0,
      goalSetAt: '2024-06-01T09:00:00.000Z',
      currentStreakDays: null,
    },
  ]);
  // An app file whose root is not a dictionary holds no values.
  assert.deepEqual(appArray, [
    {
      id: 'current',
      enabled: false,
      dailyGoalSeconds: 1800,
      goalSetAt: '2022-03-05T08:02:05.000Z',
      currentStreakDays: null,
    },
  ]);
});

test('Books classifies each book file by what is on disk', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-'));
  // A book Books added from a file at path.
  const addBook = (
    location: BooksFixture,
    key: number,
    assetId: string,
    path: string,
  ) => {
    using library = new DatabaseSync(location.files.library);
    library
      .prepare(
        "INSERT INTO ZBKLIBRARYASSET (Z_PK, Z_ENT, Z_OPT, ZASSETID, ZTITLE, ZCONTENTTYPE, ZPATH, ZISFINISHED, ZISHIDDEN, ZISSAMPLE, ZDATASOURCEIDENTIFIER) VALUES (?, 5, 1, ?, ?, 1, ?, 0, 0, 0, 'com.apple.ibooks.datasource.ubiquity')",
      )
      .run(key, assetId, assetId, path);
  };
  const addEmptyPackage = async (location: BooksFixture) => {
    const folder = join(location.documents, 'Empty.epub');
    await mkdir(folder);
    addBook(location, 5, 'E5', folder);
  };
  const location = await booksFixture(join(scratch.path, 'books'));
  addBook(location, 5, 'X5', join(location.documents, 'X.PDF'));
  addBook(location, 6, 'Y6', join(location.documents, 'Y.EPUB'));
  const folder = join(location.documents, 'Folder');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'not a book');
  addBook(location, 7, 'F7', folder);
  // Modification times with a fraction of a millisecond, as APFS keeps them.
  const epub = join(location.documents, 'Design.epub');
  for (const file of [
    'mimetype',
    'META-INF/container.xml',
    'OEBPS/content.opf',
  ])
    await utimes(join(epub, file), 1_788_000_000, 1_788_000_000);
  await utimes(
    join(epub, 'OEBPS/chapter.xhtml'),
    1_789_000_100.456_789,
    1_789_000_100.456_789,
  );
  await utimes(
    join(location.documents, 'Notes.pdf'),
    1_789_000_000.123_789,
    1_789_000_000.123_789,
  );
  await utimes(
    join(location.documents, 'Packed.epub'),
    1_788_500_000,
    1_788_500_000,
  );
  const books = await appleImport(
    new AppleBooksSource(location),
    join(scratch.path, 'import'),
  );
  const emptyLocation = await booksFixture(join(scratch.path, 'empty-listed'));
  await addEmptyPackage(emptyLocation);
  const emptySource = new AppleBooksSource(emptyLocation);
  const locked: string[] = [];

  await books.load();
  const listed = await readStream(emptySource, emptySource.bookFiles);
  const empty = await failedAfter(join(scratch.path, 'empty'), addEmptyPackage);

  assert.deepEqual(
    rows(
      books.read(
        `SELECT "assetId", format, "availableLocally" AS local, "fileCount" AS count, "sizeBytes" AS size, "modifiedAt", "attachmentRef" IS NOT NULL AS stored FROM book_files ORDER BY "assetId"`,
      ),
    ),
    [
      // The latest file of the package, its fraction of a millisecond cut.
      {
        assetId: 'A1',
        format: 'epub-package',
        local: 1,
        count: 4,
        size: 280,
        modifiedAt: '2026-09-10T00:28:20.456Z',
        stored: 1,
      },
      // A directory that is no EPUB package is never exported.
      {
        assetId: 'F7',
        format: 'epub-package',
        local: 0,
        count: null,
        size: null,
        modifiedAt: null,
        stored: 0,
      },
      {
        assetId: 'G3',
        format: 'epub-package',
        local: 0,
        count: null,
        size: null,
        modifiedAt: null,
        stored: 0,
      },
      {
        assetId: 'P2',
        format: 'file',
        local: 1,
        count: 1,
        size: 18,
        modifiedAt: '2026-09-10T00:26:40.123Z',
        stored: 1,
      },
      // A missing path's format comes from its extension, in any case.
      {
        assetId: 'X5',
        format: 'file',
        local: 0,
        count: null,
        size: null,
        modifiedAt: null,
        stored: 0,
      },
      {
        assetId: 'Y6',
        format: 'epub-package',
        local: 0,
        count: null,
        size: null,
        modifiedAt: null,
        stored: 0,
      },
      {
        assetId: 'Z4',
        format: 'file',
        local: 1,
        count: 1,
        size: 22,
        modifiedAt: '2026-09-04T05:33:20.000Z',
        stored: 1,
      },
    ],
  );
  // An empty package is on this Mac, but writing it as an .epub fails, and
  // fails only bookFiles.
  assert.deepEqual(
    fieldsOf(listed, 'assetId', 'E5', [
      'format',
      'availableLocally',
      'fileCount',
      'sizeBytes',
      'modifiedAt',
    ]),
    {
      format: 'epub-package',
      availableLocally: true,
      fileCount: 0,
      sizeBytes: 0,
      modifiedAt: null,
    },
  );
  assert.deepEqual(Object.keys(empty), ['bookFiles']);
  assert.match(empty.bookFiles ?? '', /no mimetype/);
  try {
    const unlistable = await failedAfter(
      join(scratch.path, 'unlistable'),
      async (fixture) => {
        const denied = join(fixture.documents, 'Locked.epub');
        await mkdir(denied);
        await writeFile(join(denied, 'mimetype'), 'application/epub+zip');
        addBook(fixture, 5, 'L5', denied);
        await chmod(denied, 0o000);
        locked.push(denied);
      },
    );

    // A package it cannot list is not a missing one: bookFiles fails, and
    // only it.
    assert.deepEqual(Object.keys(unlistable), ['bookFiles']);
    assert.match(unlistable.bookFiles ?? '', /EACCES/);
    assert.match(unlistable.bookFiles ?? '', /Locked\.epub/);
  } finally {
    await Promise.all(locked.map((path) => chmod(path, 0o755)));
  }
});

test('Books reads this Mac’s stores into SQLite without opening iCloud placeholders', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Books requires macOS');
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'books-live-'));
  const source = new AppleBooksSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'books.sqlite'),
  });
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'live',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              destination.table(
                stream.name,
                stream.supportsFileTransfer
                  ? (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns
                        .text('attachmentRef')
                        .from(stream.file.store(files)),
                    ]
                  : undefined,
              ),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });

  const outcome = await pipeline.run().then(
    (results) => results,
    (error: unknown) => error,
  );
  if (
    outcome instanceof PipelineError &&
    JSON.stringify(outcome, Object.getOwnPropertyNames(outcome)).includes(
      BooksUnavailableError.name,
    )
  )
    return t.skip(`no access to ${booksContainer} or ${booksGroupContainer}`);
  assert.ok(Array.isArray(outcome), String(outcome));

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const count = (sql: string) => Number(database.prepare(sql).get()?.n);
  // Every stored book has its bytes on this Mac; a placeholder has none.
  assert.equal(
    count(
      'SELECT count(*) AS n FROM bookFiles WHERE availableLocally <> (attachmentRef IS NOT NULL)',
    ),
    0,
  );
  assert.equal(
    count('SELECT count(*) AS n FROM bookFiles'),
    count('SELECT count(*) AS n FROM libraryAssets WHERE path IS NOT NULL'),
  );
});
