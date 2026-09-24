import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Pipeline, SQLiteCheckpointStore } from 'elt';
import { PostgresDestination } from 'elt-postgresql';
import postgres from 'postgres';

import {
  installSearchConsoleMarts,
  installWarehouse,
  SearchConsoleSource,
  searchConsoleCopies,
} from './index.ts';

const server =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';
const NOW = () => new Date('2026-09-22T00:00:00.000Z');
const RAW = 'google_search_console';

type Row = {
  keys: string[];
  clicks: number;
  impressions: number;
  position?: number;
};
type Request = { site: string; dimensions: string[]; type: string };

// What Google answers, set by each test and changed between loads.
type Google = {
  firstIncompleteDate?: string;
  analytics: (request: Request) => Row[];
};

/**
 * A fresh database and reader role, loaded through the real pipeline from a
 * fake Search Console, with marts installed as the app installs them.
 */
async function warehouse(siteUrls: string[], google: Google) {
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  const id = randomUUID().replaceAll('-', '');
  const name = `gsc_test_${id}`;
  const reader = `agent_${id}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(server).host} is unavailable. Start it with: docker compose -f infra/docker-compose.yml up -d --wait`,
      { cause },
    );
  }
  // The same role settings infra/init/01-roles.sh gives agent_reader.
  await admin.unsafe(
    `CREATE ROLE "${reader}" LOGIN NOINHERIT PASSWORD 'agent'`,
  );
  await admin.unsafe(
    `ALTER ROLE "${reader}" SET default_transaction_read_only = on`,
  );
  await admin.unsafe(`ALTER ROLE "${reader}" SET search_path = marts`);
  const scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-warehouse-'));
  const url = new URL(server);
  url.pathname = `/${name}`;
  const agentUrl = new URL(url);
  agentUrl.username = reader;
  agentUrl.password = 'agent';
  const sql = postgres(url.href, { max: 1, onnotice: () => {} });
  const agent = postgres(agentUrl.href, { max: 1, onnotice: () => {} });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const requester = {
    async request(options: { url: string; data?: Record<string, unknown> }) {
      const path = new URL(options.url).pathname;
      if (path.endsWith('/webmasters/v3/sites'))
        return {
          data: {
            siteEntry: siteUrls.map((siteUrl) => ({
              siteUrl,
              permissionLevel: 'siteOwner',
            })),
          },
        };
      if (path.endsWith('/sitemaps')) return { data: {} };
      const site = decodeURIComponent(
        path.split('/sites/')[1]?.split('/')[0] ?? '',
      );
      return {
        data: {
          // Google always reports ctr, so the fake derives it as Google does.
          rows: google
            .analytics({
              site,
              dimensions: (options.data?.['dimensions'] as string[]) ?? [],
              type: String(options.data?.['type']),
            })
            .map((row) => ({
              ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
              ...row,
            })),
          ...(google.firstIncompleteDate && {
            metadata: { firstIncompleteDate: google.firstIncompleteDate },
          }),
        },
      };
    },
  };
  return {
    sql,
    agent,
    reader,
    async load() {
      const source = new SearchConsoleSource({
        requester,
        siteUrls,
        now: NOW,
        searchTypes: ['WEB', 'DISCOVER'],
      });
      const destination = new PostgresDestination({
        url: url.href,
        schema: RAW,
      });
      await new Pipeline({
        source,
        destination,
        checkpoints,
        steps: searchConsoleCopies(source, (table) => destination.table(table)),
      }).run();
      await installWarehouse(sql, { reader });
      await installSearchConsoleMarts(sql, { raw: RAW, reader });
    },
    async [Symbol.asyncDispose]() {
      await agent.end();
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE "${reader}"`);
      await admin.end();
      await scratch[Symbol.asyncDispose]();
    },
  };
}

const SITE = 'sc-domain:example.com';
const row = (keys: string[], clicks: number, impressions: number) => ({
  keys,
  clicks,
  impressions,
  position: 5,
});

test('the agent reads marts by bare name and can neither write nor reach raw tables', async () => {
  await using store = await warehouse([SITE], {
    analytics: ({ dimensions }) =>
      dimensions.join() === 'date' ? [row(['2026-09-20'], 3, 30)] : [],
  });
  await store.load();

  assert.deepEqual(
    [
      ...(await store.agent`SELECT site_url, clicks::int FROM search_console_totals_daily WHERE search_type = 'WEB'`),
    ],
    [{ site_url: SITE, clicks: 3 }],
  );
  await assert.rejects(
    store.agent`SELECT * FROM google_search_console.search_daily`,
    /permission denied for schema google_search_console/,
  );
  // Turning read-only off is allowed; privileges still refuse every write.
  await store.agent`SET default_transaction_read_only = off`;
  await assert.rejects(
    store.agent`INSERT INTO search_console_properties (site_url) VALUES ('x')`,
    /permission denied/,
  );
  await assert.rejects(
    store.agent`CREATE TABLE marts.notes (note text)`,
    /permission denied for schema marts/,
  );
  await assert.rejects(
    store.agent`CREATE TEMP TABLE notes (note text)`,
    /permission denied to create temporary tables/,
  );
  // Reinstalling marts on the next load keeps the reader's access.
  await store.load();
  assert.equal(
    (
      await store.agent`SELECT count(*)::int AS n FROM search_console_totals_daily`
    )[0]?.n,
    2,
  );
});

test('rates and ranks can only be computed from sums, never averaged per row', async () => {
  await using store = await warehouse([SITE], {
    analytics: ({ dimensions, type }) => {
      if (dimensions.join() !== 'date') return [];
      if (type === 'DISCOVER')
        return [{ keys: ['2026-09-20'], clicks: 4, impressions: 50 }];
      return [
        { keys: ['2026-09-20'], clicks: 1, impressions: 2, position: 3 },
        { keys: ['2026-09-19'], clicks: 0, impressions: 98, position: 10 },
      ];
    },
  });
  await store.load();

  // What the column comments tell an agent to write.
  const [web] = await store.agent`
    SELECT sum(clicks)::float / nullif(sum(impressions), 0) AS ctr,
      sum(position_weight) / nullif(sum(ranked_impressions), 0) AS rank
    FROM search_console_totals_daily WHERE search_type = 'WEB'`;
  const [all] = await store.agent`
    SELECT sum(position_weight) / nullif(sum(ranked_impressions), 0) AS rank
    FROM search_console_totals_daily`;
  const perRow = await store.agent`
    SELECT name FROM catalog
    WHERE kind = 'column' AND split_part(name, '.', 2) IN ('ctr', 'position')`;

  // Averaging the two per-row rates would give 0.25.
  assert.equal(web?.ctr, 0.01);
  assert.equal(web?.rank, (3 * 2 + 10 * 98) / 100);
  // Discover has no rank, so its 50 impressions do not dilute the average.
  assert.equal(all?.rank, (3 * 2 + 10 * 98) / 100);
  assert.deepEqual([...perRow], []);
});

test('withheld traffic is each property’s totals minus its reported queries', async () => {
  const OTHER = 'sc-domain:other.example';
  await using store = await warehouse([SITE, OTHER], {
    analytics: ({ site, dimensions, type }) => {
      if (type !== 'WEB') return [];
      if (dimensions.join() === 'date')
        return site === SITE
          ? [row(['2026-09-20'], 58, 1986)]
          : [row(['2026-09-20'], 5, 50)];
      if (dimensions.join() === 'date,query' && site === SITE)
        return [
          row(['2026-09-20', 'context compiler'], 30, 900),
          row(['2026-09-20', 'elt'], 7, 120),
        ];
      return [];
    },
  });
  await store.load();

  assert.deepEqual(
    (
      await store.agent`
        SELECT site_url, total_clicks::int, query_clicks::int, withheld_clicks::int,
          withheld_impressions::int
        FROM search_console_withheld_daily ORDER BY site_url`
    ).map((found) => ({ ...found })),
    [
      {
        site_url: SITE,
        total_clicks: 58,
        query_clicks: 37,
        withheld_clicks: 21,
        withheld_impressions: 966,
      },
      {
        site_url: OTHER,
        total_clicks: 5,
        query_clicks: 0,
        withheld_clicks: 5,
        withheld_impressions: 50,
      },
    ],
  );
});

test('a re-read day settles, and query rows Google stopped reporting drop out of marts', async () => {
  let queries = [
    row(['2026-09-20', 'kept'], 2, 20),
    row(['2026-09-20', 'dropped'], 1, 10),
    row(['2026-09-21', 'provisional'], 1, 5),
  ];
  const google: Google = {
    firstIncompleteDate: '2026-09-21',
    analytics: ({ dimensions, type }) =>
      type === 'WEB' && dimensions.join() === 'date,query' ? queries : [],
  };
  await using store = await warehouse([SITE], google);
  await store.load();
  const read = async () =>
    (
      await store.agent`
        SELECT date::text, query, settled FROM search_console_queries_daily
        ORDER BY date, query`
    ).map((found) => ({ ...found }));
  const freshness = async () =>
    (
      await store.agent`
        SELECT latest_date::text, latest_settled_date::text FROM freshness
        WHERE relation = 'search_console_queries_daily'`
    ).map((found) => ({ ...found }));

  assert.deepEqual(await read(), [
    { date: '2026-09-20', query: 'dropped', settled: true },
    { date: '2026-09-20', query: 'kept', settled: true },
    { date: '2026-09-21', query: 'provisional', settled: false },
  ]);
  assert.deepEqual(await freshness(), [
    { latest_date: '2026-09-21', latest_settled_date: '2026-09-20' },
  ]);

  google.firstIncompleteDate = '2026-09-22';
  queries = [
    row(['2026-09-20', 'kept'], 2, 20),
    row(['2026-09-21', 'provisional'], 1, 5),
  ];
  await store.load();

  assert.deepEqual(await read(), [
    { date: '2026-09-20', query: 'kept', settled: true },
    { date: '2026-09-21', query: 'provisional', settled: true },
  ]);
  assert.deepEqual(await freshness(), [
    { latest_date: '2026-09-21', latest_settled_date: '2026-09-21' },
  ]);
});

test('everything the agent can see explains itself', async () => {
  await using store = await warehouse([SITE], {
    analytics: ({ dimensions, type }) =>
      type === 'WEB' && dimensions.join() === 'date,page'
        ? [
            row(['2026-09-20', 'https://x.example/a/b?q=1#f'], 1, 10),
            row(['2026-09-20', 'https://x.example'], 1, 10),
          ]
        : [],
  });
  await store.load();

  const undescribed = await store.agent`
    SELECT kind, name FROM catalog WHERE coalesce(description, '') = ''`;
  const kinds =
    await store.agent`SELECT DISTINCT kind FROM catalog ORDER BY kind`;
  const paths = await store.agent`
    SELECT page_path FROM search_console_pages_daily ORDER BY page_path`;

  assert.deepEqual([...undescribed], []);
  // Nothing to call: the agent's server allows only built-in functions.
  assert.deepEqual(
    kinds.map((found) => found.kind),
    ['column', 'table', 'view'],
  );
  assert.deepEqual(
    paths.map((found) => found.page_path),
    ['/', '/a/b'],
  );
});
