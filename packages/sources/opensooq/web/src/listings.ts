import { ArchiveReader } from '@workspace/sdk-web-crawler';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { OpenSooqExtractor } from './opensooq-extractor.ts';

/** The listings of the category pages given as inputs, following each category's rel="next" pagination. */
export const listings = new WebStream({
  name: 'opensooq_listings',
  primaryKey: ['id'],
  // Not ListingReader: OpenSooq's robots.txt lists the sitemaps of 20 country sites.
  // Inputs are categories, and a category with few listings has no pagination to mark it as one.
  readers: [new ArchiveReader({ starts: 'archives' })],
  include: [new URLPattern({ pathname: '/:lang/search/*' })],
  extractor: new OpenSooqExtractor(),
});
