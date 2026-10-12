import type { Partition } from '@workspace/elt';

import { ListingStream } from '../listing-stream.ts';
import type { SearchConsoleScan } from '../search-console-scan.ts';
import {
  instant,
  searchConsoleFields,
  siteUrl,
} from '../search-console-stream.ts';

const {
  id,
  nullableText,
  nullableTimestamp,
  boolean,
  ordinal,
  nullableOrdinal,
} = searchConsoleFields;

const properties = {
  siteUrl,
  path: { ...id, description: 'The sitemap URL.' },
  type: {
    ...nullableText,
    description:
      'The format Google read the sitemap as: sitemap, rssFeed, atomFeed, urlList or patternSitemap.',
  },
  lastSubmitted: {
    ...nullableTimestamp,
    description: 'When the sitemap was last submitted to Google.',
  },
  lastDownloaded: {
    ...nullableTimestamp,
    description:
      'When Google last downloaded the sitemap; NULL until Google downloads it the first time.',
  },
  isPending: {
    ...boolean,
    description: 'True while Google has not processed the sitemap yet.',
  },
  isSitemapsIndex: {
    ...boolean,
    description: 'True when the sitemap lists other sitemaps, not pages.',
  },
  warnings: {
    ...ordinal,
    description: 'How many warnings Google reported for the sitemap.',
  },
  errors: {
    ...ordinal,
    description: 'How many errors Google reported for the sitemap.',
  },
  urlsRead: {
    ...nullableOrdinal,
    description:
      'How many page URLs this connector read from the file itself, through the sitemaps it indexes; NULL when readError is set.',
  },
  readError: {
    ...nullableText,
    description:
      'Why this connector could not read the file, such as an HTTP status or a format error; NULL when it read the file.',
  },
};

export class SitemapsStream extends ListingStream {
  constructor() {
    super({
      name: 'sitemaps',
      description:
        'One record per sitemap that a configured property submitted to Google, with Google’s report on it and what this connector read from the file. Primary key siteUrl, path. An incremental read deletes a sitemap that the property no longer lists.',
      properties,
      primaryKey: ['siteUrl', 'path'],
      partitionKey: ['siteUrl'],
    });
  }

  protected async list(
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]> {
    const siteUrl = this.siteUrl(partition);
    const sitemaps = await scan.sitemaps(siteUrl, signal);
    const reads = await scan.sitemapReads(siteUrl, signal);
    return sitemaps.map((sitemap) => {
      const read = reads.get(sitemap.path);
      if (read === undefined)
        throw new TypeError(
          `Search Console listed sitemap ${sitemap.path}, which was not read`,
        );
      return {
        siteUrl,
        path: sitemap.path,
        type: sitemap.type,
        lastSubmitted: instant(sitemap.lastSubmitted),
        lastDownloaded: instant(sitemap.lastDownloaded),
        isPending: sitemap.isPending,
        isSitemapsIndex: sitemap.isSitemapsIndex,
        // int64 counts arrive as decimal strings.
        warnings: Number(sitemap.warnings),
        errors: Number(sitemap.errors),
        urlsRead: read.urls === null ? null : read.urls.length,
        readError: read.error,
      };
    });
  }
}
