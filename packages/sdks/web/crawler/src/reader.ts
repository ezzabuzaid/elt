import { MIMEType } from 'node:util';

import type { Response } from 'got';
import sniffHtmlEncoding from 'html-encoding-sniffer';
import type { z } from 'zod';

export type PageLocation = {
  readonly url: string;
  /** Final URL of the response that first named this URL. */
  readonly listingUrl: string;
  /** Raw modification hint of the listing, such as a sitemap lastmod or an Atom updated; never a publication date. */
  readonly lastModified: string | null;
  /** When the listing says the page was published, such as an RSS pubDate or an Atom published, in ISO 8601 UTC. */
  readonly published: string | null;
};

/** A URL in the crawl, as every reader sees it. */
export type CrawlRequest = PageLocation & {
  /** Ordinary links followed from a starting page or a listed page. */
  readonly hops: number;
  /** One of the URLs the crawl started from. */
  readonly start: boolean;
  /** The caller gets this URL back as a page. */
  readonly page: boolean;
  /** Some reader found the URL as a list of pages, such as an archive. */
  readonly list: boolean;
  /**
   * How readers expand the URL: look for URLs that no response names, such as
   * its links and its origin's robots.txt. 'origin' is a starting URL, whose
   * origin readers expand within their limits. 'step' is a page that a list
   * hands back on an origin that no starting URL names: readers find its links
   * on every origin, and the crawl keeps only what matches its expand patterns.
   */
  readonly expand: 'origin' | 'step' | null;
};

/**
 * How soon the crawl downloads a finding. Listings go first; the other levels
 * share the downloads by weight, so archive backfill never blocks new pages.
 */
export const priorities = ['listing', 'page', 'link', 'backfill'] as const;
export type Priority = (typeof priorities)[number];

/**
 * How a response named a URL, from the most specific way to the least, for a
 * URL that one response names in more than one way:
 * - 'list-item': a page that a list hands back, such as a row of a list on GitHub.
 * - 'pagination': another page of the same list, feed or sitemap.
 * - 'archive': an archive that a page links, which is a list.
 * - 'declaration': a feed or a sitemap that a page declares in a `<link>`, a `Link` header or a feed label.
 * - 'robots': the robots.txt of the origin of a page that the crawl expands.
 * - 'robots-sitemap': a sitemap that a robots.txt names.
 * - 'sitemap-guess': the /sitemap.xml that the crawl tries when a robots.txt names no sitemap.
 * - 'sitemap-index': a sitemap that a sitemap index lists.
 * - 'sitemap-entry': a page that a sitemap or a text list of URLs lists.
 * - 'feed-item': a page that an item of a feed links.
 * - 'link': an ordinary link of an HTML or Markdown page.
 * - 'redirect': the URL that a request was redirected to.
 */
export const routeHows = [
  'list-item',
  'pagination',
  'archive',
  'declaration',
  'robots',
  'robots-sitemap',
  'sitemap-guess',
  'sitemap-index',
  'sitemap-entry',
  'feed-item',
  'link',
  'redirect',
] as const;
export type RouteHow = (typeof routeHows)[number];

/** How a response named a URL, and the text it named the URL with. */
export type Naming = {
  readonly how: RouteHow;
  /** The anchor text of an HTML or Markdown link or list item, or the title of a feed item; null when the response gives none, as for a sitemap entry. */
  readonly text: string | null;
};

/** One URL that a listing named: the edge "listing L named URL U" of the crawl. */
export type Route = Naming & { readonly url: string };

/** One URL a reader found in a response. */
export type Finding<Note> = {
  readonly url: string;
  /** How the response names the URL; null when it does not name it, as StartReader hands back the starting URL itself. */
  readonly naming: Naming | null;
  readonly lastModified: string | null;
  readonly published: string | null;
  /** False for a document only a reader reads, such as a sitemap. */
  readonly page: boolean;
  /**
   * An HTML page that lists pages, such as an archive. Only the reader that
   * finds the URL knows this; readers of lists read it from the request.
   */
  readonly list: boolean;
  /** Found through a link: one more hop, and a listing's provenance replaces it. */
  readonly linked: boolean;
  /** Failure statuses that are ordinary answers rather than errors. */
  readonly tolerate: readonly number[] | 'any';
  /** The finding reader's own record of why it wants the response. */
  readonly note: Note | null;
  readonly priority: Priority;
};

/** The text of an anchor as a reader of the page sees it, with its white space collapsed; null when it has none, such as a logo. */
export function anchorText(anchor: Element) {
  return anchor.textContent.replace(/\s+/g, ' ').trim() || null;
}

export function isHtml(type: string | null) {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/**
 * The text of an HTML or Markdown page, decoded by its byte order mark, its
 * Content-Type charset or its <meta charset>, in that order (the WHATWG
 * encoding sniffing algorithm). An unlabeled page is read as UTF-8, and bytes
 * that do not decode become U+FFFD rather than failing the page.
 */
export function pageText(response: Response) {
  const contentType = response.headers['content-type'];
  const charset =
    contentType === undefined
      ? undefined
      : (new MIMEType(contentType).params.get('charset') ?? undefined);
  return new TextDecoder(
    sniffHtmlEncoding(response.rawBody, {
      transportLayerEncodingLabel: charset,
      defaultEncoding: 'UTF-8',
    }),
  ).decode(response.rawBody);
}

export type Visit<Note> = {
  readonly response: Response;
  readonly headers: Headers;
  /** The response's media type, lowercase and without parameters. */
  readonly type: string | null;
  readonly request: CrawlRequest;
  /** This reader's note for the URL, if it found the URL itself. */
  readonly note: Note | null;
  /** This reader asked for the download through wants(). */
  readonly wanted: boolean;
  /**
   * The response says that its URL must be visited again within this many
   * milliseconds, whatever the revisit policy, such as a feed that would
   * otherwise roll items off before the next visit.
   */
  revisitWithin(within: number): void;
};

/**
 * One kind of thing to find in a response. The crawler downloads; a reader
 * reads one response at a time and returns what it found. Its per-crawl state
 * and notes are plain data, so a snapshot can carry them.
 */
export abstract class Reader<Note, State> {
  abstract readonly notes: z.ZodType<Note>;
  abstract readonly states: z.ZodType<State>;
  abstract open(): State;
  /** Whether a page that nobody else needs is worth downloading for this reader. */
  abstract wants(request: CrawlRequest, state: State): boolean;
  /**
   * What the reader found in the response, or null when it skips a response
   * that it reads at other times, such as a linked page past its limits: the
   * response then names more than the findings of this read.
   */
  abstract read(
    visit: Visit<Note>,
    state: State,
  ): Promise<readonly Finding<Note>[] | null> | readonly Finding<Note>[] | null;
}
