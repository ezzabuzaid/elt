import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, realpathSync, renameSync } from 'node:fs';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
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
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [entry, ...args],
    { cwd: mac, env: { ...process.env, HOME: mac }, encoding: 'utf8' },
  );
  return { status, stdout, stderr };
}

// The user's Notes, where Notes keeps them under HOME. Only Notes has a store
// here; every other app finds nothing, as on a Mac that denies access.
const withNotes = (mac: string) =>
  noteStoreFixture(join(mac, 'Library/Group Containers/group.com.apple.notes'));

// The CLI in a terminal of its own, typed into as a person would: expect,
// which macOS ships, gives it a 120×40 pseudo-terminal, relays keys and exits
// with the CLI's status.
function terminal(mac: string, ...args: string[]) {
  const child = spawn(
    '/usr/bin/expect',
    [
      '-c',
      `set stty_init {columns 120 rows 40}; spawn -noecho {${process.execPath}} {${entry}} ${args.join(' ')}; interact; lassign [wait] pid spawned failed status; exit $status`,
    ],
    { cwd: mac, env: { ...process.env, HOME: mac } },
  );
  let screen = '';
  child.stdout.on('data', (data) => {
    screen += stripVTControlCharacters(String(data));
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
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

const down = '\x1b[B';
const space = ' ';
const enter = '\r';

const lines = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('an app macOS will not open fails alone, named with the access to grant, while the others load', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  assert.equal(
    cli(mac.path, 'setup', '--app', 'notes', '--app', 'messages').status,
    0,
  );

  const synced = cli(mac.path, 'sync');

  assert.equal(synced.status, 1);
  const passes = Object.fromEntries(
    lines(synced.stdout).map((pass) => [pass.app, pass]),
  );
  assert.equal(passes.notes.status, 'succeeded');
  assert.equal(passes.messages.status, 'failed');
  assert.match(passes.messages.error, /Full Disk Access/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ app, state }: { app: string; state: string }) => [
      app,
      state,
    ]),
    [
      ['notes', 'succeeded'],
      ['messages', 'failed'],
    ],
  );
});

test('a second sync is refused while another holds the store, and nothing it imported is touched', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');
  // Stands in for a running sync: a real one would be `sync --watch`, which
  // launches the real Notes app. A sync holds this lock for its whole run.
  mkdirSync(join(mac.path, 'outputs/cli'), { recursive: true });
  using held = new DatabaseSync(join(mac.path, 'outputs/cli/lease.sqlite'));
  held.exec('BEGIN EXCLUSIVE');

  const second = cli(mac.path, 'sync');
  const rescoped = cli(
    mac.path,
    'setup',
    '--app',
    'notes',
    '--collection',
    'FOLDER-NOTES',
  );

  assert.equal(second.status, 1);
  assert.match(second.stderr, /Another sync is using this store/);
  assert.equal(rescoped.status, 1);
  const notes = cli(
    mac.path,
    'query',
    'notes',
    'SELECT count(*) AS n FROM notes',
    '--json',
  );
  assert.ok(JSON.parse(notes.stdout)[0].n > 0);
});

test('setup, sync, status and query read the Notes this Mac holds through documented views', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);

  const setup = cli(mac.path, 'setup', '--app', 'notes', '--json');
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
    apps: [{ app: 'notes', scope: {}, includeAttachments: true }],
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
      'SELECT app, database FROM selected_apps',
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(
    JSON.parse(selected.stdout).map(
      ({ app, database }: { app: string; database: string }) => [
        app,
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

test('changing what an app imports, down to its attachments, loads the new selection completely on the next sync', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
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

  // Narrowing flags bind to the --app before them, here the second one.
  const rescoped = cli(
    mac.path,
    'setup',
    '--app',
    'messages',
    '--app',
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
  const notesPass = lines(synced.stdout).find(({ app }) => app === 'notes');
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
  cli(mac.path, 'setup', '--app', 'notes');
  cli(mac.path, 'sync');

  const unnamed = cli(mac.path, 'setup');
  const misplaced = cli(
    mac.path,
    'setup',
    '--collection',
    'FOLDER-NOTES',
    '--app',
    'notes',
  );
  const undated = cli(
    mac.path,
    'setup',
    '--app',
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
  const unselected = cli(mac.path, 'sync', '--app', 'calendar');
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
  assert.match(unnamed.stderr, /--app/);
  assert.match(misplaced.stderr, /must follow the --app/);
  assert.match(undated.stderr, /date filtering is unavailable/);
  assert.match(twoStatements.stderr, /one SQL statement/);
  const status = JSON.parse(cli(mac.path, 'status', '--json').stdout);
  assert.deepEqual(
    status.map(({ app }: { app: string }) => app),
    ['notes'],
  );
});

test('the setup wizard saves what the person picks and syncs it when asked', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  const wizard = terminal(mac.path, 'setup');
  try {
    await wizard.shows('Which apps should be imported?');
    // Apps are listed by name; Notes is the sixth.
    await wizard.type(down, down, down, down, down, space, enter);
    await wizard.shows('Narrow any app?');
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

test('one SQL statement runs however it is spaced or commented', async () => {
  await using mac = await mkdtempDisposable(join(tmpdir(), 'cli-e2e-'));
  await withNotes(mac.path);
  cli(mac.path, 'setup', '--app', 'notes');
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

test('sync --watch loads each change Safari commits until Ctrl-C stops it, keeping every pass it finished', async () => {
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
  cli(mac.path, 'setup', '--app', 'safari');
  const watching = spawn(process.execPath, [entry, 'sync', '--watch'], {
    cwd: mac.path,
    env: { ...process.env, HOME: mac.path },
  });
  try {
    let stdout = '';
    watching.stdout.on('data', (data) => {
      stdout += String(data);
    });
    const passes = () => (stdout.trim() === '' ? [] : lines(stdout));
    const until = async (done: () => boolean) => {
      for (let tries = 0; !done(); tries++) {
        if (tries > 200) assert.fail(`never happened:\n${stdout}`);
        await sleep(100);
      }
    };
    await until(() => passes().length === 1);

    {
      using history = new DatabaseSync(join(directory, 'History.db'));
      history
        .prepare(
          'INSERT INTO history_visits (history_item, visit_time) VALUES (1, ?)',
        )
        .run(appleSeconds('2026-04-01T00:00:00Z'));
    }
    await until(() =>
      passes().some(({ streams }) =>
        streams.some(
          ({ stream, written }: { stream: string; written: number }) =>
            stream === 'historyVisits' && written === 1,
        ),
      ),
    );
    watching.kill('SIGINT');
    const [code] = await once(watching, 'close');

    assert.equal(code, 130);
    assert.ok(
      passes().every(({ status }) => status === 'succeeded'),
      stdout,
    );
    const visits = cli(
      mac.path,
      'query',
      'safari',
      "SELECT count(*) AS n FROM history_visits WHERE visitedAt LIKE '2026-04-01%'",
      '--json',
    );
    assert.equal(JSON.parse(visits.stdout)[0].n, 1, visits.stderr);
  } finally {
    watching.kill();
  }
});
