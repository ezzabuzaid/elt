import { Copy, type Target } from '@workspace/elt';

import type { SearchConsoleSource } from './search-console-source.ts';

// Each stream's table, without any destination's prefix or schema.
export const searchConsoleTables = {
  sites: 'sites',
  sitemaps: 'sitemaps',
  sitemapContents: 'sitemap_contents',
  searchAnalyticsCountries: 'search_countries',
  urlInspection: 'url_inspection',
  urlInspectionSitemaps: 'url_inspection_sitemaps',
  urlInspectionReferrers: 'url_inspection_referrers',
  searchAnalyticsDaily: 'search_daily',
  searchAnalyticsQueries: 'search_queries_daily',
  searchAnalyticsPages: 'search_pages_daily',
} as const;

/**
 * Every Search Console stream as an incremental copy into `table(name)`. One
 * source reads every property as a partition of each stream, so each table
 * has one writer and each property keeps its own checkpoint.
 */
export function searchConsoleCopies<T extends Target>(
  source: SearchConsoleSource,
  table: (name: string) => T,
): Copy<T>[] {
  const tables = searchConsoleTables;
  return [
    // Each read is diffed with the last: a copy writes changes and deletes
    // only the keys the previous snapshot held. The dated analytics resume
    // from the last settled day, and each grain is its own copy: Google
    // anonymizes rare rows, so the daily totals stay authoritative while the
    // breakdowns are only comparable within themselves.
    ...(
      [
        [source.sites, tables.sites],
        [source.sitemaps, tables.sitemaps],
        [source.sitemapContents, tables.sitemapContents],
        [source.searchAnalyticsDaily, tables.searchAnalyticsDaily],
        [source.searchAnalyticsQueries, tables.searchAnalyticsQueries],
        [source.searchAnalyticsPages, tables.searchAnalyticsPages],
        [source.searchAnalyticsCountries, tables.searchAnalyticsCountries],
        [source.urlInspection, tables.urlInspection],
        [source.urlInspectionSitemaps, tables.urlInspectionSitemaps],
        [source.urlInspectionReferrers, tables.urlInspectionReferrers],
      ] as const
    ).map(
      ([stream, name]) =>
        new Copy(stream, table(name), {
          id: stream.name,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    ),
  ];
}
