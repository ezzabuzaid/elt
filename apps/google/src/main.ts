import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  Copy,
  Pipeline,
  PipelineError,
  SQLiteCheckpointStore,
  SQLiteDestination,
} from 'elt';
import { GOOGLE_SEARCH_CONSOLE_SCOPE } from 'google-auth';

import {
  googleSession,
  grantDirectory,
  OAuthCallbackTimeoutError,
  SearchConsoleSource,
} from './index.ts';

class MissingClientError extends Error {
  override readonly name = 'MissingClientError';
  constructor() {
    super(
      `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com enabled. Grants are stored under ${grantDirectory()}.`,
    );
  }
}

const siteUrl = process.argv[2] ?? process.env.SEARCH_CONSOLE_SITE_URL;

try {
  if (!siteUrl)
    throw new TypeError(
      'Pass a Search Console property, for example: nx run google:start -- sc-domain:example.com',
    );
  const path = resolve('outputs/search-console.sqlite');
  await mkdir(dirname(path), { recursive: true });

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
  const source = new SearchConsoleSource({ requester, siteUrl });
  const destination = new SQLiteDestination({ path });
  const checkpoints = new SQLiteCheckpointStore({
    path: resolve('outputs/search-console-state.sqlite'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints,
    steps: [
      new Copy(source.sites, destination.table('raw_sites')),
      new Copy(source.sitemaps, destination.table('raw_sitemaps')),
      new Copy(
        source.sitemapContents,
        destination.table('raw_sitemap_contents'),
      ),
      // Each grain is its own copy: Google anonymizes rare rows, so the daily
      // totals stay authoritative while the breakdowns are only comparable
      // within themselves. The cursor is part of every key, so a restated day
      // has to replace the loaded rows rather than lose to an equal cursor.
      ...(
        [
          [source.searchAnalyticsDaily, 'raw_search_daily'],
          [source.searchAnalyticsQueries, 'raw_search_queries_daily'],
          [source.searchAnalyticsPages, 'raw_search_pages_daily'],
        ] as const
      ).map(
        ([stream, table]) =>
          new Copy(stream, destination.table(table), {
            id: `${stream.name}:${siteUrl}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            dedupPolicy: 'replace',
            cursorField: 'date',
            primaryKey: [...stream.primaryKey],
          }),
      ),
      // The country and device split carries no date, so it is a trailing
      // view that is replaced whole rather than resumed.
      new Copy(
        source.searchAnalyticsCountries,
        destination.table('raw_search_countries'),
      ),
      new Copy(source.urlInspection, destination.table('raw_url_inspection')),
      new Copy(
        source.urlInspectionSitemaps,
        destination.table('raw_url_inspection_sitemaps'),
      ),
      new Copy(
        source.urlInspectionReferrers,
        destination.table('raw_url_inspection_referrers'),
      ),
    ],
  });

  const results = await pipeline.run();
  console.table(
    results.map(({ copy, count }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
    })),
  );
  console.log(`Loaded Search Console for ${siteUrl} into ${path}`);
  using database = new DatabaseSync(path, { readOnly: true });
  // Query rows never add up to the daily totals, because Google withholds
  // rare queries. Showing both is the point of keeping the grains apart.
  console.table(
    database
      .prepare(`
      SELECT
        totals.date,
        totals.clicks AS total_clicks,
        totals.impressions AS total_impressions,
        coalesce(sum(queries.clicks), 0) AS query_clicks,
        coalesce(sum(queries.impressions), 0) AS query_impressions
      FROM raw_search_daily AS totals
      LEFT JOIN raw_search_queries_daily AS queries ON queries.date = totals.date
      WHERE totals.searchType = 'WEB'
      GROUP BY totals.date, totals.clicks, totals.impressions
      ORDER BY totals.date DESC
      LIMIT 10
    `)
      .all(),
  );
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
