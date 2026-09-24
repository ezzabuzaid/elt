import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type CopyResult,
  Pipeline,
  PipelineError,
  SQLiteCheckpointStore,
} from 'elt';
import { PostgresDestination, type PostgresTable } from 'elt-postgresql';
import { SQLiteDestination, type SQLiteTable } from 'elt-sqlite';
import { GOOGLE_SEARCH_CONSOLE_SCOPE } from 'google-auth';
import postgres from 'postgres';

import {
  googleSession,
  grantDirectory,
  installSearchConsoleMarts,
  installWarehouse,
  OAuthCallbackTimeoutError,
  SearchConsoleSource,
  searchConsoleCopies,
} from './index.ts';

class MissingClientError extends Error {
  override readonly name = 'MissingClientError';
  constructor() {
    super(
      `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com enabled. Grants are stored under ${grantDirectory()}.`,
    );
  }
}

const argumentSites = process.argv.slice(2);
const siteUrls =
  argumentSites.length > 0
    ? argumentSites
    : (process.env.SEARCH_CONSOLE_SITE_URLS?.split(',').filter(Boolean) ?? []);

try {
  if (siteUrls.length === 0)
    throw new TypeError(
      'Pass one or more Search Console properties, for example: nx run google:start -- sc-domain:example.com sc-domain:example.org',
    );
  await mkdir(resolve('outputs'), { recursive: true });

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new MissingClientError();
  // The first run opens a browser for consent; later runs reuse the stored
  // grant. Quota is billed to the OAuth client's own project.
  const requester = await googleSession({
    clientId,
    clientSecret,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  });
  // One source reads every property as a partition of each stream, so each
  // table has one writer and each property keeps its own checkpoint.
  const source = new SearchConsoleSource({ requester, siteUrls });
  const warehouseUrl = process.env.WAREHOUSE_URL;
  if (warehouseUrl) await loadWarehouse(source, warehouseUrl);
  else await loadSQLite(source);
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (
    !(cause instanceof MissingClientError) &&
    !(cause instanceof OAuthCallbackTimeoutError)
  )
    throw error;
  console.error(cause.message);
  process.exitCode = 1;
}

function report(
  results: readonly CopyResult<SQLiteTable | PostgresTable>[],
  into: string,
): void {
  console.table(
    results.map(({ copy, count, deleted }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
      deleted,
    })),
  );
  console.log(`Loaded Search Console for ${siteUrls.join(', ')} into ${into}`);
}

async function loadSQLite(source: SearchConsoleSource): Promise<void> {
  const path = resolve('outputs/search-console.sqlite');
  const destination = new SQLiteDestination({ path });
  const results = await new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: resolve('outputs/search-console-state.sqlite'),
    }),
    steps: searchConsoleCopies(source, (name) =>
      destination.table(`raw_${name}`),
    ),
  }).run();
  report(results, path);
  using database = new DatabaseSync(path, { readOnly: true });
  // Query rows never add up to the daily totals, because Google withholds
  // rare queries. Showing both is the point of keeping the grains apart.
  console.table(
    database
      .prepare(`
      SELECT
        totals.siteUrl,
        totals.date,
        totals.clicks AS total_clicks,
        totals.impressions AS total_impressions,
        coalesce(sum(queries.clicks), 0) AS query_clicks,
        coalesce(sum(queries.impressions), 0) AS query_impressions
      FROM raw_search_daily AS totals
      LEFT JOIN raw_search_queries_daily AS queries
        ON queries.siteUrl = totals.siteUrl AND queries.date = totals.date
      WHERE totals.searchType = 'WEB'
      GROUP BY totals.siteUrl, totals.date, totals.clicks, totals.impressions
      ORDER BY totals.date DESC, totals.siteUrl
      LIMIT 10
    `)
      .all(),
  );
}

// Raw tables land in the connector's schema; the reader sees only marts.
async function loadWarehouse(
  source: SearchConsoleSource,
  url: string,
): Promise<void> {
  const raw = 'google_search_console';
  // Created by infra/init/01-roles.sh.
  const reader = 'agent_reader';
  const destination = new PostgresDestination({ url, schema: raw });
  const results = await new Pipeline({
    source,
    destination,
    // Progress belongs to this warehouse: reset it when the warehouse is reset.
    checkpoints: new SQLiteCheckpointStore({
      path: resolve('outputs/search-console-warehouse-state.sqlite'),
    }),
    steps: searchConsoleCopies(source, (name) => destination.table(name)),
  }).run();
  report(results, `${new URL(url).host} schema ${raw}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await installWarehouse(sql, { reader });
    await installSearchConsoleMarts(sql, { raw, reader });
    console.table(
      await sql`SELECT * FROM marts.search_console_withheld_daily ORDER BY date DESC, site_url LIMIT 10`,
    );
  } finally {
    await sql.end();
  }
}
