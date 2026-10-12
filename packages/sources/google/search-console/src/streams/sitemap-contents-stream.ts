import type { Partition } from '@workspace/elt';

import { ListingStream } from '../listing-stream.ts';
import type { SearchConsoleScan } from '../search-console-scan.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const { id, text, ordinal, nullableOrdinal } = searchConsoleFields;

const properties = {
  siteUrl,
  sitemapPath: { ...id, description: 'The sitemap URL (sitemaps.path).' },
  type: {
    ...text,
    description:
      'The kind of URLs counted: web, image, video, news, mobile, androidApp and so on.',
  },
  submitted: {
    ...ordinal,
    description: 'How many URLs of this kind the sitemap lists.',
  },
  indexed: {
    ...nullableOrdinal,
    description:
      'How many URLs of this kind Google reports as indexed; NULL when Google sends no count. Google deprecated this count and reports 0.',
  },
};

export class SitemapContentsStream extends ListingStream {
  constructor() {
    super({
      name: 'sitemapContents',
      description:
        'One record per kind of URL in a submitted sitemap, with how many the sitemap lists. Primary key siteUrl, sitemapPath, type. An incremental read deletes a record that Google no longer reports.',
      properties,
      primaryKey: ['siteUrl', 'sitemapPath', 'type'],
      partitionKey: ['siteUrl'],
    });
  }

  protected async list(
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]> {
    const siteUrl = this.siteUrl(partition);
    return (await scan.sitemaps(siteUrl, signal)).flatMap(
      ({ path, contents = [] }) =>
        contents.map((content) => ({
          siteUrl,
          sitemapPath: path,
          type: content.type,
          submitted: Number(content.submitted),
          indexed:
            content.indexed === undefined ? null : Number(content.indexed),
        })),
    );
  }
}
