import type { KeyValue } from '@workspace/elt';
import type { UrlInspection } from '@workspace/sdk-google-search-console';

import {
  type InspectionOptions,
  InspectionStream,
  inspectionUrlField,
} from '../inspection-stream.ts';
import type { Discovery } from '../rolling-inspection.ts';
import {
  instant,
  searchConsoleFields,
  siteUrl,
} from '../search-console-stream.ts';

const { nullableText, nullableTimestamp, boolean, timestamp, nullableInteger } =
  searchConsoleFields;
const rejected = 'NULL when errorStatus is set or Google did not report it.';

const properties = {
  siteUrl,
  inspectionUrl: inspectionUrlField,
  verdict: {
    ...nullableText,
    description: `Google’s overall verdict on the page in the index: PASS, PARTIAL, FAIL or NEUTRAL. ${rejected}`,
  },
  coverageState: {
    ...nullableText,
    description: `Google’s explanation of the page’s index coverage, such as "Submitted and indexed". ${rejected}`,
  },
  robotsTxtState: {
    ...nullableText,
    description: `Whether robots.txt lets Google crawl the page, such as ALLOWED or DISALLOWED. ${rejected}`,
  },
  indexingState: {
    ...nullableText,
    description: `Whether the page’s meta tags and HTTP headers let Google index it, such as INDEXING_ALLOWED. ${rejected}`,
  },
  pageFetchState: {
    ...nullableText,
    description: `The result of Google’s last fetch of the page, such as SUCCESSFUL or NOT_FOUND. ${rejected}`,
  },
  crawledAs: {
    ...nullableText,
    description: `The crawler Google last used for the page: DESKTOP or MOBILE. ${rejected}`,
  },
  googleCanonical: {
    ...nullableText,
    description: `The canonical URL that Google chose for the page. ${rejected}`,
  },
  userCanonical: {
    ...nullableText,
    description: `The canonical URL that the page declares. ${rejected}`,
  },
  lastCrawlTime: {
    ...nullableTimestamp,
    description: `When Google last crawled the page. ${rejected}`,
  },
  inspectionResultLink: {
    ...nullableText,
    description: `A link to this inspection in Search Console. ${rejected}`,
  },
  mobileUsabilityVerdict: {
    ...nullableText,
    description: `Google’s verdict on how usable the page is on a phone, such as PASS or FAIL. ${rejected}`,
  },
  richResultsVerdict: {
    ...nullableText,
    description: `Google’s verdict on the page’s structured data for rich results, such as PASS or FAIL. ${rejected}`,
  },
  ampVerdict: {
    ...nullableText,
    description: `Google’s verdict on the page’s AMP version, such as PASS or FAIL. ${rejected}`,
  },
  inSitemap: {
    ...boolean,
    description: 'True when a sitemap of the property lists the URL.',
  },
  inSearchAnalytics: {
    ...boolean,
    description:
      'True when the property’s search analytics of the last sixteen months show the URL as a page.',
  },
  inspectedAt: {
    ...timestamp,
    description:
      'When this connector inspected the URL. The URL is inspected again once this is inspectionRefreshHours old.',
  },
  errorStatus: {
    ...nullableInteger,
    description:
      'The HTTP status Google rejected this URL with, such as 400 for a malformed URL; the verdict columns are then NULL. NULL when Google inspected the URL.',
  },
  errorMessage: {
    ...nullableText,
    description:
      'Why Google rejected this URL, in Google’s words. NULL when Google inspected the URL.',
  },
};

export class UrlInspectionStream extends InspectionStream {
  constructor(options: InspectionOptions) {
    super(
      {
        name: 'urlInspection',
        description:
          'One record per URL of a property that this connector inspected: Google’s index status of the page at its last inspection. The URLs are the ones the property’s sitemaps list and the pages its search analytics show. Primary key siteUrl, inspectionUrl. A URL is deleted when every sitemap could be read, none lists it, and the search analytics no longer show it.',
        properties,
        primaryKey: ['siteUrl', 'inspectionUrl'],
        partitionKey: ['siteUrl'],
      },
      options,
    );
  }

  protected rows(
    siteUrl: string,
    { inspectionUrl, inspectedAt, result, error }: UrlInspection,
    { sitemap, search }: Discovery,
  ): Record<string, unknown>[] {
    const status = result?.indexStatusResult;
    return [
      {
        siteUrl,
        inspectionUrl,
        verdict: status?.verdict ?? null,
        coverageState: status?.coverageState ?? null,
        robotsTxtState: status?.robotsTxtState ?? null,
        indexingState: status?.indexingState ?? null,
        pageFetchState: status?.pageFetchState ?? null,
        crawledAs: status?.crawledAs ?? null,
        googleCanonical: status?.googleCanonical ?? null,
        userCanonical: status?.userCanonical ?? null,
        lastCrawlTime: instant(status?.lastCrawlTime),
        inspectionResultLink: result?.inspectionResultLink ?? null,
        mobileUsabilityVerdict: result?.mobileUsabilityResult?.verdict ?? null,
        richResultsVerdict: result?.richResultsResult?.verdict ?? null,
        ampVerdict: result?.ampResult?.verdict ?? null,
        inSitemap: sitemap,
        inSearchAnalytics: search,
        inspectedAt,
        errorStatus: error?.status ?? null,
        errorMessage: error?.message ?? null,
      },
    ];
  }

  // A URL's one row is keyed by the URL alone.
  protected override key(
    siteUrl: string,
    inspectionUrl: string,
  ): Readonly<Record<string, KeyValue>> {
    return { siteUrl, inspectionUrl };
  }
}
