import { XMLValidator } from 'fast-xml-parser';
import {
  detectAtomFeed,
  detectJsonFeed,
  detectRdfFeed,
  detectRssFeed,
  parseAtomFeed,
  parseJsonFeed,
  parseRdfFeed,
  parseRssFeed,
} from 'feedsmith';

import { type SitemapListing, parseSitemap } from '@workspace/codec-sitemap';

export const paginationLinks = [
  'next',
  'prev',
  'prev-archive',
  'next-archive',
].map((rel) => ({ rel }));

export function readListing(text: string): SitemapListing {
  if (detectJsonFeed(text)) {
    const feed = parseJsonFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.url === undefined ? [] : [{ url: item.url, lastModified: null }],
      ),
      sitemaps: feed.next_url === undefined ? [] : [feed.next_url],
    };
  }
  if (detectRdfFeed(text)) {
    // Feedsmith parses RDF without asking its XML parser to validate it.
    const valid = XMLValidator.validate(text);
    if (valid !== true) throw new Error(valid.err.msg);
    const feed = parseRdfFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.link === undefined ? [] : [{ url: item.link, lastModified: null }],
      ),
      sitemaps: [],
    };
  }
  const listing = parseSitemap(text);
  const links = detectAtomFeed(text)
    ? parseAtomFeed(text).links
    : detectRssFeed(text)
      ? parseRssFeed(text).atom?.links
      : undefined;
  return {
    ...listing,
    sitemaps: [
      ...listing.sitemaps,
      ...(links ?? []).flatMap((link) =>
        link.href !== undefined &&
        link.rel !== undefined &&
        ['next', 'prev', 'prev-archive', 'next-archive'].includes(link.rel)
          ? [link.href]
          : [],
      ),
    ],
  };
}
