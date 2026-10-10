import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import v8 from 'node:v8';
import { deflateSync, gzipSync } from 'node:zlib';

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
  const created = appleSeconds('2025-01-02T03:04:05.006Z');
  const modified = appleSeconds('2025-02-03T04:05:06.007Z');
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

const execute = promisify(execFile);

// Safari 27's own schemas on macOS 27, as its stores declare them.
const historySchema = `
CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,domain_expansion TEXT NULL,visit_count INTEGER NOT NULL,daily_visit_counts BLOB NOT NULL,weekly_visit_counts BLOB NULL,autocomplete_triggers BLOB NULL,should_recompute_derived_visit_counts INTEGER NOT NULL,visit_count_score INTEGER NOT NULL,status_code INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT,history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,visit_time REAL NOT NULL,title TEXT NULL,load_successful BOOLEAN NOT NULL DEFAULT 1,http_non_get BOOLEAN NOT NULL DEFAULT 0,synthesized BOOLEAN NOT NULL DEFAULT 0,redirect_source INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,redirect_destination INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,origin INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,attributes INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT,start_time REAL NOT NULL,end_time REAL NOT NULL,url TEXT,generation INTEGER NOT NULL DEFAULT 0, udid TEXT, attributes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
CREATE TABLE history_client_versions (client_version INTEGER PRIMARY KEY,last_seen REAL NOT NULL);
CREATE TABLE history_event_listeners (listener_name TEXT PRIMARY KEY NOT NULL UNIQUE,last_seen REAL NOT NULL);
CREATE TABLE history_events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,event_time REAL NOT NULL,pending_listeners TEXT NOT NULL,value BLOB);
CREATE TABLE history_tags (id INTEGER PRIMARY KEY,type INTEGER NOT NULL,level INTEGER NOT NULL,identifier TEXT NOT NULL,title TEXT NOT NULL,modification_timestamp REAL NOT NULL,item_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_items_to_tags (history_item INTEGER NOT NULL,tag_id INTEGER NOT NULL,timestamp REAL NOT NULL,FOREIGN KEY(tag_id) REFERENCES history_tags(id) ON DELETE CASCADE,FOREIGN KEY(history_item) REFERENCES history_items(id) ON DELETE CASCADE,UNIQUE(history_item, tag_id) ON CONFLICT REPLACE);
CREATE TRIGGER increment_count_on_insert AFTER INSERT ON history_items_to_tags BEGIN  UPDATE history_tags SET item_count = item_count + 1 WHERE id = NEW.tag_id;END;
CREATE TRIGGER decrement_count_on_delete BEFORE DELETE ON history_items_to_tags BEGIN  UPDATE history_tags SET item_count = item_count - 1 WHERE id = OLD.tag_id;END;
`;

const tabsSchema = `
CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT,special_id INTEGER DEFAULT 0,parent INTEGER, type INTEGER,title TEXT,url TEXT COLLATE NOCASE,num_children INTEGER DEFAULT 0,editable INTEGER DEFAULT 1,deletable INTEGER DEFAULT 1,hidden INTEGER DEFAULT 0,hidden_ancestor_count INTEGER DEFAULT 0,order_index INTEGER NOT NULL,external_uuid TEXT UNIQUE,read INTEGER DEFAULT NULL,last_modified REAL DEFAULT NULL,server_id TEXT, sync_key TEXT,sync_data BLOB,added INTEGER DEFAULT 1,deleted INTEGER DEFAULT 0,extra_attributes BLOB DEFAULT NULL,local_attributes BLOB DEFAULT NULL,fetched_icon BOOL DEFAULT 0, icon BLOB DEFAULT NULL,dav_generation INTEGER DEFAULT 0,locally_added BOOL DEFAULT 0,archive_status INTEGER DEFAULT 0,syncable BOOL DEFAULT 1,web_filter_status INTEGER DEFAULT 0, modified_attributes UNSIGNED BIG INT DEFAULT 0, date_closed REAL DEFAULT NULL, last_selected_child INTEGER DEFAULT NULL, subtype INTEGER DEFAULT 0, cookies_uuid TEXT DEFAULT NULL, local_storage_uuid TEXT DEFAULT NULL, session_storage_uuid TEXT DEFAULT NULL, topic_title TEXT, feature_text TEXT, fetched_feature_text BOOL DEFAULT 0, is_marked_for_expiration INTEGER, FOREIGN KEY (last_selected_child) REFERENCES bookmarks (id) ON DELETE SET NULL);
CREATE TABLE windows (id INTEGER PRIMARY KEY,active_tab_group_id INTEGER DEFAULT NULL,active_profile_id INTEGER DEFAULT NULL,date_closed REAL DEFAULT NULL,extra_attributes BLOB DEFAULT NULL,is_last_session INTEGER DEFAULT 0,local_tab_group_id INTEGER DEFAULT NULL,private_tab_group_id INTEGER DEFAULT NULL,scene_id TEXT DEFAULT NULL,uuid TEXT NOT NULL UNIQUE,restoration_archive BLOB DEFAULT NULL,FOREIGN KEY (active_tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE SET NULL,FOREIGN KEY (active_profile_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE SET NULL,FOREIGN KEY (local_tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (private_tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE);
CREATE TABLE windows_tab_groups (id INTEGER PRIMARY KEY,active_tab_id INTEGER DEFAULT NULL,tab_group_id INTEGER NOT NULL,window_id INTEGER NOT NULL,FOREIGN KEY (active_tab_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (window_id) REFERENCES windows (id) ON UPDATE CASCADE ON DELETE CASCADE,UNIQUE (tab_group_id, window_id));
CREATE TABLE windows_profiles (id INTEGER PRIMARY KEY,active_tab_group_id INTEGER DEFAULT NULL,profile_id INTEGER NOT NULL,window_id INTEGER NOT NULL,FOREIGN KEY (active_tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (profile_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (window_id) REFERENCES windows (id) ON UPDATE CASCADE ON DELETE CASCADE,UNIQUE (profile_id, window_id));
CREATE TABLE windows_unnamed_tab_groups (id INTEGER PRIMARY KEY,tab_group_id INTEGER NOT NULL,window_id INTEGER NOT NULL,FOREIGN KEY (tab_group_id) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY (window_id) REFERENCES windows (id) ON UPDATE CASCADE ON DELETE CASCADE,UNIQUE (tab_group_id, window_id));
CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value NUMERIC NOT NULL, generation INTEGER NOT NULL, device_identifier TEXT NOT NULL, parent INTEGER, sync_data BLOB, modified INTEGER NOT NULL, deleted INTEGER NOT NULL, server_id TEXT,FOREIGN KEY (parent) REFERENCES bookmarks (id) ON UPDATE CASCADE ON DELETE SET NULL, UNIQUE (key, parent));
`;

const cloudTabsSchema = `
CREATE TABLE cloud_tab_devices (device_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_name TEXT,device_type_identifier TEXT,has_duplicate_device_name BOOLEAN DEFAULT 0,is_ephemeral_device BOOLEAN DEFAULT 0,last_modified REAL NOT NULL);
CREATE TABLE cloud_tabs (tab_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_uuid TEXT NOT NULL,position BLOB NOT NULL,title TEXT,url TEXT NOT NULL,is_showing_reader BOOLEAN DEFAULT 0,is_pinned BOOLEAN DEFAULT 0,reader_scroll_position_page_index INTEGER,scene_id TEXT,last_viewed_time REAL DEFAULT 0,topic_title TEXT,FOREIGN KEY(device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
CREATE TABLE cloud_tab_close_requests (close_request_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,destination_device_uuid TEXT NOT NULL,url TEXT NOT NULL,tab_uuid TEXT NOT NULL,FOREIGN KEY(destination_device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
`;

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
  await execute('/usr/bin/plutil', ['-convert', 'binary1', path]);
}

async function binaryPlist(
  directory: string,
  value: unknown,
): Promise<Uint8Array> {
  const path = join(directory, `blob-${crypto.randomUUID()}.plist`);
  await writePlist(path, value);
  try {
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(path);
  }
}

// Seconds since 2001-01-01, as Safari's databases and Notes' Core Data
// store times.
const appleSeconds = (iso: string) =>
  (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

const int32s = (values: readonly number[]) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setInt32(index * 4, value, true);
  });
  return bytes;
};

const bookmarksPlist = {
  Title: '',
  WebBookmarkFileVersion: 1,
  WebBookmarkType: 'WebBookmarkTypeList',
  WebBookmarkUUID: 'ROOT',
  Children: [
    {
      Title: 'History',
      WebBookmarkIdentifier: 'History',
      WebBookmarkType: 'WebBookmarkTypeProxy',
      WebBookmarkUUID: 'PROXY-HISTORY',
    },
    {
      Title: 'BookmarksBar',
      WebBookmarkType: 'WebBookmarkTypeList',
      WebBookmarkUUID: 'BAR',
      Children: [
        {
          URIDictionary: { title: 'Example' },
          URLString: 'https://example.com/',
          WebBookmarkType: 'WebBookmarkTypeLeaf',
          WebBookmarkUUID: 'BM-1',
          dateAdded: new Date('2026-01-02T03:04:05Z'),
          featureText: 'An example page.',
        },
        {
          Title: 'Reading',
          WebBookmarkType: 'WebBookmarkTypeList',
          WebBookmarkUUID: 'FOLDER-1',
          Children: [
            {
              URIDictionary: { title: 'Nested' },
              URLString: 'https://example.org/nested',
              WebBookmarkType: 'WebBookmarkTypeLeaf',
              WebBookmarkUUID: 'BM-2',
            },
          ],
        },
      ],
    },
    {
      Title: 'BookmarksMenu',
      WebBookmarkType: 'WebBookmarkTypeList',
      WebBookmarkUUID: 'MENU',
      Children: [],
    },
    {
      Title: 'com.apple.ReadingList',
      ShouldOmitFromUI: true,
      WebBookmarkType: 'WebBookmarkTypeList',
      WebBookmarkUUID: 'READING-LIST',
      Children: [
        {
          ReadingList: {
            DateAdded: new Date('2026-02-01T10:00:00Z'),
            PreviewText: 'A preview',
          },
          ReadingListNonSync: {
            DateLastFetched: new Date('2026-02-01T10:05:00Z'),
            FetchResult: 1,
            Title: 'Fetched title',
            neverFetchMetadata: false,
          },
          URIDictionary: { title: 'Saved' },
          URLString: 'https://example.net/saved',
          WebBookmarkType: 'WebBookmarkTypeLeaf',
          WebBookmarkUUID: 'RL-1',
          imageURL: 'https://example.net/image.png',
        },
      ],
    },
  ],
} as const;

const distantPast = new Date('0001-01-01T00:00:00Z');

const closedTabsPlist = {
  ClosedTabOrWindowPersistentStatesVersion: '1',
  ClosedTabOrWindowPersistentStates: [
    {
      PersistentStateType: 0,
      PersistentState: {
        TabUUID: 'CT-1',
        WindowUUID: 'W-0',
        ProfileUUID: 'DefaultProfile',
        TabTitle: 'Closed alone',
        TabURL: 'https://example.com/closed',
        DateClosed: new Date('2026-03-01T12:00:00Z'),
        LastVisitTime: distantPast,
        TabIndex: 2,
        TabGroupForTab: 'G-1',
        TabGroupTypeForTabKey: true,
        AncestorTabUUIDsKey: ['CT-0'],
        IsMuted: true,
        IsDisposable: false,
        SafeToLoad: true,
        TabStateVersion: 1,
      },
    },
    {
      PersistentStateType: 1,
      PersistentState: {
        WindowUUID: 'W-1',
        ProfileUUID: 'DefaultProfile',
        DateClosed: new Date('2026-03-02T12:00:00Z'),
        IsPrivateWindow: false,
        IsPopupWindow: false,
        Miniaturized: false,
        TabBarHidden: false,
        FavoritesBarHidden: true,
        PrefersReadingListSidebarVisible: false,
        SelectedTabIndex: 1,
        SelectedPinnedTabIndex: 0,
        WindowUnifiedSidebarMode: 0,
        WindowContentRect: '{{0, 0}, {800, 600}}',
        CustomUnifiedFieldText: 'half typed',
        activeTabGroupUUID: 'G-2',
        UnnamedTabGroupUUIDs: ['G-2'],
        TabGroupsToActiveTabs: { 'G-2': 'CT-3' },
        WindowStateVersion: '1',
        TabStates: [
          {
            TabUUID: 'CT-2',
            WindowUUID: 'W-1',
            ProfileUUID: 'DefaultProfile',
            TabTitle: 'First',
            TabURL: 'https://example.com/first',
            DateClosed: new Date('2026-03-02T12:00:00Z'),
            LastVisitTime: new Date('2026-03-02T11:00:00Z'),
            TabIndex: 0,
            TabGroupForTab: 'G-2',
            TabGroupTypeForTabKey: true,
            IsMuted: false,
            IsDisposable: false,
            SafeToLoad: true,
          },
          {
            TabUUID: 'CT-3',
            WindowUUID: 'W-1',
            ProfileUUID: 'DefaultProfile',
            TabTitle: 'Second',
            TabURL: 'https://example.com/second',
            DateClosed: new Date('2026-03-02T12:00:00Z'),
            LastVisitTime: new Date('2026-03-02T11:30:00Z'),
            TabIndex: 1,
            TabGroupForTab: 'G-2',
            TabGroupTypeForTabKey: true,
            IsMuted: false,
            IsDisposable: false,
            SafeToLoad: true,
          },
        ],
      },
    },
    // The same tab closed earlier, listed again after the window.
    {
      PersistentStateType: 0,
      PersistentState: {
        TabUUID: 'CT-1',
        WindowUUID: 'W-0',
        ProfileUUID: 'DefaultProfile',
        TabTitle: 'Closed earlier',
        TabURL: 'https://example.com/closed',
        DateClosed: new Date('2026-02-01T12:00:00Z'),
        TabIndex: 5,
        TabGroupTypeForTabKey: true,
      },
    },
  ],
} as const;

// A Safari library and container holding a little of everything Safari keeps.
async function safariFixture(root: string) {
  const directory = join(root, 'Safari');
  const container = join(root, 'Container');
  await mkdir(directory, { recursive: true });
  await mkdir(container, { recursive: true });
  const triggers = await binaryPlist(root, ['exa', 'examp']);
  {
    using history = new DatabaseSync(join(directory, 'History.db'));
    history.exec('PRAGMA journal_mode = WAL');
    history.exec(historySchema);
    const item = history.prepare(
      'INSERT INTO history_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    item.run(
      1,
      'https://example.com/',
      null,
      2,
      int32s([20, 0]),
      null,
      null,
      0,
      40,
      0,
    );
    item.run(
      2,
      'https://example.org/',
      'www',
      1,
      int32s([0, 20]),
      int32s([80]),
      triggers,
      1,
      20,
      200,
    );
    const visit = history.prepare(
      'INSERT INTO history_visits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    visit.run(
      10,
      1,
      appleSeconds('2026-01-10T09:00:00Z'),
      'Example',
      1,
      0,
      0,
      null,
      null,
      0,
      7,
      0,
      100,
    );
    visit.run(
      11,
      1,
      appleSeconds('2026-02-10T09:00:00Z'),
      '',
      1,
      1,
      0,
      null,
      null,
      1,
      8,
      2,
      50,
    );
    visit.run(
      12,
      2,
      appleSeconds('2026-02-10T09:00:01Z'),
      'Org',
      0,
      0,
      0,
      11,
      null,
      1,
      8,
      0,
      0,
    );
    history.exec(
      'UPDATE history_visits SET redirect_destination = 12 WHERE id = 11',
    );
    history
      .prepare('INSERT INTO history_tombstones VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        1,
        appleSeconds('2026-01-01T00:00:00Z'),
        appleSeconds('2026-01-02T00:00:00Z'),
        'https://gone.example/',
        5,
        'DEVICE-1',
        0,
      );
    history
      .prepare('INSERT INTO history_tombstones VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        2,
        -63_114_076_800,
        appleSeconds('2026-01-03T00:00:00Z'),
        new Uint8Array([0x42, 0x8f, 0x0a]),
        6,
        'DEVICE-1',
        65793,
      );
    history
      .prepare('INSERT INTO history_tombstones VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        3,
        appleSeconds('2026-01-04T10:00:00Z'),
        appleSeconds('2026-01-04T11:00:00Z'),
        null,
        7,
        'DEVICE-1',
        65793,
      );
    history
      .prepare('INSERT INTO history_tags VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1, 1, 200, 'Q2063', 'JSON', appleSeconds('2026-01-11T00:00:00Z'), 0);
    history
      .prepare('INSERT INTO history_items_to_tags VALUES (?, ?, ?)')
      .run(1, 1, appleSeconds('2026-01-11T00:00:00Z'));
  }
  {
    using cloud = new DatabaseSync(join(container, 'CloudTabs.db'));
    cloud.exec('PRAGMA journal_mode = WAL');
    cloud.exec(cloudTabsSchema);
    const fields = new Uint8Array([0]);
    cloud
      .prepare('INSERT INTO cloud_tab_devices VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'DEV-1',
        fields,
        'Phone',
        'com.apple.iphone-15-pro-5',
        0,
        0,
        appleSeconds('2026-03-03T00:00:00Z'),
      );
    const position = deflateSync(
      JSON.stringify({
        sortValues: [
          { changeID: 0, sortValue: 1500, deviceIdentifier: 'SORT-DEV' },
        ],
      }),
    );
    cloud
      .prepare(
        'INSERT INTO cloud_tabs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'TAB-1',
        fields,
        'DEV-1',
        position,
        'Remote',
        'https://example.net/',
        0,
        1,
        null,
        'SCENE-1',
        0,
        null,
      );
    cloud
      .prepare('INSERT INTO cloud_tab_close_requests VALUES (?, ?, ?, ?, ?)')
      .run('CR-1', fields, 'DEV-1', 'https://example.net/', 'TAB-1');
  }
  {
    await mkdir(join(container, 'Profiles', 'SERVER-WORK'), {
      recursive: true,
    });
    using work = new DatabaseSync(
      join(container, 'Profiles', 'SERVER-WORK', 'History.db'),
    );
    work.exec(historySchema);
    work
      .prepare(
        'INSERT INTO history_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        1,
        'https://work.example/',
        null,
        1,
        int32s([20]),
        null,
        null,
        0,
        20,
        0,
      );
    work
      .prepare(
        'INSERT INTO history_visits (id, history_item, visit_time, title) VALUES (?, ?, ?, ?)',
      )
      .run(1, 1, appleSeconds('2026-02-15T08:00:00Z'), 'Work page');
  }
  await tabsFixture(root, join(container, 'SafariTabs.db'));
  const downloaded = join(root, 'Downloads', 'report.pdf');
  await mkdir(join(root, 'Downloads'), { recursive: true });
  await writeFile(downloaded, 'downloaded bytes');
  await writePlist(join(directory, 'Downloads.plist'), {
    DownloadHistory: [
      {
        DownloadEntryIdentifier: 'DL-1',
        DownloadEntryURL: 'https://example.com/report.pdf',
        DownloadEntryPath: downloaded,
        DownloadEntryProfileUUIDStringKey: 'DefaultProfile',
        DownloadEntryDateAddedKey: new Date('2026-03-04T10:00:00Z'),
        DownloadEntryDateFinishedKey: new Date('2026-03-04T10:00:01Z'),
        DownloadEntryProgressBytesSoFar: 16,
        DownloadEntryProgressTotalToLoad: 16,
        DownloadEntryRemoveWhenDoneKey: false,
        DownloadEntryBookmarkBlob: new Uint8Array([1, 2, 3]),
      },
      {
        DownloadEntryIdentifier: 'DL-2',
        DownloadEntryURL: 'https://example.com/archive.zip',
        DownloadEntryPath: join(
          root,
          'Downloads',
          'archive.zip.download',
          'archive.zip',
        ),
        DownloadEntryPostPath: join(
          root,
          'Downloads',
          'archive.zip.download',
          'archive',
          'README',
        ),
        DownloadEntryProfileUUIDStringKey: 'PROFILE-WORK',
        DownloadEntryDateAddedKey: new Date('2026-03-05T10:00:00Z'),
        DownloadEntryDateFinishedKey: new Date('2026-03-05T10:00:01Z'),
        DownloadEntryProgressBytesSoFar: 351,
        DownloadEntryProgressTotalToLoad: 351,
        DownloadEntryRemoveWhenDoneKey: false,
      },
    ],
  });
  await writePlist(join(directory, 'Bookmarks.plist'), bookmarksPlist);
  await writePlist(
    join(directory, 'RecentlyClosedTabs.plist'),
    closedTabsPlist,
  );
  return { directory, container };
}

// An NSKeyedArchiver archive of one object, as Safari archives profile colors.
const archived = (
  className: string,
  fields: Record<string, number | string>,
) => {
  const keys = Object.keys(fields);
  return {
    $archiver: 'NSKeyedArchiver',
    $version: 100000,
    $top: { root: { CF$UID: 1 } },
    $objects: [
      '$null',
      {
        $class: { CF$UID: 2 + keys.length },
        ...Object.fromEntries(
          keys.map((key, index) => [key, { CF$UID: 2 + index }]),
        ),
      },
      ...keys.map((key) => fields[key]),
      { $classname: className, $classes: [className, 'NSObject'] },
    ],
  };
};

// SafariTabs.db with two profiles, a named group with a tab and a group
// Favorite, a window's own groups with an ordinary and a pinned tab, and the
// second profile's device folder, unnamed group and tab.
async function tabsFixture(root: string, path: string) {
  const plist = (value: unknown) => binaryPlist(root, value);
  const session = await plist({
    SessionHistory: {
      SessionHistoryCurrentIndex: 1,
      SessionHistoryVersion: 1,
      SessionHistoryEntries: [
        {
          SessionHistoryEntryURL: 'https://example.com/start',
          SessionHistoryEntryOriginalURL: 'http://example.com/start',
          SessionHistoryEntryTitle: 'Start',
          SessionHistoryEntryWasCreatedByJSWithoutUserInteraction: false,
          SessionHistoryEntryData: new Uint8Array([9]),
        },
        {
          SessionHistoryEntryURL: 'https://example.com/research',
          SessionHistoryEntryOriginalURL: 'https://example.com/research',
          SessionHistoryEntryTitle: 'Research',
          SessionHistoryEntryWasCreatedByJSWithoutUserInteraction: true,
          SessionHistoryEntryShouldOpenExternalURLsPolicyKey: 'allow',
        },
      ],
    },
  });
  const sessionState = new Uint8Array(4 + session.length);
  sessionState.set([0, 0, 0, 2]);
  sessionState.set(session, 4);
  const added = {
    'com.apple.Bookmark': { DateAdded: new Date('2026-03-01T09:00:00Z') },
  };
  const color = await plist(
    archived('WBSNamedColorOption', {
      colorName: 'heatherBlue',
      redComponent: 0.62,
      greenComponent: 0.72,
      blueComponent: 0.74,
      alphaComponent: 1,
    }),
  );
  using tabs = new DatabaseSync(path);
  tabs.exec('PRAGMA journal_mode = WAL');
  tabs.exec(tabsSchema);
  const row = tabs.prepare(
    'INSERT INTO bookmarks (id, parent, type, subtype, special_id, hidden, title, url, order_index, external_uuid, server_id, last_modified, last_selected_child, extra_attributes, local_attributes, topic_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const bookmark = (
    id: number,
    parent: number | null,
    type: number,
    subtype: number,
    fields: {
      special?: number;
      hidden?: number;
      title?: string;
      url?: string;
      order?: number;
      uuid: string;
      server?: string;
      selected?: number;
      extra?: Uint8Array;
      local?: Uint8Array;
      topic?: string;
    },
  ) =>
    row.run(
      id,
      parent,
      type,
      subtype,
      fields.special ?? 0,
      fields.hidden ?? 0,
      fields.title ?? null,
      fields.url ?? null,
      fields.order ?? 0,
      fields.uuid,
      fields.server ?? null,
      appleSeconds('2026-03-02T00:00:00Z'),
      fields.selected ?? null,
      fields.extra ?? null,
      fields.local ?? null,
      fields.topic ?? null,
    );
  bookmark(0, null, 1, 0, { title: 'Root', uuid: 'Root' });
  bookmark(2, null, 1, 0, { hidden: 1, title: 'pinned', uuid: 'pinned' });
  bookmark(6, 0, 1, 2, {
    uuid: 'DefaultProfile',
    server: 'DefaultProfile',
    extra: await plist({ SymbolImageName: 'person.fill' }),
  });
  bookmark(20, 0, 1, 2, {
    title: 'Work',
    order: 1,
    uuid: 'PROFILE-WORK',
    server: 'SERVER-WORK',
    extra: await plist({
      ...added,
      SymbolImageName: 'briefcase.fill',
      CustomFavoritesFolderServerID: 'FAV-WORK',
      StartPageSectionsData: new TextEncoder().encode(
        JSON.stringify({
          Sections: [
            { Identifier: 'favoritesItemIdentifier', IsEnabled: true },
            { Identifier: 'privacyReportIdentifier', IsEnabled: false },
          ],
        }),
      ),
    }),
  });
  bookmark(21, 20, 1, 3, {
    title: 'Mac',
    uuid: 'DEVICE-FOLDER',
    extra: await plist({
      ...added,
      DeviceTypeIdentifier: 'com.apple.macbookpro',
    }),
  });
  bookmark(22, 21, 1, 0, {
    title: 'Unnamed',
    uuid: 'GROUP-WORK',
    extra: await plist({ ...added, IsUnnamed: true }),
  });
  bookmark(30, 0, 1, 0, {
    title: 'Research',
    order: 2,
    uuid: 'GROUP-NAMED',

    topic: 'Science',
    extra: await plist(added),
  });
  bookmark(31, 30, 1, 1, {
    title: 'TopScopedBookmarkList',
    uuid: 'GROUP-FAVORITES',
  });
  bookmark(32, 30, 0, 0, {
    title: 'Research',
    url: 'https://example.com/research',
    uuid: 'TAB-NAMED',
    extra: await plist({
      ...added,
      LocalTitle: 'Research here',
      DateLastViewed: new Date('2026-03-03T09:00:00Z'),
      DeviceIdentifier: 'DEVICE-1',
    }),
    local: await plist({
      WindowUUID: 'WIN-1',
      TabIndex: 0,
      IsMuted: true,
      LastAccessDate: new Date('0001-01-01T00:00:00Z'),
      LastVisitTime: new Date('2026-03-03T09:00:00Z'),
      AncestorTabUUIDsKey: ['TAB-LOCAL'],
      SessionState: sessionState,
      TabPageContextIDKey: {
        profileIdentifier: 'DefaultProfile',
        keywords: ['physics', 'lab'],
        keywordsWeights: [0.9, 0.25],
        pageLanguage: 'en',
        summary: '',
      },
    }),
  });
  bookmark(33, 31, 0, 0, {
    title: 'Pinned favorite',
    url: 'https://example.com/favorite',
    uuid: 'TAB-FAVORITE',
  });
  tabs.exec('UPDATE bookmarks SET last_selected_child = 32 WHERE id = 30');
  bookmark(40, null, 1, 0, { hidden: 1, title: 'Local', uuid: 'GROUP-LOCAL' });
  bookmark(41, null, 1, 0, {
    hidden: 1,
    title: 'Private',
    uuid: 'GROUP-PRIVATE',
  });
  bookmark(42, 40, 0, 0, {
    title: 'Local tab',
    url: 'https://example.com/local',
    uuid: 'TAB-LOCAL',
    local: await plist({ WindowUUID: 'WIN-1', TabIndex: 1 }),
  });
  bookmark(43, 2, 0, 0, {
    title: 'Mail',
    url: 'https://mail.example/inbox',
    uuid: 'TAB-PINNED',
    extra: await plist({
      IsPinned: true,
      PinnedTitle: 'Mail',
      PinnedAddress: 'https://mail.example/',
    }),
    local: await plist({
      WindowUUID: 'WIN-1',
      TabPageContextIDKey: { profileIdentifier: 'DefaultProfile' },
    }),
  });
  bookmark(50, 22, 0, 0, {
    title: 'Work tab',
    url: 'https://work.example/',
    uuid: 'TAB-WORK',
    local: await plist({
      WindowUUID: 'WIN-2',
      TabPageContextIDKey: { profileIdentifier: 'PROFILE-WORK' },
    }),
  });
  const windowState = await plist({
    WindowUUID: 'WIN-1',
    IsPrivateWindow: false,
    IsPopupWindow: false,
    Miniaturized: false,
    SelectedTabIndex: 0,
    SelectedPinnedTabIndex: 9223372036854775807n,
    TabBarHidden: false,
    FavoritesBarHidden: true,
    PrefersReadingListSidebarVisible: false,
    WindowUnifiedSidebarMode: 0,
    WindowContentRect: '{{0, 0}, {800, 600}}',
    UnnamedTabGroupUUIDs: ['GROUP-LOCAL'],
  });
  const window = tabs.prepare(
    'INSERT INTO windows (id, uuid, active_tab_group_id, active_profile_id, local_tab_group_id, private_tab_group_id, is_last_session, extra_attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  window.run(1, 'WIN-1', 30, 6, 40, 41, 1, windowState);
  window.run(2, 'WIN-2', 22, 20, null, null, 1, null);
  tabs
    .prepare(
      'INSERT INTO windows_tab_groups (window_id, tab_group_id, active_tab_id) VALUES (?, ?, ?)',
    )
    .run(1, 30, 32);
  tabs
    .prepare(
      'INSERT INTO windows_unnamed_tab_groups (window_id, tab_group_id) VALUES (?, ?)',
    )
    .run(1, 40);
  tabs
    .prepare(
      'INSERT INTO windows_profiles (window_id, profile_id, active_tab_group_id) VALUES (?, ?, ?)',
    )
    .run(1, 6, 30);
  tabs
    .prepare(
      "INSERT INTO settings (key, value, generation, device_identifier, parent, modified, deleted) VALUES ('ProfileColor', ?, 2, 'DEVICE-1', 20, 0, 0)",
    )
    .run(color);
}

const entry = join(import.meta.dirname, 'main.js');

// The CLI as a script runs it: no terminal, HOME pointing at a Mac whose
// apps' stores the test wrote, and the working directory holding outputs/.
function cli(mac: string, ...args: string[]) {
  const { status, signal, stdout, stderr } = spawnSync(
    process.execPath,
    [entry, ...args],
    { cwd: mac, env: { ...process.env, HOME: mac }, encoding: 'utf8' },
  );
  return { status, signal, stdout, stderr };
}

// The CLI started alongside the test, as a second process a person or script
// runs while another works; exited settles with how it ended.
function started(mac: string, ...args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: mac,
    env: { ...process.env, HOME: mac },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{
    status: number | null;
    stderr: string;
    stdout: string;
  }>((resolve) =>
    child.once('close', (status) => resolve({ status, stdout, stderr })),
  );
  return { child, exited };
}

// The user's Notes, where Notes keeps them under HOME. Only Notes has a store
// here; every other connector finds nothing, as on a Mac that denies access.
const withNotes = (mac: string) =>
  noteStoreFixture(join(mac, 'Library/Group Containers/group.com.apple.notes'));

// The CLI in a terminal of its own, typed into as a person would: expect,
// which macOS ships, gives it a 120×40 pseudo-terminal, relays keys and exits
// with the CLI's status. A CLI a signal ended has no status, so expect names
// the signal instead, and exited resolves to it.
function terminal(mac: string, ...args: string[]) {
  const child = spawn(
    '/usr/bin/expect',
    [
      '-c',
      `set stty_init {columns 120 rows 40}; spawn -noecho {${process.execPath}} {${entry}} ${args.join(' ')}; interact; lassign [wait] pid spawned failed status killed signal; if {$killed eq {CHILDKILLED}} {puts stderr $signal}; exit $status`,
    ],
    { cwd: mac, env: { ...process.env, HOME: mac } },
  );
  let screen = '';
  child.stdout.on('data', (data) => {
    screen += stripVTControlCharacters(String(data));
  });
  let signal = '';
  child.stderr.on('data', (data) => {
    signal += String(data);
  });
  const exited = new Promise<number | string | null>((resolve) =>
    child.once('close', (status) => resolve(signal.trim() || status)),
  );
  return {
    child,
    exited,
    get screen() {
      return screen;
    },
    async shows(text: string) {
      for (let tries = 0; !screen.includes(text); tries++) {
        if (tries > 300) assert.fail(`never showed ${text}:\n${screen}`);
        await sleep(100);
      }
    },
    async type(...keys: string[]) {
      for (const key of keys) {
        child.stdin.write(key);
        await sleep(150);
      }
    },
  };
}

// Polls status until the only selected connector's pass runs.
async function passRunning(mac: string) {
  const deadline = Date.now() + 60_000;
  while (
    JSON.parse(cli(mac, 'status', '--json').stdout)[0]?.state !== 'running'
  ) {
    if (Date.now() > deadline)
      assert.fail('the sync did not start its pass within a minute');
    await sleep(100);
  }
}

const ctrlC = '\x03';
const down = '\x1b[B';
const space = ' ';
const enter = '\r';

const lines = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('a connector whose app macOS will not open fails alone, named with the access to grant, while the others load', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  assert.equal(
    cli(mac.path, 'setup', '--connector', 'notes', '--connector', 'messages')
      .status,
    0,
  );

  const synced = cli(mac.path, 'sync');

  assert.equal(synced.status, 1);
  const passes = Object.fromEntries(
    lines(synced.stdout).map((pass) => [pass.connector, pass]),
  );
  assert.equal(passes.notes.status, 'succeeded');
  assert.equal(passes.messages.status, 'failed');
  assert.match(passes.messages.error, /Full Disk Access/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ connector, state }: { connector: string; state: string }) => [
      connector,
      state,
    ]),
    [
      ['notes', 'succeeded'],
      ['messages', 'failed'],
    ],
  );
});

test('a second sync of an import another sync is importing says so, waits for that pass and shows it', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  // A pipe the test writes once the second sync waits: the Photos read waits
  // on it, so the first sync's pass still runs when the second starts.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos');
  const first = started(mac.path, 'sync', '--json');
  try {
    await passRunning(mac.path);
    const second = terminal(mac.path, 'sync');
    try {
      await second.shows('a sync is importing it');

      await writeFile(pictures, JSON.stringify([{ id: 'p1', title: 'Beach' }]));
      const ended = await Promise.race([
        Promise.all([first.exited, second.exited]),
        sleep(30_000).then(() => null),
      ]);

      if (ended === null)
        assert.fail(`a sync never finished:\n${second.screen}`);
      const [led, waited] = ended;
      assert.equal(led.status, 0, led.stderr);
      assert.deepEqual(
        lines(led.stdout).map(({ connector, status }) => [connector, status]),
        [['photos', 'succeeded']],
      );
      assert.equal(waited, 0, second.screen);
      assert.match(second.screen, /Photos\s+1 rows · 1 streams/);
      assert.match(second.screen, /All connectors current\./);
      const attempts = cli(
        mac.path,
        'query',
        'photos',
        'SELECT count(*) AS n FROM sync_attempts',
        '--json',
      );
      assert.deepEqual(JSON.parse(attempts.stdout), [{ n: 1 }]);
    } finally {
      second.child.kill('SIGKILL');
      await second.exited;
    }
  } finally {
    first.child.kill('SIGKILL');
    await first.exited;
  }
});

test('a sync waiting on another sync whose pass is killed says the pass was interrupted and exits 1', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  // A pipe no one writes to: the first sync's Photos pass runs until killed.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos');
  const first = started(mac.path, 'sync', '--json');
  try {
    await passRunning(mac.path);
    const second = terminal(mac.path, 'sync');
    try {
      await second.shows('a sync is importing it');

      first.child.kill('SIGKILL');
      const waited = await Promise.race([
        second.exited,
        sleep(10_000).then(() => 'still waiting'),
      ]);

      assert.equal(waited, 1, second.screen);
      assert.match(
        second.screen,
        /Photos\s+interrupted · the sync importing it stopped/,
      );
      assert.match(second.screen, /Some connectors did not load completely\./);
    } finally {
      second.child.kill('SIGKILL');
      await second.exited;
    }
  } finally {
    first.child.kill('SIGKILL');
    await first.exited;
  }
});

test('a sync of one connector runs while another sync waits on a read of a different one', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  await withConnectors(mac.path);
  // A pipe no one writes to: the Photos pass runs until killed.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos', '--connector', 'notes');
  const photos = started(mac.path, 'sync', '--json', '--connector', 'photos');
  try {
    await passRunning(mac.path);
    const notes = started(mac.path, 'sync', '--json', '--connector', 'notes');
    try {
      const synced = await Promise.race([
        notes.exited,
        sleep(30_000).then(() => null),
      ]);

      if (synced === null)
        assert.fail('the Notes sync waited on the Photos pass');
      assert.equal(synced.status, 0, synced.stderr);
      assert.deepEqual(
        lines(synced.stdout).map(({ connector, status }) => [
          connector,
          status,
        ]),
        [['notes', 'succeeded']],
      );
    } finally {
      notes.child.kill('SIGKILL');
      await notes.exited;
    }
  } finally {
    photos.child.kill('SIGKILL');
    await photos.exited;
  }
});

test('Ctrl-C stops a sync at once while a connector waits on a read', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  // A pipe no one writes to: the Photos read waits on it in a thread of
  // Node's pool, which an exit that waits for that pool never gets past.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos');
  const sync = started(mac.path, 'sync', '--json');
  try {
    await passRunning(mac.path);

    sync.child.kill('SIGINT');
    const ended = await Promise.race([
      sync.exited,
      sleep(10_000).then(() => null),
    ]);

    assert.notEqual(ended, null, 'the sync still ran 10 s after SIGINT');
    assert.equal(sync.child.signalCode, 'SIGINT');
  } finally {
    sync.child.kill('SIGKILL');
    await sync.exited;
  }
});

test('Ctrl-C typed in a terminal stops a sync at once while a connector waits on a read', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  // A pipe no one writes to, as above: the Photos read never returns.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos');
  const sync = terminal(mac.path, 'sync');
  try {
    await passRunning(mac.path);
    await sync.shows('Photos photos');

    await sync.type(ctrlC);
    const ended = await Promise.race([
      sync.exited,
      sleep(10_000).then(() => 'still running'),
    ]);

    assert.equal(ended, 'SIGINT', sync.screen);
  } finally {
    sync.child.kill('SIGKILL');
    await sync.exited;
  }
  assert.match(sync.screen, /Sync interrupted/);
});

test('SIGTERM stops a sync in a terminal at once while its spinner shows', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'photos');
  const sync = terminal(mac.path, 'sync');
  try {
    await passRunning(mac.path);
    await sync.shows('Photos photos');
    // expect runs the CLI as its only child.
    const pid = spawnSync('/usr/bin/pgrep', ['-P', String(sync.child.pid)], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.match(pid, /^\d+$/, 'expect runs no CLI');

    process.kill(Number(pid), 'SIGTERM');
    const ended = await Promise.race([
      sync.exited,
      sleep(10_000).then(() => 'still running'),
    ]);

    assert.equal(ended, 'SIGTERM', sync.screen);
  } finally {
    sync.child.kill('SIGKILL');
    await sync.exited;
  }
  assert.match(sync.screen, /Sync interrupted/);
});

test('a setup that removes a connector stops the sync importing it, while the rest loads, and the next sync removes its import', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  await withConnectors(mac.path);
  // A pipe the test writes only after the removal: the Photos read waits on
  // it, so its pass is running when another setup removes Photos.
  const pictures = join(mac.path, 'Pictures/photos.json');
  await rm(pictures);
  spawnSync('/usr/bin/mkfifo', [pictures]);
  cli(mac.path, 'setup', '--connector', 'notes', '--connector', 'photos');
  const sync = started(mac.path, 'sync', '--json');
  try {
    let imported: string | undefined;
    const deadline = Date.now() + 60_000;
    while (imported === undefined) {
      const photos = JSON.parse(cli(mac.path, 'status', '--json').stdout).find(
        ({ connector }: { connector: string }) => connector === 'photos',
      );
      if (photos?.state === 'running') imported = photos.database;
      else if (Date.now() > deadline)
        assert.fail('the Photos pass did not start within a minute');
      else await sleep(100);
    }

    const removed = cli(mac.path, 'setup', '--connector', 'notes');
    // Longer than the sync takes to hear of the removal; then the Photos read
    // gets its next message.
    await sleep(3_000);
    await writeFile(pictures, JSON.stringify([{ id: 'p1', title: 'Beach' }]));
    const synced = await sync.exited;

    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(synced.status, 0, synced.stderr);
    assert.deepEqual(
      lines(synced.stdout).map(({ connector, status }) => [connector, status]),
      [
        ['notes', 'succeeded'],
        ['photos', 'removed'],
      ],
    );
    assert.equal(existsSync(dirname(String(imported))), true);
    assert.equal(cli(mac.path, 'sync').status, 0);
    assert.equal(existsSync(dirname(String(imported))), false);
  } finally {
    // A sync still waiting on the pipe exits only when killed.
    sync.child.kill('SIGKILL');
    await sync.exited;
  }
});

test("status waits out a write to the store's settings instead of printing nothing", async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--connector', 'notes');
  // Stands in for a setup or a sync writing the store's settings.
  const writer = new DatabaseSync(
    join(mac.path, 'outputs/cli/settings.sqlite'),
  );
  writer.exec('BEGIN EXCLUSIVE');

  const status = started(mac.path, 'status', '--json');
  try {
    await Promise.race([status.exited, sleep(3_000)]);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  const reported = await status.exited;

  assert.equal(reported.status, 0, reported.stderr);
  assert.deepEqual(
    JSON.parse(reported.stdout).map(
      ({ connector, state }: { connector: string; state: string }) => [
        connector,
        state,
      ],
    ),
    [['notes', 'never']],
  );
});

test('setup, sync, status and query read the Notes this Mac holds through documented views', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);

  const setup = cli(mac.path, 'setup', '--connector', 'notes', '--json');
  const synced = cli(mac.path, 'sync');
  const status = cli(mac.path, 'status', '--json');
  const views = cli(mac.path, 'query', 'notes', '--tables', '--json');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes WHERE title IS NOT NULL ORDER BY title',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout), {
    connectors: [{ connector: 'notes', scope: {}, includeAttachments: true }],
  });
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(lines(synced.stdout)[0].status, 'succeeded');
  const [notes] = JSON.parse(status.stdout);
  assert.equal(notes.state, 'succeeded');
  assert.notEqual(notes.lastSuccessAt, null);
  assert.match(
    notes.database,
    new RegExp(
      `^${join(realpathSync(mac.path), 'outputs/cli/notes')}/[0-9a-f]{16}/data\\.sqlite$`,
    ),
  );
  // Agents find the same import through the store's settings file.
  const selected = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      join(mac.path, 'outputs/cli/settings.sqlite'),
      'SELECT connector, database FROM selected_connectors',
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(
    JSON.parse(selected.stdout).map(
      ({ connector, database }: { connector: string; database: string }) => [
        connector,
        realpathSync(database),
      ],
    ),
    [['notes', notes.database]],
  );
  const readable = JSON.parse(views.stdout);
  assert.ok(
    readable.some(
      ({ view, rows }: { view: string; rows: number }) =>
        view === 'notes' && rows > 0,
    ),
    views.stdout,
  );
  assert.ok(
    readable.some(
      ({ view }: { view: string }) => view === 'inline_attachments',
    ),
  );
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Groceries', 'Old', 'Secret'],
  );
});

test('changing what a connector imports, down to its attachments, loads the new selection completely on the next sync', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--connector', 'notes');
  cli(mac.path, 'sync');
  const options = JSON.parse(
    cli(mac.path, 'options', 'notes', '--json').stdout,
  );
  const trash = options
    .flatMap(
      ({ options }: { options: { id: string; label: string }[] }) => options,
    )
    .find(
      ({ label }: { label: string }) => label === 'iCloud / Recently Deleted',
    );

  // Narrowing flags bind to the --connector before them, here the second one.
  const rescoped = cli(
    mac.path,
    'setup',
    '--connector',
    'messages',
    '--connector',
    'notes',
    '--collection',
    trash.id,
    '--no-attachments',
  );
  const synced = cli(mac.path, 'sync');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes',
    '--json',
  );

  assert.equal(rescoped.status, 0, rescoped.stderr);
  const notesPass = lines(synced.stdout).find(
    ({ connector }) => connector === 'notes',
  );
  assert.equal(notesPass.status, 'succeeded', synced.stdout);
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Old'],
  );
  const fileColumns = cli(
    mac.path,
    'query',
    'notes',
    "SELECT name FROM catalog WHERE name LIKE '%.attachmentRef'",
    '--json',
  );
  assert.deepEqual(JSON.parse(fileColumns.stdout), []);
});

test('a command a script cannot run fails and says why, changing nothing', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--connector', 'notes');
  cli(mac.path, 'sync');

  const unnamed = cli(mac.path, 'setup');
  const misplaced = cli(
    mac.path,
    'setup',
    '--collection',
    'FOLDER-NOTES',
    '--connector',
    'notes',
  );
  const undated = cli(
    mac.path,
    'setup',
    '--connector',
    'contacts',
    '--since',
    '2025-01-01',
  );
  const twoStatements = cli(
    mac.path,
    'query',
    'notes',
    'SELECT 1; DELETE FROM notes',
  );
  // Indented further than the second statement is long, the way an editor
  // or an agent might send it.
  const unselected = cli(mac.path, 'sync', '--connector', 'calendar');
  const indented = cli(
    mac.path,
    'query',
    'notes',
    `${' '.repeat(12)}SELECT 1; SELECT 2`,
  );

  for (const run of [
    unnamed,
    misplaced,
    undated,
    unselected,
    twoStatements,
    indented,
  ])
    assert.equal(run.status, 1, run.stderr);
  assert.match(unselected.stderr, /calendar is not set up/);
  assert.match(unnamed.stderr, /--connector/);
  assert.match(misplaced.stderr, /must follow the --connector/);
  assert.match(undated.stderr, /date filtering is unavailable/);
  assert.match(twoStatements.stderr, /one SQL statement/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ connector }: { connector: string }) => connector),
    ['notes'],
  );
});

test('the setup wizard saves what the person picks and syncs it when asked', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  const wizard = terminal(mac.path, 'setup');
  try {
    await wizard.shows('Which connectors should be imported?');
    // Connectors are listed by name; Notes is the ninth.
    await wizard.type(
      down,
      down,
      down,
      down,
      down,
      down,
      down,
      down,
      space,
      enter,
    );
    await wizard.shows('Narrow any connector?');
    await wizard.type(space, enter);
    await wizard.shows('Notes: accounts');
    await wizard.type(enter);
    await wizard.shows('iCloud / Recently Deleted');
    await wizard.type(down, space, enter);
    await wizard.shows('date last edited since');
    await wizard.type(enter);
    await wizard.shows('date last edited until');
    await wizard.type(enter);
    await wizard.shows('Sync now?');
    await wizard.type(enter);

    assert.equal(await wizard.exited, 0, wizard.screen);
  } finally {
    wizard.child.kill();
  }

  assert.match(wizard.screen, /Notes\s+\d+ rows/);
  const [notes] = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.equal(notes.state, 'succeeded');
  const titles = cli(
    mac.path,
    'query',
    'notes',
    'SELECT title FROM notes',
    '--json',
  );
  assert.deepEqual(
    JSON.parse(titles.stdout).map(({ title }: { title: string }) => title),
    ['Old'],
  );
});

// The user's own connectors, where both Apple hosts look for them under HOME:
// the Photos connector an agent wrote, as its TypeScript source, and Drafts,
// which does not parse.
async function withConnectors(mac: string) {
  const connectors = join(
    mac,
    'Library/Application Support/Context Compiler/Connectors',
  );
  await mkdir(join(connectors, 'photos'), { recursive: true });
  await writeFile(
    join(connectors, 'photos/package.json'),
    JSON.stringify({
      type: 'module',
      exports: './photos-connector.ts',
      contextCompiler: { name: 'photos', title: 'Photos' },
    }),
  );
  await writeFile(
    join(connectors, 'photos/photos-connector.ts'),
    await readFile(
      resolve(
        'packages/connectors/apple/manifest/src/fixtures/photos/photos-connector.ts',
      ),
    ),
  );
  await mkdir(join(connectors, 'drafts'), { recursive: true });
  await writeFile(
    join(connectors, 'drafts/package.json'),
    JSON.stringify({
      type: 'module',
      exports: './drafts-connector.ts',
      contextCompiler: { name: 'drafts', title: 'Drafts' },
    }),
  );
  await writeFile(
    join(connectors, 'drafts/drafts-connector.ts'),
    'export default {',
  );
  await mkdir(join(mac, 'Pictures'));
  await writeFile(
    join(mac, 'Pictures/photos.json'),
    JSON.stringify([
      { id: 'p1', title: 'Beach' },
      { id: 'p2', title: 'Snow' },
    ]),
  );
}

test('a connector the user added syncs and answers queries beside the built-in connectors, through its presets too, and one that does not load is reported while the rest work', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withConnectors(mac.path);
  const presets = join(
    mac.path,
    'Library/Application Support/Context Compiler/Connectors/photos/presets',
  );
  await mkdir(presets);
  await writeFile(
    join(presets, 'titled_photos.sql'),
    [
      '-- titled_photos: Each photo with its title in capitals.',
      '-- id: The photo identifier.',
      '-- title: The title in capitals.',
      'CREATE TEMP VIEW titled_photos AS SELECT id, upper(title) AS title FROM photos;',
    ].join('\n'),
  );

  const setup = cli(mac.path, 'setup', '--connector', 'photos');
  const sync = cli(mac.path, 'sync');
  const photos = cli(
    mac.path,
    'query',
    'photos',
    'SELECT id, title FROM photos ORDER BY id',
    '--json',
  );
  const titled = cli(
    mac.path,
    'query',
    'photos',
    'SELECT id, title FROM titled_photos ORDER BY id',
    '--json',
  );
  const tables = cli(mac.path, 'query', 'photos', '--tables', '--json');

  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stderr, /^Drafts could not be loaded: /m);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(photos.status, 0, photos.stderr);
  assert.deepEqual(JSON.parse(photos.stdout), [
    { id: 'p1', title: 'Beach' },
    { id: 'p2', title: 'Snow' },
  ]);
  assert.equal(titled.status, 0, titled.stderr);
  assert.deepEqual(JSON.parse(titled.stdout), [
    { id: 'p1', title: 'BEACH' },
    { id: 'p2', title: 'SNOW' },
  ]);
  assert.equal(tables.status, 0, tables.stderr);
  assert.deepEqual(JSON.parse(tables.stdout).at(-1), {
    view: 'titled_photos',
    rows: null,
    coverage: 'Preset, loaded before each query',
  });
});

test('a selected connector that was removed is reported by status, and sync still loads the other connectors', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  await withConnectors(mac.path);
  cli(mac.path, 'setup', '--connector', 'notes', '--connector', 'photos');
  await rm(
    join(
      mac.path,
      'Library/Application Support/Context Compiler/Connectors/photos',
    ),
    { recursive: true },
  );

  const sync = cli(mac.path, 'sync');
  const status = cli(mac.path, 'status', '--json');

  assert.equal(sync.status, 1, sync.stderr);
  assert.equal(status.status, 0, status.stderr);
  const [notes, photos] = JSON.parse(status.stdout);
  assert.equal(notes.state, 'succeeded');
  assert.equal(photos.state, 'failed');
  assert.match(photos.error, /^No connector named photos is loaded/);
});

test('--until takes in the day it names, and a day that is not on the calendar is refused', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);

  const impossible = cli(
    mac.path,
    'setup',
    '--connector',
    'notes',
    '--until',
    '2025-02-30',
  );
  const setup = cli(
    mac.path,
    'setup',
    '--connector',
    'notes',
    '--until',
    '2025-02-03',
  );
  cli(mac.path, 'sync');
  const notes = cli(
    mac.path,
    'query',
    'notes',
    "SELECT title FROM notes WHERE title = 'Groceries'",
    '--json',
  );

  assert.equal(impossible.status, 1, impossible.stderr);
  assert.match(impossible.stderr, /Use YYYY-MM-DD/);
  assert.equal(setup.status, 0, setup.stderr);
  const [status] = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.equal(status.selection, 'until 2025-02-03');
  // Groceries was last edited at 2025-02-03T04:05Z.
  assert.deepEqual(JSON.parse(notes.stdout), [{ title: 'Groceries' }]);
});

test('--since and --until name days on the clock of the Mac the CLI runs on, and status shows them as typed', async () => {
  // Groceries was last edited at 2025-02-03T04:05Z: the evening of 2 February
  // in Honolulu, ten hours behind UTC.
  const zone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    const imported = async (...bounds: string[]) => {
      await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
      await withNotes(mac.path);
      cli(mac.path, 'setup', '--connector', 'notes', ...bounds);
      cli(mac.path, 'sync');
      const [status] = JSON.parse(cli(mac.path, 'status', '--json').stdout);
      return {
        selection: status.selection,
        notes: JSON.parse(
          cli(
            mac.path,
            'query',
            'notes',
            "SELECT title FROM notes WHERE title = 'Groceries'",
            '--json',
          ).stdout,
        ),
      };
    };

    const until = await imported('--until', '2025-02-02');
    const since = await imported('--since', '2025-02-03');

    assert.deepEqual(until, {
      selection: 'until 2025-02-02',
      notes: [{ title: 'Groceries' }],
    });
    assert.deepEqual(since, { selection: 'from 2025-02-03', notes: [] });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('one SQL statement runs however it is spaced or commented', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--connector', 'notes');
  cli(mac.path, 'sync');

  const commented = cli(
    mac.path,
    'query',
    'notes',
    '\n  -- how many notes\n  SELECT count(*) AS n FROM notes; -- all of them\n',
    '--json',
  );

  assert.equal(commented.status, 0, commented.stderr);
  assert.equal(JSON.parse(commented.stdout)[0].n, 3);
});

test('sync loads Safari history from its library and tabs from where Safari keeps its sandbox container', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  // Safari keeps history under ~/Library/Safari and its tabs in its sandbox
  // container; the fixture writes both, and the container moves where Safari
  // keeps it.
  const library = join(mac.path, 'Library');
  const { directory, container } = await safariFixture(library);
  const sandboxed = join(
    library,
    'Containers/com.apple.Safari/Data/Library/Safari',
  );
  mkdirSync(dirname(sandboxed), { recursive: true });
  renameSync(container, sandboxed);
  {
    using history = new DatabaseSync(join(directory, 'History.db'));
    history
      .prepare(
        'INSERT INTO history_visits (history_item, visit_time) VALUES (1, ?)',
      )
      .run(appleSeconds('2026-04-01T00:00:00Z'));
  }
  cli(mac.path, 'setup', '--connector', 'safari');

  const synced = cli(mac.path, 'sync');

  assert.equal(synced.status, 0, synced.stderr);
  const visits = cli(
    mac.path,
    'query',
    'safari',
    "SELECT count(*) AS n FROM history_visits WHERE visitedAt LIKE '2026-04-01%'",
    '--json',
  );
  assert.equal(JSON.parse(visits.stdout)[0].n, 1, visits.stderr);
  const tabs = cli(
    mac.path,
    'query',
    'safari',
    'SELECT count(*) AS n FROM tabs',
    '--json',
  );
  assert.ok(JSON.parse(tabs.stdout)[0].n > 0, tabs.stderr);
});

// The user's call history, where callhistoryd keeps it under HOME: every table
// the reader reads, as macOS 27's CallHistory model declares it, holding a
// call from August and one from September, each with one participant.
function withCallHistory(mac: string) {
  const directory = join(mac, 'Library/Application Support/CallHistoryDB');
  mkdirSync(directory, { recursive: true });
  using store = new DatabaseSync(join(directory, 'CallHistory.storedata'));
  store.exec(`
    CREATE TABLE ZCALLDBPROPERTIES ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTIMER_ALL FLOAT, ZTIMER_INCOMING FLOAT, ZTIMER_LAST FLOAT, ZTIMER_LIFETIME FLOAT, ZTIMER_OUTGOING FLOAT );
    CREATE TABLE ZCALLRECORD ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZAUTOANSWEREDREASON INTEGER, ZCALLDIRECTORYIDENTITYTYPE INTEGER, ZCALL_CATEGORY INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA INTEGER, ZFILTERED_OUT_REASON INTEGER, ZHANDLE_TYPE INTEGER, ZHASMESSAGE INTEGER, ZJUNKCONFIDENCE INTEGER, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZSCREENSHARINGTYPE INTEGER, ZUSEDEMERGENCYVIDEOSTREAMING INTEGER, ZVERIFICATIONSTATUS INTEGER, ZWASEMERGENCYCALL INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, ZBLOCKEDBYEXTENSION VARCHAR, ZIDENTITYEXTENSION VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZJUNKIDENTIFICATIONCATEGORY VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZCONVERSATIONID BLOB, ZIMAGEURL VARCHAR, ZLOCALPARTICIPANTUUID BLOB, ZOUTGOINGLOCALPARTICIPANTUUID BLOB, ZPARTICIPANTGROUPUUID BLOB , ZINITIATOR INTEGER, ZBLOCKEDBYEXTENSIONNAME VARCHAR, ZREMINDERUUID BLOB, ZNEEDEDSCANNOUNCEMENT INTEGER, ZCOMMUNICATIONTRUSTSCORE INTEGER, ZORIGINATINGUITYPE INTEGER, ZORIGINATINGDEVICENAME VARCHAR, ZDIDENABLETRANSLATION INTEGER, ZSAINT_DAVIDS_1 INTEGER, ZSAINT_DAVIDS_2 VARCHAR);
    CREATE TABLE ZEMERGENCYMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZEMERGENCYMEDIATYPE INTEGER, ZUPLOADEDFORCALL INTEGER, ZASSETID VARCHAR );
    CREATE TABLE ZHANDLE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR );
    CREATE TABLE ZSAINTDAVIDSCOUNTS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCOUNT INTEGER, ZTYPE INTEGER, ZCALL INTEGER );
    CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES ( Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER, PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES) );
    INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, ZUNIQUE_ID, ZDATE, ZDURATION, ZSERVICE_PROVIDER, ZCALLTYPE, ZCALL_CATEGORY, ZORIGINATED, ZANSWERED)
      VALUES (1, 2, 'CALL-AUGUST', ${appleSeconds('2026-08-20T09:00:00Z')}, 60, 'com.apple.Telephony', 1, 1, 1, 1),
             (2, 2, 'CALL-SEPTEMBER', ${appleSeconds('2026-09-20T09:00:00Z')}, 90, 'com.apple.FaceTime', 16, 1, 0, 1);
    INSERT INTO ZHANDLE (Z_PK, Z_ENT, ZTYPE, ZVALUE, ZNORMALIZEDVALUE)
      VALUES (1, 4, 2, '+15550100100', '+15550100100'), (2, 4, 3, 'ada@example.com', 'ada@example.com');
    INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (1, 1), (2, 2);
    INSERT INTO ZCALLDBPROPERTIES (Z_PK, Z_ENT, ZTIMER_LIFETIME) VALUES (1, 1, 150);
  `);
}

test('call history syncs from where callhistoryd keeps it, and --since keeps the calls from that day on with their participants', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  withCallHistory(mac.path);

  const setup = cli(
    mac.path,
    'setup',
    '--connector',
    'call-history',
    '--since',
    '2026-09-01',
  );
  const synced = cli(mac.path, 'sync');
  const calls = cli(
    mac.path,
    'query',
    'call-history',
    'SELECT id, kind FROM calls',
    '--json',
  );
  const participants = cli(
    mac.path,
    'query',
    'call-history',
    'SELECT callId, value FROM call_participants',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.equal(lines(synced.stdout)[0].connector, 'call-history');
  assert.deepEqual(JSON.parse(calls.stdout), [
    { id: 'CALL-SEPTEMBER', kind: 'faceTimeAudio' },
  ]);
  assert.deepEqual(JSON.parse(participants.stdout), [
    { callId: 'CALL-SEPTEMBER', value: 'ada@example.com' },
  ]);
});

test('call history that macOS keeps behind Full Disk Access fails its sync naming that access', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  // No store under HOME: SQLite cannot open it, as under a privacy denial.
  assert.equal(cli(mac.path, 'setup', '--connector', 'call-history').status, 0);

  const synced = cli(mac.path, 'sync');

  assert.equal(synced.status, 1);
  const [pass] = lines(synced.stdout);
  assert.equal(pass.connector, 'call-history');
  assert.equal(pass.status, 'failed');
  assert.match(pass.error, /Full Disk Access/);
});

// The user's Notification Center, where usernoted keeps it under HOME: the
// tables the reader reads, as macOS 27's usernoted declares them, holding a
// notification from September and one from October.
async function withNotificationCenter(mac: string) {
  const directory = join(
    mac,
    'Library/Group Containers/group.com.apple.usernoted/db2',
  );
  mkdirSync(directory, { recursive: true });
  const deliveries = [
    [
      '1A000000-0000-4000-8000-000000000001',
      '2026-09-20T09:00:00Z',
      'Old news',
    ],
    ['2B000000-0000-4000-8000-000000000002', '2026-10-06T09:00:00Z', 'Lunch?'],
  ] as const;
  using store = new DatabaseSync(join(directory, 'db'));
  store.exec(`
    CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
    CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, request_date REAL, request_last_date REAL, delivered_date REAL, presented Bool, style INTEGER, snooze_fire_date REAL);
    CREATE TABLE categories (app_id INTEGER PRIMARY KEY, categories BLOB);
    INSERT INTO app VALUES (1, 'com.apple.mobilesms', 1);
  `);
  for (const [index, [id, delivered, title]] of deliveries.entries()) {
    const uuid = Uint8Array.from(Buffer.from(id.replaceAll('-', ''), 'hex'));
    store
      .prepare(
        'INSERT INTO record (rec_id, app_id, uuid, data, delivered_date, presented, style) VALUES (?, 1, ?, ?, ?, 0, 1)',
      )
      .run(
        index + 1,
        uuid,
        await binaryPlist(directory, {
          app: 'com.apple.MobileSMS',
          uuid,
          date: appleSeconds(delivered),
          styl: 1,
          req: { titl: title, body: 'From Sam', iden: `message-${index}` },
        }),
        appleSeconds(delivered),
      );
  }
}

test('notification center syncs from where usernoted keeps it, and --since keeps the notifications delivered from that day on', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotificationCenter(mac.path);

  const setup = cli(
    mac.path,
    'setup',
    '--connector',
    'notification-center',
    '--since',
    '2026-10-01',
  );
  const synced = cli(mac.path, 'sync');
  const notifications = cli(
    mac.path,
    'query',
    'notification-center',
    'SELECT id, bundleId, title FROM notifications',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.equal(lines(synced.stdout)[0].connector, 'notification-center');
  assert.deepEqual(JSON.parse(notifications.stdout), [
    {
      id: '2B000000-0000-4000-8000-000000000002',
      bundleId: 'com.apple.MobileSMS',
      title: 'Lunch?',
    },
  ]);
});

// The user's Wallet, where passd keeps it under HOME: the columns the reader
// reads, typed as macOS 27's passd declares them, and one boarding pass's
// bundle.
function withWallet(mac: string) {
  const directory = join(mac, 'Library/Passes');
  const bundle = join(directory, 'Cards/Rj5JgNLqUsLcgX514jcGtHwF+aI=.pkpass');
  mkdirSync(bundle, { recursive: true });
  const pass = JSON.stringify({
    formatVersion: 1,
    passTypeIdentifier: 'pass.com.example.airline',
    serialNumber: 'BP-845',
    teamIdentifier: 'TEAM123456',
    organizationName: 'Example Air',
    description: 'Boarding pass',
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: 'M1RIVERA/SAM E9U5XWF KULDOHEA 0845',
        messageEncoding: 'iso-8859-1',
      },
    ],
    boardingPass: {
      transitType: 'PKTransitTypeAir',
      headerFields: [{ key: 'boarding-gate', label: 'GATE', value: 'C1' }],
    },
  });
  writeFileSync(join(bundle, 'pass.json'), pass);
  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      'pass.json': createHash('sha1').update(pass).digest('hex'),
    }),
  );
  using store = new DatabaseSync(join(directory, 'passes23.sqlite'));
  store.exec(`
    CREATE TABLE "pass" ("pid" INTEGER, "unique_id" TEXT NOT NULL, "pass_type_pid" INTEGER NOT NULL, "serial_number" TEXT NOT NULL, "signing_date" INTEGER, "ingested_date" INTEGER, "modified_date" INTEGER, PRIMARY KEY (pid));
    CREATE TABLE pass_annotations (pass_pid INTEGER, sorting_state INTEGER, archived_timestamp INTEGER, PRIMARY KEY (pass_pid));
    INSERT INTO pass VALUES (1, 'Rj5JgNLqUsLcgX514jcGtHwF+aI=', 1, 'BP-845', 779580466, 779621300.66, 779621300.97);
    INSERT INTO pass_annotations VALUES (1, 0, NULL);
  `);
}

test('wallet syncs the passes where passd keeps them, with their fields', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  withWallet(mac.path);

  const setup = cli(mac.path, 'setup', '--connector', 'wallet');
  const synced = cli(mac.path, 'sync');
  const passes = cli(
    mac.path,
    'query',
    'wallet',
    'SELECT organizationName, style FROM passes',
    '--json',
  );
  const fields = cli(
    mac.path,
    'query',
    'wallet',
    'SELECT label, value FROM pass_fields',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.equal(lines(synced.stdout)[0].connector, 'wallet');
  assert.deepEqual(JSON.parse(passes.stdout), [
    { organizationName: 'Example Air', style: 'boardingPass' },
  ]);
  assert.deepEqual(JSON.parse(fields.stdout), [{ label: 'GATE', value: 'C1' }]);
});

// The Slack app's store as it leaves it: Chromium's IndexedDB for
// app.slack.com in LevelDB, one log record holding the database's and object
// store's names and the workspace's client state, which Blink keeps as V8's
// serialization in its envelope.
function withSlack(mac: string) {
  const directory = join(
    mac,
    'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/IndexedDB/https_app.slack.com_0.indexeddb.leveldb',
  );
  mkdirSync(directory, { recursive: true });
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  const maskedCrc = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes)
      crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
  };
  const varint = (value: number) => {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    return Buffer.from([...bytes, rest]);
  };
  const prefixed = (bytes: Buffer) =>
    Buffer.concat([varint(bytes.length), bytes]);
  const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
  const withLength = (text: string) =>
    Buffer.concat([varint(text.length), utf16be(text)]);
  const record = (payload: Buffer) => {
    const header = Buffer.alloc(7);
    header.writeUInt32LE(maskedCrc(Buffer.concat([Buffer.of(1), payload])));
    header.writeUInt16LE(payload.length, 4);
    header.writeUInt8(1, 6);
    return Buffer.concat([header, payload]);
  };
  const serializer = new v8.Serializer();
  serializer.writeHeader();
  serializer.writeValue({
    selfTeamIds: { teamId: 'T1' },
    teams: { T1: { id: 'T1', name: 'January', domain: 'january', plan: '' } },
    channels: {
      C1: { id: 'C1', name: 'general', is_channel: true, is_member: true },
    },
    members: { U1: { id: 'U1', name: 'ezz', real_name: 'Ezz', profile: {} } },
    messages: {
      C1: {
        '1758445200.000100': {
          type: 'message',
          ts: '1758445200.000100',
          user: 'U1',
          text: 'before',
        },
        '1790000000.000100': {
          type: 'message',
          ts: '1790000000.000100',
          user: 'U1',
          text: 'after',
        },
      },
    },
    channelHistory: {
      C1: {
        slices: [
          {
            start: '1758445200.000100',
            end: '1790000000.000100',
            timestamps: ['1758445200.000100', '1790000000.000100'],
          },
        ],
      },
    },
  });
  const v8Bytes = serializer.releaseBuffer();
  // Slack's V8 writes format 16, which differs from Node's 15 only for buffers.
  v8Bytes[1] = 16;
  const value = Buffer.concat([
    varint(1),
    Buffer.of(0xff, 0x15, 0xfe),
    Buffer.alloc(12),
    v8Bytes,
  ]);
  const writes = [
    [
      Buffer.concat([
        Buffer.of(0, 0, 0, 0, 201),
        withLength('https_app.slack.com_0@1'),
        withLength('reduxPersistence'),
      ]),
      Buffer.of(2),
    ],
    [
      Buffer.concat([Buffer.of(0, 2, 0, 0, 50, 1, 0)]),
      utf16be('reduxPersistenceStore'),
    ],
    [
      Buffer.concat([
        Buffer.of(0, 2, 1, 1, 1),
        withLength('persist:slack-client-T1-U1'),
      ]),
      value,
    ],
  ] as const;
  const batch = Buffer.alloc(12);
  batch.writeBigUInt64LE(1n);
  batch.writeUInt32LE(writes.length, 8);
  writeFileSync(
    join(directory, '000003.log'),
    record(
      Buffer.concat([
        batch,
        ...writes.flatMap(([key, data]) => [
          Buffer.of(1),
          prefixed(key),
          prefixed(data),
        ]),
      ]),
    ),
  );
  const edit = Buffer.concat([
    varint(1),
    prefixed(Buffer.from('idb_cmp1')),
    varint(2),
    varint(0),
  ]);
  writeFileSync(join(directory, 'MANIFEST-000001'), record(edit));
  writeFileSync(join(directory, 'CURRENT'), 'MANIFEST-000001\n');
}

test('slack syncs from the store the Slack app keeps, and --since keeps the messages sent from that day on', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  withSlack(mac.path);

  const setup = cli(
    mac.path,
    'setup',
    '--connector',
    'slack',
    '--since',
    '2026-01-01',
  );
  const synced = cli(mac.path, 'sync');
  const messages = cli(
    mac.path,
    'query',
    'slack',
    'SELECT channelId, ts, sentAt, text FROM messages',
    '--json',
  );

  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.equal(lines(synced.stdout)[0].connector, 'slack');
  assert.deepEqual(JSON.parse(messages.stdout), [
    {
      channelId: 'C1',
      ts: '1790000000.000100',
      sentAt: '2026-09-21T14:13:20.000100Z',
      text: 'after',
    },
  ]);
});
