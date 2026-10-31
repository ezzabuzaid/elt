import {
  AlwaysRevisit,
  CompositeRevisit,
  OnceRevisit,
  PaginationReader,
} from '@workspace/sdk-web-crawler';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { OpenSooqExtractor } from './opensooq-extractor.ts';

const listingPage = new URLPattern({ pathname: '/:lang/search/*' });

/** The listings of the category pages given as inputs, following each category's rel="next" pagination. */
export const listings = new WebStream({
  name: 'opensooq_listings',
  primaryKey: ['id'],
  // Not ListingReader: OpenSooq's robots.txt lists the sitemaps of 20 country sites.
  // Not ArchiveReader: OpenSooq has no year archives, and a year filter such as /en/cars/motorcycles/2024 is not one.
  readers: [new PaginationReader()],
  // A listing is read once; the category pages, where new listings appear,
  // are read in every run. OpenSooq's markup differs on each request, so a
  // body hash would call every page changed and cannot pace either.
  revisit: new CompositeRevisit(
    [[listingPage, new OnceRevisit()]],
    new AlwaysRevisit(),
  ),
  include: [listingPage],
  extractor: new OpenSooqExtractor(),
});
