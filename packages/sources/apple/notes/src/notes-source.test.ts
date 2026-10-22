import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  Connection,
  Copy,
  Pipeline,
  type ReadMessage,
  type Source,
  type Stream,
  StreamStatus,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';

import { AppleNotesSource } from './apple-notes-source.ts';

// A sync history installed in each destination's file, as a host installs it
// before the first pass.
async function installedHistory(...destinations: SQLiteDestination[]) {
  const history = new SQLiteSyncHistory();
  await history.install(destinations);
  return history;
}

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

const execFile = promisify(execFileCallback);

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
  { text: '\nwho ' },
  {
    text: '\ufffc',
    attachment: {
      id: 'INLINE-BLANK',
      type: 'com.apple.notes.inlinetextattachment.mention',
    },
  },
  { text: '\n' },
];

// A store with a formatted note (checklist, link, file, table, tag), a
// locked note, a note in Recently Deleted, a cloud placeholder and a row
// Notes marked for deletion. The file attachment's bytes sit where Notes
// keeps media; the photo's do not, as when iCloud has not downloaded it.
// Also cases a live store rarely holds: a second account with its own
// folder, a scan gallery whose page belongs to the gallery rather than the
// note, a photo with a blank user title and two locations, and a mention
// whose text is blank.
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
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME, ZACCOUNTTYPE) VALUES (1, 14, 'ACCOUNT-1', 'iCloud', 1), (18, 14, 'ACCOUNT-2', 'On My Mac', 3);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZFOLDERTYPE, ZPARENT) VALUES
      (2, 15, 'FOLDER-NOTES', 'Notes', 1, 0, NULL),
      (3, 15, 'FOLDER-TRASH', 'Recently Deleted', 1, 1, NULL),
      (4, 15, 'FOLDER-CHILD', 'Child', 1, 0, 2),
      (19, 15, 'FOLDER-LOCAL', 'Local', 18, 0, NULL);
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
      (16, 5, 'ATT-PURGED', 5, 1, NULL, 'public.jpeg', 10, ${created}, ${modified}, NULL, 1),
      (20, 5, 'ATT-GALLERY', 5, 1, NULL, 'com.apple.notes.gallery', 0, ${created}, ${modified}, NULL, 0),
      (21, 5, 'ATT-PAGE', NULL, 1, NULL, 'com.apple.paper.doc.scan', 0, ${created}, ${modified}, NULL, 0);
    UPDATE ZICCLOUDSYNCINGOBJECT SET ZPARENTATTACHMENT = 20 WHERE Z_PK = 21;
    UPDATE ZICCLOUDSYNCINGOBJECT SET ZUSERTITLE = '', ZTITLE = 'Photo' WHERE Z_PK = 12;
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1, ZACCOUNT6, ZATTACHMENT1) VALUES
      (10, 11, 'MEDIA-FILE', 'list.txt', '1_GEN', 1, 9),
      (13, 11, 'MEDIA-PHOTO', 'photo.jpg', '1_GEN', 1, 12);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNOTE1, ZTYPEUTI1, ZALTTEXT, ZTOKENCONTENTIDENTIFIER, ZCREATIONDATE2) VALUES
      (15, 9, 'INLINE-TAG', 5, 'com.apple.notes.inlinetextattachment.hashtag', '#food', 'FOOD', ${created}),
      (17, 9, 'INLINE-LINK', 5, 'com.apple.notes.inlinetextattachment.link', 'Old', 'applenotes:note/note-trashed', ${created}),
      (22, 9, 'INLINE-BLANK', 5, 'com.apple.notes.inlinetextattachment.mention', ' ', NULL, ${created});
    INSERT INTO ZICLOCATION (ZATTACHMENT, ZLATITUDE, ZLONGITUDE) VALUES (12, 52.52, 13.405), (12, 48.8566, 2.3522);
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

const notesPipeline = async (source: AppleNotesSource, directory: string) => {
  const destination = new SQLiteDestination({
    path: join(directory, 'notes.sqlite'),
  });
  const history = await installedHistory(destination);
  return {
    destination,
    pipeline: new Pipeline({
      history,
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
  const { pipeline, destination } = await notesPipeline(source, scratch.path);
  await pipeline.run();
  assert.deepEqual(noteRows(destination.path, 'SELECT id FROM accounts'), [
    { id: 'ACCOUNT-1' },
  ]);
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

test('a Notes folder scope keeps only the accounts that own a selected folder', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-scope-'));
  const source = new AppleNotesSource({
    path: await noteStoreFixture(scratch.path),
    scope: { collectionIds: ['FOLDER-LOCAL'] },
  });
  const { pipeline, destination } = await notesPipeline(source, scratch.path);

  await pipeline.run();

  assert.deepEqual(noteRows(destination.path, 'SELECT id FROM accounts'), [
    { id: 'ACCOUNT-2' },
  ]);
  assert.deepEqual(noteRows(destination.path, 'SELECT id FROM folders'), [
    { id: 'FOLDER-LOCAL' },
  ]);
});

test('Notes exports every stream from its store, skipping cloud placeholders and locked content', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-notes-'));
  const source = new AppleNotesSource({
    path: await noteStoreFixture(scratch.path),
  });
  const { destination, pipeline } = await notesPipeline(source, scratch.path);

  for (const stream of (await source.discover()).streams) {
    assert.ok(
      typeof stream.jsonSchema.description === 'string' &&
        stream.jsonSchema.description.length > 0,
      stream.name,
    );
    const { properties } = stream.jsonSchema;
    assert.ok(properties, stream.name);
    for (const [name, field] of Object.entries(properties)) {
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
      ['accounts', 2],
      ['folders', 4],
      ['notes', 3],
      ['inlineAttachments', 3],
      ['attachments', 6],
    ],
  );
  assert.deepEqual(rows('SELECT id, name, type FROM accounts'), [
    { id: 'ACCOUNT-1', name: 'iCloud', type: 1 },
    { id: 'ACCOUNT-2', name: 'On My Mac', type: 3 },
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
        id: 'FOLDER-LOCAL',
        accountId: 'ACCOUNT-2',
        parentId: null,
        name: 'Local',
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
        // A blank mention adds nothing to the text but keeps its stored
        // space in Markdown.
        text: 'Groceries\nMilk\nEggs\nBuy fresh\nsee site\n\n\ntag #food\nlink Old\nwho ',
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
          'who  ',
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
        id: 'INLINE-BLANK',
        noteId: 'NOTE-RICH',
        type: 'com.apple.notes.inlinetextattachment.mention',
        text: null,
        target: null,
      },
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
      'SELECT id, noteId, parentId, type, title, filename, ocrText, latitude, longitude, availableLocally, CAST(bytes AS TEXT) AS content FROM attachments ORDER BY id',
    ).map(({ content, ...row }) => ({ ...row, hasBytes: content !== null })),
    [
      {
        id: 'ATT-FILE',
        noteId: 'NOTE-RICH',
        parentId: null,
        type: 'public.plain-text',
        title: null,
        filename: 'list.txt',
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 1,
        hasBytes: true,
      },
      {
        id: 'ATT-GALLERY',
        noteId: 'NOTE-RICH',
        parentId: null,
        type: 'com.apple.notes.gallery',
        title: null,
        filename: null,
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 0,
        hasBytes: false,
      },
      {
        id: 'ATT-LOCKED',
        noteId: 'NOTE-LOCKED',
        parentId: null,
        type: 'public.jpeg',
        title: null,
        filename: null,
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 0,
        hasBytes: false,
      },
      {
        // A scan page belongs to its gallery, and through it to the note.
        id: 'ATT-PAGE',
        noteId: 'NOTE-RICH',
        parentId: 'ATT-GALLERY',
        type: 'com.apple.paper.doc.scan',
        title: null,
        filename: null,
        ocrText: null,
        latitude: null,
        longitude: null,
        availableLocally: 0,
        hasBytes: false,
      },
      {
        // One record despite two locations; a blank user title hides the
        // stored one.
        id: 'ATT-PHOTO',
        noteId: 'NOTE-RICH',
        parentId: null,
        type: 'public.jpeg',
        title: null,
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
        parentId: null,
        type: 'com.apple.notes.table',
        title: null,
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
  const { pipeline } = await notesPipeline(source, scratch.path);
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
    assert.equal(missing.failureType(error), 'config');
    return true;
  });
  await assert.rejects(reading, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'NotesSchemaError');
    assert.match(error.message, /ZICCLOUDSYNCINGOBJECT\.ZTITLE1/);
    assert.equal(other.failureType(error), 'system');
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
    history: await installedHistory(destination),
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

test('Notes declares the local Apple store as the coverage of every stream', async () => {
  const notes = new AppleNotesSource();

  const { streams } = await notes.discover();

  for (const stream of streams)
    assert.match(
      notes.coverage(stream).description,
      /local Apple store/,
      stream.name,
    );
});

test('a Notes watch keeps every stream current while Notes runs and the note store holds still', async () => {
  // The watch launches Notes hidden, and a running Notes keeps its store
  // live, so the source says nothing earlier than each check.
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-current-'),
  );
  const store = await noteStoreFixture(dir.path);
  const source = new AppleNotesSource({ path: store });
  const data = join(dir.path, 'out.sqlite');
  const destination = new SQLiteDestination({ path: data });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const { streams } = await source.discover();
  const watching = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(dir.path, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) => new Copy(stream, destination.table(stream.name)),
        ),
      }),
    ],
  }).watch({ signal: AbortSignal.timeout(30_000) });
  try {
    await watching.next();
    using out = new DatabaseSync(data, { readOnly: true });
    const status = out.prepare(
      'SELECT stream, status, last_successful_sync_at, current_as_of FROM stream_status',
    );
    const [pass] = out
      .prepare('SELECT started_at, completed_at FROM sync_attempts')
      .all();
    // Nothing changes, so only the watch's next check can move current_as_of.
    for (
      let tries = 0;
      status
        .all()
        .some(
          ({ current_as_of }) =>
            String(current_as_of) <= String(pass?.started_at),
        );
      tries++
    ) {
      if (tries > 100)
        assert.fail(`not current: ${JSON.stringify(status.all())}`);
      await sleep(100);
    }

    assert.equal(
      out.prepare('SELECT count(*) AS n FROM sync_attempts').get()?.n,
      1,
    );
    for (const row of status.all()) {
      assert.equal(row.status, 'succeeded', String(row.stream));
      assert.equal(row.last_successful_sync_at, pass?.completed_at);
    }
  } finally {
    await watching.return(undefined);
  }
});

test('a Notes pass over a large store holds one note at a time, so it loads in a small heap', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-large-'));
  const path = await noteStoreFixture(scratch.path);
  {
    using database = new DatabaseSync(path);
    const note = database.prepare(
      'INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7, ZNOTEDATA, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZISPINNED, ZISPASSWORDPROTECTED, ZHASCHECKLIST, ZHASCHECKLISTINPROGRESS) VALUES (?, 12, ?, ?, 2, 1, ?, 780000000, 780000000, 0, 0, 0, 0)',
    );
    const data = database.prepare(
      'INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)',
    );
    database.exec('BEGIN');
    for (let n = 1; n <= 60_000; n++) {
      note.run(100 + n, `LARGE-${n}`, `Note ${n}`, 100 + n);
      data.run(
        100 + n,
        100 + n,
        noteBody([
          { text: `Note ${n}\n`, style: 0 },
          { text: `${randomBytes(500).toString('hex')} ${n}\n` },
        ]),
      );
    }
    database.exec('COMMIT');
  }
  // The import as a host runs it, in a process whose heap is far smaller
  // than the store. Each note body carries 1 KB of text that does not
  // compress, so a pass that holds every note, or every record it keeps, at
  // once runs out of it: one that reads a note at a time but validates the
  // whole set at once needs about 176 MB, and one that also reads every row
  // at once needs more than 112 (its need with 100-byte bodies); one that
  // reads and validates a note at a time fits in 32. The process loads the
  // built source from this package's folder, where its dependencies resolve.
  const pass = `
    const { Connection, Copy, Pipeline } = await import('@workspace/elt');
    const { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } = await import('@workspace/elt-sqlite');
    const { AppleNotesSource } = await import(process.env.SOURCE);
    const source = new AppleNotesSource({ path: process.env.STORE });
    const destination = new SQLiteDestination({ path: process.env.OUT + '/data.sqlite' });
    const { streams } = await source.discover();
    const history = new SQLiteSyncHistory();
    await history.install([destination]);
    await new Pipeline({
      history,
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: process.env.OUT + '/checkpoints.sqlite' }),
          steps: streams.map((stream) => new Copy(stream, destination.table('raw_' + stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          })),
        }),
      ],
    }).run();
  `;

  const run = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '-e', pass],
    {
      // The package's own folder, where its dependencies resolve.
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SOURCE: pathToFileURL(
          join(import.meta.dirname, 'apple-notes-source.js'),
        ).href,
        STORE: path,
        OUT: scratch.path,
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  // V8 names a heap limit it reached in the first lines it writes.
  assert.equal(
    run.status,
    0,
    `${run.signal ?? ''} ${run.error?.message ?? ''}\n${run.stderr.slice(0, 1000)}`,
  );
  assert.deepEqual(
    noteRows(
      join(scratch.path, 'data.sqlite'),
      "SELECT count(*) AS n FROM raw_notes WHERE id LIKE 'LARGE-%'",
    ),
    [{ n: 60_000 }],
  );
});
