import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BooksLocation } from '../sources/apple-books/books-scan.ts';
import { appleSeconds, writePlist } from './safari-stores.ts';

// Books' own CREATE TABLE statements, as its stores declare them (Books 8 on
// macOS 27); fixtures insert synthetic rows only.
export const librarySchema = `
CREATE TABLE ZBKLIBRARYASSET ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZAUTHORCOUNT INTEGER, ZCANREDOWNLOAD INTEGER, ZCOMBINEDSTATE INTEGER, ZCOMPUTEDRATING INTEGER, ZCONTENTTYPE INTEGER, ZDESKTOPSUPPORTLEVEL INTEGER, ZDIDRUNFORYOUENDOFBOOKEXPERIENCE INTEGER, ZDIDWARNABOUTDESKTOPSUPPORT INTEGER, ZFILESIZE INTEGER, ZFINISHEDDATEKIND INTEGER, ZGENERATION INTEGER, ZHASRACSUPPORT INTEGER, ZHASTOOMANYAUTHORS INTEGER, ZHASTOOMANYNARRATORS INTEGER, ZISDEVELOPMENT INTEGER, ZISDOWNLOADINGSUPPLEMENTALCONTENT INTEGER, ZISEPHEMERAL INTEGER, ZISEXPLICIT INTEGER, ZISFINISHED INTEGER, ZISHIDDEN INTEGER, ZISLOCKED INTEGER, ZISNEW INTEGER, ZISPROOF INTEGER, ZISSAMPLE INTEGER, ZISSTOREAUDIOBOOK INTEGER, ZISSUPPLEMENTALCONTENT INTEGER, ZISTRACKEDASRECENT INTEGER, ZMAPPEDASSETCONTENTTYPE INTEGER, ZMETADATAMIGRATIONVERSION INTEGER, ZNARRATORCOUNT INTEGER, ZNOTFINISHED INTEGER, ZPAGECOUNT INTEGER, ZRATING INTEGER, ZSERIESFILTERMODE INTEGER, ZSERIESISCLOUDONLY INTEGER, ZSERIESISHIDDEN INTEGER, ZSERIESISORDERED INTEGER, ZSERIESNEXTFLAG INTEGER, ZSERIESSORTKEY INTEGER, ZSERIESSORTMODE INTEGER, ZSORTKEY INTEGER, ZSTATE INTEGER, ZTASTE INTEGER, ZTASTESYNCEDTOSTORE INTEGER, ZLOCALONLYSERIESITEMSPARENT INTEGER, ZPURCHASEDANDLOCALPARENT INTEGER, ZSERIESCONTAINER INTEGER, ZSUPPLEMENTALCONTENTPARENT INTEGER, ZASSETDETAILSMODIFICATIONDATE TIMESTAMP, ZBOOKHIGHWATERMARKPROGRESS FLOAT, ZBOOKMARKSSERVERMAXMODIFICATIONDATE TIMESTAMP, ZCOVERASPECTRATIO FLOAT, ZCREATIONDATE TIMESTAMP, ZDATEFINISHED TIMESTAMP, ZDURATION FLOAT, ZEXPECTEDDATE TIMESTAMP, ZFILEONDISKLASTTOUCHDATE TIMESTAMP, ZLASTENGAGEDDATE TIMESTAMP, ZLASTOPENDATE TIMESTAMP, ZLOCATIONSERVERMAXMODIFICATIONDATE TIMESTAMP, ZMODIFICATIONDATE TIMESTAMP, ZPURCHASEDATE TIMESTAMP, ZREADINGPROGRESS FLOAT, ZRELEASEDATE TIMESTAMP, ZUPDATEDATE TIMESTAMP, ZVERSIONNUMBER FLOAT, ZSEQUENCENUMBER DECIMAL, ZACCOUNTID VARCHAR, ZASSETGUID VARCHAR, ZASSETID VARCHAR, ZAUTHOR VARCHAR, ZBOOKDESCRIPTION VARCHAR, ZBOOKMARKSSERVERVERSION VARCHAR, ZCOMMENTS VARCHAR, ZCOVERURL VARCHAR, ZCOVERWRITINGMODE VARCHAR, ZDATASOURCEIDENTIFIER VARCHAR, ZDOWNLOADEDDSID VARCHAR, ZEPUBID VARCHAR, ZFAMILYID VARCHAR, ZGENRE VARCHAR, ZGROUPING VARCHAR, ZKIND VARCHAR, ZLANGUAGE VARCHAR, ZLOCATIONSERVERVERSION VARCHAR, ZMAPPEDASSETID VARCHAR, ZPAGEPROGRESSIONDIRECTION VARCHAR, ZPATH VARCHAR, ZPERMLINK VARCHAR, ZPURCHASEDDSID VARCHAR, ZSEQUENCEDISPLAYNAME VARCHAR, ZSERIESID VARCHAR, ZSERIESSTACKIDS VARCHAR, ZSORTAUTHOR VARCHAR, ZSORTTITLE VARCHAR, ZSTOREID VARCHAR, ZSTOREPLAYLISTID VARCHAR, ZTEMPORARYASSETID VARCHAR, ZTITLE VARCHAR, ZVERSIONNUMBERHUMANREADABLE VARCHAR, ZYEAR VARCHAR, ZURL VARCHAR, ZAUTHORNAMES BLOB, ZGENRES BLOB, ZNARRATORNAMES BLOB );
CREATE TABLE ZBKCOLLECTION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZHIDDEN INTEGER, ZPLACEHOLDER INTEGER, ZSORTKEY INTEGER, ZSORTMODE INTEGER, ZVIEWMODE INTEGER, ZLASTMODIFICATION TIMESTAMP, ZLOCALMODDATE TIMESTAMP, ZCOLLECTIONID VARCHAR, ZDETAILS VARCHAR, ZTITLE VARCHAR );
CREATE TABLE ZBKCOLLECTIONMEMBER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORTKEY INTEGER, ZASSET INTEGER, ZCOLLECTION INTEGER, ZLOCALMODDATE TIMESTAMP, ZASSETID VARCHAR, ZTEMPORARYASSETID VARCHAR );
`;

export const annotationsSchema = `
CREATE TABLE ZAEANNOTATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANNOTATIONDELETED INTEGER, ZANNOTATIONISUNDERLINE INTEGER, ZANNOTATIONSTYLE INTEGER, ZANNOTATIONTYPE INTEGER, ZPLABSOLUTEPHYSICALLOCATION INTEGER, ZPLLOCATIONRANGEEND INTEGER, ZPLLOCATIONRANGESTART INTEGER, ZANNOTATIONCREATIONDATE TIMESTAMP, ZANNOTATIONMODIFICATIONDATE TIMESTAMP, ZANNOTATIONASSETID VARCHAR, ZANNOTATIONCREATORIDENTIFIER VARCHAR, ZANNOTATIONLOCATION VARCHAR, ZANNOTATIONNOTE VARCHAR, ZANNOTATIONREPRESENTATIVETEXT VARCHAR, ZANNOTATIONSELECTEDTEXT VARCHAR, ZANNOTATIONUUID VARCHAR, ZFUTUREPROOFING1 VARCHAR, ZFUTUREPROOFING10 VARCHAR, ZFUTUREPROOFING11 VARCHAR, ZFUTUREPROOFING12 VARCHAR, ZFUTUREPROOFING2 VARCHAR, ZFUTUREPROOFING3 VARCHAR, ZFUTUREPROOFING4 VARCHAR, ZFUTUREPROOFING5 VARCHAR, ZFUTUREPROOFING6 VARCHAR, ZFUTUREPROOFING7 VARCHAR, ZFUTUREPROOFING8 VARCHAR, ZFUTUREPROOFING9 VARCHAR, ZPLSTORAGEUUID VARCHAR, ZPLUSERDATA BLOB );
`;

export const assetDataSchema = `
CREATE TABLE ZBCASSETDETAIL ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZFINISHEDDATEKIND INTEGER, ZISFINISHED INTEGER, ZISTRACKEDASRECENT INTEGER, ZNOTFINISHED INTEGER, ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION INTEGER, ZREADINGPOSITIONLOCATIONRANGEEND INTEGER, ZREADINGPOSITIONLOCATIONRANGESTART INTEGER, ZSTARRATING INTEGER, ZSYNCGENERATION INTEGER, ZTASTE INTEGER, ZTASTESYNCEDTOSTORE INTEGER, ZBOOKMARKTIME FLOAT, ZDATEFINISHED TIMESTAMP, ZDATEPLAYBACKTIMEUPDATED TIMESTAMP, ZLASTENGAGEDDATE TIMESTAMP, ZLASTOPENDATE TIMESTAMP, ZMODIFICATIONDATE TIMESTAMP, ZREADINGPOSITIONLOCATIONUPDATEDATE TIMESTAMP, ZREADINGPROGRESS FLOAT, ZREADINGPROGRESSHIGHWATERMARK FLOAT, ZASSETID VARCHAR, ZREADINGPOSITIONANNOTATIONVERSION VARCHAR, ZREADINGPOSITIONASSETVERSION VARCHAR, ZREADINGPOSITIONCFISTRING VARCHAR, ZREADINGPOSITIONSTORAGEUUID VARCHAR, ZSALTEDHASHEDID VARCHAR, ZCKSYSTEMFIELDS BLOB, ZREADINGPOSITIONUSERDATA BLOB );
CREATE TABLE ZBCASSETREVIEW ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZSTARRATING INTEGER, ZSYNCGENERATION INTEGER, ZMODIFICATIONDATE TIMESTAMP, ZASSETREVIEWID VARCHAR, ZREVIEWBODY VARCHAR, ZREVIEWTITLE VARCHAR, ZSALTEDHASHEDID VARCHAR, ZUSERID VARCHAR, ZCKSYSTEMFIELDS BLOB );
`;

export const readingHistorySchema = `
CREATE TABLE ZCRDTMODELSYNCENTITY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDELETEDFLAG INTEGER, ZEDITGENERATION INTEGER, ZSYNCGENERATION INTEGER, ZMODIFICATIONDATE TIMESTAMP, ZSALTEDHASHEDID VARCHAR, ZTYPE VARCHAR, ZCKSYSTEMFIELDS BLOB, ZPROTODATA BLOB );
`;

export const purchasesSchema = `
CREATE TABLE ZBLJALISCOSERVERITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTAINSAUDIO INTEGER, ZISAUDIOBOOK INTEGER, ZISDISABLED INTEGER, ZISEXPLICIT INTEGER, ZISHIDDEN INTEGER, ZISPICTUREBOOK INTEGER, ZISREADALOUD INTEGER, ZNEEDSIMPORT INTEGER, ZPURCHASEHISTORYID INTEGER, ZSTOREACCOUNTID INTEGER, ZDATABASE INTEGER, ZEXPECTEDDATE TIMESTAMP, ZPURCHASEDAT TIMESTAMP, ZARTIST VARCHAR, ZARTWORKTOKENCODE VARCHAR, ZARTWORKURLSTRING VARCHAR, ZCHAPTERMETADATAURLSTRING VARCHAR, ZCLOUDID VARCHAR, ZDISPLAYVERSION VARCHAR, ZFILEEXTENSION VARCHAR, ZGENRE VARCHAR, ZHLSPLAYLISTURLSTRING VARCHAR, ZPURCHASEDTOKENCODE VARCHAR, ZSORTEDAUTHOR VARCHAR, ZSORTEDTITLE VARCHAR, ZSTOREDOWNLOADPARAMETERS VARCHAR, ZSTOREID VARCHAR, ZTITLE VARCHAR, ZADDITIONALAUDIOBOOKINFO BLOB );
`;

export const themesSchema = `
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

export type HistoryMonth = {
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
export function readingHistoryDocument(
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
          ] as [number, Uint8Array],
      );
      const fields: Record<string, Uint8Array> = {
        days: dictionary(dayEntries),
        lastDayStreakOrdinal: register(int(lastDayStreakOrdinal)),
      };
      if (totalTime !== undefined) fields.totalTime = register(int(totalTime));
      return [key, reference(object(struct(fields)))] as [number, Uint8Array];
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

export const defaultHistory = {
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

export type BooksFixture = BooksLocation & {
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
// annotations, collections, synced reading state, reading history, a store
// purchase, a custom theme, and the reading goal preferences.
export async function booksFixture(root: string): Promise<BooksFixture> {
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
