import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { Copy, Pipeline, PipelineError } from 'elt';
import { GOOGLE_SEARCH_CONSOLE_SCOPE } from 'google-auth';
import { LoginTicket, OAuth2Client } from 'google-auth-library';

import {
  GrantFiles,
  googleCalendarAttachments,
  googleSession,
  listenForCallback,
  OAuthCallbackTimeoutError,
  SearchConsoleApi,
  SearchConsoleQuotaError,
  SearchConsoleSource,
} from './index.ts';
import { scratchWarehouse } from './test-warehouse.ts';

const SITE = 'sc-domain:example.com';
const NOW = () => new Date('2026-09-22T00:00:00.000Z');

type Call = {
  url: string;
  data?: Record<string, unknown>;
};

function recorder(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    requester: {
      async request(options: {
        url: string;
        method?: string;
        data?: Record<string, unknown>;
      }) {
        const call: Call = {
          url: options.url,
          ...(options.data ? { data: options.data } : {}),
        };
        calls.push(call);
        return { data: reply(call) };
      },
    },
  };
}

// A sitemaps.list entry as the API returns it live.
const sitemapEntry = (path: string) => ({
  path,
  lastSubmitted: '2024-07-18T14:07:25.104Z',
  isPending: false,
  isSitemapsIndex: false,
  type: 'sitemap',
  lastDownloaded: '2026-09-19T07:32:39.730Z',
  warnings: '0',
  errors: '0',
  contents: [{ type: 'web', submitted: '1', indexed: '0' }],
});

const analyticsCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.url.includes('searchAnalytics/query'));

test('Search Console maps positional analytics keys onto its dimensions', async () => {
  const { requester, calls } = recorder(() => ({
    metadata: { firstIncompleteDate: '2026-09-21' },
    rows: [
      {
        clicks: 0,
        impressions: 340,
        keys: ['2026-09-20', 'context compiler'],
        ctr: 0,
        position: 8.1,
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('search_analytics'),
  );

  assert.deepEqual(
    await new Pipeline({ source, destination, steps: [copy] }).run(),
    [{ copy, count: 1, deleted: 0 }],
  );
  const [loaded] =
    await sql`SELECT date::text, query, clicks::int, impressions::int, position FROM search_analytics`;
  assert.deepEqual(
    { ...loaded },
    {
      clicks: 0,
      date: '2026-09-20',
      impressions: 340,
      position: 8.1,
      query: 'context compiler',
    },
  );
  const [request] = analyticsCalls(calls);
  assert.deepEqual(request?.data, {
    dataState: 'ALL',
    dimensions: ['date', 'query'],
    endDate: '2026-09-22',
    rowLimit: 25_000,
    // Sixteen calendar months before 2026-09-22, not 480 days.
    startDate: '2025-05-22',
    startRow: 0,
    type: 'WEB',
  });
});

test('a restated day replaces the loaded row and the checkpoint stops at the settled date', async () => {
  let clicks = 12;
  let firstIncompleteDate = '2026-09-21';
  const { requester, calls } = recorder(() => ({
    metadata: { firstIncompleteDate },
    rows: [
      {
        clicks,
        ctr: 0.035,
        impressions: 340,
        keys: ['2026-09-20', 'context compiler'],
        position: 8.1,
      },
      {
        clicks: 5,
        ctr: 0.05,
        impressions: 100,
        keys: ['2026-09-21', 'context compiler'],
        position: 7,
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('search_analytics'),
    {
      cursorField: 'date',
      dedupPolicy: 'replace',
      destinationSyncMode: 'append_dedup',
      id: 'search-analytics',
      primaryKey: ['siteUrl', 'date', 'query'],
      syncMode: 'incremental',
    },
  );
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
  });

  await pipeline.run();
  const loaded = async () =>
    (
      await sql`SELECT date::text, clicks::int, settled FROM search_analytics ORDER BY date`
    ).map((row) => ({ ...row }));
  const saved = async () => {
    const [row] =
      await sql`SELECT state FROM _mac_elt_checkpoints WHERE id = ${'search-analytics'}`;
    return row?.state;
  };
  // The 21st is still being collected, and its row says so.
  assert.deepEqual(await loaded(), [
    { clicks: 12, date: '2026-09-20', settled: true },
    { clicks: 5, date: '2026-09-21', settled: false },
  ]);
  // firstIncompleteDate is 2026-09-21, so the last settled day is the 20th,
  // kept as the property's own partition state.
  const checkpoint = (date: string) => ({
    partitions: [{ partition: { siteUrl: SITE }, state: { date } }],
  });
  assert.deepEqual(await saved(), checkpoint('2026-09-20'));

  clicks = 19;
  firstIncompleteDate = '2026-09-22';
  await pipeline.run();
  // One row per day still, carrying the restated metric, and the 21st has
  // settled since.
  assert.deepEqual(await loaded(), [
    { clicks: 19, date: '2026-09-20', settled: true },
    { clicks: 5, date: '2026-09-21', settled: true },
  ]);
  assert.deepEqual(await saved(), checkpoint('2026-09-21'));
  // The second run resumes at the settled day rather than after it.
  assert.equal(analyticsCalls(calls).at(-1)?.data?.startDate, '2026-09-20');
});

test('a fractional click count is refused rather than stored', async () => {
  const { requester } = recorder(() => ({
    rows: [
      {
        clicks: 1.5,
        ctr: 0.5,
        impressions: 3,
        keys: ['2026-09-20'],
        position: 2,
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination } = warehouse;
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });

  await assert.rejects(
    new Pipeline({
      source,
      destination,
      steps: [
        new Copy(source.searchAnalyticsDaily, destination.table('daily')),
      ],
    }).run(),
    /clicks/,
  );
});

test('analytics pagination follows startRow until a short page', async () => {
  const page = (start: number, size: number) =>
    Array.from({ length: size }, (_, index) => ({
      clicks: 1,
      ctr: 0.1,
      impressions: 2,
      keys: [`2026-09-0${((start + index) % 9) + 1}`, `q-${start + index}`],
      position: 1,
    }));
  const { requester, calls } = recorder((call) => {
    const startRow = Number(call.data?.['startRow'] ?? 0);
    const rowLimit = Number(call.data?.['rowLimit'] ?? 0);
    return { rows: startRow === 0 ? page(0, rowLimit) : page(rowLimit, 3) };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('rows'),
  );
  // Extraction is lazy: nothing is requested until the destination pulls.
  assert.equal(analyticsCalls(calls).length, 0);
  await new Pipeline({ source, destination, steps: [copy] }).run();
  const requests = analyticsCalls(calls);
  assert.equal(requests.length, 2, 'a full page is followed by one more');
  assert.equal(requests[0]?.data?.['startRow'], 0);
  assert.equal(requests[1]?.data?.['startRow'], 25_000);
  const [total] = await sql`SELECT count(*)::int AS count FROM rows`;
  assert.deepEqual({ ...total }, { count: 25_003 });
});

test('sitemaps convert int64 text and second-precision times', async () => {
  const { requester } = recorder(() => ({
    sitemap: [
      {
        ...sitemapEntry('https://example.com/sitemap.xml'),
        contents: [{ submitted: '512', type: 'web' }],
        errors: '2',
        lastDownloaded: '2026-09-20T10:30:00Z',
        lastSubmitted: '2026-09-19T08:00:00.250Z',
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    fetch: async () =>
      new Response('https://example.com/a\nhttps://example.com/b\n'),
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  await new Pipeline({
    source,
    destination,
    steps: [
      new Copy(source.sitemaps, destination.table('sitemaps')),
      new Copy(source.sitemapContents, destination.table('contents')),
    ],
  }).run();

  const [sitemap] =
    await sql`SELECT path, errors::int, warnings::int, "isPending", "isSitemapsIndex", "lastDownloaded", "lastSubmitted", "urlsRead"::int, "readError" FROM sitemaps`;
  assert.deepEqual(
    { ...sitemap },
    {
      errors: 2,
      isPending: false,
      isSitemapsIndex: false,
      lastDownloaded: new Date('2026-09-20T10:30:00.000Z'),
      lastSubmitted: new Date('2026-09-19T08:00:00.250Z'),
      path: 'https://example.com/sitemap.xml',
      readError: null,
      urlsRead: 2,
      warnings: 0,
    },
  );
  const [content] =
    await sql`SELECT "sitemapPath", type, submitted::int, indexed::int FROM contents`;
  assert.deepEqual(
    { ...content },
    {
      indexed: null,
      sitemapPath: 'https://example.com/sitemap.xml',
      submitted: 512,
      type: 'web',
    },
  );
});

test('inspection covers every sitemap and search URL once, shared by all three streams', async () => {
  const { requester, calls } = recorder((call) => {
    if (call.url.endsWith('/sitemaps'))
      return { sitemap: [sitemapEntry('https://example.com/sitemap.xml')] };
    if (call.url.includes('searchAnalytics/query'))
      // A later startRow exhausts the range, which ends the paging loop.
      return {
        rows:
          Number(call.data?.['startRow'] ?? 0) > 0
            ? []
            : [
                {
                  clicks: 1,
                  ctr: 1,
                  impressions: 9,
                  keys: ['https://example.com/a'],
                  position: 1,
                },
                // A sitelink anchor is the same document as its page.
                {
                  clicks: 0,
                  ctr: 0,
                  impressions: 4,
                  keys: ['https://example.com/b#intro'],
                  position: 2,
                },
                // Not under the property, so it cannot be inspected.
                {
                  clicks: 0,
                  ctr: 0,
                  impressions: 1,
                  keys: ['https://other.org/x'],
                  position: 9,
                },
              ],
      };
    return {
      inspectionResult: {
        inspectionResultLink: 'https://search.google.com/inspect',
        indexStatusResult: {
          coverageState: 'Submitted and indexed',
          lastCrawlTime: '2026-09-18T04:05:06Z',
          referringUrls: ['https://example.com/hub'],
          sitemap: ['https://example.com/sitemap.xml'],
          verdict: 'PASS',
        },
      },
    };
  });
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    return new Response(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/c?x=1&amp;y=2</loc></url></urlset>',
    );
  };
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    fetch,
    now: NOW,
    requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: (
      [
        [source.urlInspection, 'inspection'],
        [source.urlInspectionSitemaps, 'inspection_sitemaps'],
        [source.urlInspectionReferrers, 'inspection_referrers'],
      ] as const
    ).map(
      ([stream, table]) =>
        new Copy(stream, destination.table(table), {
          id: table,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: [...stream.primaryKey],
        }),
    ),
  });
  const inspected = () =>
    calls
      .filter((call) => call.url.endsWith('index:inspect'))
      .map((call) => call.data?.['inspectionUrl']);

  await pipeline.run();
  // Three distinct pages, each inspected once although three streams load it.
  assert.deepEqual(inspected().sort(), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c?x=1&y=2',
  ]);
  assert.deepEqual(fetched, ['https://example.com/sitemap.xml']);
  // The same day, every URL is fresh: no inspection call at all.
  await pipeline.run();
  assert.equal(inspected().length, 3);

  assert.deepEqual(
    (
      await sql`SELECT "inspectionUrl", "inSitemap", "inSearchAnalytics", verdict, "inspectedAt" FROM inspection ORDER BY "inspectionUrl"`
    ).map((row) => ({ ...row })),
    (
      [
        ['https://example.com/a', true, true],
        ['https://example.com/b', false, true],
        ['https://example.com/c?x=1&y=2', true, false],
      ] as const
    ).map(([inspectionUrl, inSitemap, inSearchAnalytics]) => ({
      inspectionUrl,
      inSitemap,
      inSearchAnalytics,
      verdict: 'PASS',
      inspectedAt: NOW(),
    })),
  );
  for (const table of ['inspection_sitemaps', 'inspection_referrers']) {
    const [total] = await sql`SELECT count(*)::int AS count FROM ${sql(table)}`;
    assert.equal(total?.count, 3);
  }
});

test('watching invalidates only when the property actually changed', async () => {
  let clicks = 12;
  const { requester, calls } = recorder(() => ({
    metadata: { firstIncompleteDate: '2026-09-21' },
    rows: [
      {
        clicks,
        ctr: 0.03,
        impressions: 340,
        keys: ['2026-09-20'],
        position: 8,
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    pollIntervalMs: 1,
    requester,
    siteUrls: [SITE],
  });
  // One key per row is the daily grain.
  const copy = new Copy(source.searchAnalyticsDaily, destination.table('rows'));
  const controller = new AbortController();
  const watching = new Pipeline({ source, destination, steps: [copy] }).watch({
    signal: controller.signal,
  });

  try {
    assert.deepEqual((await watching.next()).value, [
      { copy, count: 1, deleted: 0 },
    ]);
    const afterFirst = calls.length;
    // The property is unchanged, so ticks probe without ever extracting.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(calls.length > afterFirst, 'the watcher keeps probing');
    clicks = 19;
    assert.deepEqual((await watching.next()).value, [
      { copy, count: 1, deleted: 0 },
    ]);
    const [row] = await sql`SELECT clicks::int FROM rows`;
    assert.equal(row?.clicks, 19);
  } finally {
    controller.abort();
  }
});

test('a feed report keeps an absent position as unknown, not as rank one', async () => {
  const { requester } = recorder((call) => {
    const type = String(call.data?.['type']);
    // Google's Discover and Google News responses omit position on every row,
    // including zero-traffic rows.
    if (type === 'DISCOVER' || type === 'GOOGLE_NEWS')
      return {
        rows: [{ clicks: 0, ctr: 0, impressions: 0, keys: ['2026-09-20'] }],
      };
    return {
      rows: [
        {
          clicks: 4,
          ctr: 0.02,
          impressions: 200,
          keys: ['2026-09-20'],
          position: 1.5,
        },
      ],
    };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    searchTypes: ['WEB', 'DISCOVER', 'GOOGLE_NEWS'],
    siteUrls: [SITE],
  });
  await new Pipeline({
    source,
    destination,
    steps: [new Copy(source.searchAnalyticsDaily, destination.table('daily'))],
  }).run();

  assert.deepEqual(
    (
      await sql`SELECT "searchType", clicks::int, position FROM daily ORDER BY "searchType"`
    ).map((row) => ({ ...row })),
    [
      { searchType: 'DISCOVER', clicks: 0, position: null },
      { searchType: 'GOOGLE_NEWS', clicks: 0, position: null },
      { searchType: 'WEB', clicks: 4, position: 1.5 },
    ],
  );
});

test('the history window clamps to the last day of a shorter start month', async () => {
  const requests: string[] = [];
  const { requester } = recorder((call) => {
    if (call.data?.['startDate']) requests.push(String(call.data['startDate']));
    return { rows: [] };
  });
  await using warehouse = await scratchWarehouse();
  const { destination } = warehouse;
  // Sixteen months before 31 March is 30 November, which has no 31st. An
  // unclamped subtraction rolls into December and drops a month of history.
  const source = new SearchConsoleSource({
    now: () => new Date('2026-03-31T00:00:00.000Z'),
    requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  await new Pipeline({
    source,
    destination,
    steps: [new Copy(source.searchAnalyticsDaily, destination.table('daily'))],
  }).run();

  assert.deepEqual(requests, ['2024-11-30']);
});

test('the country breakdown is a trailing snapshot, diffed rather than resumed by date', async () => {
  const windows: string[] = [];
  let rows: Record<string, unknown>[] = [
    {
      clicks: 3,
      ctr: 0.1,
      impressions: 30,
      keys: ['usa', 'DESKTOP'],
      position: 4,
    },
    {
      clicks: 1,
      ctr: 0.5,
      impressions: 2,
      keys: ['gbr', 'MOBILE'],
      position: 7,
    },
    // Google's own row, with one key too few: skipped, not fatal.
    { clicks: 9, ctr: 0.2, impressions: 90, keys: ['zzz'], position: 2 },
  ];
  const { requester } = recorder((call) => {
    if (call.data?.['startDate']) windows.push(String(call.data['startDate']));
    return { rows };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    breakdownMonths: 3,
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsCountries,
    destination.table('countries'),
    {
      id: 'countries',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      primaryKey: [...source.searchAnalyticsCountries.primaryKey],
    },
  );
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
  });

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  rows = [
    {
      clicks: 4,
      ctr: 0.1,
      impressions: 40,
      keys: ['usa', 'DESKTOP'],
      position: 4,
    },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 1 }]);

  // The window trails the clock; no date checkpoint narrows it.
  assert.deepEqual(windows, ['2026-06-22', '2026-06-22']);
  assert.deepEqual(
    (
      await sql`SELECT "siteUrl", country, device, clicks::int, "startDate"::text, "endDate"::text FROM countries`
    ).map((row) => ({ ...row })),
    [
      {
        clicks: 4,
        country: 'usa',
        device: 'DESKTOP',
        endDate: '2026-09-22',
        siteUrl: SITE,
        startDate: '2026-06-22',
      },
    ],
  );
});

test('every stream but sites carries its property and keys by it first', async () => {
  const source = new SearchConsoleSource({
    now: NOW,
    requester: recorder(() => ({})).requester,
    siteUrls: [SITE],
  });

  const unkeyed = (await source.discover()).streams.filter(
    (stream) =>
      stream.name !== 'sites' &&
      (stream.primaryKey[0] !== 'siteUrl' ||
        !Object.hasOwn(stream.jsonSchema['properties'] as object, 'siteUrl')),
  );

  assert.deepEqual(
    unkeyed.map((stream) => stream.name),
    [],
  );
});

test('two properties share tables through one source without deleting each other', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const sitemaps: Record<string, unknown[]> = {
    [A]: [sitemapEntry('https://a.example/sitemap.xml')],
    [B]: [sitemapEntry('https://b.example/sitemap.xml')],
  };
  const { requester } = recorder((call) => {
    const site = decodeURIComponent(
      call.url.split('/sites/')[1]?.split('/')[0] ?? '',
    );
    if (call.url.endsWith('/sitemaps')) return { sitemap: sitemaps[site] };
    const dimensions = call.data?.['dimensions'];
    const keys =
      Array.isArray(dimensions) && dimensions.includes('date')
        ? ['2026-09-20']
        : ['usa', 'DESKTOP'];
    return {
      rows: [{ clicks: 1, ctr: 0.1, impressions: 10, keys, position: 3 }],
    };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const pipeline = (siteUrls: string[], name = 'search-console') => {
    const source = new SearchConsoleSource({
      fetch: async () => new Response(''),
      now: NOW,
      requester,
      searchTypes: ['WEB'],
      siteUrls,
    });
    const listing = (stream: typeof source.sitemaps, table: string) =>
      new Copy(stream, destination.table(table), {
        id: `${name}:${stream.name}`,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        primaryKey: [...stream.primaryKey],
      });
    return new Pipeline({
      source,
      destination,
      checkpoints,
      steps: [
        listing(source.sitemaps, 'sitemaps'),
        new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
          id: `${name}:searchAnalyticsDaily`,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          dedupPolicy: 'replace',
          cursorField: 'date',
          primaryKey: [...source.searchAnalyticsDaily.primaryKey],
        }),
        listing(source.searchAnalyticsCountries, 'countries'),
      ],
    });
  };

  await pipeline([A, B]).run();
  sitemaps[A] = [];
  const counts = (await pipeline([A, B]).run()).map(
    ({ copy, count, deleted }) => [copy.from.name, count, deleted],
  );

  assert.deepEqual(counts, [
    ['sitemaps', 0, 1],
    ['searchAnalyticsDaily', 2, 0],
    ['searchAnalyticsCountries', 0, 0],
  ]);
  // A second pipeline is a second writer, even for a property the first
  // does not list.
  await assert.rejects(
    pipeline(['sc-domain:c.example'], 'other').run(),
    /Target sitemaps is written by \{"copy":"search-console:sitemaps"\}; \{"copy":"other:sitemaps"\} cannot write it/,
  );
  const sites = async (table: string) =>
    (await sql`SELECT "siteUrl" FROM ${sql(table)} ORDER BY "siteUrl"`).map(
      (row) => row.siteUrl,
    );
  assert.deepEqual(await sites('sitemaps'), [B]);
  assert.deepEqual(await sites('daily'), [A, B]);
  assert.deepEqual(await sites('countries'), [A, B]);
});

test('an unverified property is not offered as a readable site', async () => {
  const { requester } = recorder(() => ({
    siteEntry: [
      { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:owned.example' },
      {
        permissionLevel: 'siteRestrictedUser',
        siteUrl: 'sc-domain:shared.example',
      },
      // Listed by Google, but its history cannot be read.
      {
        permissionLevel: 'siteUnverifiedUser',
        siteUrl: 'sc-domain:other.example',
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  await new Pipeline({
    source,
    destination,
    steps: [new Copy(source.sites, destination.table('sites'))],
  }).run();

  assert.deepEqual(
    (
      await sql`SELECT "siteUrl", "permissionLevel" FROM sites ORDER BY "siteUrl"`
    ).map((row) => ({ ...row })),
    [
      { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:owned.example' },
      {
        permissionLevel: 'siteRestrictedUser',
        siteUrl: 'sc-domain:shared.example',
      },
    ],
  );
});

// Shaped like the GaxiosError google-auth-library throws for a real 429:
// `status`, a `Headers` object, and Google's error body.
function httpError(
  status: number,
  { retryAfter, reason }: { retryAfter?: string; reason?: string } = {},
) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: {
      status,
      headers: new Headers(
        retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      ),
      data: { error: { code: status, errors: reason ? [{ reason }] : [] } },
    },
  });
}

function sequence(outcomes: readonly unknown[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    requester: {
      async request() {
        const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
        calls += 1;
        if (outcome instanceof Error) throw outcome;
        return { data: outcome };
      },
    },
  };
}

const fast = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2000 };

test('a rate limit waits for the Retry-After the server asks for', async () => {
  const api = sequence([
    httpError(429, { retryAfter: '1' }),
    { siteEntry: [] },
  ]);
  const started = performance.now();

  assert.deepEqual(
    await new SearchConsoleApi(api.requester, { retry: fast }).sites(),
    { siteEntry: [] },
  );
  assert.equal(api.calls, 2);
  assert.ok(performance.now() - started >= 950, 'waited the requested second');
});

test('a Retry-After longer than the policy allows fails without waiting', async () => {
  const api = sequence([httpError(429, { retryAfter: '120' })]);
  const started = performance.now();

  await assert.rejects(
    new SearchConsoleApi(api.requester, { retry: fast }).sites(),
    (error: unknown) => {
      assert.ok(error instanceof SearchConsoleQuotaError);
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(api.calls, 1);
  assert.ok(performance.now() - started < 500);
});

test('rate limits that never clear report how many attempts were made', async () => {
  const api = sequence([httpError(429)]);

  await assert.rejects(
    new SearchConsoleApi(api.requester, { retry: fast }).sites(),
    (error: unknown) => {
      assert.ok(error instanceof SearchConsoleQuotaError);
      assert.equal(error.status, 429);
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.equal(api.calls, 3);
});

test('a rate-limit 403 is retried but a scope 403 is not', async () => {
  const limited = sequence([
    httpError(403, { reason: 'userRateLimitExceeded' }),
    { siteEntry: [] },
  ]);
  assert.deepEqual(
    await new SearchConsoleApi(limited.requester, { retry: fast }).sites(),
    { siteEntry: [] },
  );
  assert.equal(limited.calls, 2);

  // The same status Google uses for a missing scope or a disabled API.
  const scope = httpError(403, { reason: 'insufficientPermissions' });
  const denied = sequence([scope]);
  await assert.rejects(
    new SearchConsoleApi(denied.requester, { retry: fast }).sites(),
    (error: unknown) => error === scope,
  );
  assert.equal(denied.calls, 1);
});

test('a server error is retried, and one that persists passes through unchanged', async () => {
  const recovering = sequence([httpError(503), { siteEntry: [] }]);
  assert.deepEqual(
    await new SearchConsoleApi(recovering.requester, { retry: fast }).sites(),
    { siteEntry: [] },
  );
  assert.equal(recovering.calls, 2);

  const failure = httpError(500);
  const failing = sequence([failure]);
  await assert.rejects(
    new SearchConsoleApi(failing.requester, { retry: fast }).sites(),
    (error: unknown) => error === failure,
  );
  assert.equal(failing.calls, 3);
});

test('a grant file is owner-only, lands whole, and reads back', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-grant-'));
  const files = new GrantFiles(scratch.path);
  const ref = 'google/user/accounts/account.json';

  assert.equal(await files.read(ref), undefined);
  await files.write(ref, { credentialRef: 'google/user/accounts/a.json' });

  assert.deepEqual(await files.read(ref), {
    credentialRef: 'google/user/accounts/a.json',
  });
  assert.equal((await stat(join(scratch.path, ref))).mode & 0o777, 0o600);
  // The temporary file a write stages through is gone once it lands.
  assert.deepEqual(await readdir(join(scratch.path, 'google/user/accounts')), [
    'account.json',
  ]);
  await files.remove(ref);
  assert.equal(await files.read(ref), undefined);
  await assert.rejects(
    files.write('../outside.json', { credentialRef: 'x' }),
    /escapes the grant directory/,
  );
});

test('the loopback listener settles only on the redirect carrying its state', async () => {
  using listener = await listenForCallback();
  const answered = listener.callback('expected-state');

  const stray = await fetch(`${listener.redirectUri}?code=c&state=other`);
  assert.equal(stray.status, 400);
  assert.equal(
    (await fetch(new URL('/favicon.ico', listener.redirectUri))).status,
    404,
  );

  const redirect = `${listener.redirectUri}?code=c&state=expected-state`;
  const page = await fetch(redirect);
  assert.match(await page.text(), /Signed in/);
  assert.equal(await answered, redirect);
});

test('a refused consent still settles the listener so the flow can report it', async () => {
  using listener = await listenForCallback();
  const answered = listener.callback('state-1');

  const redirect = `${listener.redirectUri}?error=access_denied&state=state-1`;
  assert.match(await (await fetch(redirect)).text(), /Sign-in failed/);
  assert.equal(await answered, redirect);
});

test('a listener nobody answers times out and closes', async () => {
  using listener = await listenForCallback({ timeoutMs: 20 });

  await assert.rejects(
    listener.callback('state-1'),
    (error: unknown) => error instanceof OAuthCallbackTimeoutError,
  );
  await assert.rejects(fetch(listener.redirectUri));
});

function answerGoogle(t: TestContext, scope: string | (() => string)): void {
  t.mock.method(OAuth2Client.prototype, 'getToken', async () => ({
    res: null,
    tokens: {
      access_token: 'fresh',
      expiry_date: 2_000_000_000_000,
      id_token: 'id-token',
      refresh_token: 'refresh',
      scope: typeof scope === 'string' ? scope : scope(),
    },
  }));
  t.mock.method(
    OAuth2Client.prototype,
    'verifyIdToken',
    async () =>
      new LoginTicket('id-token', {
        aud: 'client-id',
        email: 'owner@example.com',
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        iss: 'https://accounts.google.com',
        sub: 'google-1',
      }),
  );
}

// Plays the browser: reads where Google would redirect and with which state.
function browser() {
  const opened: string[] = [];
  return {
    opened,
    async open(url: string) {
      opened.push(url);
      const consent = new URL(url);
      const redirect = new URL(
        String(consent.searchParams.get('redirect_uri')),
      );
      redirect.searchParams.set('code', 'authorization-code');
      redirect.searchParams.set(
        'state',
        String(consent.searchParams.get('state')),
      );
      await fetch(redirect);
    },
  };
}

const client = { clientId: 'client-id', clientSecret: 'client-secret' };

test('the first session runs consent and stores the grant; the next reuses it', async (t) => {
  answerGoogle(t, `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-session-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };

  const requester = await googleSession(options);
  assert.equal(typeof requester.request, 'function');
  assert.equal(chrome.opened.length, 1);
  const consent = new URL(String(chrome.opened[0]));
  assert.match(
    String(consent.searchParams.get('redirect_uri')),
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
  );
  assert.match(
    String(consent.searchParams.get('scope')),
    /webmasters\.readonly/,
  );

  const [user] = await readdir(join(scratch.path, 'google'));
  const accounts = join(scratch.path, 'google', String(user), 'accounts');
  const [account] = await readdir(accounts);
  assert.equal(
    (await stat(join(accounts, String(account)))).mode & 0o777,
    0o600,
  );

  await googleSession(options);
  assert.equal(chrome.opened.length, 1, 'the stored grant is reused');
});

test('a grant that lacks a newly needed scope asks for consent again', async (t) => {
  const analytics = 'https://www.googleapis.com/auth/analytics.readonly';
  // Google grants what the consent asked for, so the first grant lacks it.
  let granted = `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`;
  answerGoogle(t, () => granted);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-upgrade-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
  };

  await googleSession({ ...options, scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE] });
  granted = `${granted} ${analytics}`;
  await googleSession({
    ...options,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE, analytics],
  });

  assert.equal(chrome.opened.length, 2);
  // Re-consent asks for the union, so the scope already granted is kept.
  const second = String(
    new URL(String(chrome.opened[1])).searchParams.get('scope'),
  );
  assert.match(second, /webmasters\.readonly/);
  assert.match(second, /analytics\.readonly/);
});

test('a grant Google no longer honors is replaced through consent', async (t) => {
  answerGoogle(t, `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-revoked-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };
  await googleSession(options);

  // Google refuses the stored refresh token once, as it does after revocation.
  let refusals = 1;
  t.mock.method(OAuth2Client.prototype, 'getAccessToken', async () => {
    if (refusals-- > 0) throw new Error('invalid_grant');
    return { res: null, token: 'fresh' };
  });
  await googleSession(options);

  assert.equal(chrome.opened.length, 2);
});

test('aborting a watcher stops a rate-limit wait instead of sitting it out', {
  timeout: 5000,
}, async () => {
  let loaded = false;
  const limited = Promise.withResolvers<void>();
  const requester = {
    async request() {
      // Every probe and the load of the first pass succeed; the next probe is
      // told to come back in 45 seconds. The watcher keeps probing while the
      // warehouse connects, so the first pass can take more than two calls.
      if (!loaded)
        return {
          data: {
            rows: [
              {
                clicks: 1,
                ctr: 0.1,
                impressions: 9,
                keys: ['2026-09-20'],
                position: 2,
              },
            ],
          },
        };
      limited.resolve();
      throw httpError(429, { retryAfter: '45' });
    },
  };
  await using warehouse = await scratchWarehouse();
  const { destination } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    pollIntervalMs: 1,
    requester,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 60_000 },
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const copy = new Copy(source.searchAnalyticsDaily, destination.table('rows'));
  const controller = new AbortController();
  const watching = new Pipeline({ source, destination, steps: [copy] }).watch({
    signal: controller.signal,
  });

  assert.deepEqual((await watching.next()).value, [
    { copy, count: 1, deleted: 0 },
  ]);
  loaded = true;
  await limited.promise;
  const started = performance.now();
  controller.abort();

  assert.deepEqual(await watching.next(), { done: true, value: undefined });
  assert.ok(performance.now() - started < 1000, 'closed without the 45 s wait');
});

test('aborting a watcher cancels its in-flight probe as an AbortError', {
  timeout: 5000,
}, async () => {
  let served = 0;
  const probing = Promise.withResolvers<void>();
  const requester = {
    request({ signal }: { signal?: AbortSignal }) {
      served += 1;
      if (served === 1)
        return Promise.resolve({
          data: {
            rows: [
              {
                clicks: 1,
                ctr: 0.1,
                impressions: 9,
                keys: ['2026-09-20'],
                position: 2,
              },
            ],
          },
        });
      probing.resolve();
      // gaxios rejects a cancelled fetch with a generic error, not AbortError.
      return new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () =>
          reject(
            new Error('The operation was aborted.', { cause: signal.reason }),
          ),
        );
      });
    },
  };
  const source = new SearchConsoleSource({
    now: NOW,
    pollIntervalMs: 1,
    requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const controller = new AbortController();
  const watching = source.watch({
    signal: controller.signal,
    streams: [source.searchAnalyticsDaily],
  });

  await watching.next();
  const polling = watching.next();
  await probing.promise;
  controller.abort();

  await assert.rejects(polling, { name: 'AbortError' });
});

test('an incremental sites copy deletes a property that is no longer listed', async () => {
  let siteEntry = [
    { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:a.example' },
    { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:b.example' },
  ];
  const { requester } = recorder(() => ({ siteEntry }));
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(source.sites, destination.table('sites'), {
    id: 'sites',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['siteUrl'],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [copy],
  });

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  siteEntry = [
    { permissionLevel: 'siteFullUser', siteUrl: 'sc-domain:a.example' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 1 }]);
  assert.deepEqual(
    (await sql`SELECT "siteUrl", "permissionLevel" FROM sites`).map((row) => ({
      ...row,
    })),
    [{ siteUrl: 'sc-domain:a.example', permissionLevel: 'siteFullUser' }],
  );
});

function googleError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    response: { status, data },
  });
}

test('Calendar attachments download Drive files and Gmail parts, and report unreachable ones', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  const pdf = new TextEncoder().encode('%PDF-1.7').buffer;
  const { calls, requester } = recorder(({ url }) => {
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
  const fetch = googleCalendarAttachments(requester);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gcal-att-'));
  const saved = async (uri: string) => {
    const path = join(scratch.path, `f${calls.length}`);
    const result = await fetch({ uri }, path);
    return result ? new Uint8Array(await readFile(path)) : result;
  };

  assert.deepEqual(
    await saved('https://drive.google.com/file/d/image/view?usp=drive_web'),
    new Uint8Array(png),
  );
  assert.deepEqual(
    await saved('https://drive.google.com/open?id=doc&authuser=0'),
    new Uint8Array(pdf),
  );
  assert.deepEqual(
    await saved('?view=att&th=m1&attid=0.1&disp=safe&zw'),
    new Uint8Array(Buffer.from('mail bytes')),
  );
  assert.deepEqual(
    await saved('?view=att&th=t1&attid=0.2&disp=safe&zw'),
    new Uint8Array(Buffer.from('inline')),
  );
  assert.equal(
    await saved('https://drive.google.com/file/d/private/view'),
    false,
  );
  assert.equal(await saved('https://drive.google.com/file/d/gone/view'), false);
  assert.equal(await saved('https://example.com/file.pdf'), false);
  assert.equal(await saved('?view=att&th=m1&attid=0.9'), false);
});

test('Calendar attachment downloads fail on a disabled API, a missing scope or a server error', async () => {
  for (const [error, message] of [
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
  ] as const) {
    const { requester } = recorder(() => {
      throw error;
    });
    await assert.rejects(
      googleCalendarAttachments(requester)(
        { uri: 'https://drive.google.com/file/d/abc/view' },
        '/unused',
      ),
      message,
    );
  }
});

const siteOf = (call: Call) =>
  decodeURIComponent(call.url.split('/sites/')[1]?.split('/')[0] ?? '') ||
  String(call.data?.['siteUrl']);

test('one source loads every property; a newly listed one backfills while the others resume', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const { requester, calls } = recorder((call) => {
    const site = siteOf(call);
    if (call.url.includes('index:inspect'))
      return { inspectionResult: { indexStatusResult: { verdict: site } } };
    const pages = call.data?.['dimensions'];
    // A later startRow exhausts the range, which ends the paging loop.
    if (Array.isArray(pages) && pages.includes('page'))
      return {
        rows:
          Number(call.data?.['startRow'] ?? 0) > 0
            ? []
            : [
                {
                  clicks: 1,
                  ctr: 1,
                  impressions: 1,
                  keys: [`https://${site.replace('sc-domain:', '')}/`],
                  position: 1,
                },
              ],
      };
    return {
      metadata: { firstIncompleteDate: '2026-09-21' },
      rows: [
        {
          clicks: site === A ? 3 : 7,
          ctr: 0.1,
          impressions: 30,
          keys: ['2026-09-20'],
          position: 2,
        },
      ],
    };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const run = (siteUrls: string[]) => {
    const source = new SearchConsoleSource({
      now: NOW,
      requester,
      searchTypes: ['WEB'],
      siteUrls,
    });
    return new Pipeline({
      source,
      destination,
      checkpoints,
      steps: [
        new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
          id: 'daily',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          dedupPolicy: 'replace',
          cursorField: 'date',
          primaryKey: [...source.searchAnalyticsDaily.primaryKey],
        }),
        new Copy(source.urlInspection, destination.table('inspection'), {
          id: 'inspection',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: [...source.urlInspection.primaryKey],
        }),
      ],
    }).run();
  };

  await run([A]);
  const firstRun = calls.length;
  await run([A, B]);

  const windows = analyticsCalls(calls.slice(firstRun))
    .filter((call) => call.data?.['dimensions']?.toString() === 'date')
    .map((call) => [siteOf(call), call.data?.['startDate']]);
  // A resumes at its settled day; B has no state yet, so it backfills.
  assert.deepEqual(windows, [
    [A, '2026-09-20'],
    [B, '2025-05-22'],
  ]);
  assert.deepEqual(
    (
      await sql`SELECT "siteUrl", clicks::int FROM daily ORDER BY "siteUrl"`
    ).map((row) => [row.siteUrl, row.clicks]),
    [
      [A, 3],
      [B, 7],
    ],
  );
  assert.deepEqual(
    (
      await sql`SELECT "siteUrl", "inspectionUrl", verdict FROM inspection ORDER BY "siteUrl"`
    ).map((row) => [row.siteUrl, row.inspectionUrl, row.verdict]),
    [
      [A, 'https://a.example/', A],
      [B, 'https://b.example/', B],
    ],
  );
});

test('a property without permission is reported by name while the others load and checkpoint', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  let denied = true;
  const { requester } = recorder((call) => {
    if (denied && siteOf(call) === B)
      throw googleError(403, {
        error: {
          message: `User does not have sufficient permission for site '${B}'.`,
          errors: [{ reason: 'forbidden' }],
        },
      });
    return {
      rows: [
        {
          clicks: 1,
          ctr: 1,
          impressions: 1,
          keys: ['2026-09-20'],
          position: 1,
        },
      ],
    };
  });
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    searchTypes: ['WEB'],
    siteUrls: [A, B],
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [
      new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
        id: 'daily',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        dedupPolicy: 'replace',
        cursorField: 'date',
        primaryKey: [...source.searchAnalyticsDaily.primaryKey],
      }),
    ],
  });
  const loaded = async () =>
    (await sql`SELECT DISTINCT "siteUrl" FROM daily ORDER BY "siteUrl"`).map(
      (row) => row.siteUrl,
    );
  const saved = async () =>
    (await sql`SELECT state FROM _mac_elt_checkpoints`).flatMap(({ state }) =>
      (
        state as { partitions: { partition: { siteUrl: string } }[] }
      ).partitions.map(({ partition }) => partition.siteUrl),
    );

  const error = await pipeline.run().then(
    () => assert.fail('run should report the property without permission'),
    (error: unknown) => error,
  );

  // Never skipped silently: the run fails and names the property.
  assert.ok(error instanceof PipelineError, String(error));
  assert.match(
    error.message,
    /daily \{"siteUrl":"sc-domain:b\.example"\}: .*status code 403/,
  );
  assert.deepEqual(await loaded(), [A]);
  assert.deepEqual(await saved(), [A]);

  denied = false;
  await pipeline.run();
  assert.deepEqual(await loaded(), [A, B]);
  assert.deepEqual(await saved(), [A, B]);
});

test('watching invalidates when only one of several properties changed', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const clicks: Record<string, number> = { [A]: 3, [B]: 7 };
  const { requester, calls } = recorder((call) => ({
    metadata: { firstIncompleteDate: '2026-09-21' },
    rows: [
      {
        clicks: clicks[siteOf(call)],
        ctr: 0.1,
        impressions: 30,
        keys: ['2026-09-20'],
        position: 2,
      },
    ],
  }));
  await using warehouse = await scratchWarehouse();
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    now: NOW,
    pollIntervalMs: 1,
    requester,
    searchTypes: ['WEB'],
    siteUrls: [A, B],
  });
  const copy = new Copy(source.searchAnalyticsDaily, destination.table('rows'));
  const controller = new AbortController();
  const watching = new Pipeline({ source, destination, steps: [copy] }).watch({
    signal: controller.signal,
  });

  try {
    assert.deepEqual((await watching.next()).value, [
      { copy, count: 2, deleted: 0 },
    ]);
    const probed = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      [...new Set(calls.slice(probed).map(siteOf))].sort(),
      [A, B],
      'every property is probed',
    );
    clicks[B] = 9;
    assert.deepEqual((await watching.next()).value, [
      { copy, count: 2, deleted: 0 },
    ]);
    assert.deepEqual(
      (
        await sql`SELECT "siteUrl", clicks::int FROM rows ORDER BY "siteUrl"`
      ).map((row) => [row.siteUrl, row.clicks]),
      [
        [A, 3],
        [B, 9],
      ],
    );
  } finally {
    controller.abort();
  }
});

// A property whose sitemaps, search pages and inspection replies a test sets.
function inspectionProperty({
  sitemaps = {},
  pages = [],
  inspect = (url: string) => ({ verdict: 'PASS', referringUrls: [url] }),
}: {
  sitemaps?: Record<string, string | Uint8Array | number>;
  pages?: string[];
  inspect?: (url: string) => Record<string, unknown> | Error;
}) {
  const inspected: string[] = [];
  const requester = {
    async request(options: { url: string; data?: Record<string, unknown> }) {
      if (options.url.endsWith('/sitemaps'))
        return {
          data: {
            sitemap: Object.keys(sitemaps)
              .filter((path) => !path.startsWith('!'))
              .map(sitemapEntry),
          },
        };
      if (options.url.includes('searchAnalytics/query'))
        return {
          data: {
            rows:
              Number(options.data?.['startRow'] ?? 0) > 0
                ? []
                : pages.map((page) => ({
                    clicks: 0,
                    ctr: 0,
                    impressions: 1,
                    keys: [page],
                    position: 1,
                  })),
          },
        };
      const url = String(options.data?.['inspectionUrl']);
      inspected.push(url);
      const reply = inspect(url);
      if (reply instanceof Error) throw reply;
      return { data: { inspectionResult: { indexStatusResult: reply } } };
    },
  };
  const fetch = async (url: string) => {
    const body = sitemaps[url] ?? sitemaps[`!${url}`];
    if (body === undefined) return new Response('missing', { status: 404 });
    if (typeof body === 'number') return new Response('', { status: body });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body));
  };
  return { requester, fetch, inspected };
}

type Warehouse = Awaited<ReturnType<typeof scratchWarehouse>>;

async function inspectionRun(
  source: SearchConsoleSource,
  { destination, checkpoints }: Warehouse,
  streams: readonly (
    | 'urlInspection'
    | 'urlInspectionSitemaps'
    | 'urlInspectionReferrers'
  )[] = ['urlInspection'],
) {
  return new Pipeline({
    source,
    destination,
    checkpoints,
    steps: streams.map(
      (name) =>
        new Copy(source[name], destination.table(name), {
          id: name,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
          primaryKey: [...source[name].primaryKey],
        }),
    ),
  }).run();
}

async function inspectionRows({ sql }: Warehouse, table = 'urlInspection') {
  return (await sql`SELECT * FROM ${sql(table)} ORDER BY "inspectionUrl"`).map(
    (row) => ({ ...row }),
  );
}

test('sitemaps in every format feed the inspection universe', async () => {
  const property = inspectionProperty({
    sitemaps: {
      'https://example.com/index.xml':
        '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/pages.xml.gz</loc></sitemap><sitemap><loc>https://example.com/list.txt</loc></sitemap><sitemap><loc>https://example.com/feed.rss</loc></sitemap><sitemap><loc>https://example.com/atom.xml</loc></sitemap></sitemapindex>',
      '!https://example.com/pages.xml.gz': gzipSync(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/q?x=1&amp;y=2</loc></url><url><loc>https://example.com/q?x=1&#38;y=2</loc></url><url><loc>https://example.com/q?x=1&#x26;y=2#top</loc></url><url><loc><![CDATA[https://example.com/c?a=1&b=2]]></loc></url></urlset>',
      ),
      '!https://example.com/list.txt':
        'https://example.com/t\nhttps://blog.example.com/t\nhttps://elsewhere.org/t\n',
      '!https://example.com/feed.rss':
        '<rss version="2.0"><channel><item><link>https://example.com/r</link></item></channel></rss>',
      '!https://example.com/atom.xml':
        '<feed xmlns="http://www.w3.org/2005/Atom"><link rel="self" href="https://example.com/atom.xml"/><entry><link href="https://example.com/a"/></entry></feed>',
    },
  });
  await using warehouse = await scratchWarehouse();

  await inspectionRun(
    new SearchConsoleSource({
      ...property,
      now: NOW,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    }),
    warehouse,
  );

  // Entity forms and anchors collapse to one URL; other hosts are dropped.
  assert.deepEqual(property.inspected.sort(), [
    'https://blog.example.com/t',
    'https://example.com/a',
    'https://example.com/c?a=1&b=2',
    'https://example.com/q?x=1&y=2',
    'https://example.com/r',
    'https://example.com/t',
  ]);
});

test('an unreadable sitemap is recorded as data and inspection covers everything else', async () => {
  const nested = (depth: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: depth }, (_, level) => [
        `${level === 0 ? '' : '!'}https://example.com/i${level}.xml`,
        `<sitemapindex><sitemap><loc>https://example.com/i${level + 1}.xml</loc></sitemap></sitemapindex>`,
      ]),
    );
  const cases: [
    string,
    Record<string, string | Uint8Array | number>,
    RegExp,
  ][] = [
    ['missing', { 'https://example.com/s.xml': 404 }, /HTTP 404/],
    [
      'malformed',
      { 'https://example.com/s.xml': '<urlset><url><loc>x</url></urlset>' },
      /Expected closing tag/,
    ],
    [
      'an HTML page',
      { 'https://example.com/s.xml': '<!doctype html><p>Not found</p>' },
      /could not be read/,
    ],
    [
      'corrupt gzip',
      { 'https://example.com/s.xml': Uint8Array.of(0x1f, 0x8b, 1, 2, 3) },
      /could not be read/,
    ],
    ['nested too deep', nested(5), /nest deeper than 3 levels/],
  ];
  for (const [label, broken, reason] of cases) {
    const property = inspectionProperty({
      pages: ['https://example.com/p'],
      sitemaps: {
        ...broken,
        'https://example.com/good.xml': 'https://example.com/g\n',
      },
    });
    await using warehouse = await scratchWarehouse();
    const { destination, sql } = warehouse;
    const source = new SearchConsoleSource({
      ...property,
      now: NOW,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });

    await new Pipeline({
      source,
      destination,
      steps: [new Copy(source.sitemaps, destination.table('sitemaps'))],
    }).run();
    await inspectionRun(source, warehouse);

    // The good sitemap's page and the search page are still inspected.
    assert.deepEqual(
      property.inspected.sort(),
      ['https://example.com/g', 'https://example.com/p'],
      label,
    );
    const rows = (
      await sql`SELECT path, "urlsRead"::int, "readError" FROM sitemaps ORDER BY path`
    ).map((row) => ({ ...row }));
    const good = rows.find(
      (row) => row.path === 'https://example.com/good.xml',
    );
    const bad = rows.find((row) => row.path !== 'https://example.com/good.xml');
    assert.deepEqual(
      good,
      { path: 'https://example.com/good.xml', urlsRead: 1, readError: null },
      label,
    );
    assert.equal(bad?.urlsRead, null, label);
    assert.match(
      String(bad?.readError),
      /^Sitemap https:\/\/example\.com\/\S+ could not be read/,
      label,
    );
    assert.match(String(bad?.readError), reason, label);
  }
});

test('rolling refresh inspects new URLs first, then the stalest, and skips fresh ones', async () => {
  const pages = ['https://example.com/a', 'https://example.com/b'];
  const property = inspectionProperty({ pages });
  let clock = NOW().getTime();
  const source = () =>
    new SearchConsoleSource({
      ...property,
      inspectionConcurrency: 1,
      now: () => new Date(clock),
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
  const hour = 60 * 60 * 1000;
  await using warehouse = await scratchWarehouse();
  const calls = async () => {
    const before = property.inspected.length;
    await inspectionRun(source(), warehouse);
    return property.inspected.slice(before);
  };

  assert.deepEqual(await calls(), pages);
  clock += 12 * hour;
  pages.push('https://example.com/c');
  assert.deepEqual(await calls(), ['https://example.com/c']);
  clock += 18 * hour;
  pages.push('https://example.com/d');
  // a and b are 30 h old, c only 18 h: the new d goes first, c waits.
  assert.deepEqual(await calls(), [
    'https://example.com/d',
    'https://example.com/a',
    'https://example.com/b',
  ]);
});

test('the daily quota stops inspection cleanly and resumes after Pacific midnight', async () => {
  for (const [start, reset] of [
    ['2026-09-22T00:00:00.000Z', '2026-09-22T07:00:00.000Z'],
    ['2026-12-01T12:00:00.000Z', '2026-12-02T08:00:00.000Z'],
  ] as const) {
    let allowed = 2;
    const property = inspectionProperty({
      pages: ['a', 'b', 'c', 'd'].map((page) => `https://example.com/${page}`),
      inspect: () =>
        allowed-- > 0
          ? { verdict: 'PASS' }
          : httpError(429, { reason: 'rateLimitExceeded' }),
    });
    let clock = Date.parse(start);
    const source = new SearchConsoleSource({
      ...property,
      inspectionConcurrency: 1,
      now: () => new Date(clock),
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    await using warehouse = await scratchWarehouse();

    await inspectionRun(source, warehouse);
    // Live, the exhausted daily quota answers 429 rateLimitExceeded with no
    // Retry-After ("Quota exceeded for sc-domain:limerence.sh.").
    assert.deepEqual(property.inspected, [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    assert.deepEqual(
      (await inspectionRows(warehouse)).map((row) => row.inspectionUrl),
      ['https://example.com/a', 'https://example.com/b'],
    );
    clock = Date.parse(reset) - 1;
    await inspectionRun(source, warehouse);
    assert.equal(property.inspected.length, 3, 'no call before the reset');
    clock = Date.parse(reset);
    allowed = 10;
    await inspectionRun(source, warehouse);
    assert.deepEqual(property.inspected.slice(3), [
      'https://example.com/c',
      'https://example.com/d',
    ]);
  }
});

test('one inspection serves all three streams, and a URL that leaves is deleted from each', async () => {
  const pages = ['https://example.com/a', 'https://example.com/b'];
  let referrers = 2;
  const property = inspectionProperty({
    pages,
    inspect: (url) => ({
      verdict: 'PASS',
      sitemap: ['https://example.com/sitemap.xml'],
      referringUrls: Array.from(
        { length: referrers },
        (_, n) => `${url}/r${n}`,
      ),
    }),
  });
  let clock = NOW().getTime();
  const source = new SearchConsoleSource({
    ...property,
    now: () => new Date(clock),
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const all = [
    'urlInspection',
    'urlInspectionSitemaps',
    'urlInspectionReferrers',
  ] as const;
  await using warehouse = await scratchWarehouse();

  await inspectionRun(source, warehouse, ['urlInspection']);
  // The other two streams load later: they reuse the inspections already made.
  await inspectionRun(source, warehouse, all);
  assert.equal(property.inspected.length, 2);

  pages.pop();
  referrers = 1;
  clock += 25 * 60 * 60 * 1000;
  await inspectionRun(source, warehouse, all);

  assert.equal(property.inspected.length, 3);
  for (const table of all)
    assert.deepEqual(
      [
        ...new Set(
          (await inspectionRows(warehouse, table)).map(
            (row) => row.inspectionUrl,
          ),
        ),
      ],
      ['https://example.com/a'],
      table,
    );
  assert.deepEqual(
    (await inspectionRows(warehouse, 'urlInspectionReferrers')).map(
      (row) => row.referringUrl,
    ),
    ['https://example.com/a/r0'],
  );
});

test('inspections run concurrently, a rejected URL becomes a row, and a server error fails', async () => {
  let inFlight = 0;
  let peak = 0;
  const pages = Array.from({ length: 7 }, (_, n) => `https://example.com/${n}`);
  const requester = {
    async request(options: { url: string; data?: Record<string, unknown> }) {
      if (options.url.endsWith('/sitemaps')) return { data: {} };
      if (options.url.includes('searchAnalytics/query'))
        return {
          data: {
            rows:
              Number(options.data?.['startRow'] ?? 0) > 0
                ? []
                : pages.map((page) => ({
                    clicks: 0,
                    ctr: 0,
                    impressions: 1,
                    keys: [page],
                    position: 1,
                  })),
          },
        };
      const url = String(options.data?.['inspectionUrl']);
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later URLs answer sooner, so completions arrive out of order.
      await new Promise((resolve) =>
        setTimeout(resolve, 20 - pages.indexOf(url) * 2),
      );
      inFlight--;
      if (url.endsWith('/3'))
        throw googleError(400, {
          error: { code: 400, message: 'Invalid URL' },
        });
      return {
        data: { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } },
      };
    },
  };
  await using warehouse = await scratchWarehouse();

  await inspectionRun(
    new SearchConsoleSource({
      fetch: async () => new Response(''),
      inspectionConcurrency: 3,
      now: NOW,
      requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    }),
    warehouse,
  );

  assert.equal(peak, 3);
  const rows = await inspectionRows(warehouse);
  assert.deepEqual(
    rows.map((row) => [
      row.inspectionUrl,
      row.verdict,
      row.errorStatus === null ? null : Number(row.errorStatus),
    ]),
    pages.map((page) =>
      page.endsWith('/3') ? [page, null, 400] : [page, 'PASS', null],
    ),
  );
  assert.equal(rows[3]?.errorMessage, 'Invalid URL');

  const failing = inspectionProperty({
    pages,
    inspect: (url) =>
      url.endsWith('/5') ? googleError(500) : { verdict: 'PASS' },
  });
  await using broken = await scratchWarehouse();
  await assert.rejects(
    inspectionRun(
      new SearchConsoleSource({
        ...failing,
        now: NOW,
        retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        searchTypes: ['WEB'],
        siteUrls: [SITE],
      }),
      broken,
    ),
    /status code 500/,
  );
  assert.deepEqual(
    [...(await broken.sql`SELECT id FROM _mac_elt_checkpoints`)],
    [],
  );
});

test('inspection options are validated', () => {
  const base = {
    now: NOW,
    requester: recorder(() => ({})).requester,
    siteUrls: [SITE],
  };
  for (const inspectionRefreshHours of [0, -1, Number.NaN])
    assert.throws(
      () => new SearchConsoleSource({ ...base, inspectionRefreshHours }),
      /inspectionRefreshHours must be a positive number of hours/,
    );
  for (const inspectionConcurrency of [0, 1.5])
    assert.throws(
      () => new SearchConsoleSource({ ...base, inspectionConcurrency }),
      /inspectionConcurrency must be a whole number of at least one/,
    );
});

test('watching wakes inspection streams when URLs fall due, not when traffic changes', async () => {
  let clicks = 1;
  const property = inspectionProperty({ pages: ['https://example.com/a'] });
  const requester = {
    async request(options: { url: string; data?: Record<string, unknown> }) {
      const dimensions = options.data?.['dimensions'];
      if (Array.isArray(dimensions) && dimensions.includes('date'))
        return {
          data: {
            rows: [
              {
                clicks,
                ctr: 0.1,
                impressions: 10,
                keys: ['2026-09-20'],
                position: 1,
              },
            ],
          },
        };
      return property.requester.request(options);
    },
  };
  const source = new SearchConsoleSource({
    fetch: property.fetch,
    // 36 ms: the inspection falls due again almost at once.
    inspectionRefreshHours: 0.00001,
    pollIntervalMs: 5,
    requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  await using warehouse = await scratchWarehouse();
  const { destination, checkpoints } = warehouse;
  const copy = (stream: typeof source.urlInspection, id: string, extra = {}) =>
    new Copy(stream, destination.table(id), {
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
      primaryKey: [...stream.primaryKey],
      ...extra,
    });
  const controller = new AbortController();
  const watching = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [
      copy(source.urlInspection, 'inspection'),
      copy(source.searchAnalyticsDaily, 'daily', {
        dedupPolicy: 'replace',
        cursorField: 'date',
      }),
    ],
  }).watch({ signal: controller.signal });
  const passes = async (count: number) => {
    const names: string[][] = [];
    for (let n = 0; n < count; n++) {
      const { value } = await watching.next();
      names.push(
        value
          ? value.map(
              (result: { copy: { from: { name: string } } }) =>
                result.copy.from.name,
            )
          : [],
      );
    }
    return names;
  };

  try {
    assert.deepEqual(await passes(1), [
      ['urlInspection', 'searchAnalyticsDaily'],
    ]);
    // With traffic unchanged, only the due inspection wakes the pipeline.
    assert.deepEqual(await passes(1), [['urlInspection']]);
    assert.ok(property.inspected.length >= 2);
    clicks = 9;
    const seen = await passes(4);
    assert.ok(
      seen.some((names) => names.includes('searchAnalyticsDaily')),
      'a traffic change re-extracts the analytics stream',
    );
    assert.ok(
      seen.every(
        (names) =>
          !(names.includes('searchAnalyticsDaily') && names.length === 2),
      ) || seen.some((names) => names.length === 1),
    );
  } finally {
    controller.abort();
  }
});
