import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';

import { Copy, Pipeline, SQLiteCheckpointStore, SQLiteDestination } from 'elt';
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

const analyticsCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.url.includes('searchAnalytics/query'));

test('Search Console maps positional analytics keys onto its dimensions', async () => {
  const { requester, calls } = recorder(() => ({
    metadata: { firstIncompleteDate: '2026-09-21' },
    rows: [
      {
        // clicks is absent: proto3 omits a zero rather than reporting one.
        impressions: 340,
        keys: ['2026-09-20', 'context compiler'],
        ctr: 0,
        position: 8.1,
      },
    ],
  }));
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-map-'));
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('search_analytics'),
  );

  assert.deepEqual(
    await new Pipeline({ source, destination, steps: [copy] }).run(),
    [{ copy, count: 1, deleted: 0 }],
  );
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT date, query, clicks, impressions, position FROM search_analytics',
        )
        .get(),
    },
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
  const { requester, calls } = recorder(() => ({
    metadata: { firstIncompleteDate: '2026-09-21' },
    rows: [
      {
        clicks,
        ctr: 0.035,
        impressions: 340,
        keys: ['2026-09-20', 'context compiler'],
        position: 8.1,
      },
    ],
  }));
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-restate-'));
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
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
  using database = new DatabaseSync(destination.path, { readOnly: true });
  using state = new DatabaseSync(checkpoints.path, { readOnly: true });
  const loaded = () =>
    database
      .prepare('SELECT date, clicks FROM search_analytics')
      .all()
      .map((row) => ({ ...row }));
  const saved = () =>
    JSON.parse(
      String(
        state
          .prepare('SELECT state FROM checkpoints WHERE id = ?')
          .get('search-analytics')?.state,
      ),
    );
  assert.deepEqual(loaded(), [{ clicks: 12, date: '2026-09-20' }]);
  // firstIncompleteDate is 2026-09-21, so the last settled day is the 20th,
  // kept as the property's own partition state.
  const settled = {
    partitions: [
      { partition: { siteUrl: SITE }, state: { date: '2026-09-20' } },
    ],
  };
  assert.deepEqual(saved(), settled);

  clicks = 19;
  await pipeline.run();
  // One row still, carrying the restated metric rather than the first one.
  assert.deepEqual(loaded(), [{ clicks: 19, date: '2026-09-20' }]);
  assert.deepEqual(saved(), settled);
  // The second run resumes at the settled day rather than after it.
  assert.equal(analyticsCalls(calls).at(-1)?.data?.startDate, '2026-09-20');
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-page-'));
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    { ...database.prepare('SELECT count(*) AS count FROM rows').get() },
    { count: 25_003 },
  );
});

test('sitemaps normalize int64 text, omitted flags, and second-precision times', async () => {
  const { requester } = recorder(() => ({
    sitemap: [
      {
        contents: [{ submitted: '512', type: 'WEB' }],
        // warnings and isPending are omitted, which proto3 uses for zero/false.
        errors: '2',
        lastDownloaded: '2026-09-20T10:30:00Z',
        lastSubmitted: '2026-09-19T08:00:00.250Z',
        path: 'https://example.com/sitemap.xml',
        type: 'SITEMAP',
      },
    ],
  }));
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-sitemap-'));
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [
      new Copy(source.sitemaps, destination.table('sitemaps')),
      new Copy(source.sitemapContents, destination.table('contents')),
    ],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    {
      ...database
        .prepare(
          'SELECT path, errors, warnings, isPending, isSitemapsIndex, lastDownloaded, lastSubmitted FROM sitemaps',
        )
        .get(),
    },
    {
      errors: 2,
      isPending: 0,
      isSitemapsIndex: 0,
      lastDownloaded: '2026-09-20T10:30:00.000Z',
      lastSubmitted: '2026-09-19T08:00:00.250Z',
      path: 'https://example.com/sitemap.xml',
      warnings: 0,
    },
  );
  assert.deepEqual(
    {
      ...database
        .prepare('SELECT sitemapPath, type, submitted, indexed FROM contents')
        .get(),
    },
    {
      indexed: null,
      sitemapPath: 'https://example.com/sitemap.xml',
      submitted: 512,
      type: 'WEB',
    },
  );
});

test('the three urlInspection streams share one inspection batch', async () => {
  const { requester, calls } = recorder((call) => {
    if (call.url.includes('searchAnalytics/query'))
      // Only the first page carries rows; a later startRow exhausts the range,
      // which is what ends the connector's paging loop.
      return {
        rows:
          Number(call.data?.['startRow'] ?? 0) > 0
            ? []
            : [
                {
                  clicks: 5,
                  ctr: 0.1,
                  impressions: 90,
                  keys: ['https://example.com/b'],
                  position: 3,
                },
                {
                  clicks: 9,
                  ctr: 0.2,
                  impressions: 400,
                  keys: ['https://example.com/a'],
                  position: 1,
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
        mobileUsabilityResult: { verdict: 'PASS' },
      },
    };
  });
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-inspect-'));
  const source = new SearchConsoleSource({
    inspectionLimit: 2,
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [
      new Copy(source.urlInspection, destination.table('inspection')),
      new Copy(
        source.urlInspectionSitemaps,
        destination.table('inspection_sitemaps'),
      ),
      new Copy(
        source.urlInspectionReferrers,
        destination.table('inspection_referrers'),
      ),
    ],
  }).run();

  // Two URLs, inspected once each, although three streams consumed them.
  assert.equal(
    calls.filter((call) => call.url.endsWith('index:inspect')).length,
    2,
  );
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare(
        'SELECT inspectionUrl, verdict, lastCrawlTime FROM inspection ORDER BY inspectionUrl',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        inspectionUrl: 'https://example.com/a',
        lastCrawlTime: '2026-09-18T04:05:06.000Z',
        verdict: 'PASS',
      },
      {
        inspectionUrl: 'https://example.com/b',
        lastCrawlTime: '2026-09-18T04:05:06.000Z',
        verdict: 'PASS',
      },
    ],
  );
  assert.deepEqual(
    {
      ...database
        .prepare('SELECT count(*) AS count FROM inspection_sitemaps')
        .get(),
    },
    { count: 2 },
  );
  assert.deepEqual(
    {
      ...database
        .prepare('SELECT count(*) AS count FROM inspection_referrers')
        .get(),
    },
    { count: 2 },
  );
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-watch-'));
  const source = new SearchConsoleSource({
    searchTypes: ['WEB'],
    now: NOW,
    pollIntervalMs: 1,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
    using database = new DatabaseSync(destination.path, { readOnly: true });
    assert.equal(database.prepare('SELECT clicks FROM rows').get()?.clicks, 19);
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-feed-'));
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    searchTypes: ['WEB', 'DISCOVER', 'GOOGLE_NEWS'],
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [new Copy(source.searchAnalyticsDaily, destination.table('daily'))],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare(
        'SELECT searchType, clicks, position FROM daily ORDER BY searchType',
      )
      .all()
      .map((row) => ({ ...row })),
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-clamp-'));
  // Sixteen months before 31 March is 30 November, which has no 31st. An
  // unclamped subtraction rolls into December and drops a month of history.
  const source = new SearchConsoleSource({
    now: () => new Date('2026-03-31T00:00:00.000Z'),
    requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-country-'));
  const source = new SearchConsoleSource({
    breakdownMonths: 3,
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
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
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT siteUrl, country, device, clicks FROM countries')
      .all()
      .map((row) => ({ ...row })),
    [{ clicks: 4, country: 'usa', device: 'DESKTOP', siteUrl: SITE }],
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

test('two properties load into the same tables without deleting each other', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const sitemaps: Record<string, unknown[]> = {
    [A]: [{ path: 'https://a.example/sitemap.xml' }],
    [B]: [{ path: 'https://b.example/sitemap.xml' }],
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-share-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const pipeline = (siteUrl: string) => {
    const source = new SearchConsoleSource({
      now: NOW,
      requester,
      searchTypes: ['WEB'],
      siteUrls: [siteUrl],
    });
    const listing = (stream: typeof source.sitemaps, table: string) =>
      new Copy(stream, destination.table(table), {
        id: `${stream.name}:${siteUrl}`,
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
          id: `searchAnalyticsDaily:${siteUrl}`,
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

  await pipeline(A).run();
  await pipeline(B).run();
  sitemaps[A] = [];
  const counts = (await pipeline(A).run()).map(({ copy, count, deleted }) => [
    copy.from.name,
    count,
    deleted,
  ]);

  assert.deepEqual(counts, [
    ['sitemaps', 0, 1],
    ['searchAnalyticsDaily', 1, 0],
    ['searchAnalyticsCountries', 0, 0],
  ]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const sites = (table: string) =>
    database
      .prepare(`SELECT siteUrl FROM ${table} ORDER BY siteUrl`)
      .all()
      .map((row) => row['siteUrl']);
  assert.deepEqual(sites('sitemaps'), [B]);
  assert.deepEqual(sites('daily'), [A, B]);
  assert.deepEqual(sites('countries'), [A, B]);
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-sites-'));
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [new Copy(source.sites, destination.table('sites'))],
  }).run();

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT siteUrl, permissionLevel FROM sites ORDER BY siteUrl')
      .all()
      .map((row) => ({ ...row })),
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
  let served = 0;
  const limited = Promise.withResolvers<void>();
  const requester = {
    async request() {
      served += 1;
      // The first probe and the first load succeed; the next probe is told to
      // come back in 45 seconds.
      if (served <= 2)
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-abort-'));
  const source = new SearchConsoleSource({
    now: NOW,
    pollIntervalMs: 1,
    requester,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 60_000 },
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const copy = new Copy(source.searchAnalyticsDaily, destination.table('rows'));
  const controller = new AbortController();
  const watching = new Pipeline({ source, destination, steps: [copy] }).watch({
    signal: controller.signal,
  });

  assert.deepEqual((await watching.next()).value, [
    { copy, count: 1, deleted: 0 },
  ]);
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-snap-'));
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    siteUrls: [SITE],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: [copy],
  });

  assert.deepEqual(await pipeline.run(), [{ copy, count: 2, deleted: 0 }]);
  assert.deepEqual(await pipeline.run(), [{ copy, count: 0, deleted: 0 }]);
  siteEntry = [
    { permissionLevel: 'siteFullUser', siteUrl: 'sc-domain:a.example' },
  ];
  assert.deepEqual(await pipeline.run(), [{ copy, count: 1, deleted: 1 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT siteUrl, permissionLevel FROM sites')
      .all()
      .map((row) => ({ ...row })),
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
                  keys: [`https://${site}/`],
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-many-'));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const run = (siteUrls: string[]) => {
    const source = new SearchConsoleSource({
      inspectionLimit: 1,
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
        new Copy(source.urlInspection, destination.table('inspection')),
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
  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT siteUrl, clicks FROM daily ORDER BY siteUrl')
      .all()
      .map((row) => [row.siteUrl, row.clicks]),
    [
      [A, 3],
      [B, 7],
    ],
  );
  assert.deepEqual(
    database
      .prepare(
        'SELECT siteUrl, inspectionUrl, verdict FROM inspection ORDER BY siteUrl',
      )
      .all()
      .map((row) => [row.siteUrl, row.inspectionUrl, row.verdict]),
    [
      [A, `https://${A}/`, A],
      [B, `https://${B}/`, B],
    ],
  );
});

test('a property that keeps failing commits nothing for any property', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const { requester } = recorder((call) => {
    if (siteOf(call) === B) throw googleError(500);
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-fail-'));
  const source = new SearchConsoleSource({
    now: NOW,
    requester,
    retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    searchTypes: ['WEB'],
    siteUrls: [A, B],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
  });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });

  await assert.rejects(
    new Pipeline({
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
    }).run(),
    /status code 500/,
  );

  using database = new DatabaseSync(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'daily'")
      .all(),
    [],
  );
  using state = new DatabaseSync(checkpoints.path, { readOnly: true });
  assert.deepEqual(state.prepare('SELECT id FROM checkpoints').all(), []);
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
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-watch-'));
  const source = new SearchConsoleSource({
    now: NOW,
    pollIntervalMs: 1,
    requester,
    searchTypes: ['WEB'],
    siteUrls: [A, B],
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'sc.sqlite'),
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
    using database = new DatabaseSync(destination.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT siteUrl, clicks FROM rows ORDER BY siteUrl')
        .all()
        .map((row) => [row.siteUrl, row.clicks]),
      [
        [A, 3],
        [B, 9],
      ],
    );
  } finally {
    controller.abort();
  }
});
