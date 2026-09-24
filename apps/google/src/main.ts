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
      // Every row carries its property, and each copy id names the property,
      // so several properties' pipelines share these tables. Listings are
      // complete on every read: a copy writes changes and deletes only the
      // keys its own previous snapshot held.
      ...(
        [
          [source.sites, 'raw_sites'],
          [source.sitemaps, 'raw_sitemaps'],
          [source.sitemapContents, 'raw_sitemap_contents'],
          // The country and device split carries no date, so it is a trailing
          // view diffed as a whole rather than resumed.
          [source.searchAnalyticsCountries, 'raw_search_countries'],
          [source.urlInspection, 'raw_url_inspection'],
          [source.urlInspectionSitemaps, 'raw_url_inspection_sitemaps'],
          [source.urlInspectionReferrers, 'raw_url_inspection_referrers'],
        ] as const
      ).map(
        ([stream, table]) =>
          new Copy(stream, destination.table(table), {
            id: `${stream.name}:${siteUrl}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            primaryKey: [...stream.primaryKey],
          }),
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
    ],
  });

  const results = await pipeline.run();
  console.table(
    results.map(({ copy, count, deleted }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
      deleted,
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
      LEFT JOIN raw_search_queries_daily AS queries
        ON queries.siteUrl = totals.siteUrl AND queries.date = totals.date
      WHERE totals.siteUrl = ? AND totals.searchType = 'WEB'
      GROUP BY totals.date, totals.clicks, totals.impressions
      ORDER BY totals.date DESC
      LIMIT 10
    `)
      .all(siteUrl),
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
