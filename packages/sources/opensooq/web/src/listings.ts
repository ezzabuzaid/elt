import { PaginationReader } from '@workspace/sdk-web-crawler';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { OpenSooqExtractor } from './opensooq-extractor.ts';

/** The listings of the category pages given as inputs, following each category's rel="next" pagination. */
export const listings = new WebStream({
  name: 'opensooq_listings',
  primaryKey: ['id'],
  // Not ListingReader: OpenSooq's robots.txt lists the sitemaps of 20 country sites.
  // Not ArchiveReader: OpenSooq has no year archives, and a year filter such as /en/cars/motorcycles/2024 is not one.
  readers: [new PaginationReader()],
  include: [new URLPattern({ pathname: '/:lang/search/*' })],
  extractor: new OpenSooqExtractor(),
});
