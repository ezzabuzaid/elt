import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { RollbackJournal, UnchangedJournal, open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  type Source,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  type ChromiumBrowser,
  chrome,
  chromiumBrowsers,
  dia,
} from '@workspace/sdk-chromium-browser';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { ChromiumSource } from './chromium-source.ts';

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One browser loaded as the hosts load it: every stream incrementally into
// raw_<stream> of one SQLite file, read through its <snake_stream> view.
async function chromiumImport(source: Source, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const { streams } = await source.discover();
  const connection = new Connection({
    name: 'chromium',
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
            .table(`raw_${stream.name}`)
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
  const pipeline = () =>
    new Pipeline({ clock: globalThis, history, connections: [connection] });
  return {
    load: () => pipeline().run(),
    watch: (signal: AbortSignal) => pipeline().watch({ signal }),
    read: (sql: string) => {
      using database = open(path, { readOnly: true });
      const statement = database.prepare(sql);
      // An int64 column holds integers past what a JavaScript number holds;
      // such a value reads as its decimal text, as the stream declares it.
      statement.setReadBigInts(true);
      // The view's loaded_at says when a row loaded, not what it holds.
      return statement
        .all()
        .map(({ loaded_at: _loaded, ...row }) =>
          Object.fromEntries(
            Object.entries(row).map(([field, value]) => [
              field,
              typeof value !== 'bigint'
                ? value
                : Number.isSafeInteger(Number(value))
                  ? Number(value)
                  : String(value),
            ]),
          ),
        );
    },
  };
}

// The streams that failed, by failure type.
function failedStreams(error: {
  readonly results: readonly {
    readonly copy: {
      readonly configuration: { readonly stream: { readonly name: string } };
    };
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): Record<string, string[]> {
  const streams: Record<string, string[]> = {};
  for (const { copy, failures } of error.results)
    for (const failureType of new Set(
      failures.map(({ failureType }) => failureType),
    ))
      (streams[failureType] ??= []).push(copy.configuration.stream.name);
  for (const names of Object.values(streams)) names.sort();
  return streams;
}

const historyStreams = [
  'downloads',
  'historyItems',
  'historyVisits',
  'searchTerms',
];

// Chromium's time: microseconds since 1601-01-01 UTC.
const chromiumMicros = (iso: string, micros = 0) =>
  (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 1000n + BigInt(micros);
const daysAgo = (days: number) =>
  chromiumMicros(new Date(Date.now() - days * 86_400_000).toISOString());

// History version 70 as Chrome, Dia, Arc and Edge declare the tables the
// source reads, on 2026-11-02.
const historySchema = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
INSERT INTO meta VALUES ('version', '70'), ('last_compatible_version', '69');
CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL);
CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL,visit_time INTEGER NOT NULL,from_visit INTEGER,external_referrer_url TEXT,transition INTEGER DEFAULT 0 NOT NULL,segment_id INTEGER,visit_duration INTEGER DEFAULT 0 NOT NULL,incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL,opener_visit INTEGER,originator_cache_guid TEXT,originator_visit_id INTEGER,originator_from_visit INTEGER,originator_opener_visit INTEGER,is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL,consider_for_ntp_most_visited BOOLEAN DEFAULT FALSE NOT NULL,visited_link_id INTEGER DEFAULT 0 NOT NULL,app_id TEXT);
CREATE TABLE visit_source(id INTEGER PRIMARY KEY,source INTEGER NOT NULL);
CREATE TABLE context_annotations(visit_id INTEGER PRIMARY KEY,context_annotation_flags INTEGER NOT NULL,duration_since_last_visit INTEGER,page_end_reason INTEGER,total_foreground_duration INTEGER,browser_type INTEGER DEFAULT 0 NOT NULL,window_id INTEGER DEFAULT -1 NOT NULL,tab_id INTEGER DEFAULT -1 NOT NULL,task_id INTEGER DEFAULT -1 NOT NULL,root_task_id INTEGER DEFAULT -1 NOT NULL,parent_task_id INTEGER DEFAULT -1 NOT NULL,response_code INTEGER DEFAULT 0 NOT NULL);
CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL,url_id INTEGER NOT NULL,term LONGVARCHAR NOT NULL,normalized_term LONGVARCHAR NOT NULL);
CREATE TABLE downloads (id INTEGER PRIMARY KEY,guid VARCHAR NOT NULL,current_path LONGVARCHAR NOT NULL,target_path LONGVARCHAR NOT NULL,start_time INTEGER NOT NULL,received_bytes INTEGER NOT NULL,total_bytes INTEGER NOT NULL,state INTEGER NOT NULL,danger_type INTEGER NOT NULL,interrupt_reason INTEGER NOT NULL,hash BLOB NOT NULL,end_time INTEGER NOT NULL,opened INTEGER NOT NULL,last_access_time INTEGER NOT NULL,transient INTEGER NOT NULL,referrer VARCHAR NOT NULL,site_url VARCHAR NOT NULL,embedder_download_data VARCHAR NOT NULL,tab_url VARCHAR NOT NULL,tab_referrer_url VARCHAR NOT NULL,http_method VARCHAR NOT NULL,by_ext_id VARCHAR NOT NULL,by_ext_name VARCHAR NOT NULL,by_web_app_id VARCHAR NOT NULL,etag VARCHAR NOT NULL,last_modified VARCHAR NOT NULL,mime_type VARCHAR(255) NOT NULL,original_mime_type VARCHAR(255) NOT NULL);
CREATE TABLE downloads_url_chains (id INTEGER NOT NULL,chain_index INTEGER NOT NULL,url LONGVARCHAR NOT NULL, PRIMARY KEY (id, chain_index) );
`;

// A History as Chromium writes it: a rollback journal.
function createHistory(path: string): DatabaseSync {
  const database = open(path, { journal: new RollbackJournal() });
  database.exec(historySchema);
  return database;
}

function addUrl(
  database: DatabaseSync,
  id: number,
  url: string,
  lastVisit: bigint,
): void {
  database
    .prepare(
      'INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, 1, 0, ?)',
    )
    .run(id, url, `Title ${id}`, lastVisit);
}

function addVisit(
  database: DatabaseSync,
  id: number,
  url: number,
  time: bigint,
  transition = 0,
): void {
  database
    .prepare(
      'INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)',
    )
    .run(id, url, time, transition);
}

const t1 = chromiumMicros('2026-10-01T08:00:00.123Z', 456);
const t2 = chromiumMicros('2026-10-01T09:30:00.000Z', 789);

// The Default profile's History: a typed visit with what the browser noted
// as it happened, a server redirect it led to that Dia imported from Arc
// (source 6), a search, and a download through a redirect.
function defaultHistory(path: string): void {
  using database = createHistory(path);
  database
    .prepare(
      'INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(1, 'https://example.com/', 'Example', 2, 1, t1, 0);
  database
    .prepare(
      'INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(2, 'https://search.example/?q=elt', '', 1, 0, t2, 1);
  database
    .prepare(
      `INSERT INTO visits (id, url, visit_time, from_visit, external_referrer_url, transition, segment_id, visit_duration,
         incremented_omnibox_typed_score, opener_visit, originator_cache_guid, originator_visit_id, originator_from_visit,
         originator_opener_visit, is_known_to_sync, consider_for_ntp_most_visited, visited_link_id, app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      10,
      1,
      t1,
      0,
      '',
      0x3000_0001,
      4,
      2_500_000,
      1,
      0,
      '',
      0,
      0,
      0,
      1,
      1,
      7,
      '',
    );
  database
    .prepare(
      `INSERT INTO visits (id, url, visit_time, from_visit, external_referrer_url, transition, segment_id, visit_duration,
         incremented_omnibox_typed_score, opener_visit, originator_cache_guid, originator_visit_id, originator_from_visit,
         originator_opener_visit, is_known_to_sync, consider_for_ntp_most_visited, visited_link_id, app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      11,
      2,
      t2,
      10,
      'https://app.example/',
      -0x8000_0000,
      0,
      0,
      0,
      10,
      'DEVICE',
      77,
      76,
      75,
      0,
      0,
      0,
      'web-app',
    );
  database
    .prepare('INSERT INTO visit_source (id, source) VALUES (?, ?)')
    .run(11, 6);
  database
    .prepare(
      `INSERT INTO context_annotations (visit_id, context_annotation_flags, duration_since_last_visit, page_end_reason,
         total_foreground_duration, browser_type, window_id, tab_id, task_id, root_task_id, parent_task_id, response_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      10,
      3,
      -1_000_000,
      4,
      1_500_000,
      1,
      12,
      34,
      9_007_199_254_740_993n,
      -1,
      6_917_529_027_641_081_857n,
      200,
    );
  database
    .prepare(
      'INSERT INTO keyword_search_terms (keyword_id, url_id, term, normalized_term) VALUES (?, ?, ?, ?)',
    )
    .run(2, 2, 'ELT  Pipelines', 'elt pipelines');
  database
    .prepare(
      `INSERT INTO downloads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1,
      'D0WNL0AD-GUID',
      '/Users/u/Downloads/a.pdf',
      '/Users/u/Downloads/a.pdf',
      t1,
      2048,
      4096,
      1,
      0,
      0,
      new Uint8Array([0xab, 0xcd]),
      t2,
      1,
      0,
      0,
      'https://example.com/',
      'https://example.com/',
      '',
      'https://example.com/files',
      '',
      'GET',
      '',
      '',
      '',
      '"etag"',
      'Wed, 01 Oct 2026 08:00:00 GMT',
      'application/pdf',
      'application/pdf',
    );
  database
    .prepare('INSERT INTO downloads_url_chains VALUES (?, ?, ?)')
    .run(1, 1, 'https://cdn.example/a.pdf');
  database
    .prepare('INSERT INTO downloads_url_chains VALUES (?, ?, ?)')
    .run(1, 0, 'https://example.com/a');
}

// A Bookmarks file as BookmarkCodec writes it.
const bookmarksFile = (children: readonly unknown[]) => ({
  checksum: '0',
  roots: {
    bookmark_bar: {
      children,
      date_added: String(chromiumMicros('2026-01-01T00:00:00.000Z')),
      date_modified: String(chromiumMicros('2026-10-01T00:00:00.000Z', 1)),
      guid: '0bc5d13f-2cba-5d74-951f-3f233fe6c908',
      id: '1',
      name: 'Bookmarks bar',
      type: 'folder',
    },
    other: {
      children: [],
      date_added: '0',
      date_modified: '0',
      guid: '82b081ec-3dd3-529c-8475-ab6c344590dd',
      id: '2',
      name: 'Other bookmarks',
      type: 'folder',
    },
    synced: {
      children: [],
      date_added: '0',
      guid: '4cf2e351-0e85-532b-bb37-df045d8f8d0f',
      id: '3',
      name: 'Mobile bookmarks',
      type: 'folder',
    },
  },
  version: 1,
});

const work = {
  date_added: '0',
  date_last_used: '0',
  date_modified: '0',
  guid: 'f1d0c0de-0000-4000-8000-000000000001',
  id: '5',
  name: 'Work',
  type: 'folder',
  children: [
    {
      date_added: String(chromiumMicros('2026-03-04T05:06:07.000Z', 8)),
      date_last_used: String(chromiumMicros('2026-10-02T00:00:00.000Z')),
      guid: 'f1d0c0de-0000-4000-8000-000000000002',
      id: '6',
      meta_info: { last_visited_desktop: '13405693115177284' },
      name: 'Example',
      type: 'url',
      url: 'https://example.com/',
    },
  ],
};

const imported = {
  date_added: '0',
  guid: 'f1d0c0de-0000-4000-8000-000000000003',
  id: '7',
  name: 'Imported',
  type: 'url',
  url: 'https://imported.example/',
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

// A browser's data folder as Chromium leaves it: Local State names Default
// and Profile 1; Default has History and Bookmarks, Profile 1 only History,
// Profile 2 only Bookmarks and no entry in Local State, and Profile 3 a
// History with no tables, as a profile that never kept history.
async function browserFixture(home: string, browser: ChromiumBrowser) {
  const root = browser.root(home);
  const profile = (folder: string) => join(root, folder);
  for (const folder of ['Default', 'Profile 1', 'Profile 2', 'Profile 3'])
    await mkdir(profile(folder), { recursive: true });
  await writeJson(join(root, 'Local State'), {
    profile: {
      info_cache: {
        Default: { name: 'Personal' },
        'Profile 1': { name: 'Work' },
        'Profile 3': { name: 'Empty' },
      },
    },
  });
  defaultHistory(join(profile('Default'), 'History'));
  await writeJson(
    join(profile('Default'), 'Bookmarks'),
    bookmarksFile([work, imported]),
  );
  {
    using database = createHistory(join(profile('Profile 1'), 'History'));
    addUrl(database, 1, 'https://work.example/', t1);
    addVisit(database, 1, 1, t1);
  }
  await writeJson(join(profile('Profile 2'), 'Bookmarks'), bookmarksFile([]));
  open(join(profile('Profile 3'), 'History'), {
    journal: new RollbackJournal(),
  }).close();
  return { root, profile };
}

test('a Chromium History that the browser holds in exclusive locking mode loads as the browser last committed it', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { profile } = await browserFixture(scratch.path, dia);
  // A running browser keeps History open in exclusive locking mode, so no
  // other connection can read it, and has a transaction open.
  using browser = open(join(profile('Default'), 'History'), {
    journal: new UnchangedJournal(),
  });
  browser.exec('PRAGMA locking_mode = EXCLUSIVE');
  browser.exec("UPDATE urls SET title = 'Committed' WHERE id = 1");
  browser.exec('BEGIN');
  browser.exec("UPDATE urls SET title = 'Pending' WHERE id = 1");
  addVisit(browser, 12, 1, t2);
  {
    // timeout 0 fails at once, where open() waits 5 s for the lock.
    using reader = open(join(profile('Default'), 'History'), {
      readOnly: true,
      timeout: 0,
    });
    assert.throws(
      () => reader.prepare('SELECT count(*) FROM urls').get(),
      /database is locked/,
    );
  }
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path }),
    join(scratch.path, 'import'),
  );

  await chromium.load();

  assert.deepEqual(
    chromium.read(
      "SELECT id, title FROM history_items WHERE profileId = 'Default' ORDER BY id",
    ),
    [
      { id: 1, title: 'Committed' },
      { id: 2, title: '' },
    ],
  );
  assert.deepEqual(
    chromium.read(
      "SELECT id FROM history_visits WHERE profileId = 'Default' ORDER BY id",
    ),
    [{ id: 10 }, { id: 11 }],
  );
  browser.exec('ROLLBACK');
});

test('a Chromium browser loads each profile’s history, downloads, searches and bookmarks, and names its profiles', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  await browserFixture(scratch.path, dia);
  const source = new ChromiumSource({ browser: dia, home: scratch.path });
  const chromium = await chromiumImport(source, join(scratch.path, 'import'));

  await chromium.load();

  assert.equal(source.identity, 'chromium:dia');
  assert.deepEqual(chromium.read('SELECT * FROM profiles ORDER BY id'), [
    { id: 'Default', name: 'Personal' },
    { id: 'Profile 1', name: 'Work' },
    { id: 'Profile 2', name: null },
    { id: 'Profile 3', name: 'Empty' },
  ]);
  // Each profile numbers its own rows: the same id in two profiles is two
  // rows. Profile 3's History has no tables, so it adds none.
  assert.deepEqual(
    chromium.read(
      'SELECT profileId, id, url, title, visitCount, typedCount, lastVisitedAt, hidden FROM history_items ORDER BY profileId, id',
    ),
    [
      {
        profileId: 'Default',
        id: 1,
        url: 'https://example.com/',
        title: 'Example',
        visitCount: 2,
        typedCount: 1,
        lastVisitedAt: '2026-10-01T08:00:00.123456Z',
        hidden: 0,
      },
      {
        profileId: 'Default',
        id: 2,
        url: 'https://search.example/?q=elt',
        title: '',
        visitCount: 1,
        typedCount: 0,
        lastVisitedAt: '2026-10-01T09:30:00.000789Z',
        hidden: 1,
      },
      {
        profileId: 'Profile 1',
        id: 1,
        url: 'https://work.example/',
        title: 'Title 1',
        visitCount: 1,
        typedCount: 0,
        lastVisitedAt: '2026-10-01T08:00:00.123456Z',
        hidden: 0,
      },
    ],
  );
  assert.deepEqual(
    chromium.read(
      "SELECT * FROM history_visits WHERE profileId = 'Default' ORDER BY id",
    ),
    [
      {
        profileId: 'Default',
        id: 10,
        urlId: 1,
        visitedAt: '2026-10-01T08:00:00.123456Z',
        fromVisitId: null,
        externalReferrerUrl: null,
        transition: 0x3000_0001,
        transitionType: 'typed',
        transitionQualifiers: '["chain_start","chain_end"]',
        segmentId: 4,
        durationMicros: 2_500_000,
        incrementedOmniboxTypedScore: 1,
        openerVisitId: null,
        originatorCacheGuid: null,
        originatorVisitId: null,
        originatorFromVisitId: null,
        originatorOpenerVisitId: null,
        knownToSync: 1,
        considerForNtpMostVisited: 1,
        visitedLinkId: 7,
        appId: null,
        source: 1,
        contextFlags: 3,
        contextDurationSinceLastVisitMicros: -1_000_000,
        contextPageEndReason: 4,
        contextTotalForegroundDurationMicros: 1_500_000,
        contextBrowserType: 1,
        contextWindowId: 12,
        contextTabId: 34,
        contextTaskId: '9007199254740993',
        contextRootTaskId: -1,
        contextParentTaskId: '6917529027641081857',
        contextResponseCode: 200,
      },
      {
        profileId: 'Default',
        id: 11,
        urlId: 2,
        visitedAt: '2026-10-01T09:30:00.000789Z',
        fromVisitId: 10,
        externalReferrerUrl: 'https://app.example/',
        transition: -0x8000_0000,
        transitionType: 'link',
        transitionQualifiers: '["server_redirect"]',
        segmentId: null,
        durationMicros: 0,
        incrementedOmniboxTypedScore: 0,
        openerVisitId: 10,
        originatorCacheGuid: 'DEVICE',
        originatorVisitId: 77,
        originatorFromVisitId: 76,
        originatorOpenerVisitId: 75,
        knownToSync: 0,
        considerForNtpMostVisited: 0,
        visitedLinkId: null,
        appId: 'web-app',
        source: 6,
        contextFlags: null,
        contextDurationSinceLastVisitMicros: null,
        contextPageEndReason: null,
        contextTotalForegroundDurationMicros: null,
        contextBrowserType: null,
        contextWindowId: null,
        contextTabId: null,
        contextTaskId: null,
        contextRootTaskId: null,
        contextParentTaskId: null,
        contextResponseCode: null,
      },
    ],
  );
  assert.deepEqual(
    chromium.read(
      "SELECT profileId, id FROM history_visits WHERE profileId != 'Default'",
    ),
    [{ profileId: 'Profile 1', id: 1 }],
  );
  assert.deepEqual(chromium.read('SELECT * FROM search_terms'), [
    {
      profileId: 'Default',
      keywordId: 2,
      urlId: 2,
      term: 'ELT  Pipelines',
      normalizedTerm: 'elt pipelines',
    },
  ]);
  assert.deepEqual(chromium.read('SELECT * FROM downloads'), [
    {
      profileId: 'Default',
      id: 1,
      guid: 'D0WNL0AD-GUID',
      currentPath: '/Users/u/Downloads/a.pdf',
      targetPath: '/Users/u/Downloads/a.pdf',
      startedAt: '2026-10-01T08:00:00.123456Z',
      endedAt: '2026-10-01T09:30:00.000789Z',
      receivedBytes: 2048,
      totalBytes: 4096,
      state: 1,
      dangerType: 0,
      interruptReason: 0,
      hash: 'abcd',
      opened: 1,
      lastAccessedAt: null,
      transient: 0,
      referrer: 'https://example.com/',
      siteUrl: 'https://example.com/',
      embedderDownloadData: null,
      tabUrl: 'https://example.com/files',
      tabReferrerUrl: null,
      httpMethod: 'GET',
      byExtensionId: null,
      byExtensionName: null,
      byWebAppId: null,
      etag: '"etag"',
      lastModified: 'Wed, 01 Oct 2026 08:00:00 GMT',
      mimeType: 'application/pdf',
      originalMimeType: 'application/pdf',
      urlChain: '["https://example.com/a","https://cdn.example/a.pdf"]',
    },
  ]);
  assert.deepEqual(
    chromium.read(
      "SELECT * FROM bookmarks WHERE profileId = 'Default' ORDER BY id",
    ),
    [
      {
        profileId: 'Default',
        guid: '0bc5d13f-2cba-5d74-951f-3f233fe6c908',
        id: '1',
        parentGuid: null,
        root: 'bookmark_bar',
        position: 0,
        type: 'folder',
        name: 'Bookmarks bar',
        url: null,
        addedAt: '2026-01-01T00:00:00.000000Z',
        lastUsedAt: null,
        modifiedAt: '2026-10-01T00:00:00.000001Z',
        metaInfo: '[]',
      },
      {
        profileId: 'Default',
        guid: '82b081ec-3dd3-529c-8475-ab6c344590dd',
        id: '2',
        parentGuid: null,
        root: 'other',
        position: 0,
        type: 'folder',
        name: 'Other bookmarks',
        url: null,
        addedAt: null,
        lastUsedAt: null,
        modifiedAt: null,
        metaInfo: '[]',
      },
      {
        profileId: 'Default',
        guid: '4cf2e351-0e85-532b-bb37-df045d8f8d0f',
        id: '3',
        parentGuid: null,
        root: 'synced',
        position: 0,
        type: 'folder',
        name: 'Mobile bookmarks',
        url: null,
        addedAt: null,
        lastUsedAt: null,
        modifiedAt: null,
        metaInfo: '[]',
      },
      {
        profileId: 'Default',
        guid: 'f1d0c0de-0000-4000-8000-000000000001',
        id: '5',
        parentGuid: '0bc5d13f-2cba-5d74-951f-3f233fe6c908',
        root: 'bookmark_bar',
        position: 0,
        type: 'folder',
        name: 'Work',
        url: null,
        addedAt: null,
        lastUsedAt: null,
        modifiedAt: null,
        metaInfo: '[]',
      },
      {
        profileId: 'Default',
        guid: 'f1d0c0de-0000-4000-8000-000000000002',
        id: '6',
        parentGuid: 'f1d0c0de-0000-4000-8000-000000000001',
        root: 'bookmark_bar',
        position: 0,
        type: 'url',
        name: 'Example',
        url: 'https://example.com/',
        addedAt: '2026-03-04T05:06:07.000008Z',
        lastUsedAt: '2026-10-02T00:00:00.000000Z',
        modifiedAt: null,
        metaInfo:
          '[{"key":"last_visited_desktop","value":"13405693115177284"}]',
      },
      {
        profileId: 'Default',
        guid: 'f1d0c0de-0000-4000-8000-000000000003',
        id: '7',
        parentGuid: '0bc5d13f-2cba-5d74-951f-3f233fe6c908',
        root: 'bookmark_bar',
        position: 1,
        type: 'url',
        name: 'Imported',
        url: 'https://imported.example/',
        addedAt: null,
        lastUsedAt: null,
        modifiedAt: null,
        metaInfo: '[]',
      },
    ],
  );
  assert.deepEqual(
    chromium.read(
      "SELECT count(*) AS n FROM bookmarks WHERE profileId = 'Profile 2'",
    ),
    [{ n: 3 }],
  );
});

// What each load committed to each stream.
const written = (
  loaded: readonly {
    readonly copy: { readonly from: { readonly name: string } };
    readonly count: number;
    readonly deleted: number;
  }[],
) =>
  Object.fromEntries(
    loaded.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

test('a Chromium rerun writes nothing, and edits and deletions in each store land', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { root, profile } = await browserFixture(scratch.path, dia);
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path }),
    join(scratch.path, 'import'),
  );
  const first = written(await chromium.load());
  const unchanged = written(await chromium.load());
  {
    using database = open(join(profile('Default'), 'History'), {
      journal: new RollbackJournal(),
    });
    database.exec(`DELETE FROM visits WHERE id = 11;
      UPDATE urls SET title = 'Renamed' WHERE id = 1;
      DELETE FROM downloads; DELETE FROM downloads_url_chains;
      DELETE FROM keyword_search_terms;`);
  }
  await writeJson(
    join(profile('Default'), 'Bookmarks'),
    bookmarksFile([
      {
        ...work,
        children: work.children.map((child) => ({
          ...child,
          name: 'Renamed',
        })),
      },
    ]),
  );
  await rm(profile('Profile 1'), { recursive: true });
  await rm(profile('Profile 2'), { recursive: true });
  await writeJson(join(root, 'Local State'), {
    profile: { info_cache: { Default: { name: 'Home' } } },
  });

  const edited = written(await chromium.load());

  assert.deepEqual(first, {
    profiles: { count: 4, deleted: 0 },
    historyItems: { count: 3, deleted: 0 },
    historyVisits: { count: 3, deleted: 0 },
    downloads: { count: 1, deleted: 0 },
    searchTerms: { count: 1, deleted: 0 },
    bookmarks: { count: 9, deleted: 0 },
  });
  assert.deepEqual(
    unchanged,
    Object.fromEntries(
      Object.keys(first).map((stream) => [stream, { count: 0, deleted: 0 }]),
    ),
  );
  assert.deepEqual(edited, {
    profiles: { count: 2, deleted: 2 },
    historyItems: { count: 1, deleted: 1 },
    historyVisits: { count: 0, deleted: 2 },
    downloads: { count: 0, deleted: 1 },
    searchTerms: { count: 0, deleted: 1 },
    bookmarks: { count: 1, deleted: 4 },
  });
  assert.deepEqual(chromium.read('SELECT id, name FROM profiles ORDER BY id'), [
    { id: 'Default', name: 'Home' },
    { id: 'Profile 3', name: null },
  ]);
  assert.deepEqual(
    chromium.read(
      'SELECT profileId, id, title FROM history_items ORDER BY profileId, id',
    ),
    [
      { profileId: 'Default', id: 1, title: 'Renamed' },
      { profileId: 'Default', id: 2, title: '' },
    ],
  );
  assert.deepEqual(chromium.read('SELECT profileId, id FROM history_visits'), [
    { profileId: 'Default', id: 10 },
  ]);
  assert.deepEqual(
    chromium.read(
      "SELECT name FROM bookmarks WHERE type = 'url' ORDER BY name",
    ),
    [{ name: 'Renamed' }],
  );
});

// A browser's Default profile whose History holds one URL and one visit for
// each age given, in days, by URL id.
async function agedHistory(
  home: string,
  browser: ChromiumBrowser,
  visits: readonly { id: number; days: number; transition?: number }[],
) {
  const folder = join(browser.root(home), 'Default');
  await mkdir(folder, { recursive: true });
  using database = createHistory(join(folder, 'History'));
  for (const { id, days, transition } of visits) {
    addUrl(database, id, `https://${id}.example/`, daysAgo(days));
    addVisit(database, id, id, daysAgo(days), transition);
    database
      .prepare(
        'INSERT INTO keyword_search_terms (keyword_id, url_id, term, normalized_term) VALUES (1, ?, ?, ?)',
      )
      .run(id, `term ${id}`, `term ${id}`);
  }
  database.exec(
    `INSERT INTO downloads (id, guid, current_path, target_path, start_time, received_bytes, total_bytes, state, danger_type,
       interrupt_reason, hash, end_time, opened, last_access_time, transient, referrer, site_url, embedder_download_data, tab_url,
       tab_referrer_url, http_method, by_ext_id, by_ext_name, by_web_app_id, etag, last_modified, mime_type, original_mime_type)
     VALUES (1, 'OLD', '', '', ${daysAgo(200)}, 0, 0, 1, 0, 0, x'', 0, 0, 0, 0, '', '', '', '', '', '', '', '', '', '', '', '', '')`,
  );
  return join(folder, 'History');
}

const autoSubframe = 3;

test('a Chromium browser that removes old history keeps what it expired after 90 days, or 87 for a frame and a URL, and deletes what was removed before', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const path = await agedHistory(scratch.path, chrome, [
    { id: 20, days: 91 },
    { id: 21, days: 88, transition: autoSubframe },
    { id: 22, days: 10 },
    { id: 23, days: 88 },
    { id: 24, days: 86, transition: autoSubframe },
  ]);
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: chrome, home: scratch.path }),
    join(scratch.path, 'import'),
  );
  await chromium.load();
  const [visit] = chromium.read(
    'SELECT visitedAt, expiresAt FROM history_visits WHERE id = 22',
  );
  {
    using database = open(path, { journal: new RollbackJournal() });
    database.exec(
      'DELETE FROM visits; DELETE FROM urls; DELETE FROM keyword_search_terms; DELETE FROM downloads',
    );
  }

  const loaded = written(await chromium.load());

  // A visit expires 90 days after it, to the millisecond.
  assert.equal(
    visit?.expiresAt,
    new Date(
      Date.parse(String(visit?.visitedAt)) + 90 * 86_400_000,
    ).toISOString(),
  );
  assert.deepEqual(loaded, {
    profiles: { count: 0, deleted: 0 },
    historyItems: { count: 0, deleted: 2 },
    historyVisits: { count: 0, deleted: 3 },
    downloads: { count: 0, deleted: 1 },
    searchTerms: { count: 0, deleted: 2 },
    bookmarks: { count: 0, deleted: 0 },
  });
  assert.deepEqual(
    chromium.read(`SELECT 'visit ' || id AS row FROM history_visits
      UNION ALL SELECT 'url ' || id FROM history_items
      UNION ALL SELECT 'term ' || urlId FROM search_terms ORDER BY row`),
    [
      { row: 'term 20' },
      { row: 'term 21' },
      { row: 'term 23' },
      { row: 'url 20' },
      { row: 'url 21' },
      { row: 'url 23' },
      { row: 'visit 20' },
      { row: 'visit 21' },
    ],
  );
});

test('a Chromium browser that keeps its history deletes an old visit that is gone, and its streams have no expiry', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const path = await agedHistory(scratch.path, dia, [
    { id: 20, days: 400 },
    { id: 21, days: 2 },
  ]);
  const source = new ChromiumSource({ browser: dia, home: scratch.path });
  const chromium = await chromiumImport(source, join(scratch.path, 'import'));
  await chromium.load();
  {
    using database = open(path, { journal: new RollbackJournal() });
    database.exec(
      'DELETE FROM visits WHERE id = 20; DELETE FROM urls WHERE id = 20; DELETE FROM keyword_search_terms WHERE url_id = 20',
    );
  }

  const loaded = written(await chromium.load());

  assert.deepEqual(loaded.historyVisits, { count: 0, deleted: 1 });
  assert.deepEqual(loaded.historyItems, { count: 0, deleted: 1 });
  assert.deepEqual(loaded.searchTerms, { count: 0, deleted: 1 });
  const { streams } = await source.discover();
  assert.deepEqual(
    streams.filter(
      (stream) =>
        stream.expiresBy !== undefined ||
        'expiresAt' in (stream.jsonSchema.properties ?? {}),
    ),
    [],
  );
});

test('a Chromium import scope selects profiles for every stream, and dates for visits only', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { profile } = await browserFixture(scratch.path, dia);
  {
    // A download long before the dates, which select visits only.
    using database = open(join(profile('Default'), 'History'), {
      journal: new RollbackJournal(),
    });
    database.exec(
      `INSERT INTO downloads SELECT 2, 'OLD', current_path, target_path, ${daysAgo(400)}, received_bytes, total_bytes, state,
         danger_type, interrupt_reason, hash, ${daysAgo(400)}, opened, last_access_time, transient, referrer, site_url,
         embedder_download_data, tab_url, tab_referrer_url, http_method, by_ext_id, by_ext_name, by_web_app_id, etag,
         last_modified, mime_type, original_mime_type FROM downloads WHERE id = 1`,
    );
  }
  const scope: ImportScope = {
    collectionIds: ['Default'],
    // Visit 10 is at 08:00:00.123456, visit 11 at 09:30:00.000789.
    startAt: '2026-10-01T08:00:00.123Z',
    endAt: '2026-10-01T09:30:00.000Z',
  };
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path, scope }),
    join(scratch.path, 'import'),
  );

  await chromium.load();

  assert.deepEqual(
    chromium.read(`SELECT 'profile ' || id AS row FROM profiles
      UNION ALL SELECT 'url ' || profileId || ' ' || id FROM history_items
      UNION ALL SELECT 'visit ' || profileId || ' ' || id FROM history_visits
      UNION ALL SELECT 'download ' || profileId || ' ' || id FROM downloads
      UNION ALL SELECT 'term ' || profileId || ' ' || urlId FROM search_terms
      UNION ALL SELECT 'bookmarks ' || profileId || ' ' || count(*) FROM bookmarks GROUP BY profileId
      ORDER BY row`),
    [
      { row: 'bookmarks Default 6' },
      { row: 'download Default 1' },
      { row: 'download Default 2' },
      { row: 'profile Default' },
      { row: 'term Default 2' },
      { row: 'url Default 1' },
      { row: 'url Default 2' },
      { row: 'visit Default 10' },
    ],
  );
});

test('a Chromium store that cannot be read fails only its streams, as config when access is denied, and keeps their rows', async (t) => {
  if (process.getuid?.() === 0) return t.skip('chmod denies nothing to root');
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { profile } = await browserFixture(scratch.path, dia);
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path }),
    join(scratch.path, 'import'),
  );
  await chromium.load();
  const counts = () =>
    chromium.read(`SELECT (SELECT count(*) FROM history_visits) AS visits,
      (SELECT count(*) FROM bookmarks) AS bookmarks,
      (SELECT count(*) FROM profiles) AS profiles`);
  const failure = async () => {
    const error = await chromium.load().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof PipelineError, String(error));
    return failedStreams(error);
  };
  const denied = [
    join(profile('Profile 1'), 'History'),
    join(profile('Profile 2'), 'Bookmarks'),
  ];
  try {
    for (const path of denied) await chmod(path, 0o000);
    const unavailable = await failure();
    for (const path of denied) await chmod(path, 0o644);
    await writeFile(join(profile('Default'), 'Bookmarks'), '{');
    {
      using database = open(join(profile('Profile 1'), 'History'), {
        journal: new RollbackJournal(),
      });
      database.exec('ALTER TABLE visits DROP COLUMN app_id');
    }
    const broken = await failure();

    assert.deepEqual(unavailable, {
      config: [...historyStreams, 'bookmarks'].sort(),
    });
    assert.deepEqual(broken, {
      system: [...historyStreams, 'bookmarks'].sort(),
    });
    assert.deepEqual(counts(), [{ visits: 3, bookmarks: 9, profiles: 4 }]);
  } finally {
    for (const path of denied) await chmod(path, 0o644);
  }
});

test('a Chromium watch loads only the streams of the store that changed, while the browser holds its History', async (t) => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { root, profile } = await browserFixture(scratch.path, dia);
  const source = new ChromiumSource({ browser: dia, home: scratch.path });
  const { streams } = await source.discover();
  const chromium = await chromiumImport(source, join(scratch.path, 'import'));
  // The browser holds History in exclusive locking mode while it runs.
  using browser = open(join(profile('Default'), 'History'), {
    journal: new UnchangedJournal(),
  });
  browser.exec('PRAGMA locking_mode = EXCLUSIVE');
  browser.exec('SELECT count(*) FROM urls');
  const controller = new AbortController();
  const woken: string[][] = [];
  // The visit comes after two checks found History unchanged, while the
  // watch goes on: a change that the first pass's own read made is a pass of
  // its own, before the visit. The history records the first such check at
  // once; the watch checks again each second.
  const visit = async () => {
    await t.waitFor(
      () =>
        assert.equal(
          chromium.read(
            `SELECT stream FROM _elt_stream_checks WHERE stream = 'historyVisits'`,
          ).length,
          1,
        ),
      { interval: 5, timeout: 10_000 },
    );
    await setTimeout(1_500);
    addVisit(browser, 12, 1, t2);
  };
  const visiting: Promise<void>[] = [];

  for await (const { outcomes } of chromium.watch(
    // A pass that never comes ends the watch, so the assertion fails.
    AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
  )) {
    woken.push(outcomes.map(({ copy }) => copy.from.name));
    // A check that changes nothing makes no pass.
    if (woken.length === 1) visiting.push(visit());
    else if (woken.length === 2)
      await writeJson(
        join(profile('Default'), 'Bookmarks'),
        bookmarksFile([work]),
      );
    else if (woken.length === 3)
      await writeJson(join(root, 'Local State'), {
        profile: { info_cache: { Default: { name: 'Home' } } },
      });
    else if (woken.length === 4) {
      await mkdir(profile('Profile 4'));
      using database = createHistory(join(profile('Profile 4'), 'History'));
    } else if (woken.length === 5) controller.abort();
  }
  await Promise.all(visiting);

  assert.deepEqual(woken, [
    streams.map((stream) => stream.name),
    ['historyItems', 'historyVisits', 'downloads', 'searchTerms'],
    ['bookmarks'],
    ['profiles'],
    ['profiles', 'historyItems', 'historyVisits', 'downloads', 'searchTerms'],
  ]);
});

// The times of a closed browser's files, as it left them when it quit.
async function leftByBrowser(path: string, written: string): Promise<void> {
  await utimes(path, new Date('2026-10-22T09:00:00.000Z'), new Date(written));
}

test('while a Chromium browser is closed, its history and bookmarks are current as of its last write to them; while it runs, as of the pass', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { root, profile } = await browserFixture(scratch.path, dia);
  await leftByBrowser(
    join(profile('Default'), 'History'),
    '2026-10-20T10:40:00.000Z',
  );
  await leftByBrowser(
    join(profile('Profile 1'), 'History'),
    '2026-10-20T10:42:21.000Z',
  );
  await leftByBrowser(
    join(profile('Profile 3'), 'History'),
    '2026-10-20T10:00:00.000Z',
  );
  await leftByBrowser(
    join(profile('Default'), 'Bookmarks'),
    '2026-10-20T10:42:22.000Z',
  );
  await leftByBrowser(
    join(profile('Profile 2'), 'Bookmarks'),
    '2026-10-20T10:30:00.000Z',
  );
  // A browser that crashed leaves its lock behind, naming a process that
  // no longer runs.
  const ended = spawnSync(process.execPath, ['-e', '']).pid;
  await symlink(`${hostname()}-${ended}`, join(root, 'SingletonLock'));
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path }),
    join(scratch.path, 'import'),
  );
  const currentAsOf = () =>
    Object.fromEntries(
      chromium
        .read('SELECT stream, current_as_of FROM stream_status')
        .map(({ stream, current_as_of }) => [String(stream), current_as_of]),
    );
  const startedAt = () =>
    chromium
      .read('SELECT started_at FROM sync_attempts ORDER BY started_at DESC')
      .at(0)?.started_at;

  await chromium.load();
  const closed = currentAsOf();
  const closedPass = startedAt();
  // The browser runs: its lock names this process on this host.
  await rm(join(root, 'SingletonLock'));
  await symlink(`${hostname()}-${process.pid}`, join(root, 'SingletonLock'));
  await chromium.load();
  const running = currentAsOf();
  const runningPass = startedAt();

  assert.deepEqual(closed, {
    profiles: closedPass,
    historyItems: '2026-10-20T10:42:21.000Z',
    historyVisits: '2026-10-20T10:42:21.000Z',
    downloads: '2026-10-20T10:42:21.000Z',
    searchTerms: '2026-10-20T10:42:21.000Z',
    bookmarks: '2026-10-20T10:42:22.000Z',
  });
  assert.deepEqual(
    running,
    Object.fromEntries(
      Object.keys(closed).map((stream) => [stream, runningPass]),
    ),
  );
});

test('a Chromium browser whose SingletonLock names another host is closed here, and one whose process another user owns runs', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root may signal every process');
  await using scratch = await new TemporaryFiles().directory('chromium-');
  const { root, profile } = await browserFixture(scratch.path, dia);
  for (const folder of ['Default', 'Profile 1', 'Profile 3'])
    await leftByBrowser(
      join(profile(folder), 'History'),
      '2026-10-20T10:42:21.000Z',
    );
  for (const folder of ['Default', 'Profile 2'])
    await leftByBrowser(
      join(profile(folder), 'Bookmarks'),
      '2026-10-20T10:42:22.000Z',
    );
  const chromium = await chromiumImport(
    new ChromiumSource({ browser: dia, home: scratch.path }),
    join(scratch.path, 'import'),
  );
  // What the last pass recorded: whether the history was current as of the
  // pass, or as of the browser's last write.
  const historyCurrentAsOf = async (lock: string) => {
    await rm(join(root, 'SingletonLock'), { force: true });
    await symlink(lock, join(root, 'SingletonLock'));
    await chromium.load();
    const [pass] = chromium.read(
      'SELECT started_at FROM sync_attempts ORDER BY started_at DESC LIMIT 1',
    );
    const [status] = chromium.read(
      "SELECT current_as_of FROM stream_status WHERE stream = 'historyVisits'",
    );
    return status?.current_as_of === pass?.started_at
      ? 'pass'
      : status?.current_as_of;
  };

  // A browser on another Mac that shares the folder, with this process's id.
  const otherHost = await historyCurrentAsOf(`another-mac-${process.pid}`);
  // launchd, pid 1, lives and belongs to root: a signal check is refused
  // with EPERM, not ESRCH.
  const otherUser = await historyCurrentAsOf(`${hostname()}-1`);

  assert.equal(otherHost, '2026-10-20T10:42:21.000Z');
  assert.equal(otherUser, 'pass');
});

test('a Chromium pass over a large History holds one visit at a time, so it loads in a small heap', async () => {
  await using scratch = await new TemporaryFiles().directory('chromium-large-');
  const folder = join(dia.root(scratch.path), 'Default');
  await mkdir(folder, { recursive: true });
  {
    using database = createHistory(join(folder, 'History'));
    addUrl(database, 1, 'https://example.com/', t1);
    database.exec(
      `WITH RECURSIVE visit(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM visit WHERE n < 60000
       )
       INSERT INTO visits (id, url, visit_time, external_referrer_url)
         SELECT n, 1, ${t1} - n, 'https://referrer.example/' || hex(randomblob(500))
         FROM visit;`,
    );
  }
  // The import as a host runs it, in a process whose heap is far smaller
  // than the store: a pass that holds every visit at once runs out of it.
  // Each visit carries a 1 KB referrer so the whole set is heavy. The process
  // loads the source from this package's folder, where its dependencies
  // resolve.
  const pass = `
    const { Connection, Copy, Pipeline } = await import('@workspace/elt');
    const { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } = await import('@workspace/elt-sqlite');
    const { dia } = await import('@workspace/sdk-chromium-browser');
    const { ChromiumSource } = await import(process.env.SOURCE);
    const source = new ChromiumSource({ browser: dia, home: process.env.HOME_FOLDER });
    const destination = new SQLiteDestination({ path: process.env.OUT + '/data.sqlite' });
    await new Pipeline({ clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'chromium',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: process.env.OUT + '/checkpoints.sqlite' }),
          steps: [new Copy(source.historyVisits, destination.table('raw_historyVisits'), {
            id: 'historyVisits',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          })],
        }),
      ],
    }).run();
  `;

  const run = spawnSync(
    process.execPath,
    ['--max-old-space-size=70', '--input-type=module', '-e', pass],
    {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SOURCE: pathToFileURL(join(import.meta.dirname, 'chromium-source.ts'))
          .href,
        HOME_FOLDER: scratch.path,
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
  using imported = open(join(scratch.path, 'data.sqlite'), {
    readOnly: true,
  });
  assert.deepEqual(
    {
      ...imported.prepare('SELECT count(*) AS n FROM raw_historyVisits').get(),
    },
    { n: 60_000 },
  );
});

test('each installed Chromium browser loads this Mac’s profiles into SQLite', async (t) => {
  const home = homedir();
  const installed = chromiumBrowsers.filter(
    (browser) =>
      browser.profiles(home, 'History').length > 0 ||
      browser.profiles(home, 'Bookmarks').length > 0,
  );
  if (installed.length === 0) return t.skip('no Chromium browser installed');
  for (const browser of installed)
    await t.test(browser.name, async () => {
      await using scratch = await new TemporaryFiles().directory(
        'chromium-live-',
      );
      const chromium = await chromiumImport(
        new ChromiumSource({ browser, home }),
        scratch.path,
      );

      const first = written(await chromium.load());

      const profiles = new Set([
        ...browser.profiles(home, 'History').map(({ folder }) => folder),
        ...browser.profiles(home, 'Bookmarks').map(({ folder }) => folder),
      ]);
      assert.equal(first.profiles?.count, profiles.size);
      const count = (view: string) =>
        Number(chromium.read(`SELECT count(*) AS n FROM ${view}`)[0]?.n);
      assert.equal(count('history_items'), first.historyItems?.count);
      assert.equal(count('history_visits'), first.historyVisits?.count);
      assert.equal(count('bookmarks'), first.bookmarks?.count);
      // Each browser installed here holds history or bookmarks in some
      // profile.
      assert.ok(count('history_visits') + count('bookmarks') > 0);
    });
});
