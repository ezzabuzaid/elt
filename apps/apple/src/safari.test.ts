import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Connection, Copy, Pipeline, PipelineError, StreamStatus } from 'elt';
import { SQLiteCheckpointStore, SQLiteDestination } from 'elt-sqlite';
import { appleWarehouse } from './fixtures/apple-warehouse.ts';
import {
  appleSeconds,
  bookmarksPlist,
  closedTabsPlist,
  safariFixture,
  writePlist,
} from './fixtures/safari-stores.ts';
import {
  SafariSchemaError,
  SafariUnavailableError,
  safariContainer,
  safariDirectory,
} from './platform/macos/safari-store.ts';
import { AppleSafariSource } from './sources/apple-safari/apple-safari-source.ts';
import type { ImportScope } from './sources/import-scope.ts';

const rows = <T extends object>(found: Iterable<T>) =>
  [...found].map((row) => ({ ...row }));

test('Safari reads history, iCloud Tabs, bookmarks and recently closed tabs as documented views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  await using warehouse = await appleWarehouse(
    'safari',
    new AppleSafariSource(location),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;

  await warehouse.load();

  assert.deepEqual(
    (
      await agent`SELECT name FROM catalog WHERE kind = 'view' AND name LIKE 'safari%' ORDER BY name`
    ).map(({ name }) => name),
    [
      'safari_bookmarks',
      'safari_closed_tabs',
      'safari_closed_window_active_tabs',
      'safari_closed_windows',
      'safari_cloud_tab_close_requests',
      'safari_cloud_tab_devices',
      'safari_cloud_tab_positions',
      'safari_cloud_tabs',
      'safari_downloads',
      'safari_history_item_tags',
      'safari_history_items',
      'safari_history_tags',
      'safari_history_tombstones',
      'safari_history_visits',
      'safari_profile_start_page_sections',
      'safari_profiles',
      'safari_reading_list_items',
      'safari_tab_groups',
      'safari_tab_history_entries',
      'safari_tabs',
      'safari_window_profiles',
      'safari_window_tab_groups',
      'safari_windows',
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT kind, name FROM catalog WHERE name LIKE 'safari%' AND coalesce(description, '') = ''`,
    ),
    [],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT name, data_type FROM catalog
        WHERE name IN ('safari_history_items.dailyVisitCounts', 'safari_history_items.autocompleteTriggers', 'safari_history_visits.visitedAt', 'safari_closed_tabs.ancestorTabIds')
        ORDER BY name`,
    ),
    [
      { name: 'safari_closed_tabs.ancestorTabIds', data_type: 'text[]' },
      {
        name: 'safari_history_items.autocompleteTriggers',
        data_type: 'text[]',
      },
      { name: 'safari_history_items.dailyVisitCounts', data_type: 'bigint[]' },
      {
        name: 'safari_history_visits.visitedAt',
        data_type: 'timestamp with time zone',
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT id, url, "dailyVisitCounts"::text AS daily, "weeklyVisitCounts"::text AS weekly,
        "autocompleteTriggers"::text AS triggers, "statusCode", "derivedCountsStale"
        FROM safari_history_items WHERE "profileId" = 'DefaultProfile' ORDER BY id`,
    ),
    [
      {
        id: '1',
        url: 'https://example.com/',
        daily: '{20,0}',
        weekly: null,
        triggers: null,
        statusCode: null,
        derivedCountsStale: false,
      },
      {
        id: '2',
        url: 'https://example.org/',
        daily: '{0,20}',
        weekly: '{80}',
        triggers: '{exa,examp}',
        statusCode: '200',
        derivedCountsStale: true,
      },
    ],
  );
  // A redirect joins its two visits; an empty title reads as NULL.
  assert.deepEqual(
    rows(
      await agent`SELECT s.id AS source, d.id AS destination, s.title, d."loadSuccessful", s.origin, s."httpNonGet",
        to_char(d."visitedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
        FROM safari_history_visits s JOIN safari_history_visits d ON d."profileId" = s."profileId" AND d.id = s."redirectDestinationId"`,
    ),
    [
      {
        source: '11',
        destination: '12',
        title: null,
        loadSuccessful: false,
        origin: '1',
        httpNonGet: true,
        at: '2026-02-10T09:00:01Z',
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT i.url, t.identifier, t.title FROM safari_history_item_tags l
        JOIN safari_history_items i ON i."profileId" = l."profileId" AND i.id = l."itemId" JOIN safari_history_tags t ON t."profileId" = l."profileId" AND t.id = l."tagId"`,
    ),
    [{ url: 'https://example.com/', identifier: 'Q2063', title: 'JSON' }],
  );
  // Safari 27 stores a deleted URL encrypted, and an unbounded start as year 1.
  assert.deepEqual(
    rows(
      await agent`SELECT id, url, "encryptedUrl", "startAt" IS NULL AS unbounded, "deviceId"
        FROM safari_history_tombstones ORDER BY id`,
    ),
    [
      {
        id: '1',
        url: 'https://gone.example/',
        encryptedUrl: null,
        unbounded: false,
        deviceId: 'DEVICE-1',
      },
      {
        id: '2',
        url: null,
        encryptedUrl: 'Qo8K',
        unbounded: true,
        deviceId: 'DEVICE-1',
      },
      // Clearing a time range records the range and no URL.
      {
        id: '3',
        url: null,
        encryptedUrl: null,
        unbounded: false,
        deviceId: 'DEVICE-1',
      },
    ],
  );
  // Every profile keeps its own History.db; its rows carry the profile.
  assert.deepEqual(
    rows(
      await agent`SELECT v."profileId", p.title, count(*)::int AS visits
        FROM safari_history_visits v JOIN safari_profiles p ON p.id = v."profileId"
        GROUP BY 1, 2 ORDER BY 1`,
    ),
    [
      { profileId: 'DefaultProfile', title: null, visits: 3 },
      { profileId: 'PROFILE-WORK', title: 'Work', visits: 1 },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT t.title, d.name, t.pinned, t."lastViewedAt", p."sortValue", r.id AS close_request
        FROM safari_cloud_tabs t JOIN safari_cloud_tab_devices d ON d.id = t."deviceId"
        JOIN safari_cloud_tab_positions p ON p."tabId" = t.id
        JOIN safari_cloud_tab_close_requests r ON r."tabId" = t.id`,
    ),
    [
      {
        title: 'Remote',
        name: 'Phone',
        pinned: true,
        lastViewedAt: null,
        sortValue: '1500',
        close_request: 'CR-1',
      },
    ],
  );
  // The Reading List folder is a bookmark; its items are their own stream.
  assert.deepEqual(
    rows(
      await agent`SELECT b.id, p.title AS folder, b.position, b.kind, b.title, b.url, b.hidden
        FROM safari_bookmarks b LEFT JOIN safari_bookmarks p ON p.id = b."parentId" ORDER BY b.id`,
    ),
    [
      {
        id: 'BAR',
        folder: null,
        position: '1',
        kind: 'folder',
        title: 'BookmarksBar',
        url: null,
        hidden: false,
      },
      {
        id: 'BM-1',
        folder: 'BookmarksBar',
        position: '0',
        kind: 'bookmark',
        title: 'Example',
        url: 'https://example.com/',
        hidden: false,
      },
      {
        id: 'BM-2',
        folder: 'Reading',
        position: '0',
        kind: 'bookmark',
        title: 'Nested',
        url: 'https://example.org/nested',
        hidden: false,
      },
      {
        id: 'FOLDER-1',
        folder: 'BookmarksBar',
        position: '1',
        kind: 'folder',
        title: 'Reading',
        url: null,
        hidden: false,
      },
      {
        id: 'MENU',
        folder: null,
        position: '2',
        kind: 'folder',
        title: 'BookmarksMenu',
        url: null,
        hidden: false,
      },
      {
        id: 'PROXY-HISTORY',
        folder: null,
        position: '0',
        kind: 'proxy',
        title: 'History',
        url: null,
        hidden: false,
      },
      {
        id: 'READING-LIST',
        folder: null,
        position: '3',
        kind: 'folder',
        title: 'com.apple.ReadingList',
        url: null,
        hidden: true,
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT id, title, "fetchedTitle", "previewText", "lastViewedAt", "fetchResult" FROM safari_reading_list_items`,
    ),
    [
      {
        id: 'RL-1',
        title: 'Saved',
        fetchedTitle: 'Fetched title',
        previewText: 'A preview',
        lastViewedAt: null,
        fetchResult: '1',
      },
    ],
  );
  // A tab closed on its own keeps no window; year 1 means never visited.
  assert.deepEqual(
    rows(
      await agent`SELECT t.id, t."closedWindowId", t.position, t."lastVisitedAt" IS NULL AS never,
        t."ancestorTabIds"::text AS ancestors, w."addressFieldText", a."tabId" = t.id AS active
        FROM safari_closed_tabs t LEFT JOIN safari_closed_windows w ON w.id = t."closedWindowId"
        LEFT JOIN safari_closed_window_active_tabs a ON a."windowId" = w.id ORDER BY t.id`,
    ),
    [
      {
        id: 'CT-1',
        closedWindowId: null,
        position: '0',
        never: true,
        ancestors: '{CT-0}',
        addressFieldText: null,
        active: null,
      },
      {
        id: 'CT-2',
        closedWindowId: 'W-1',
        position: '0',
        never: false,
        ancestors: '{}',
        addressFieldText: 'half typed',
        active: false,
      },
      {
        id: 'CT-3',
        closedWindowId: 'W-1',
        position: '1',
        never: false,
        ancestors: '{}',
        addressFieldText: 'half typed',
        active: true,
      },
    ],
  );
});

test('Safari reads profiles, windows, tab groups, tabs with their back and forward lists, and downloads with their files', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  await using warehouse = await appleWarehouse(
    'safari',
    new AppleSafariSource(location),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;

  await warehouse.load();

  assert.deepEqual(
    rows(
      await agent`SELECT id, "serverId", title, symbol, "colorName", red, alpha, "favoritesFolderServerId"
        FROM safari_profiles ORDER BY position`,
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
      await agent`SELECT identifier, enabled FROM safari_profile_start_page_sections WHERE "profileId" = 'PROFILE-WORK' ORDER BY position`,
    ),
    [
      { identifier: 'favoritesItemIdentifier', enabled: true },
      { identifier: 'privacyReportIdentifier', enabled: false },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT id, kind, "profileId", "parentId", title, "lastSelectedTabId", "deviceType", topic
        FROM safari_tab_groups ORDER BY id`,
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
      await agent`SELECT id, kind, "profileId", "tabGroupId", "windowId", pinned, "pinnedUrl", muted,
        "lastAccessedAt", "localTitle", "pageKeywords"::text AS keywords, "pageKeywordWeights"::text AS weights,
        "pageSummary", "ancestorTabIds"::text AS ancestors
        FROM safari_tabs ORDER BY id`,
    ),
    [
      {
        id: 'TAB-FAVORITE',
        kind: 'favorite',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-FAVORITES',
        windowId: null,
        pinned: false,
        pinnedUrl: null,
        muted: false,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '{}',
        weights: '{}',
        pageSummary: null,
        ancestors: '{}',
      },
      {
        id: 'TAB-LOCAL',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-LOCAL',
        windowId: 'WIN-1',
        pinned: false,
        pinnedUrl: null,
        muted: false,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '{}',
        weights: '{}',
        pageSummary: null,
        ancestors: '{}',
      },
      {
        id: 'TAB-NAMED',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'GROUP-NAMED',
        windowId: 'WIN-1',
        pinned: false,
        pinnedUrl: null,
        muted: true,
        lastAccessedAt: null,
        localTitle: 'Research here',
        keywords: '{physics,lab}',
        weights: '{0.9,0.25}',
        pageSummary: null,
        ancestors: '{TAB-LOCAL}',
      },
      {
        id: 'TAB-PINNED',
        kind: 'tab',
        profileId: 'DefaultProfile',
        tabGroupId: 'pinned',
        windowId: 'WIN-1',
        pinned: true,
        pinnedUrl: 'https://mail.example/',
        muted: false,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '{}',
        weights: '{}',
        pageSummary: null,
        ancestors: '{}',
      },
      {
        id: 'TAB-WORK',
        kind: 'tab',
        profileId: 'PROFILE-WORK',
        tabGroupId: 'GROUP-WORK',
        windowId: 'WIN-2',
        pinned: false,
        pinnedUrl: null,
        muted: false,
        lastAccessedAt: null,
        localTitle: null,
        keywords: '{}',
        weights: '{}',
        pageSummary: null,
        ancestors: '{}',
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT position, current, url, "originalUrl", "scriptCreated", "externalUrlPolicy"
        FROM safari_tab_history_entries WHERE "tabId" = 'TAB-NAMED' ORDER BY position`,
    ),
    [
      {
        position: '0',
        current: false,
        url: 'https://example.com/start',
        originalUrl: 'http://example.com/start',
        scriptCreated: false,
        externalUrlPolicy: null,
      },
      {
        position: '1',
        current: true,
        url: 'https://example.com/research',
        originalUrl: 'https://example.com/research',
        scriptCreated: true,
        externalUrlPolicy: 'allow',
      },
    ],
  );
  // A window names its profile, groups and state; NSNotFound reads as NULL.
  assert.deepEqual(
    rows(
      await agent`SELECT w.id, w."profileId", w."activeTabGroupId", w."localTabGroupId", w."privateTabGroupId",
        w."selectedPinnedTabIndex", w."favoritesBarHidden", w."unnamedTabGroupIds"::text AS unnamed,
        g."activeTabId", p."activeTabGroupId" AS profile_group
        FROM safari_windows w
        LEFT JOIN safari_window_tab_groups g ON g."windowId" = w.id AND g."tabGroupId" = w."activeTabGroupId"
        LEFT JOIN safari_window_profiles p ON p."windowId" = w.id ORDER BY w.id`,
    ),
    [
      {
        id: 'WIN-1',
        profileId: 'DefaultProfile',
        activeTabGroupId: 'GROUP-NAMED',
        localTabGroupId: 'GROUP-LOCAL',
        privateTabGroupId: 'GROUP-PRIVATE',
        selectedPinnedTabIndex: null,
        favoritesBarHidden: true,
        unnamed: '{GROUP-LOCAL}',
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
        favoritesBarHidden: false,
        unnamed: '{}',
        activeTabId: null,
        profile_group: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT "windowId", "tabGroupId", "activeTabId", unnamed FROM safari_window_tab_groups ORDER BY 2`,
    ),
    [
      {
        windowId: 'WIN-1',
        tabGroupId: 'GROUP-LOCAL',
        activeTabId: null,
        unnamed: true,
      },
      {
        windowId: 'WIN-1',
        tabGroupId: 'GROUP-NAMED',
        activeTabId: 'TAB-NAMED',
        unnamed: false,
      },
    ],
  );
  // A download still on disk is stored; an archive Safari opened is gone.
  const downloads = rows(
    await agent`SELECT id, "profileId", "availableLocally", "openedPath" IS NOT NULL AS opened, "attachmentRef"
      FROM safari_downloads ORDER BY id`,
  );
  assert.deepEqual(
    downloads.map(({ attachmentRef: _, ...download }) => download),
    [
      {
        id: 'DL-1',
        profileId: 'DefaultProfile',
        availableLocally: true,
        opened: false,
      },
      {
        id: 'DL-2',
        profileId: 'PROFILE-WORK',
        availableLocally: false,
        opened: true,
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
  await using warehouse = await appleWarehouse(
    'safari',
    new AppleSafariSource(location),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  const loads = async () =>
    rows(
      await warehouse.sql`SELECT (SELECT count(DISTINCT loaded_at) FROM apple_safari."raw_historyVisits")::int AS visits,
        (SELECT count(DISTINCT loaded_at) FROM apple_safari.raw_bookmarks)::int AS bookmarks`,
    );
  await warehouse.load();
  const first = await loads();

  await warehouse.load();
  const unchanged = await loads();
  {
    using history = new DatabaseSync(join(location.directory, 'History.db'));
    history.exec('DELETE FROM history_visits WHERE id = 10');
    history.exec('UPDATE history_items SET visit_count = 3 WHERE id = 2');
  }
  {
    using cloud = new DatabaseSync(join(location.container, 'CloudTabs.db'));
    cloud.exec('DELETE FROM cloud_tab_devices');
  }
  const bookmarks = structuredClone(bookmarksPlist) as unknown as {
    Children: { Children?: unknown[] }[];
  };
  bookmarks.Children[1]?.Children?.shift();
  await writePlist(join(location.directory, 'Bookmarks.plist'), bookmarks);
  await writePlist(join(location.directory, 'RecentlyClosedTabs.plist'), {
    ...closedTabsPlist,
    ClosedTabOrWindowPersistentStates:
      closedTabsPlist.ClosedTabOrWindowPersistentStates.slice(1, 2),
  });
  await warehouse.load();

  assert.deepEqual(first, [{ visits: 1, bookmarks: 1 }]);
  assert.deepEqual(unchanged, first);
  assert.deepEqual(
    (
      await agent`SELECT id FROM safari_history_visits WHERE "profileId" = 'DefaultProfile' ORDER BY id`
    ).map(({ id }) => id),
    ['11', '12'],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT id, "visitCount" FROM safari_history_items WHERE "profileId" = 'DefaultProfile' ORDER BY id`,
    ),
    [
      { id: '1', visitCount: '2' },
      { id: '2', visitCount: '3' },
    ],
  );
  assert.deepEqual(
    rows(
      await agent`SELECT (SELECT count(*) FROM safari_cloud_tabs)::int AS tabs,
        (SELECT count(*) FROM safari_cloud_tab_positions)::int AS positions,
        (SELECT count(*) FROM safari_cloud_tab_devices)::int AS devices`,
    ),
    [{ tabs: 0, positions: 0, devices: 0 }],
  );
  assert.deepEqual(
    (
      await agent`SELECT id FROM safari_bookmarks WHERE kind = 'bookmark' ORDER BY id`
    ).map(({ id }) => id),
    ['BM-2'],
  );
  assert.deepEqual(
    (await agent`SELECT id FROM safari_closed_tabs ORDER BY id`).map(
      ({ id }) => id,
    ),
    ['CT-2', 'CT-3'],
  );
});

test('Safari scope keeps the chosen profiles and visit dates, and leaves unattributed data whole', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const counts = async (scope: ImportScope) => {
    await using warehouse = await appleWarehouse(
      'safari',
      new AppleSafariSource({ ...location, scope }),
      join(scratch.path, 'outputs'),
    );
    await warehouse.load();
    return rows(
      await warehouse.agent`SELECT (SELECT count(*) FROM safari_history_visits)::int AS visits,
        (SELECT count(*) FROM safari_history_items)::int AS items,
        (SELECT count(*) FROM safari_history_tags)::int AS tags,
        (SELECT count(*) FROM safari_history_tombstones)::int AS tombstones,
        (SELECT count(*) FROM safari_closed_tabs)::int AS closed,
        (SELECT count(*) FROM safari_tabs)::int AS tabs,
        (SELECT count(*) FROM safari_tab_groups)::int AS groups,
        (SELECT count(*) FROM safari_downloads)::int AS downloads,
        (SELECT count(*) FROM safari_bookmarks)::int AS bookmarks,
        (SELECT count(*) FROM safari_cloud_tabs)::int AS cloud`,
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
  await using warehouse = await appleWarehouse(
    'safari',
    source,
    join(scratch.path, 'outputs'),
  );
  await warehouse.load();
  await rm(join(location.directory, 'Bookmarks.plist'));
  {
    using history = new DatabaseSync(join(location.directory, 'History.db'));
    history.exec('ALTER TABLE history_visits DROP COLUMN score');
  }

  const failure = await warehouse.load().then(
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
      await warehouse.agent`SELECT (SELECT count(*) FROM safari_bookmarks)::int AS bookmarks,
        (SELECT count(*) FROM safari_history_visits)::int AS visits,
        (SELECT count(*) FROM safari_cloud_tabs)::int AS cloud`,
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
  assert.ok(status.error instanceof SafariSchemaError);
});

test('a Safari watch wakes only the streams of the store that changed, while Safari keeps its databases open', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'safari-'));
  const location = await safariFixture(scratch.path);
  const source = new AppleSafariSource({ ...location, pollIntervalMs: 20 });
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
    signal: controller.signal,
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
      SafariUnavailableError.name,
    )
  )
    return t.skip(`no access to ${safariDirectory} or ${safariContainer}`);
  assert.ok(Array.isArray(outcome), String(outcome));

  using database = new DatabaseSync(destination.path, { readOnly: true });
  const count = (table: string) =>
    Number(database.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n);
  assert.ok(count('historyItems') > 0);
  assert.ok(count('historyVisits') >= count('historyItems'));
  assert.equal(
    count('bookmarks') > 0,
    true,
    'Safari always has its top-level bookmark folders',
  );
});
