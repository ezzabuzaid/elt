import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { Postgres } from '@zukhruf/testing/postgres';
import { type PathParams, http } from 'msw';
import { setupServer } from 'msw/node';
import postgres from 'postgres';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import { GoogleGrant, GoogleOAuthApp } from '@workspace/google-auth';

import { SearchConsoleSource } from './search-console-source.ts';

const databases = new Postgres({
  environment: process.env,
});

const SITE = 'sc-domain:example.com';
const RAW = 'google_search_console';

type Warehouse = {
  sql: postgres.Sql;
  history: PostgresSyncHistory;
  destination: PostgresDestination;
  checkpoints: PostgresCheckpointStore;
};

// A real OAuth client over a stored grant: its first call mints an access
// token at the token endpoint the test's server answers.
function signedIn() {
  return new GoogleOAuthApp({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }).client(
    new GoogleGrant({
      kind: 'GOOGLE_BIGQUERY_OAUTH',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    }),
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
}

// A call Search Console received: its path, the property it names in the
// path or the body, and its JSON body.
type Call = {
  readonly path: string;
  readonly site: unknown;
  readonly body: Readonly<Record<string, unknown>>;
};

/**
 * Google's side of the wire for one test, stubbed below fetch with msw. Each
 * Search Console call is answered with what `reply` returns for it, a JSON
 * body or a whole Response, and each URL in `files` with its content, or
 * with the status a number names. Any other request fails the test.
 */
function google({
  reply,
  files = {},
}: {
  reply: (call: Call) => unknown;
  files?: Readonly<Record<string, string | Uint8Array<ArrayBuffer> | number>>;
}) {
  const calls: Call[] = [];
  const fetched: string[] = [];
  const waiting = new Set<{
    done: (calls: readonly Call[]) => boolean;
    resolve: () => void;
  }>();
  const server = setupServer(
    http.post('https://oauth2.googleapis.com/token', () =>
      Response.json({ access_token: 'access-token', expires_in: 3600 }),
    ),
    http.all<PathParams, Record<string, unknown>>(
      'https://searchconsole.googleapis.com/*',
      async ({ request }) => {
        const path = new URL(request.url).pathname;
        const body = request.method === 'POST' ? await request.json() : {};
        // /webmasters/v3/sites/<property>/... names it in the path.
        const [, , , , property] = path.split('/');
        const call = {
          path,
          site:
            property === undefined
              ? body.siteUrl
              : decodeURIComponent(property),
          body,
        };
        calls.push(call);
        for (const waiter of waiting)
          if (waiter.done(calls)) {
            waiting.delete(waiter);
            waiter.resolve();
          }
        const answer = await reply(call);
        return answer instanceof Response ? answer : Response.json(answer);
      },
    ),
    ...Object.entries(files).map(([url, content]) =>
      http.get(url, () => {
        fetched.push(url);
        return typeof content === 'number'
          ? new Response(null, { status: content })
          : new Response(content);
      }),
    ),
  );
  server.listen({ onUnhandledFrame: 'error' });
  return {
    calls,
    fetched,
    requester: signedIn(),
    // Resolves once the calls received so far satisfy done.
    until(done: (calls: readonly Call[]) => boolean): Promise<void> {
      if (done(calls)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.add({ done, resolve });
      return promise;
    },
    [Symbol.dispose]: () => server.close(),
  };
}

type Google = ReturnType<typeof google>;

// An error as Google's APIs answer one.
function refusal(
  status: number,
  reason: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: 'global', reason }],
      },
    },
    { status, headers },
  );
}

// Sent with every refusal the policy retries, so the real default policy
// retries at once instead of backing off for seconds. Live, the daily quota's
// 429 carries no Retry-After.
const RETRY_NOW = { 'retry-after': '0' };

const forbidden = (site: string) =>
  refusal(
    403,
    'forbidden',
    `User does not have sufficient permission for site '${site}'. See also: https://support.google.com/webmasters/answer/2451999.`,
  );
// Live, an exhausted daily quota answers 429 rateLimitExceeded with this
// message.
const quotaExceeded = () =>
  refusal(429, 'rateLimitExceeded', `Quota exceeded for ${SITE}.`, RETRY_NOW);
const serverError = () =>
  refusal(500, 'backendError', 'Internal error encountered.', RETRY_NOW);

// The Pacific day `offset` days from today, as Search Console dates its data.
const day = (offset: number) =>
  Temporal.Now.plainDateISO('America/Los_Angeles')
    .add({ days: offset })
    .toString();
const monthsBack = (months: number) =>
  Temporal.Now.plainDateISO('America/Los_Angeles')
    .subtract({ months })
    .toString();

// The watch's change probe: the last 28 days of daily web totals.
const isProbe = (call: Call) => call.body.startDate === day(-28);

// A read as the tests name it: what it lists, inspects or queries, and for a
// query, its dimensions and first day.
const query = (site: string, dimensions: string, from: string) =>
  `${site} ${dimensions} from ${from}`;
function label({ path, site, body }: Call): string {
  if (path.endsWith('/sitemaps')) return `sitemaps of ${String(site)}`;
  if (path.endsWith('index:inspect'))
    return `inspect ${String(body.inspectionUrl)}`;
  return query(String(site), String(body.dimensions), String(body.startDate));
}
const reads = ({ calls }: Google) =>
  calls.filter((call) => !isProbe(call)).map(label);

/**
 * Half a second of a watch whose next pass was asked for, cut short by the
 * first read: what it probed and what it read meanwhile. A watch that reloads
 * an unchanged property reads within it.
 */
async function quietly(searchConsole: Google) {
  const { calls, until } = searchConsole;
  const probed = calls.filter(isProbe);
  const read = reads(searchConsole).length;
  await Promise.race([
    sleep(500),
    until(
      (received) => received.filter((call) => !isProbe(call)).length > read,
    ),
  ]);
  return {
    probed: calls.filter(isProbe).slice(probed.length),
    read: reads(searchConsole).slice(read),
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

const ALL_INSPECTIONS = [
  'urlInspection',
  'urlInspectionSitemaps',
  'urlInspectionReferrers',
] as const;

/**
 * Search Console's answers for one property: the sitemaps its API lists, the
 * pages its search analytics show, and each URL's inspection, an index status
 * or a whole Response such as a refusal.
 */
function property({
  sitemaps = [],
  pages = [],
  inspect = (url) => ({ verdict: 'PASS', referringUrls: [url] }),
}: {
  sitemaps?: readonly string[];
  pages?: readonly string[];
  inspect?: (url: string) => Record<string, unknown> | Response;
}) {
  return ({ path, body }: Call): unknown => {
    if (path.endsWith('/sitemaps'))
      return { sitemap: sitemaps.map(sitemapEntry) };
    if (path.endsWith('index:inspect')) {
      const reply = inspect(String(body.inspectionUrl));
      return reply instanceof Response
        ? reply
        : { inspectionResult: { indexStatusResult: reply } };
    }
    return {
      rows: pages.map((page) => ({
        clicks: 0,
        ctr: 0,
        impressions: 1,
        keys: [page],
        position: 1,
      })),
    };
  };
}

// The URLs Google was asked to inspect, in the order the calls arrived.
const inspected = ({ calls }: Google) =>
  calls
    .filter(({ path }) => path.endsWith('index:inspect'))
    .map(({ body }) => body.inspectionUrl);

async function inspectionRun(
  source: SearchConsoleSource,
  {
    history,
    destination,
    checkpoints,
  }: Pick<Warehouse, 'history' | 'destination' | 'checkpoints'>,
  streams: readonly (typeof ALL_INSPECTIONS)[number][] = ['urlInspection'],
) {
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: streams.map(
          (name) =>
            new Copy(source[name], destination.table(name), {
              id: name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  }).run();
}

async function inspectionRows({ sql }: Warehouse, table = 'urlInspection') {
  return (await sql`SELECT * FROM ${sql(table)} ORDER BY "inspectionUrl"`).map(
    (row) => ({ ...row }),
  );
}

test('Search Console maps positional analytics keys onto its dimensions', async () => {
  using searchConsole = google({
    reply: () => ({
      metadata: { firstIncompleteDate: day(0) },
      rows: [
        {
          clicks: 0,
          impressions: 340,
          keys: [day(-1), 'context compiler'],
          ctr: 0,
          position: 8.1,
        },
      ],
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('search_analytics'),
  );

  assert.deepEqual(
    await new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({ name: 'test', source, destination, steps: [copy] }),
      ],
    }).run(),
    [{ copy, count: 1, deleted: 0 }],
  );
  const [loaded] =
    await sql`SELECT date::text, query, clicks::int, impressions::int, position FROM search_analytics`;
  assert.deepEqual(
    { ...loaded },
    {
      clicks: 0,
      date: day(-1),
      impressions: 340,
      position: 8.1,
      query: 'context compiler',
    },
  );
  assert.deepEqual(
    searchConsole.calls.map(({ body }) => body),
    [
      {
        dataState: 'ALL',
        dimensions: ['date', 'query'],
        // Today in Pacific Time, and sixteen calendar months before it.
        endDate: day(0),
        rowLimit: 25_000,
        startDate: monthsBack(16),
        startRow: 0,
        type: 'WEB',
      },
    ],
  );
});

test('a restated day replaces the loaded row, and the next read starts at the last settled day', async () => {
  let clicks = 12;
  let firstIncompleteDate = day(0);
  using searchConsole = google({
    reply: () => ({
      metadata: { firstIncompleteDate },
      rows: [
        {
          clicks,
          ctr: 0.035,
          impressions: 340,
          keys: [day(-1), 'context compiler'],
          position: 8.1,
        },
        {
          clicks: 5,
          ctr: 0.05,
          impressions: 100,
          keys: [day(0), 'context compiler'],
          position: 7,
        },
      ],
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('search_analytics'),
    {
      destinationSyncMode: 'append_dedup',
      id: 'search-analytics',
      syncMode: 'incremental',
    },
  );
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy],
      }),
    ],
  });
  const loaded = async () =>
    (
      await sql`SELECT date::text, clicks::int, settled FROM search_analytics ORDER BY date`
    ).map((row) => ({ ...row }));

  await pipeline.run();
  // Today is still being collected, and its row says so.
  assert.deepEqual(await loaded(), [
    { clicks: 12, date: day(-1), settled: true },
    { clicks: 5, date: day(0), settled: false },
  ]);

  clicks = 19;
  firstIncompleteDate = day(1);
  await pipeline.run();
  // One row per day still, carrying the restated metric, and today has
  // settled since.
  assert.deepEqual(await loaded(), [
    { clicks: 19, date: day(-1), settled: true },
    { clicks: 5, date: day(0), settled: true },
  ]);

  await pipeline.run();
  // The first read covers the whole history; each later one starts at the
  // last day the read before it saw settled, read again rather than after it.
  assert.deepEqual(
    searchConsole.calls.map(({ body }) => body.startDate),
    [monthsBack(16), day(-1), day(0)],
  );
});

test('a re-read deletes the query rows and days Google stopped reporting, and keeps the days before it', async () => {
  let firstIncompleteDate = day(-1);
  let queries: [date: string, query: string][] = [
    [day(-4), 'older'],
    [day(-3), 'older'],
    [day(-2), 'kept'],
    [day(-2), 'dropped'],
    [day(-1), 'emptied'],
  ];
  using searchConsole = google({
    // Like Google, it answers only the days the request asks for.
    reply: ({ body }) => ({
      metadata: { firstIncompleteDate },
      rows: queries
        .filter(
          ([date]) =>
            date >= String(body.startDate) && date <= String(body.endDate),
        )
        .map((keys) => ({
          clicks: 1,
          ctr: 0.1,
          impressions: 10,
          keys,
          position: 3,
        })),
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(
            source.searchAnalyticsQueries,
            destination.table('queries'),
            {
              id: 'queries',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
        ],
      }),
    ],
  });
  await pipeline.run();

  // The next read starts at the last settled day, so it asks for neither
  // older day. Of the two days it reads, Google drops one query from the
  // first and every query from the second, as it does when a day's few
  // searches were all rare.
  firstIncompleteDate = day(0);
  queries = [
    [day(-4), 'older'],
    [day(-3), 'older'],
    [day(-2), 'kept'],
  ];
  await pipeline.run();

  assert.deepEqual(
    (await sql`SELECT date::text, query FROM queries ORDER BY date, query`).map(
      (row) => ({ ...row }),
    ),
    [
      { date: day(-4), query: 'older' },
      { date: day(-3), query: 'older' },
      { date: day(-2), query: 'kept' },
    ],
  );
});

test('a re-read day keeps its unchanged query and page rows beside the ones that changed', async () => {
  let restated = 1;
  using searchConsole = google({
    reply: () => ({
      metadata: { firstIncompleteDate: day(-1) },
      rows: [
        {
          clicks: 1,
          ctr: 0.1,
          impressions: 10,
          keys: [day(-2), 'same'],
          position: 3,
        },
        {
          clicks: restated,
          ctr: 0.1,
          impressions: 40,
          keys: [day(-2), 'restated'],
          position: 3,
        },
      ],
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const incremental = (stream: typeof source.sitemaps, table: string) =>
    new Copy(stream, destination.table(table), {
      id: table,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          incremental(source.searchAnalyticsQueries, 'queries'),
          incremental(source.searchAnalyticsPages, 'pages'),
        ],
      }),
    ],
  });
  await pipeline.run();

  restated = 4;
  await pipeline.run();

  for (const [table, column] of [
    ['queries', 'query'],
    ['pages', 'page'],
  ] as const)
    assert.deepEqual(
      (
        await sql`SELECT ${sql(column)} AS key, clicks::int FROM ${sql(table)} ORDER BY key`
      ).map((row) => ({ ...row })),
      [
        { key: 'restated', clicks: 4 },
        { key: 'same', clicks: 1 },
      ],
      table,
    );
});

test('a search type whose re-read day reports nothing loses that day’s total, while the other types keep theirs', async () => {
  let discover = [day(-2), day(-1)];
  using searchConsole = google({
    reply: ({ body }) => ({
      metadata: { firstIncompleteDate: day(-1) },
      rows:
        body.type === 'DISCOVER'
          ? discover.map((date) => ({
              clicks: 1,
              ctr: 0.1,
              impressions: 10,
              keys: [date],
            }))
          : [
              {
                clicks: 5,
                ctr: 0.1,
                impressions: 50,
                keys: [day(-1)],
                position: 3,
              },
            ],
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB', 'DISCOVER'],
    siteUrls: [SITE],
  });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
            id: 'daily',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  await pipeline.run();

  discover = [day(-2)];
  await pipeline.run();

  assert.deepEqual(
    (
      await sql`SELECT date::text, "searchType" FROM daily ORDER BY date, "searchType"`
    ).map((row) => ({ ...row })),
    [
      { date: day(-2), searchType: 'DISCOVER' },
      { date: day(-1), searchType: 'WEB' },
    ],
  );
});

test('a fractional click count is refused rather than stored', async () => {
  using searchConsole = google({
    reply: () => ({
      rows: [
        { clicks: 1.5, ctr: 0.5, impressions: 3, keys: [day(-1)], position: 2 },
      ],
    }),
  });
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });

  await assert.rejects(
    new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [
            new Copy(source.searchAnalyticsDaily, destination.table('daily')),
          ],
        }),
      ],
    }).run(),
    /clicks/,
  );
});

test('analytics pagination follows startRow until a short page', async () => {
  const days = Array.from({ length: 9 }, (_, offset) => day(-1 - offset));
  const page = (start: number, size: number) =>
    Array.from({ length: size }, (_, index) => ({
      clicks: 1,
      ctr: 0.1,
      impressions: 2,
      keys: [days[(start + index) % days.length], `q-${start + index}`],
      position: 1,
    }));
  using searchConsole = google({
    reply: ({ body }) => {
      const rowLimit = Number(body.rowLimit);
      return {
        rows: body.startRow === 0 ? page(0, rowLimit) : page(rowLimit, 3),
      };
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsQueries,
    destination.table('rows'),
  );
  // Extraction is lazy: nothing is requested until the destination pulls.
  assert.equal(searchConsole.calls.length, 0);

  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({ name: 'test', source, destination, steps: [copy] }),
    ],
  }).run();

  assert.deepEqual(
    searchConsole.calls.map(({ body }) => body.startRow),
    [0, 25_000],
    'a full page is followed by one more',
  );
  const [total] = await sql`SELECT count(*)::int AS count FROM rows`;
  assert.deepEqual({ ...total }, { count: 25_003 });
});

test('sitemaps convert int64 text and second-precision times', async () => {
  using searchConsole = google({
    reply: () => ({
      sitemap: [
        {
          ...sitemapEntry('https://example.com/sitemap.xml'),
          contents: [{ submitted: '512', type: 'web' }],
          errors: '2',
          lastDownloaded: '2026-09-20T10:30:00Z',
          lastSubmitted: '2026-09-19T08:00:00.250Z',
        },
      ],
    }),
    files: {
      'https://example.com/sitemap.xml':
        'https://example.com/a\nhttps://example.com/b\n',
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    siteUrls: [SITE],
  });

  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.sitemaps, destination.table('sitemaps')),
          new Copy(source.sitemapContents, destination.table('contents')),
        ],
      }),
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
  using searchConsole = google({
    reply: ({ path }) => {
      if (path.endsWith('/sitemaps'))
        return { sitemap: [sitemapEntry('https://example.com/sitemap.xml')] };
      if (path.endsWith('/searchAnalytics/query'))
        return {
          rows: [
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
    },
    files: {
      'https://example.com/sitemap.xml':
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/c?x=1&amp;y=2</loc></url></urlset>',
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });
  const started = new Date();

  await inspectionRun(source, warehouse, ALL_INSPECTIONS);
  const finished = new Date();
  // Three distinct pages, each inspected once although three streams load it.
  assert.deepEqual(inspected(searchConsole).toSorted(), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c?x=1&y=2',
  ]);
  assert.deepEqual(searchConsole.fetched, ['https://example.com/sitemap.xml']);
  // The same day, every URL is fresh: no inspection call at all.
  await inspectionRun(source, warehouse, ALL_INSPECTIONS);
  assert.equal(inspected(searchConsole).length, 3);

  const rows =
    await sql`SELECT "inspectionUrl", "inSitemap", "inSearchAnalytics", verdict, "inspectedAt" FROM "urlInspection" ORDER BY "inspectionUrl"`;
  assert.deepEqual(
    rows.map(({ inspectedAt: _, ...row }) => row),
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
    })),
  );
  for (const { inspectedAt } of rows)
    assert.ok(
      inspectedAt >= started && inspectedAt <= finished,
      `inspected during the first run, at ${inspectedAt}`,
    );
  for (const table of ['urlInspectionSitemaps', 'urlInspectionReferrers']) {
    const [total] = await sql`SELECT count(*)::int AS count FROM ${sql(table)}`;
    assert.equal(total?.count, 3);
  }
});

test(
  'watching reloads the property only when it changed',
  { timeout: 10_000 },
  async () => {
    let clicks = 12;
    using searchConsole = google({
      reply: () => ({
        metadata: { firstIncompleteDate: day(0) },
        rows: [
          { clicks, ctr: 0.03, impressions: 340, keys: [day(-1)], position: 8 },
        ],
      }),
    });
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const warehouse = {
      sql: clients.adopt(
        postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: RAW },
        }),
        (sql) => sql.end(),
      ),
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, sql } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 1,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const copy = new Copy(
      source.searchAnalyticsDaily,
      destination.table('rows'),
    );
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({ name: 'test', source, destination, steps: [copy] }),
      ],
    }).watch({ signal: controller.signal });
    const history = query(SITE, 'date', monthsBack(16));

    try {
      assert.deepEqual((await watching.next()).value?.outcomes, [
        { copy, count: 1, deleted: 0, failures: [], cancelled: false },
      ]);
      assert.deepEqual(reads(searchConsole), [history]);
      // Asked for its next pass, the watch probes the unchanged property and
      // reads nothing.
      const next = watching.next();
      const { probed, read } = await quietly(searchConsole);
      assert.ok(probed.length >= 3, `probed ${probed.length} times`);
      assert.deepEqual(read, []);
      clicks = 19;
      assert.deepEqual((await next).value?.outcomes, [
        { copy, count: 1, deleted: 0, failures: [], cancelled: false },
      ]);
      assert.deepEqual(reads(searchConsole), [history, history]);
      const [row] = await sql`SELECT clicks::int FROM rows`;
      assert.equal(row?.clicks, 19);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test('a feed report keeps an absent position as unknown, not as rank one', async () => {
  using searchConsole = google({
    reply: ({ body }) =>
      // Google's Discover and Google News responses omit position on every
      // row, including zero-traffic rows.
      body.type === 'DISCOVER' || body.type === 'GOOGLE_NEWS'
        ? { rows: [{ clicks: 0, ctr: 0, impressions: 0, keys: [day(-1)] }] }
        : {
            rows: [
              {
                clicks: 4,
                ctr: 0.02,
                impressions: 200,
                keys: [day(-1)],
                position: 1.5,
              },
            ],
          },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB', 'DISCOVER', 'GOOGLE_NEWS'],
    siteUrls: [SITE],
  });

  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.searchAnalyticsDaily, destination.table('daily')),
        ],
      }),
    ],
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

test('the country breakdown is a trailing snapshot, diffed rather than resumed by date', async () => {
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
  using searchConsole = google({ reply: () => ({ rows }) });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    breakdownMonths: 3,
    requester: searchConsole.requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(
    source.searchAnalyticsCountries,
    destination.table('countries'),
    {
      id: 'countries',
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    },
  );
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy],
      }),
    ],
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
  assert.deepEqual(
    searchConsole.calls.map(({ body }) => body.startDate),
    [monthsBack(3), monthsBack(3)],
  );
  assert.deepEqual(
    (
      await sql`SELECT "siteUrl", country, device, clicks::int, "startDate"::text, "endDate"::text FROM countries`
    ).map((row) => ({ ...row })),
    [
      {
        clicks: 4,
        country: 'usa',
        device: 'DESKTOP',
        endDate: day(0),
        siteUrl: SITE,
        startDate: monthsBack(3),
      },
    ],
  );
});

test('every stream but sites carries its property and keys by it first', async () => {
  const source = new SearchConsoleSource({
    requester: signedIn(),
    siteUrls: [SITE],
  });

  const unkeyed = (await source.discover()).streams.filter(
    (stream) =>
      stream.name !== 'sites' &&
      (stream.primaryKey[0] !== 'siteUrl' ||
        stream.jsonSchema.properties?.siteUrl === undefined),
  );

  assert.deepEqual(
    unkeyed.map((stream) => stream.name),
    [],
  );
});

test('the country breakdown declares web search over its trailing window as its coverage, whatever report types the source reads', () => {
  const source = new SearchConsoleSource({
    requester: signedIn(),
    searchTypes: ['WEB', 'DISCOVER'],
    siteUrls: [SITE],
  });

  assert.deepEqual(source.coverage(source.searchAnalyticsCountries).selection, {
    siteUrls: [SITE],
    searchTypes: ['WEB'],
    breakdownMonths: 3,
    timeZone: 'America/Los_Angeles',
  });
});

test('two properties share tables through one source without deleting each other', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  const sitemaps: Record<string, string[]> = {
    [A]: ['https://a.example/sitemap.xml'],
    [B]: ['https://b.example/sitemap.xml'],
  };
  using searchConsole = google({
    reply: ({ path, site, body }) => {
      if (path.endsWith('/sitemaps'))
        return { sitemap: sitemaps[String(site)]?.map(sitemapEntry) };
      const keys = String(body.dimensions).includes('date')
        ? [day(-1)]
        : ['usa', 'DESKTOP'];
      return {
        rows: [{ clicks: 1, ctr: 0.1, impressions: 10, keys, position: 3 }],
      };
    },
    files: {
      'https://a.example/sitemap.xml': '',
      'https://b.example/sitemap.xml': '',
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const pipeline = (siteUrls: string[], name: string) => {
    const source = new SearchConsoleSource({
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls,
    });
    const incremental = (stream: typeof source.sitemaps, table: string) =>
      new Copy(stream, destination.table(table), {
        id: `${name}:${stream.name}`,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      });
    return new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            incremental(source.sitemaps, 'sitemaps'),
            incremental(source.searchAnalyticsDaily, 'daily'),
            incremental(source.searchAnalyticsCountries, 'countries'),
          ],
        }),
      ],
    });
  };

  await pipeline([A, B], 'search-console').run();
  sitemaps[A] = [];
  const counts = (await pipeline([A, B], 'search-console').run()).map(
    ({ copy, count, deleted }) => [copy.from.name, count, deleted],
  );

  assert.deepEqual(counts, [
    ['sitemaps', 0, 1],
    ['searchAnalyticsDaily', 2, 0],
    ['searchAnalyticsCountries', 0, 0],
  ]);
  // A second pipeline is a second writer, even for a property the first does
  // not list: it is refused before it asks Google anything, and writes
  // nothing.
  const asked = searchConsole.calls.length;
  await assert.rejects(pipeline(['sc-domain:c.example'], 'other').run());
  assert.equal(searchConsole.calls.length, asked);
  const sites = async (table: string) =>
    (await sql`SELECT "siteUrl" FROM ${sql(table)} ORDER BY "siteUrl"`).map(
      (row) => row.siteUrl,
    );
  assert.deepEqual(await sites('sitemaps'), [B]);
  assert.deepEqual(await sites('daily'), [A, B]);
  assert.deepEqual(await sites('countries'), [A, B]);
});

test('an unverified property is not offered as a readable site', async () => {
  using searchConsole = google({
    reply: () => ({
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
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    siteUrls: [SITE],
  });

  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(source.sites, destination.table('sites'))],
      }),
    ],
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

test(
  'aborting a watcher stops a rate-limit wait instead of sitting it out',
  { timeout: 5000 },
  async () => {
    let loaded = false;
    using searchConsole = google({
      // Every probe and the read of the first pass succeed; from then on
      // Google asks the watcher to come back in 45 seconds.
      reply: () =>
        loaded
          ? refusal(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
              'retry-after': '45',
            })
          : {
              rows: [
                {
                  clicks: 1,
                  ctr: 0.1,
                  impressions: 9,
                  keys: [day(-1)],
                  position: 2,
                },
              ],
            },
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 1,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const copy = new Copy(
      source.searchAnalyticsDaily,
      destination.table('rows'),
    );
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({ name: 'test', source, destination, steps: [copy] }),
      ],
    }).watch({ signal: controller.signal });

    try {
      assert.deepEqual((await watching.next()).value?.outcomes, [
        { copy, count: 1, deleted: 0, failures: [], cancelled: false },
      ]);
      assert.deepEqual(reads(searchConsole), [
        query(SITE, 'date', monthsBack(16)),
      ]);
      loaded = true;
      const answered = searchConsole.calls.length;
      await searchConsole.until((calls) => calls.length > answered);
      // Long enough for the refusal to reach the watcher, which then waits.
      await sleep(100);
      const started = performance.now();
      controller.abort();

      assert.deepEqual(await watching.next(), {
        done: true,
        value: undefined,
      });
      assert.ok(
        performance.now() - started < 1000,
        'closed without the 45 s wait',
      );
      assert.equal(searchConsole.calls.length, answered + 1);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test(
  'aborting a watcher cancels its in-flight probe as an AbortError',
  { timeout: 5000 },
  async () => {
    let served = 0;
    using searchConsole = google({
      // The first probe is answered; the next one never is.
      reply: () =>
        served++ === 0
          ? {
              rows: [
                {
                  clicks: 1,
                  ctr: 0.1,
                  impressions: 9,
                  keys: [day(-1)],
                  position: 2,
                },
              ],
            }
          : new Promise(() => {}),
    });
    const source = new SearchConsoleSource({
      pollIntervalMs: 1,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const controller = new AbortController();
    const watching = source.watch({
      signal: controller.signal,
      streams: [source.searchAnalyticsDaily],
    });

    try {
      assert.deepEqual((await watching.next()).value, [
        source.searchAnalyticsDaily,
      ]);
      const polling = watching.next();
      await searchConsole.until((calls) => calls.length === 2);
      controller.abort();

      await assert.rejects(polling, { name: 'AbortError' });
      assert.deepEqual(searchConsole.calls.map(isProbe), [true, true]);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test(
  'aborting a watch while it waits for its next poll ends it at once',
  { timeout: 5000 },
  async () => {
    using searchConsole = google({ reply: () => ({ rows: [] }) });
    const source = new SearchConsoleSource({
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const controller = new AbortController();
    const watching = source.watch({
      signal: controller.signal,
      streams: [source.searchAnalyticsDaily],
    });

    try {
      await watching.next();
      // The next poll is six hours away.
      const waiting = watching.next();
      controller.abort();

      await assert.rejects(
        Promise.race([
          waiting,
          sleep(1_000).then(() => assert.fail('still waiting a second later')),
        ]),
        { name: 'AbortError' },
      );
      assert.equal(searchConsole.calls.length, 1);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test('an incremental sites copy deletes a property that is no longer listed', async () => {
  let siteEntry = [
    { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:a.example' },
    { permissionLevel: 'siteOwner', siteUrl: 'sc-domain:b.example' },
  ];
  using searchConsole = google({ reply: () => ({ siteEntry }) });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    siteUrls: [SITE],
  });
  const copy = new Copy(source.sites, destination.table('sites'), {
    id: 'sites',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [copy],
      }),
    ],
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

test('one source loads every property; a newly listed one backfills while the others resume', async () => {
  const A = 'sc-domain:a.example';
  const B = 'sc-domain:b.example';
  using searchConsole = google({
    reply: ({ path, site, body }) => {
      if (path.endsWith('/sitemaps')) return {};
      if (path.endsWith('index:inspect'))
        return { inspectionResult: { indexStatusResult: { verdict: site } } };
      if (String(body.dimensions) === 'page')
        return {
          rows: [
            {
              clicks: 1,
              ctr: 1,
              impressions: 1,
              keys: [`https://${String(site).replace('sc-domain:', '')}/`],
              position: 1,
            },
          ],
        };
      return {
        metadata: { firstIncompleteDate: day(0) },
        rows: [
          {
            clicks: site === A ? 3 : 7,
            ctr: 0.1,
            impressions: 30,
            keys: [day(-1)],
            position: 2,
          },
        ],
      };
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const run = (siteUrls: string[]) => {
    const source = new SearchConsoleSource({
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls,
    });
    return new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
              id: 'daily',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
            new Copy(source.urlInspection, destination.table('inspection'), {
              id: 'inspection',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    }).run();
  };

  await run([A]);
  const firstRun = searchConsole.calls.length;
  await run([A, B]);

  const windows = searchConsole.calls
    .slice(firstRun)
    .filter(({ body }) => String(body.dimensions) === 'date')
    .map(({ site, body }) => [site, body.startDate]);
  // A resumes at its settled day; B has no state yet, so it backfills.
  assert.deepEqual(windows, [
    [A, day(-1)],
    [B, monthsBack(16)],
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
  using searchConsole = google({
    reply: ({ site }) =>
      denied && site === B
        ? forbidden(B)
        : {
            rows: [
              {
                clicks: 1,
                ctr: 1,
                impressions: 1,
                keys: [day(-1)],
                position: 1,
              },
            ],
          },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [A, B],
  });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
            id: 'daily',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const loaded = async () =>
    (await sql`SELECT DISTINCT "siteUrl" FROM daily ORDER BY "siteUrl"`).map(
      (row) => row.siteUrl,
    );
  // Where each property's read of the run after `from` calls starts.
  const starts = (from: number) =>
    searchConsole.calls
      .slice(from)
      .map(({ site, body }) => [site, body.startDate]);

  const error = await pipeline.run().then(
    () => assert.fail('run should report the property without permission'),
    (error: unknown) => error,
  );

  // Never skipped silently: the run fails and names the property.
  assert.ok(error instanceof PipelineError, String(error));
  assert.match(
    error.message,
    /daily \{"siteUrl":"sc-domain:b\.example"\}: User does not have sufficient permission for site 'sc-domain:b\.example'\./,
  );
  assert.deepEqual(await loaded(), [A]);

  denied = false;
  const second = searchConsole.calls.length;
  await pipeline.run();
  assert.deepEqual(await loaded(), [A, B]);
  // A resumes where its load left off; B kept no checkpoint, so it reads its
  // whole history.
  assert.deepEqual(starts(second), [
    [A, day(0)],
    [B, monthsBack(16)],
  ]);
  const third = searchConsole.calls.length;
  await pipeline.run();
  assert.deepEqual(starts(third), [
    [A, day(0)],
    [B, day(0)],
  ]);
});

test('a property Google refuses to the user is a config failure, and a quota refusal or a server error is a system failure', async () => {
  const refusals: Record<string, () => Response> = {
    'sc-domain:forbidden.example': () =>
      forbidden('sc-domain:forbidden.example'),
    'sc-domain:unauthenticated.example': () =>
      refusal(
        401,
        'authError',
        'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
      ),
    'sc-domain:limited.example': () =>
      refusal(403, 'rateLimitExceeded', 'Rate Limit Exceeded', RETRY_NOW),
    'sc-domain:broken.example': serverError,
  };
  using searchConsole = google({
    reply: ({ site }) => refusals[String(site)]?.(),
  });
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, checkpoints } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: Object.keys(refusals),
  });
  const pipeline = new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
            id: 'daily',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });

  const error = await pipeline.run().then(
    () => assert.fail('every property was refused'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results[0]?.failures.map(({ partition, failureType }) => [
      partition?.siteUrl,
      failureType,
    ]),
    [
      ['sc-domain:forbidden.example', 'config'],
      ['sc-domain:unauthenticated.example', 'config'],
      ['sc-domain:limited.example', 'system'],
      ['sc-domain:broken.example', 'system'],
    ],
  );
  // Only the user can fix a refusal, so it is tried once; the rate limit and
  // the server error are tried five times.
  assert.deepEqual(
    Object.keys(refusals).map((site) => [
      site,
      searchConsole.calls.filter((call) => call.site === site).length,
    ]),
    [
      ['sc-domain:forbidden.example', 1],
      ['sc-domain:unauthenticated.example', 1],
      ['sc-domain:limited.example', 5],
      ['sc-domain:broken.example', 5],
    ],
  );
});

test('a grant Google no longer refreshes is a config failure, asked once', async () => {
  let refreshes = 0;
  const calls: string[] = [];
  const server = setupServer(
    http.post('https://oauth2.googleapis.com/token', () => {
      refreshes += 1;
      return Response.json(
        {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        },
        { status: 400 },
      );
    }),
    http.all('https://searchconsole.googleapis.com/*', ({ request }) => {
      calls.push(request.url);
      return Response.json({});
    }),
  );
  server.listen({ onUnhandledFrame: 'error' });
  try {
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, checkpoints } = warehouse;
    const source = new SearchConsoleSource({
      // The first call mints an access token, and Google refuses.
      requester: signedIn(),
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });

    const error = await new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(source.searchAnalyticsDaily, destination.table('daily'), {
              id: 'daily',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    })
      .run()
      .then(
        () => assert.fail('the grant was refused'),
        (error: unknown) => error,
      );

    // Only the user can fix it by connecting again.
    assert.ok(error instanceof PipelineError, String(error));
    assert.deepEqual(
      error.results[0]?.failures.map(({ failureType }) => failureType),
      ['config'],
    );
    assert.equal(refreshes, 1);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test(
  'watching reloads the properties when only one of them changed',
  { timeout: 10_000 },
  async () => {
    const A = 'sc-domain:a.example';
    const B = 'sc-domain:b.example';
    const clicks: Record<string, number> = { [A]: 3, [B]: 7 };
    using searchConsole = google({
      reply: ({ site }) => ({
        metadata: { firstIncompleteDate: day(0) },
        rows: [
          {
            clicks: clicks[String(site)],
            ctr: 0.1,
            impressions: 30,
            keys: [day(-1)],
            position: 2,
          },
        ],
      }),
    });
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const warehouse = {
      sql: clients.adopt(
        postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: RAW },
        }),
        (sql) => sql.end(),
      ),
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, sql } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 1,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [A, B],
    });
    const copy = new Copy(
      source.searchAnalyticsDaily,
      destination.table('rows'),
    );
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({ name: 'test', source, destination, steps: [copy] }),
      ],
    }).watch({ signal: controller.signal });
    const histories = [
      query(A, 'date', monthsBack(16)),
      query(B, 'date', monthsBack(16)),
    ];

    try {
      assert.deepEqual((await watching.next()).value?.outcomes, [
        { copy, count: 2, deleted: 0, failures: [], cancelled: false },
      ]);
      assert.deepEqual(reads(searchConsole).toSorted(), histories);
      // Asked for its next pass, the watch probes both unchanged properties
      // and reads nothing.
      const next = watching.next();
      const { probed, read } = await quietly(searchConsole);
      assert.deepEqual(
        [...new Set(probed.map(({ site }) => site))].toSorted(),
        [A, B],
        'every property is probed',
      );
      assert.deepEqual(read, []);
      clicks[B] = 9;
      assert.deepEqual((await next).value?.outcomes, [
        { copy, count: 2, deleted: 0, failures: [], cancelled: false },
      ]);
      assert.deepEqual(
        reads(searchConsole).toSorted(),
        [...histories, ...histories].toSorted(),
      );
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
      await watching.return(undefined);
    }
  },
);

test(
  'a property without permission is reported in each batch while watching goes on for the others',
  { timeout: 10_000 },
  async () => {
    const A = 'sc-domain:a.example';
    const B = 'sc-domain:b.example';
    const clicks: Record<string, number> = { [A]: 3, [B]: 7 };
    let denied = true;
    using searchConsole = google({
      reply: ({ site }) =>
        denied && site === B
          ? forbidden(B)
          : {
              metadata: { firstIncompleteDate: day(0) },
              rows: [
                {
                  clicks: clicks[String(site)],
                  ctr: 0.1,
                  impressions: 30,
                  keys: [day(-1)],
                  position: 2,
                },
              ],
            },
    });
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const warehouse = {
      sql: clients.adopt(
        postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: RAW },
        }),
        (sql) => sql.end(),
      ),
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, checkpoints, sql } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 1,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [A, B],
    });
    const copy = new Copy(
      source.searchAnalyticsDaily,
      destination.table('rows'),
      {
        id: 'rows',
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      },
    );
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [copy],
        }),
      ],
    }).watch({ signal: controller.signal });
    const batch = async () => {
      const before = reads(searchConsole).length;
      const next = await watching.next();
      if (next.done) assert.fail('watching ended');
      const [outcome] = next.value.outcomes;
      return {
        count: outcome?.count,
        failed: outcome?.failures.map(({ partition, error, failureType }) => [
          partition?.siteUrl,
          failureType,
          error instanceof Error ? error.message : error,
        ]),
        reads: reads(searchConsole).slice(before).toSorted(),
      };
    };
    const refused = [
      B,
      'config',
      `User does not have sufficient permission for site '${B}'. See also: https://support.google.com/webmasters/answer/2451999.`,
    ];
    const loaded = async () =>
      (
        await sql`SELECT "siteUrl", clicks::int FROM rows ORDER BY "siteUrl"`
      ).map((row) => [row.siteUrl, row.clicks]);

    try {
      assert.deepEqual(await batch(), {
        count: 1,
        failed: [refused],
        reads: [
          query(A, 'date', monthsBack(16)),
          query(B, 'date', monthsBack(16)),
        ],
      });
      clicks[A] = 5;
      // A resumes at its settled day; B, never loaded, asks for its whole
      // history again.
      assert.deepEqual(await batch(), {
        count: 1,
        failed: [refused],
        reads: [query(A, 'date', day(-1)), query(B, 'date', monthsBack(16))],
      });
      assert.deepEqual(await loaded(), [[A, 5]]);
      denied = false;
      // A's row has not changed since, so only B's is written.
      assert.deepEqual(await batch(), {
        count: 1,
        failed: [],
        reads: [query(A, 'date', day(-1)), query(B, 'date', monthsBack(16))],
      });
      assert.deepEqual(await loaded(), [
        [A, 5],
        [B, 7],
      ]);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test('sitemaps in every format feed the inspection universe', async () => {
  using searchConsole = google({
    reply: property({ sitemaps: ['https://example.com/index.xml'] }),
    files: {
      'https://example.com/index.xml':
        '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/pages.xml.gz</loc></sitemap><sitemap><loc>https://example.com/list.txt</loc></sitemap><sitemap><loc>https://example.com/feed.rss</loc></sitemap><sitemap><loc>https://example.com/atom.xml</loc></sitemap></sitemapindex>',
      'https://example.com/pages.xml.gz': gzipSync(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/q?x=1&amp;y=2</loc></url><url><loc>https://example.com/q?x=1&#38;y=2</loc></url><url><loc>https://example.com/q?x=1&#x26;y=2#top</loc></url><url><loc><![CDATA[https://example.com/c?a=1&b=2]]></loc></url></urlset>',
      ),
      'https://example.com/list.txt':
        'https://example.com/t\nhttps://blog.example.com/t\nhttps://elsewhere.org/t\n',
      'https://example.com/feed.rss':
        '<rss version="2.0"><channel><item><link>https://example.com/r</link></item></channel></rss>',
      'https://example.com/atom.xml':
        '<feed xmlns="http://www.w3.org/2005/Atom"><link rel="self" href="https://example.com/atom.xml"/><entry><link href="https://example.com/a"/></entry></feed>',
    },
  });
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };

  await inspectionRun(
    new SearchConsoleSource({
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    }),
    warehouse,
  );

  // Entity forms and anchors collapse to one URL; other hosts are dropped.
  assert.deepEqual(inspected(searchConsole).toSorted(), [
    'https://blog.example.com/t',
    'https://example.com/a',
    'https://example.com/c?a=1&b=2',
    'https://example.com/q?x=1&y=2',
    'https://example.com/r',
    'https://example.com/t',
  ]);
});

test('an unreadable sitemap is recorded as data and inspection covers everything else', async () => {
  // s.xml indexes i1.xml, which indexes i2.xml, and so on.
  const nested = (depth: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: depth }, (_, level) => [
        level === 0
          ? 'https://example.com/s.xml'
          : `https://example.com/i${level}.xml`,
        `<sitemapindex><sitemap><loc>https://example.com/i${level + 1}.xml</loc></sitemap></sitemapindex>`,
      ]),
    );
  const cases: [
    string,
    Record<string, string | Uint8Array<ArrayBuffer> | number>,
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
    [
      'a url without a loc',
      { 'https://example.com/s.xml': '<urlset><url></url></urlset>' },
      /<urlset> url\.0:/,
    ],
    [
      'a sitemap entry with two locs',
      {
        'https://example.com/s.xml':
          '<sitemapindex><sitemap><loc>https://example.com/a.xml</loc><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>',
      },
      /<sitemapindex> sitemap\.0\.loc:/,
    ],
  ];
  for (const [label, broken, reason] of cases) {
    using searchConsole = google({
      reply: property({
        pages: ['https://example.com/p'],
        sitemaps: ['https://example.com/s.xml', 'https://example.com/good.xml'],
      }),
      files: {
        ...broken,
        'https://example.com/good.xml': 'https://example.com/g\n',
      },
    });
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const warehouse = {
      sql: clients.adopt(
        postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: RAW },
        }),
        (sql) => sql.end(),
      ),
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, sql } = warehouse;
    const source = new SearchConsoleSource({
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });

    await new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(source.sitemaps, destination.table('sitemaps'))],
        }),
      ],
    }).run();
    await inspectionRun(source, warehouse);

    // The good sitemap's page and the search page are still inspected.
    assert.deepEqual(
      inspected(searchConsole).toSorted(),
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

test(
  'watching with a poll longer than a Node timer can hold sleeps without overflowing it',
  { timeout: 10_000 },
  async () => {
    using searchConsole = google({
      reply: () => ({
        siteEntry: [{ permissionLevel: 'siteOwner', siteUrl: SITE }],
      }),
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 2 ** 31,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const overflows: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === 'TimeoutOverflowWarning')
        overflows.push(warning.message);
    };
    process.on('warning', onWarning);
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [new Copy(source.sites, destination.table('sites'))],
        }),
      ],
    }).watch({ signal: controller.signal });

    try {
      await watching.next();
      await sleep(200);

      assert.deepEqual(overflows, []);
    } finally {
      controller.abort();
      await watching.return(undefined);
      process.off('warning', onWarning);
    }
  },
);

test('an RSS item without a link lists no page', async () => {
  using searchConsole = google({
    reply: property({ sitemaps: ['https://example.com/feed.rss'] }),
    files: {
      'https://example.com/feed.rss':
        '<rss version="2.0"><channel><item></item><item><title>No link</title></item><item><link>https://example.com/r</link></item></channel></rss>',
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const { destination, sql } = warehouse;
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });

  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [new Copy(source.sitemaps, destination.table('sitemaps'))],
      }),
    ],
  }).run();

  assert.deepEqual(
    (await sql`SELECT "urlsRead"::int, "readError" FROM sitemaps`).map(
      (row) => ({ ...row }),
    ),
    [{ urlsRead: 1, readError: null }],
  );
});

test('a pass that cannot read a sitemap deletes no URL it may list, and the next complete pass deletes the ones gone', async () => {
  const SITEMAP = 'https://example.com/sitemap.xml';
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  // The host builds a source for every run.
  const pass = async (sitemap: string | number, pages: string[]) => {
    using searchConsole = google({
      reply: property({ sitemaps: [SITEMAP], pages }),
      files: { [SITEMAP]: sitemap },
    });
    const [outcome] = await inspectionRun(
      new SearchConsoleSource({
        requester: searchConsole.requester,
        searchTypes: ['WEB'],
        siteUrls: [SITE],
      }),
      warehouse,
    );
    return {
      inspected: inspected(searchConsole),
      deleted: outcome?.deleted,
      loaded: (await inspectionRows(warehouse)).map((row) => row.inspectionUrl),
    };
  };

  assert.deepEqual(await pass('https://example.com/x\n', []), {
    inspected: ['https://example.com/x'],
    deleted: 0,
    loaded: ['https://example.com/x'],
  });
  // The sitemap answers 503 once: x may still be listed, so it stays, while
  // a page the search analytics show is inspected as usual.
  assert.deepEqual(await pass(503, ['https://example.com/y']), {
    inspected: ['https://example.com/y'],
    deleted: 0,
    loaded: ['https://example.com/x', 'https://example.com/y'],
  });
  // Read again, the sitemap no longer lists x.
  assert.deepEqual(await pass('', ['https://example.com/y']), {
    inspected: [],
    deleted: 1,
    loaded: ['https://example.com/y'],
  });
});

test('rolling refresh inspects new URLs first, then the stalest, and skips fresh ones', async (t) => {
  const pages = ['https://example.com/a', 'https://example.com/b'];
  using searchConsole = google({ reply: property({ pages }) });
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const refreshMs = 2000;
  // The host builds a source for every run.
  const run = async () => {
    const before = inspected(searchConsole).length;
    await inspectionRun(
      new SearchConsoleSource({
        requester: searchConsole.requester,
        inspectionConcurrency: 1,
        inspectionRefreshHours: refreshMs / 3_600_000,
        searchTypes: ['WEB'],
        siteUrls: [SITE],
      }),
      warehouse,
    );
    return inspected(searchConsole).slice(before);
  };

  // The clock moves only when the test moves it, so a slow run does not
  // make a URL due early.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    assert.deepEqual(await run(), pages);
    t.mock.timers.tick(refreshMs / 2);
    pages.push('https://example.com/c');
    assert.deepEqual(await run(), ['https://example.com/c']);
    t.mock.timers.tick(refreshMs / 2);
    pages.push('https://example.com/d');
    // a and b are due again, c is still fresh: the new d goes first, c waits.
    assert.deepEqual(await run(), [
      'https://example.com/d',
      'https://example.com/a',
      'https://example.com/b',
    ]);
  } finally {
    t.mock.timers.reset();
  }
});

test('the daily quota stops inspection cleanly, and no inspection stream makes a call before the quota resets', async () => {
  let allowed = 2;
  using searchConsole = google({
    reply: property({
      pages: ['a', 'b', 'c', 'd'].map((page) => `https://example.com/${page}`),
      inspect: () => (allowed-- > 0 ? { verdict: 'PASS' } : quotaExceeded()),
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    inspectionConcurrency: 1,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
  });

  await inspectionRun(source, warehouse, ALL_INSPECTIONS);
  // The refused URL is tried five times, then the run stops inspecting and
  // succeeds with what it loaded; the streams read with it ask no more.
  assert.deepEqual(inspected(searchConsole), [
    'https://example.com/a',
    'https://example.com/b',
    ...Array(5).fill('https://example.com/c'),
  ]);
  assert.deepEqual(
    (await inspectionRows(warehouse)).map((row) => row.inspectionUrl),
    ['https://example.com/a', 'https://example.com/b'],
  );
  await inspectionRun(source, warehouse, ALL_INSPECTIONS);
  assert.equal(inspected(searchConsole).length, 7, 'no call before the reset');
});

test('with inspections in flight the daily quota keeps what loaded, and a source built for the next run makes no inspection call before the quota resets', async (t) => {
  const pages = ['a', 'b', 'c', 'd', 'e', 'f'].map(
    (page) => `https://example.com/${page}`,
  );
  let allowed = 2;
  using searchConsole = google({
    reply: property({
      pages,
      inspect: () => (allowed-- > 0 ? { verdict: 'PASS' } : quotaExceeded()),
    }),
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  // The host builds a client and a source for every run.
  const run = async () => {
    const before = inspected(searchConsole).length;
    await inspectionRun(
      new SearchConsoleSource({
        requester: signedIn(),
        inspectionConcurrency: 3,
        searchTypes: ['WEB'],
        siteUrls: [SITE],
      }),
      warehouse,
    );
    return inspected(searchConsole).slice(before);
  };
  const loaded = async () =>
    (await inspectionRows(warehouse)).map((row) => row.inspectionUrl);

  const first = await run();
  const kept = await loaded();
  // The two inspections Google allowed load. Once the quota ran out no
  // worker took another URL, so the last one never went out.
  assert.equal(kept.length, 2, String(first));
  assert.ok(!first.includes('https://example.com/f'), String(first));
  const rest = pages.filter((page) => !kept.includes(page));

  // The checkpoint keeps when the quota resets, so a new source asks nothing
  // before it.
  assert.deepEqual(await run(), []);
  assert.deepEqual(await loaded(), kept);

  allowed = Number.POSITIVE_INFINITY;
  // Pacific midnight cannot come during a test, so the clock moves to it.
  t.mock.timers.enable({
    apis: ['Date'],
    now: Temporal.Now.plainDateISO('America/Los_Angeles')
      .add({ days: 1 })
      .toZonedDateTime('America/Los_Angeles').epochMilliseconds,
  });
  try {
    assert.deepEqual((await run()).toSorted(), rest);
    assert.deepEqual(await loaded(), pages);
  } finally {
    t.mock.timers.reset();
  }
});

test(
  'one inspection serves all three streams, and a URL that leaves is deleted from each',
  { timeout: 10_000 },
  async () => {
    const pages = ['https://example.com/a', 'https://example.com/b'];
    let referrers = 2;
    using searchConsole = google({
      reply: property({
        pages,
        inspect: (url) => ({
          verdict: 'PASS',
          sitemap: ['https://example.com/sitemap.xml'],
          referringUrls: Array.from(
            { length: referrers },
            (_, n) => `${url}/r${n}`,
          ),
        }),
      }),
    });
    const refreshMs = 2000;
    const source = new SearchConsoleSource({
      requester: searchConsole.requester,
      inspectionRefreshHours: refreshMs / 3_600_000,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const warehouse = {
      sql: clients.adopt(
        postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: RAW },
        }),
        (sql) => sql.end(),
      ),
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };

    await inspectionRun(source, warehouse, ['urlInspection']);
    // The other two streams load in a later read: they share one new
    // inspection per URL, since a read reuses only the inspections it made.
    await inspectionRun(source, warehouse, ALL_INSPECTIONS);
    const lastInspected = Date.now();
    assert.equal(inspected(searchConsole).length, 4);

    pages.pop();
    referrers = 1;
    await sleep(lastInspected + refreshMs - Date.now());
    await inspectionRun(source, warehouse, ALL_INSPECTIONS);

    assert.equal(inspected(searchConsole).length, 5);
    for (const table of ALL_INSPECTIONS)
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
  },
);

test('the three inspection streams read together inspect each URL once', async () => {
  const pages = ['https://example.com/a', 'https://example.com/b'];
  const answer = property({
    pages,
    inspect: (url) => ({
      verdict: 'PASS',
      sitemap: ['https://example.com/sitemap.xml'],
      referringUrls: [`${url}/r0`],
    }),
  });
  using searchConsole = google({
    // Slow inspections keep one stream's calls in flight while the others plan.
    reply: async (call) => {
      if (call.path.endsWith('index:inspect')) await sleep(20);
      return answer(call);
    },
  });
  const source = new SearchConsoleSource({
    requester: searchConsole.requester,
    searchTypes: ['WEB'],
    siteUrls: [SITE],
    streamConcurrency: 3,
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };

  await inspectionRun(source, warehouse, ALL_INSPECTIONS);

  assert.deepEqual(inspected(searchConsole).toSorted(), pages);
  for (const table of ALL_INSPECTIONS)
    assert.deepEqual(
      [
        ...new Set(
          (await inspectionRows(warehouse, table)).map(
            (row) => row.inspectionUrl,
          ),
        ),
      ].toSorted(),
      pages,
      table,
    );
});

test('inspections run concurrently, and a URL Google rejects becomes a row', async () => {
  let inFlight = 0;
  let peak = 0;
  const pages = Array.from({ length: 7 }, (_, n) => `https://example.com/${n}`);
  const answer = property({
    pages,
    inspect: (url) =>
      url.endsWith('/3')
        ? refusal(400, 'badRequest', 'Invalid URL')
        : { verdict: 'PASS' },
  });
  using searchConsole = google({
    reply: async (call) => {
      if (!call.path.endsWith('index:inspect')) return answer(call);
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later URLs answer sooner, so completions arrive out of order.
      await sleep(20 - pages.indexOf(String(call.body.inspectionUrl)) * 2);
      inFlight--;
      return answer(call);
    },
  });
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };

  await inspectionRun(
    new SearchConsoleSource({
      inspectionConcurrency: 3,
      requester: searchConsole.requester,
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
});

test('a server error during inspection fails the run and keeps none of its inspections', async () => {
  const pages = Array.from({ length: 7 }, (_, n) => `https://example.com/${n}`);
  let failing = true;
  using searchConsole = google({
    reply: property({
      pages,
      inspect: (url) =>
        failing && url.endsWith('/5') ? serverError() : { verdict: 'PASS' },
    }),
  });
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  const run = () =>
    inspectionRun(
      new SearchConsoleSource({
        requester: searchConsole.requester,
        searchTypes: ['WEB'],
        siteUrls: [SITE],
      }),
      warehouse,
    );

  await assert.rejects(run(), (error: unknown) => {
    assert.ok(error instanceof PipelineError, String(error));
    assert.match(
      error.message,
      /urlInspection \{"siteUrl":"sc-domain:example\.com"\}: Internal error encountered\./,
    );
    return true;
  });
  assert.equal(
    inspected(searchConsole).filter((url) => url === pages[5]).length,
    5,
  );
  failing = false;
  const before = inspected(searchConsole).length;
  await run();

  // The failed run committed nothing, so every URL is inspected again.
  assert.deepEqual(inspected(searchConsole).slice(before).toSorted(), pages);
});

test('inspection options are validated', () => {
  const base = { requester: signedIn(), siteUrls: [SITE] };
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
  for (const streamConcurrency of [0, 1.5])
    assert.throws(
      () => new SearchConsoleSource({ ...base, streamConcurrency }),
      /streamConcurrency must be a whole number of at least one/,
    );
});

test(
  'watching wakes inspection streams when URLs fall due, not when traffic changes',
  { timeout: 10_000 },
  async () => {
    let clicks = 1;
    const answer = property({ pages: ['https://example.com/a'] });
    using searchConsole = google({
      reply: (call) =>
        String(call.body.dimensions) === 'date'
          ? {
              rows: [
                {
                  clicks,
                  ctr: 0.1,
                  impressions: 10,
                  keys: [day(-1)],
                  position: 1,
                },
              ],
            }
          : answer(call),
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, checkpoints } = warehouse;
    const refreshMs = 2000;
    const source = new SearchConsoleSource({
      inspectionRefreshHours: refreshMs / 3_600_000,
      pollIntervalMs: 5,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const incremental = (stream: typeof source.urlInspection, id: string) =>
      new Copy(stream, destination.table(id), {
        id,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      });
    const pipeline = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            incremental(source.urlInspection, 'inspection'),
            incremental(source.searchAnalyticsDaily, 'daily'),
          ],
        }),
      ],
    });
    // Loaded once already, the source knows when the URL next falls due.
    await pipeline.run();
    const controller = new AbortController();
    const watching = pipeline.watch({ signal: controller.signal });
    const pass = async () => {
      const before = reads(searchConsole).length;
      const next = await watching.next();
      if (next.done) assert.fail('watching ended');
      return {
        streams: next.value.outcomes.map(({ copy }) => copy.from.name),
        reads: reads(searchConsole).slice(before).toSorted(),
      };
    };
    const discovery = [
      query(SITE, 'page', monthsBack(16)),
      `sitemaps of ${SITE}`,
    ];

    try {
      // The first check wakes every stream; the URL is still fresh.
      assert.deepEqual(await pass(), {
        streams: ['urlInspection', 'searchAnalyticsDaily'],
        reads: [query(SITE, 'date', day(0)), ...discovery].toSorted(),
      });
      clicks = 9;
      // A traffic change wakes the analytics stream alone.
      assert.deepEqual(await pass(), {
        streams: ['searchAnalyticsDaily'],
        reads: [query(SITE, 'date', day(0))],
      });
      // With traffic unchanged since, only the URL falling due wakes the
      // pipeline, and inspects it again.
      assert.deepEqual(await pass(), {
        streams: ['urlInspection'],
        reads: ['inspect https://example.com/a', ...discovery].toSorted(),
      });
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test(
  'watching rereads the analytics alone when the totals change, and the listings alone when a sitemap is submitted',
  { timeout: 10_000 },
  async () => {
    const listed = ['https://example.com/a.xml'];
    let clicks = 1;
    using searchConsole = google({
      reply: ({ path }) => {
        if (path.endsWith('/v3/sites'))
          return {
            siteEntry: [{ permissionLevel: 'siteOwner', siteUrl: SITE }],
          };
        if (path.endsWith('/sitemaps'))
          return { sitemap: listed.map(sitemapEntry) };
        return {
          rows: [
            { clicks, ctr: 0.1, impressions: 10, keys: [day(-1)], position: 1 },
          ],
        };
      },
      files: {
        'https://example.com/a.xml': 'https://example.com/a\n',
        'https://example.com/b.xml': 'https://example.com/b\n',
      },
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination } = warehouse;
    const source = new SearchConsoleSource({
      pollIntervalMs: 5,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          steps: [
            source.sites,
            source.sitemaps,
            source.sitemapContents,
            source.searchAnalyticsDaily,
          ].map((stream) => new Copy(stream, destination.table(stream.name))),
        }),
      ],
    }).watch({ signal: controller.signal });
    // A probe lists the sites and sitemaps with the same calls a read makes,
    // so a pass shows in what it loaded, queried and downloaded.
    const queried = () =>
      searchConsole.calls
        .filter((call) => call.path.endsWith('/query') && !isProbe(call))
        .map(label);
    const pass = async () => {
      const before = {
        queried: queried().length,
        fetched: searchConsole.fetched.length,
      };
      const next = await watching.next();
      if (next.done) assert.fail('watching ended');
      return {
        streams: next.value.outcomes.map(({ copy }) => copy.from.name),
        queried: queried().slice(before.queried),
        fetched: searchConsole.fetched.slice(before.fetched),
      };
    };
    const history = query(SITE, 'date', monthsBack(16));

    try {
      assert.deepEqual(await pass(), {
        streams: [
          'sites',
          'sitemaps',
          'sitemapContents',
          'searchAnalyticsDaily',
        ],
        queried: [history],
        fetched: ['https://example.com/a.xml'],
      });
      clicks = 9;
      assert.deepEqual(await pass(), {
        streams: ['searchAnalyticsDaily'],
        queried: [history],
        fetched: [],
      });
      listed.push('https://example.com/b.xml');
      assert.deepEqual(await pass(), {
        streams: ['sites', 'sitemaps', 'sitemapContents'],
        queried: [],
        fetched: ['https://example.com/a.xml', 'https://example.com/b.xml'],
      });
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test(
  'under a watch, an inspection stream whose pass failed, the first one or one when its URL fell due, is inspected again at the next poll though no due time moved',
  { timeout: 15_000 },
  async () => {
    let denied = true;
    const answer = property({ pages: ['https://example.com/a'] });
    using searchConsole = google({
      reply: (call) => (denied ? forbidden(SITE) : answer(call)),
    });
    const source = new SearchConsoleSource({
      // 360 ms: the URL falls due again soon after it is inspected.
      inspectionRefreshHours: 0.0001,
      pollIntervalMs: 500,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, checkpoints } = warehouse;
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(source.urlInspection, destination.table('inspection'), {
              id: 'inspection',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    }).watch({ signal: controller.signal });
    const pass = async () => {
      const before = reads(searchConsole).length;
      const next = await watching.next();
      if (next.done) assert.fail('the inspections were not read again');
      return {
        failed: next.value.outcomes.flatMap(({ failures }) =>
          failures.map(({ failureType }) => failureType),
        ),
        reads: reads(searchConsole).slice(before).toSorted(),
      };
    };
    // A refused pass stops at the sitemap listing; a loaded one inspects.
    const refused = { failed: ['config'], reads: [`sitemaps of ${SITE}`] };
    const inspecting = {
      failed: [],
      reads: [
        'inspect https://example.com/a',
        query(SITE, 'page', monthsBack(16)),
        `sitemaps of ${SITE}`,
      ],
    };

    try {
      assert.deepEqual(await pass(), refused);
      denied = false;
      assert.deepEqual(await pass(), inspecting);
      denied = true;
      assert.deepEqual(await pass(), refused);
      denied = false;
      assert.deepEqual(await pass(), inspecting);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);

test(
  'under a watch, an inspection that falls due sooner than the next poll is made when it falls due',
  { timeout: 15_000 },
  async () => {
    using searchConsole = google({
      reply: property({ pages: ['https://example.com/a'] }),
    });
    const source = new SearchConsoleSource({
      // 360 ms: the URL falls due again soon after it is inspected.
      inspectionRefreshHours: 0.0001,
      pollIntervalMs: 60_000,
      requester: searchConsole.requester,
      searchTypes: ['WEB'],
      siteUrls: [SITE],
    });
    await using database = await databases.database();
    const warehouse = {
      history: new PostgresSyncHistory({ url: database.connectionString }),
      destination: new PostgresDestination({
        url: database.connectionString,
        schema: RAW,
      }),
      checkpoints: new PostgresCheckpointStore({
        url: database.connectionString,
        schema: RAW,
      }),
    };
    const { destination, checkpoints } = warehouse;
    const controller = new AbortController();
    const watching = new Pipeline({
      history: warehouse.history,
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints,
          steps: [
            new Copy(source.urlInspection, destination.table('inspection'), {
              id: 'inspection',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    }).watch({ signal: controller.signal });
    const inspecting = [
      'inspect https://example.com/a',
      query(SITE, 'page', monthsBack(16)),
      `sitemaps of ${SITE}`,
    ];

    try {
      await watching.next();
      assert.deepEqual(reads(searchConsole).toSorted(), inspecting);
      const inspectedAt = Date.now();
      const due = await watching.next();
      const waited = Date.now() - inspectedAt;

      assert.equal(due.done, false, 'the due inspection waited for the poll');
      assert.deepEqual(
        reads(searchConsole).slice(inspecting.length).toSorted(),
        inspecting,
      );
      assert.ok(waited < 5_000, `inspected again after ${waited} ms`);
    } finally {
      controller.abort();
      await watching.return(undefined);
    }
  },
);
