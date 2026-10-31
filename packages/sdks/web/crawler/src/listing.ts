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

/**
 * A listing: its pages, the sitemaps that a sitemap index lists, the other
 * pages of a feed, whether it is a feed, and for a feed the time its items
 * cover, which it rolls off later.
 */
type Listing = SitemapListing & {
  readonly pagination: readonly string[];
  readonly feed: boolean;
  readonly span: number | null;
};

export function readListing(text: string): Listing {
  if (detectJsonFeed(text)) {
    const feed = parseJsonFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.url === undefined
          ? []
          : [
              {
                url: item.url,
                lastModified: item.date_modified ?? null,
                published: item.date_published ?? null,
                title: item.title ?? null,
              },
            ],
      ),
      sitemaps: [],
      pagination: feed.next_url === undefined ? [] : [feed.next_url],
      feed: true,
      span: span(
        (feed.items ?? []).map(
          (item) => item.date_published ?? item.date_modified,
        ),
      ),
    };
  }
  if (detectRdfFeed(text)) {
    // Feedsmith parses RDF without asking its XML parser to validate it.
    const valid = XMLValidator.validate(text);
    if (valid !== true) throw new Error(valid.err.msg);
    const feed = parseRdfFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.link === undefined
          ? []
          : [
              {
                url: item.link,
                lastModified: null,
                published: null,
                title: item.title ?? null,
              },
            ],
      ),
      sitemaps: [],
      pagination: [],
      feed: true,
      span: null,
    };
  }
  const listing = parseSitemap(text);
  const atom = detectAtomFeed(text) ? parseAtomFeed(text) : undefined;
  const rss =
    atom === undefined && detectRssFeed(text) ? parseRssFeed(text) : undefined;
  const links = atom?.links ?? rss?.atom?.links;
  return {
    ...listing,
    pagination: (links ?? []).flatMap((link) =>
      link.href !== undefined &&
      link.rel !== undefined &&
      paginationLinks.some(({ rel }) => rel === link.rel)
        ? [link.href]
        : [],
    ),
    feed: atom !== undefined || rss !== undefined,
    span: span(
      atom
        ? (atom.entries ?? []).map((entry) => entry.published ?? entry.updated)
        : (rss?.items ?? []).map((item) => item.pubDate),
    ),
  };
}

// From the oldest publication date to the newest; null with fewer than two dates, as a sitemap has.
function span(dates: readonly (string | undefined)[]): number | null {
  const times = dates.flatMap((date) => {
    const time = date === undefined ? Number.NaN : Date.parse(date);
    return Number.isNaN(time) ? [] : [time];
  });
  return times.length < 2 ? null : Math.max(...times) - Math.min(...times);
}
