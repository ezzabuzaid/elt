import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Source,
  StreamStatus,
  readerCatalog,
  syncHistoryRelations,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { AppleSafariSource } from './apple-safari-source.ts';

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

// Seconds since 2001-01-01, as Safari's databases store times.
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

const rows = <T extends object>(found: Iterable<T>) =>
  [...found].map((row) => ({ ...row }));

test('Safari reads history, iCloud Tabs, bookmarks and recently closed tabs as documented views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const safari = await appleImport(
    new AppleSafariSource(location),
    join(scratch.path, 'import'),
  );

  await safari.load();

  assert.deepEqual(
    (await new AppleSafariSource(location).discover()).streams
      .map(({ name }) => snake(name))
      .sort(),
    [
      'bookmarks',
      'closed_tabs',
      'closed_window_active_tabs',
      'closed_windows',
      'cloud_tab_close_requests',
      'cloud_tab_devices',
      'cloud_tab_positions',
      'cloud_tabs',
      'downloads',
      'history_item_tags',
      'history_items',
      'history_tags',
      'history_tombstones',
      'history_visits',
      'profile_start_page_sections',
      'profiles',
      'reading_list_items',
      'tab_groups',
      'tab_history_entries',
      'tabs',
      'window_profiles',
      'window_tab_groups',
      'windows',
    ],
  );
  // Every stream reads through its own view, and every view and column is
  // described.
  assert.deepEqual(
    rows(
      safari.read(`SELECT name FROM catalog WHERE kind = 'view' ORDER BY name`),
    )
      .map(({ name }) => name)
      .filter(
        (name) =>
          name !== readerCatalog.name &&
          !Object.values(syncHistoryRelations).some(
            (relation) => relation.name === name,
          ),
      ),
    (await new AppleSafariSource(location).discover()).streams
      .map(({ name }) => snake(name))
      .sort(),
  );
  assert.deepEqual(
    rows(
      safari.read(
        `SELECT kind, name FROM catalog WHERE coalesce(description, '') = ''`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT name, data_type FROM catalog
        WHERE name IN ('history_items.dailyVisitCounts', 'history_items.autocompleteTriggers', 'history_visits.visitedAt', 'closed_tabs.ancestorTabIds')
        ORDER BY name`),
    ),
    [
      { name: 'closed_tabs.ancestorTabIds', data_type: 'text[]' },
      {
        name: 'history_items.autocompleteTriggers',
        data_type: 'text[]',
      },
      { name: 'history_items.dailyVisitCounts', data_type: 'integer[]' },
      {
        name: 'history_visits.visitedAt',
        data_type: 'timestamp',
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT id, url, "dailyVisitCounts" AS daily, "weeklyVisitCounts" AS weekly,
        "autocompleteTriggers" AS triggers, "statusCode", "derivedCountsStale"
        FROM history_items WHERE "profileId" = 'DefaultProfile' ORDER BY id`),
    ),
    [
      {
        id: 1,
        url: 'https://example.com/',
        daily: '[20,0]',
        weekly: null,
        triggers: null,
        statusCode: null,
        derivedCountsStale: 0,
      },
      {
        id: 2,
        url: 'https://example.org/',
        daily: '[0,20]',
        weekly: '[80]',
        triggers: '["exa","examp"]',
        statusCode: 200,
        derivedCountsStale: 1,
      },
    ],
  );
  // A redirect joins its two visits; an empty title reads as NULL.
  assert.deepEqual(
    rows(
      safari.read(`SELECT s.id AS source, d.id AS destination, s.title, d."loadSuccessful", s.origin, s."httpNonGet",
        strftime('%Y-%m-%dT%H:%M:%SZ', d."visitedAt") AS at
        FROM history_visits s JOIN history_visits d ON d."profileId" = s."profileId" AND d.id = s."redirectDestinationId"`),
    ),
    [
      {
        source: 11,
        destination: 12,
        title: null,
        loadSuccessful: 0,
        origin: 1,
        httpNonGet: 1,
        at: '2026-02-10T09:00:01Z',
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT i.url, t.identifier, t.title FROM history_item_tags l
        JOIN history_items i ON i."profileId" = l."profileId" AND i.id = l."itemId" JOIN history_tags t ON t."profileId" = l."profileId" AND t.id = l."tagId"`),
    ),
    [{ url: 'https://example.com/', identifier: 'Q2063', title: 'JSON' }],
  );
  // Safari 27 stores a deleted URL encrypted, and an unbounded start as year 1.
  assert.deepEqual(
    rows(
      safari.read(`SELECT id, url, "encryptedUrl", "startAt" IS NULL AS unbounded, "deviceId"
        FROM history_tombstones ORDER BY id`),
    ),
    [
      {
        id: 1,
        url: 'https://gone.example/',
        encryptedUrl: null,
        unbounded: 0,
        deviceId: 'DEVICE-1',
      },
      {
        id: 2,
        url: null,
        encryptedUrl: 'Qo8K',
        unbounded: 1,
        deviceId: 'DEVICE-1',
      },
      // Clearing a time range records the range and no URL.
      {
        id: 3,
        url: null,
        encryptedUrl: null,
        unbounded: 0,
        deviceId: 'DEVICE-1',
      },
    ],
  );
  // Every profile keeps its own History.db; its rows carry the profile.
  assert.deepEqual(
    rows(
      safari.read(`SELECT v."profileId", p.title, count(*) AS visits
        FROM history_visits v JOIN profiles p ON p.id = v."profileId"
        GROUP BY 1, 2 ORDER BY 1`),
    ),
    [
      { profileId: 'DefaultProfile', title: null, visits: 3 },
      { profileId: 'PROFILE-WORK', title: 'Work', visits: 1 },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT t.title, d.name, t.pinned, t."lastViewedAt", p."sortValue", r.id AS close_request
        FROM cloud_tabs t JOIN cloud_tab_devices d ON d.id = t."deviceId"
        JOIN cloud_tab_positions p ON p."tabId" = t.id
        JOIN cloud_tab_close_requests r ON r."tabId" = t.id`),
    ),
    [
      {
        title: 'Remote',
        name: 'Phone',
        pinned: 1,
        lastViewedAt: null,
        sortValue: 1500,
        close_request: 'CR-1',
      },
    ],
  );
  // The Reading List folder is a bookmark; its items are their own stream.
  assert.deepEqual(
    rows(
      safari.read(`SELECT b.id, p.title AS folder, b.position, b.kind, b.title, b.url, b.hidden
        FROM bookmarks b LEFT JOIN bookmarks p ON p.id = b."parentId" ORDER BY b.id`),
    ),
    [
      {
        id: 'BAR',
        folder: null,
        position: 1,
        kind: 'folder',
        title: 'BookmarksBar',
        url: null,
        hidden: 0,
      },
      {
        id: 'BM-1',
        folder: 'BookmarksBar',
        position: 0,
        kind: 'bookmark',
        title: 'Example',
        url: 'https://example.com/',
        hidden: 0,
      },
      {
        id: 'BM-2',
        folder: 'Reading',
        position: 0,
        kind: 'bookmark',
        title: 'Nested',
        url: 'https://example.org/nested',
        hidden: 0,
      },
      {
        id: 'FOLDER-1',
        folder: 'BookmarksBar',
        position: 1,
        kind: 'folder',
        title: 'Reading',
        url: null,
        hidden: 0,
      },
      {
        id: 'MENU',
        folder: null,
        position: 2,
        kind: 'folder',
        title: 'BookmarksMenu',
        url: null,
        hidden: 0,
      },
      {
        id: 'PROXY-HISTORY',
        folder: null,
        position: 0,
        kind: 'proxy',
        title: 'History',
        url: null,
        hidden: 0,
      },
      {
        id: 'READING-LIST',
        folder: null,
        position: 3,
        kind: 'folder',
        title: 'com.apple.ReadingList',
        url: null,
        hidden: 1,
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(
        `SELECT id, title, "fetchedTitle", "previewText", "lastViewedAt", "fetchResult" FROM reading_list_items`,
      ),
    ),
    [
      {
        id: 'RL-1',
        title: 'Saved',
        fetchedTitle: 'Fetched title',
        previewText: 'A preview',
        lastViewedAt: null,
        fetchResult: 1,
      },
    ],
  );
  // A tab closed on its own keeps no window; year 1 means never visited.
  assert.deepEqual(
    rows(
      safari.read(`SELECT t.id, t."closedWindowId", t.position, t."lastVisitedAt" IS NULL AS never,
        t."ancestorTabIds" AS ancestors, w."addressFieldText", a."tabId" = t.id AS active
        FROM closed_tabs t LEFT JOIN closed_windows w ON w.id = t."closedWindowId"
        LEFT JOIN closed_window_active_tabs a ON a."windowId" = w.id ORDER BY t.id`),
    ),
    [
      {
        id: 'CT-1',
        closedWindowId: null,
        position: 0,
        never: 1,
        ancestors: '["CT-0"]',
        addressFieldText: null,
        active: null,
      },
      {
        id: 'CT-2',
        closedWindowId: 'W-1',
        position: 0,
        never: 0,
        ancestors: '[]',
        addressFieldText: 'half typed',
        active: 0,
      },
      {
        id: 'CT-3',
        closedWindowId: 'W-1',
        position: 1,
        never: 0,
        ancestors: '[]',
        addressFieldText: 'half typed',
        active: 1,
      },
    ],
  );
});

test('Safari reads profiles, windows, tab groups, tabs with their back and forward lists, and downloads with their files', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const safari = await appleImport(
    new AppleSafariSource(location),
    join(scratch.path, 'import'),
  );

  await safari.load();

  assert.deepEqual(
    rows(
      safari.read(`SELECT id, "serverId", title, symbol, "colorName", red, alpha, "favoritesFolderServerId"
        FROM profiles ORDER BY position`),
    ),
    [
      {
        id: 'DefaultProfile',
        serverId: 'DefaultProfile',
        title: null,
        symbol: 'person.fill',
        colorName: null,
        red: null,
        alpha: null,
        favoritesFolderServerId: null,
      },
      {
        id: 'PROFILE-WORK',
        serverId: 'SERVER-WORK',
        title: 'Work',
        symbol: 'briefcase.fill',
        colorName: 'heatherBlue',
        red: 0.62,
        alpha: 1,
        favoritesFolderServerId: 'FAV-WORK',
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(
        `SELECT identifier, enabled FROM profile_start_page_sections WHERE "profileId" = 'PROFILE-WORK' ORDER BY position`,
      ),
    ),
    [
      { identifier: 'favoritesItemIdentifier', enabled: 1 },
      { identifier: 'privacyReportIdentifier', enabled: 0 },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT id, kind, "profileId", "parentId", title, "lastSelectedTabId", "deviceType", topic
        FROM tab_groups ORDER BY id`),
    ),
    [
      {
        id: 'DEVICE-FOLDER',
        kind: 'device',
        profileId: 'PROFILE-WORK',
        parentId: 'PROFILE-WORK',
        title: 'Mac',
        lastSelectedTabId: null,
        deviceType: 'com.apple.macbookpro',
        topic: null,
      },
      {
        id: 'GROUP-FAVORITES',
        kind: 'favorites',
        profileId: 'DefaultProfile',
        parentId: 'GROUP-NAMED',
        title: 'TopScopedBookmarkList',
        lastSelectedTabId: null,
        deviceType: null,
        topic: null,
      },
      {
        id: 'GROUP-LOCAL',
        kind: 'local',
        profileId: 'DefaultProfile',
        parentId: null,
        title: 'Local',
        lastSelectedTabId: null,
        deviceType: null,
        topic: null,
      },
      {
        id: 'GROUP-NAMED',
        kind: 'named',
        profileId: 'DefaultProfile',
        parentId: null,
        title: 'Research',
        lastSelectedTabId: 'TAB-NAMED',
        deviceType: null,
        topic: 'Science',
      },
      {
        id: 'GROUP-PRIVATE',
        kind: 'private',
        profileId: 'DefaultProfile',
        parentId: null,
        title: 'Private',
        lastSelectedTabId: null,
        deviceType: null,
        topic: null,
      },
      {
        id: 'GROUP-WORK',
        kind: 'unnamed',
        profileId: 'PROFILE-WORK',
        parentId: 'DEVICE-FOLDER',
        title: 'Unnamed',
        lastSelectedTabId: null,
        deviceType: null,
        topic: null,
      },
      {
        id: 'pinned',
        kind: 'pinned',
        profileId: null,
        parentId: null,
        title: 'pinned',
        lastSelectedTabId: null,
        deviceType: null,
        topic: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT id, kind, "profileId", "tabGroupId", "windowId", pinned, "pinnedUrl", muted,
        "lastAccessedAt", "localTitle", "pageKeywords" AS keywords, "pageKeywordWeights" AS weights,
        "pageSummary", "ancestorTabIds" AS ancestors
        FROM tabs ORDER BY id`),
    ),
    [
      {
        id: 'TAB-FAVORITE',
        kind: 'favorite',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-FAVORITES',
        windowId: null,
        pinned: 0,
        pinnedUrl: null,
        muted: 0,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '[]',
        weights: '[]',
        pageSummary: null,
        ancestors: '[]',
      },
      {
        id: 'TAB-LOCAL',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-LOCAL',
        windowId: 'WIN-1',
        pinned: 0,
        pinnedUrl: null,
        muted: 0,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '[]',
        weights: '[]',
        pageSummary: null,
        ancestors: '[]',
      },
      {
        id: 'TAB-NAMED',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-NAMED',
        windowId: 'WIN-1',
        pinned: 0,
        pinnedUrl: null,
        muted: 1,
        lastAccessedAt: null,
        localTitle: 'Research here',
        keywords: '["physics","lab"]',
        weights: '[0.9,0.25]',
        pageSummary: null,
        ancestors: '["TAB-LOCAL"]',
      },
      {
        id: 'TAB-PINNED',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'pinned',
        windowId: 'WIN-1',
        pinned: 1,
        pinnedUrl: 'https://mail.example/',
        muted: 0,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '[]',
        weights: '[]',
        pageSummary: null,
        ancestors: '[]',
      },
      {
        id: 'TAB-WORK',
        kind: 'tab',
        profileId: 'PROFILE-WORK',
        tabGroupId: 'GROUP-WORK',
        windowId: 'WIN-2',
        pinned: 0,
        pinnedUrl: null,
        muted: 0,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '[]',
        weights: '[]',
        pageSummary: null,
        ancestors: '[]',
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT position, current, url, "originalUrl", "scriptCreated", "externalUrlPolicy"
        FROM tab_history_entries WHERE "tabId" = 'TAB-NAMED' ORDER BY position`),
    ),
    [
      {
        position: 0,
        current: 0,
        url: 'https://example.com/start',
        originalUrl: 'http://example.com/start',
        scriptCreated: 0,
        externalUrlPolicy: null,
      },
      {
        position: 1,
        current: 1,
        url: 'https://example.com/research',
        originalUrl: 'https://example.com/research',
        scriptCreated: 1,
        externalUrlPolicy: 'allow',
      },
    ],
  );
  // A window names its profile, groups and state; NSNotFound reads as NULL.
  assert.deepEqual(
    rows(
      safari.read(`SELECT w.id, w."profileId", w."activeTabGroupId", w."localTabGroupId", w."privateTabGroupId",
        w."selectedPinnedTabIndex", w."favoritesBarHidden", w."unnamedTabGroupIds" AS unnamed,
        g."activeTabId", p."activeTabGroupId" AS profile_group
        FROM windows w
        LEFT JOIN window_tab_groups g ON g."windowId" = w.id AND g."tabGroupId" = w."activeTabGroupId"
        LEFT JOIN window_profiles p ON p."windowId" = w.id ORDER BY w.id`),
    ),
    [
      {
        id: 'WIN-1',
        profileId: 'DefaultProfile',
        activeTabGroupId: 'GROUP-NAMED',
        localTabGroupId: 'GROUP-LOCAL',
        privateTabGroupId: 'GROUP-PRIVATE',
        selectedPinnedTabIndex: null,
        favoritesBarHidden: 1,
        unnamed: '["GROUP-LOCAL"]',
        activeTabId: 'TAB-NAMED',
        profile_group: 'GROUP-NAMED',
      },
      {
        id: 'WIN-2',
        profileId: 'PROFILE-WORK',
        activeTabGroupId: 'GROUP-WORK',
        localTabGroupId: null,
        privateTabGroupId: null,
        selectedPinnedTabIndex: null,
        favoritesBarHidden: 0,
        unnamed: '[]',
        activeTabId: null,
        profile_group: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(
        `SELECT "windowId", "tabGroupId", "activeTabId", unnamed FROM window_tab_groups ORDER BY 2`,
      ),
    ),
    [
      {
        windowId: 'WIN-1',
        tabGroupId: 'GROUP-LOCAL',
        activeTabId: null,
        unnamed: 1,
      },
      {
        windowId: 'WIN-1',
        tabGroupId: 'GROUP-NAMED',
        activeTabId: 'TAB-NAMED',
        unnamed: 0,
      },
    ],
  );
  // A download still on disk is stored; an archive Safari opened is gone.
  const downloads = rows(
    safari.read(`SELECT id, "profileId", "availableLocally", "openedPath" IS NOT NULL AS opened, "attachmentRef"
      FROM downloads ORDER BY id`),
  );
  assert.deepEqual(
    downloads.map(({ attachmentRef: _, ...download }) => download),
    [
      {
        id: 'DL-1',
        profileId: 'DefaultProfile',
        availableLocally: 1,
        opened: 0,
      },
      {
        id: 'DL-2',
        profileId: 'PROFILE-WORK',
        availableLocally: 0,
        opened: 1,
      },
    ],
  );
  assert.equal(
    await readFile(String(downloads[0]?.attachmentRef), 'utf8'),
    'downloaded bytes',
  );
  assert.equal(downloads[1]?.attachmentRef, null);
});

test('Safari follows each store on its own: a rerun writes nothing, and edits and deletions land', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const safari = await appleImport(
    new AppleSafariSource(location),
    join(scratch.path, 'import'),
  );
  // What a load committed to the visits and bookmarks it copied.
  const written = (loaded: Awaited<ReturnType<typeof safari.load>>) =>
    Object.fromEntries(
      loaded
        .filter(({ copy }) =>
          ['historyVisits', 'bookmarks'].includes(copy.from.name),
        )
        .map(({ copy, count, deleted }) => [
          copy.from.name,
          { count, deleted },
        ]),
    );
  const first = written(await safari.load());

  const unchanged = written(await safari.load());
  {
    using history = new DatabaseSync(join(location.directory, 'History.db'));
    history.exec('DELETE FROM history_visits WHERE id = 10');
    history.exec('UPDATE history_items SET visit_count = 3 WHERE id = 2');
  }
  {
    using cloud = new DatabaseSync(join(location.container, 'CloudTabs.db'));
    cloud.exec('DELETE FROM cloud_tab_devices');
  }
  await writePlist(join(location.directory, 'Bookmarks.plist'), {
    ...bookmarksPlist,
    Children: bookmarksPlist.Children.map((folder) =>
      folder.WebBookmarkUUID === 'BAR' && 'Children' in folder
        ? { ...folder, Children: folder.Children.slice(1) }
        : folder,
    ),
  });
  await writePlist(join(location.directory, 'RecentlyClosedTabs.plist'), {
    ...closedTabsPlist,
    ClosedTabOrWindowPersistentStates:
      closedTabsPlist.ClosedTabOrWindowPersistentStates.slice(1, 2),
  });
  await safari.load();

  assert.deepEqual(first, {
    historyVisits: { count: 4, deleted: 0 },
    bookmarks: { count: 7, deleted: 0 },
  });
  assert.deepEqual(unchanged, {
    historyVisits: { count: 0, deleted: 0 },
    bookmarks: { count: 0, deleted: 0 },
  });
  assert.deepEqual(
    safari
      .read(
        `SELECT id FROM history_visits WHERE "profileId" = 'DefaultProfile' ORDER BY id`,
      )
      .map(({ id }) => id),
    [11, 12],
  );
  assert.deepEqual(
    rows(
      safari.read(
        `SELECT id, "visitCount" FROM history_items WHERE "profileId" = 'DefaultProfile' ORDER BY id`,
      ),
    ),
    [
      { id: 1, visitCount: 2 },
      { id: 2, visitCount: 3 },
    ],
  );
  assert.deepEqual(
    rows(
      safari.read(`SELECT (SELECT count(*) FROM cloud_tabs) AS tabs,
        (SELECT count(*) FROM cloud_tab_positions) AS positions,
        (SELECT count(*) FROM cloud_tab_devices) AS devices`),
    ),
    [{ tabs: 0, positions: 0, devices: 0 }],
  );
  assert.deepEqual(
    safari
      .read(`SELECT id FROM bookmarks WHERE kind = 'bookmark' ORDER BY id`)
      .map(({ id }) => id),
    ['BM-2'],
  );
  assert.deepEqual(
    safari.read(`SELECT id FROM closed_tabs ORDER BY id`).map(({ id }) => id),
    ['CT-2', 'CT-3'],
  );
});

test('Safari scope keeps the chosen profiles and visit dates, and leaves unattributed data whole', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  // Each selection is its own import, as a host replaces one whose
  // selection changed.
  const counts = async (scope: ImportScope) => {
    const safari = await appleImport(
      new AppleSafariSource({ ...location, scope }),
      await mkdtemp(join(scratch.path, 'import-')),
    );
    await safari.load();
    return rows(
      safari.read(`SELECT (SELECT count(*) FROM history_visits) AS visits,
        (SELECT count(*) FROM history_items) AS items,
        (SELECT count(*) FROM history_tags) AS tags,
        (SELECT count(*) FROM history_tombstones) AS tombstones,
        (SELECT count(*) FROM closed_tabs) AS closed,
        (SELECT count(*) FROM tabs) AS tabs,
        (SELECT count(*) FROM tab_groups) AS groups,
        (SELECT count(*) FROM downloads) AS downloads,
        (SELECT count(*) FROM bookmarks) AS bookmarks,
        (SELECT count(*) FROM cloud_tabs) AS cloud`),
    )[0];
  };

  const february = await counts({
    startAt: '2026-02-01T00:00:00.000Z',
    endAt: '2026-03-01T00:00:00.000Z',
  });
  const otherProfile = await counts({ collectionIds: ['ANOTHER-PROFILE'] });
  const defaultProfile = await counts({ collectionIds: ['DefaultProfile'] });
  const work = await counts({ collectionIds: ['PROFILE-WORK'] });

  // Dates select visits, and the items and tags they reach, in every profile.
  assert.deepEqual(february, {
    visits: 3,
    items: 3,
    tags: 1,
    tombstones: 3,
    closed: 3,
    tabs: 5,
    groups: 7,
    downloads: 2,
    bookmarks: 7,
    cloud: 1,
  });
  assert.deepEqual(otherProfile, {
    visits: 0,
    items: 0,
    tags: 0,
    tombstones: 0,
    closed: 0,
    tabs: 0,
    groups: 1,
    downloads: 0,
    bookmarks: 7,
    cloud: 1,
  });
  assert.deepEqual(defaultProfile, {
    visits: 3,
    items: 2,
    tags: 1,
    tombstones: 3,
    closed: 3,
    tabs: 4,
    groups: 5,
    downloads: 1,
    bookmarks: 7,
    cloud: 1,
  });
  assert.deepEqual(work, {
    visits: 1,
    items: 1,
    tags: 0,
    tombstones: 0,
    closed: 0,
    tabs: 1,
    groups: 3,
    downloads: 1,
    bookmarks: 7,
    cloud: 1,
  });
});

test('Safari names Full Disk Access for an unreadable store, refuses an unknown layout, and keeps the rows it had', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const source = new AppleSafariSource(location);
  const safari = await appleImport(source, join(scratch.path, 'import'));
  await safari.load();
  await rm(join(location.directory, 'Bookmarks.plist'));
  {
    using history = new DatabaseSync(join(location.directory, 'History.db'));
    history.exec('ALTER TABLE history_visits DROP COLUMN score');
  }

  const failure = await safari.load().then(
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
    'bookmarks',
    'historyItemTags',
    'historyItems',
    'historyTags',
    'historyTombstones',
    'historyVisits',
    'readingListItems',
  ]);
  assert.match(
    failed.bookmarks ?? '',
    /Bookmarks\.plist cannot be read\. Allow the process that runs the export Full Disk Access/,
  );
  assert.match(failed.historyVisits ?? '', /missing history_visits\.score/);
  assert.deepEqual(
    rows(
      safari.read(`SELECT (SELECT count(*) FROM bookmarks) AS bookmarks,
        (SELECT count(*) FROM history_visits) AS visits,
        (SELECT count(*) FROM cloud_tabs) AS cloud`),
    ),
    [{ bookmarks: 7, visits: 4, cloud: 1 }],
  );
  const messages = await Array.fromAsync(
    source.read(
      [
        new Copy(
          source.historyVisits,
          new SQLiteDestination({
            path: join(scratch.path, 'visits.sqlite'),
          }).table('visits'),
        ).configuration,
      ],
      new Map(),
    ),
  );
  const status = messages.find(
    (message) => message instanceof StreamStatus && message.status === 'FAILED',
  );
  assert.ok(status instanceof StreamStatus);
  assert.ok(status.error instanceof Error);
  assert.equal(status.error.name, 'SafariSchemaError');
});

test('a Safari watch wakes only the streams of the store that changed, while Safari keeps its databases open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const source = new AppleSafariSource(location);
  const streams = [
    source.historyVisits,
    source.tabs,
    source.cloudTabs,
    source.bookmarks,
  ];
  // Safari holds its connections, and so its WALs, open the whole time.
  using history = new DatabaseSync(join(location.directory, 'History.db'));
  using work = new DatabaseSync(
    join(location.container, 'Profiles', 'SERVER-WORK', 'History.db'),
  );
  using tabs = new DatabaseSync(join(location.container, 'SafariTabs.db'));
  const controller = new AbortController();
  const woken: string[][] = [];

  for await (const batch of source.watch({
    streams,
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    woken.push(batch.map((stream) => stream.name));
    if (woken.length === 1)
      history
        .prepare(
          'INSERT INTO history_visits (history_item, visit_time) VALUES (1, ?)',
        )
        .run(appleSeconds('2026-04-01T00:00:00Z'));
    else if (woken.length === 2)
      await writePlist(join(location.directory, 'Bookmarks.plist'), {
        ...bookmarksPlist,
        Children: bookmarksPlist.Children.slice(0, 1),
      });
    else if (woken.length === 3)
      work
        .prepare(
          'INSERT INTO history_visits (history_item, visit_time) VALUES (1, ?)',
        )
        .run(appleSeconds('2026-04-02T00:00:00Z'));
    else if (woken.length === 4)
      tabs.exec("UPDATE bookmarks SET title = 'Renamed' WHERE id = 42");
    else controller.abort();
  }

  assert.deepEqual(woken, [
    ['historyVisits', 'tabs', 'cloudTabs', 'bookmarks'],
    ['historyVisits'],
    ['bookmarks'],
    ['historyVisits'],
    ['tabs'],
  ]);
});

test('Safari reads this Mac’s stores into SQLite', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Safari requires macOS');
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-live-'));
  const source = new AppleSafariSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'safari.sqlite'),
  });
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
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
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
      'SafariUnavailableError',
    )
  )
    return t.skip('no Full Disk Access to Safari');
  assert.ok(Array.isArray(outcome), String(outcome));

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const count = (table: string) =>
    Number(database.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n);
  // History comes from this Mac's own History.db: when it holds items, so
  // does the import.
  using history = new DatabaseSync(
    join(homedir(), 'Library/Safari/History.db'),
    { readOnly: true },
  );
  const native = history
    .prepare('SELECT count(*) AS n FROM history_items')
    .get()?.n;
  if (Number(native) > 0) assert.ok(count('historyItems') > 0);
  assert.ok(count('historyVisits') >= count('historyItems'));
  assert.equal(
    count('bookmarks') > 0,
    true,
    'Safari always has its top-level bookmark folders',
  );
});
