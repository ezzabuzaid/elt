import type { UrlInspection } from '@workspace/sdk-google-search-console';

import {
  type InspectionOptions,
  InspectionStream,
  inspectionUrlField,
} from '../inspection-stream.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const { text, ordinal } = searchConsoleFields;

const properties = {
  siteUrl,
  inspectionUrl: inspectionUrlField,
  position: {
    ...ordinal,
    description: 'The place of the entry in Google’s list, from 0.',
  },
  sitemap: {
    ...text,
    description: 'A sitemap URL that lists the page, as Google reports it.',
  },
};

export class UrlInspectionSitemapsStream extends InspectionStream {
  constructor(options: InspectionOptions) {
    super(
      {
        name: 'urlInspectionSitemaps',
        description:
          'One record per sitemap that Google says lists an inspected URL, in Google’s order, from the URL’s last inspection. Primary key siteUrl, inspectionUrl, position. A record is deleted when a later inspection lists fewer sitemaps, and when every sitemap could be read, none lists the URL, and the search analytics no longer show it.',
        properties,
        primaryKey: ['siteUrl', 'inspectionUrl', 'position'],
        partitionKey: ['siteUrl'],
      },
      options,
    );
  }

  protected rows(
    siteUrl: string,
    { inspectionUrl, result }: UrlInspection,
  ): Record<string, unknown>[] {
    return (result?.indexStatusResult?.sitemap ?? []).map(
      (sitemap, position) => ({ siteUrl, inspectionUrl, position, sitemap }),
    );
  }
}
