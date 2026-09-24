import { searchConsoleTables as tables } from '../sources/search-console/search-console-copies.ts';
import { quote, type Sql } from './warehouse.ts';

type View = {
  readonly name: string;
  readonly description: string;
  readonly select: (raw: string) => string;
  readonly columns: Readonly<Record<string, string>>;
};

const site = 'The Search Console property, e.g. sc-domain:example.com.';
const date =
  'Calendar day in Pacific Time, as Search Console reports it. Not UTC.';
const settled =
  'False while Google may still restate the day (the last two or three days). Prefer settled days for comparisons.';
const loadedAt = 'When this row was last loaded from Google.';
const clicks =
  'Clicks. Additive. Click-through rate over any rows is sum(clicks)::float / nullif(sum(impressions), 0).';
const impressions = 'Impressions. Additive.';
const rankedImpressions =
  'Impressions that had a rank. 0 for Discover and Google News, which do not rank. Additive.';
const positionWeight =
  'Rank times impressions. Average rank over any rows is sum(position_weight) / nullif(sum(ranked_impressions), 0); 1 is the top result.';

// Per-row rates and ranks are left out: averaging them is the classic error,
// and additive columns make the correct ratio the only one expressible.
const measures = `clicks, impressions, CASE WHEN position IS NULL THEN 0 ELSE impressions END AS ranked_impressions, coalesce(position * impressions, 0) AS position_weight`;
const pagePath =
  'The page URL path without host, query or fragment; / for the root. Use it to match pages across sources.';

// Each breakdown row a re-read no longer returns keeps its older load time;
// only the latest load of a day is what Google reports now.
const latestLoad = (table: string) =>
  `(SELECT *, max(loaded_at) OVER (PARTITION BY "siteUrl", "date") AS latest_load FROM ${table}) AS loaded WHERE loaded_at = latest_load`;

const views: readonly View[] = [
  {
    name: 'search_console_properties',
    description:
      'Search Console properties the grant can read. Every other search_console view is keyed by site_url.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "permissionLevel" AS permission_level, loaded_at FROM ${raw}.${quote(tables.sites)}`,
    columns: {
      site_url: site,
      permission_level:
        'The grant’s access: siteOwner, siteFullUser or siteRestrictedUser.',
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_totals_daily',
    description:
      'Authoritative daily totals per property and search type, over 16 months. The only source for site totals: query and page breakdowns omit anonymized traffic.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "date", "searchType" AS search_type, ${measures}, settled, loaded_at FROM ${raw}.${quote(tables.searchAnalyticsDaily)}`,
    columns: {
      site_url: site,
      date,
      search_type:
        'Report: WEB, IMAGE, VIDEO, NEWS, DISCOVER or GOOGLE_NEWS. Filter to one; they are separate audiences, not parts of a whole.',
      clicks,
      impressions,
      ranked_impressions: rankedImpressions,
      position_weight: positionWeight,
      settled,
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_queries_daily',
    description:
      'Web clicks and impressions per search query and day. Google withholds rare queries, so these rows never add up to search_console_totals_daily; see search_console_withheld_daily for how much is missing.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "date", query, ${measures}, settled, loaded_at FROM ${latestLoad(`${raw}.${quote(tables.searchAnalyticsQueries)}`)}`,
    columns: {
      site_url: site,
      date,
      query: 'The search query as users typed it.',
      clicks,
      impressions,
      ranked_impressions: rankedImpressions,
      position_weight: positionWeight,
      settled,
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_pages_daily',
    description:
      'Web clicks and impressions per landing page and day. Counted per page, so they do not add up to search_console_totals_daily either.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "date", page, marts._url_path(page) AS page_path, ${measures}, settled, loaded_at FROM ${latestLoad(`${raw}.${quote(tables.searchAnalyticsPages)}`)}`,
    columns: {
      site_url: site,
      date,
      page: 'The full page URL Google showed.',
      page_path: pagePath,
      clicks,
      impressions,
      ranked_impressions: rankedImpressions,
      position_weight: positionWeight,
      settled,
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_withheld_daily',
    description:
      'Per property and day, web totals next to the sum of query rows, and the difference Google withheld as anonymized queries. For a share over a period, divide sums: sum(withheld_clicks) / sum(total_clicks).',
    select: () => `SELECT totals.site_url, totals."date",
        totals.clicks AS total_clicks, totals.impressions AS total_impressions,
        coalesce(queries.clicks, 0) AS query_clicks, coalesce(queries.impressions, 0) AS query_impressions,
        totals.clicks - coalesce(queries.clicks, 0) AS withheld_clicks,
        totals.impressions - coalesce(queries.impressions, 0) AS withheld_impressions,
        totals.settled
      FROM marts.search_console_totals_daily AS totals
      LEFT JOIN (
        SELECT site_url, "date", sum(clicks)::bigint AS clicks, sum(impressions)::bigint AS impressions
        FROM marts.search_console_queries_daily GROUP BY site_url, "date"
      ) AS queries USING (site_url, "date")
      WHERE totals.search_type = 'WEB'`,
    columns: {
      site_url: site,
      date,
      total_clicks: 'Web clicks in the daily totals.',
      total_impressions: 'Web impressions in the daily totals.',
      query_clicks: 'Sum of clicks over the reported query rows.',
      query_impressions: 'Sum of impressions over the reported query rows.',
      withheld_clicks: 'Clicks on queries Google did not report.',
      withheld_impressions: 'Impressions on queries Google did not report.',
      settled,
    },
  },
  {
    name: 'search_console_countries',
    description:
      'Web clicks and impressions per country and device over one trailing window (start_date to end_date), replaced on every load. Not daily.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, country, device, "startDate" AS start_date, "endDate" AS end_date, ${measures}, loaded_at FROM ${raw}.${quote(tables.searchAnalyticsCountries)}`,
    columns: {
      site_url: site,
      country: 'ISO 3166-1 alpha-3 country code, lower case (usa, gbr).',
      device: 'DESKTOP, MOBILE or TABLET.',
      start_date: 'First Pacific Time day of the window.',
      end_date: 'Last Pacific Time day of the window.',
      clicks,
      impressions,
      ranked_impressions: rankedImpressions,
      position_weight: positionWeight,
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_sitemaps',
    description: 'Sitemaps submitted for each property and their status.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, path, type, "lastSubmitted" AS last_submitted, "lastDownloaded" AS last_downloaded, "isPending" AS is_pending, "isSitemapsIndex" AS is_sitemaps_index, warnings, errors, loaded_at FROM ${raw}.${quote(tables.sitemaps)}`,
    columns: {
      site_url: site,
      path: 'The sitemap URL.',
      type: 'sitemap, rssFeed, atomFeed, urlList or patternSitemap.',
      last_submitted: 'When the sitemap was last submitted.',
      last_downloaded: 'When Google last downloaded it.',
      is_pending: 'Whether Google has yet to process it.',
      is_sitemaps_index: 'Whether it lists other sitemaps.',
      warnings: 'Warnings Google reported for it.',
      errors: 'Errors Google reported for it.',
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_sitemap_contents',
    description:
      'Per sitemap and content type, how many URLs were submitted and indexed.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "sitemapPath" AS sitemap_path, type, submitted, indexed, loaded_at FROM ${raw}.${quote(tables.sitemapContents)}`,
    columns: {
      site_url: site,
      sitemap_path: 'The sitemap URL, as in search_console_sitemaps.path.',
      type: 'Content type: web, image, video, news, mobile, androidApp…',
      submitted: 'URLs of this type the sitemap lists.',
      indexed: 'URLs of this type Google indexed, NULL when not reported.',
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_url_inspection',
    description:
      'Google’s index status for the pages with the most recent impressions, one row per inspected URL.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "inspectionUrl" AS inspection_url, marts._url_path("inspectionUrl") AS page_path, verdict, "coverageState" AS coverage_state, "robotsTxtState" AS robots_txt_state, "indexingState" AS indexing_state, "pageFetchState" AS page_fetch_state, "crawledAs" AS crawled_as, "googleCanonical" AS google_canonical, "userCanonical" AS user_canonical, "lastCrawlTime" AS last_crawl_time, "inspectionResultLink" AS inspection_result_link, "mobileUsabilityVerdict" AS mobile_usability_verdict, "richResultsVerdict" AS rich_results_verdict, "ampVerdict" AS amp_verdict, loaded_at FROM ${raw}.${quote(tables.urlInspection)}`,
    columns: {
      site_url: site,
      inspection_url: 'The inspected page URL.',
      page_path: pagePath,
      verdict: 'PASS, PARTIAL, FAIL or NEUTRAL for the page overall.',
      coverage_state:
        'Google’s index coverage explanation, e.g. "Submitted and indexed".',
      robots_txt_state: 'Whether robots.txt allows crawling.',
      indexing_state: 'Whether indexing is allowed by meta tags or headers.',
      page_fetch_state: 'Result of Google’s last fetch.',
      crawled_as: 'DESKTOP or MOBILE crawler.',
      google_canonical: 'The canonical URL Google chose.',
      user_canonical: 'The canonical URL the page declares.',
      last_crawl_time: 'When Google last crawled the page.',
      inspection_result_link: 'Link to the report in Search Console.',
      mobile_usability_verdict: 'Mobile usability verdict.',
      rich_results_verdict: 'Rich results verdict.',
      amp_verdict: 'AMP verdict.',
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_url_inspection_sitemaps',
    description: 'Sitemaps that list each inspected URL, per Google.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "inspectionUrl" AS inspection_url, position AS list_position, sitemap, loaded_at FROM ${raw}.${quote(tables.urlInspectionSitemaps)}`,
    columns: {
      site_url: site,
      inspection_url: 'The inspected page URL.',
      list_position: 'Order in Google’s list, from 0.',
      sitemap: 'A sitemap URL listing the page.',
      loaded_at: loadedAt,
    },
  },
  {
    name: 'search_console_url_inspection_referrers',
    description: 'Pages Google found linking to each inspected URL.',
    select: (raw) =>
      `SELECT "siteUrl" AS site_url, "inspectionUrl" AS inspection_url, position AS list_position, "referringUrl" AS referring_url, loaded_at FROM ${raw}.${quote(tables.urlInspectionReferrers)}`,
    columns: {
      site_url: site,
      inspection_url: 'The inspected page URL.',
      list_position: 'Order in Google’s list, from 0.',
      referring_url: 'A URL linking to the page.',
      loaded_at: loadedAt,
    },
  },
];

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * Search Console's marts over the raw tables elt loaded into `raw`. The
 * calculations the data needs to be read correctly live in the views, so a
 * reader sums additive columns and cannot average a rate or a rank. Run after installWarehouse
 * and after the raw tables exist; it replaces its own views every time.
 */
export async function installSearchConsoleMarts(
  sql: Sql,
  { raw, reader }: { raw: string; reader: string },
): Promise<void> {
  const schema = quote(raw);
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout = '35s'`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('mac-elt:marts', 0))`;
    // Dependents first. No CASCADE: a view another connector built on these
    // fails the install loudly instead of disappearing.
    for (const view of [...views].reverse())
      await transaction.unsafe(`DROP VIEW IF EXISTS marts.${quote(view.name)}`);
    for (const statement of [
      ...views.flatMap((view) => [
        `CREATE VIEW marts.${quote(view.name)} AS ${view.select(schema)}`,
        `COMMENT ON VIEW marts.${quote(view.name)} IS ${literal(view.description)}`,
        ...Object.entries(view.columns).map(
          ([column, description]) =>
            `COMMENT ON COLUMN marts.${quote(view.name)}.${quote(column)} IS ${literal(description)}`,
        ),
        `GRANT SELECT ON marts.${quote(view.name)} TO ${quote(reader)}`,
      ]),
      'SELECT marts._refresh_freshness()',
    ])
      await transaction.unsafe(statement);
  });
}
