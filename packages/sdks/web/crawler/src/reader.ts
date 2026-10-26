import { MIMEType } from 'node:util';

import type { Response } from 'got';
import sniffHtmlEncoding from 'html-encoding-sniffer';
import type { z } from 'zod';

export type PageLocation = {
  readonly url: string;
  /** Final URL of the response that first named this URL. */
  readonly listingUrl: string;
  /** Raw sitemap lastmod, never a publication date. */
  readonly lastModified: string | null;
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
};

/**
 * How soon the crawl downloads a finding. Listings go first; the other levels
 * share the downloads by weight, so archive backfill never blocks new pages.
 */
export const priorities = ['listing', 'page', 'link', 'backfill'] as const;
export type Priority = (typeof priorities)[number];

/** One URL a reader found in a response. */
export type Finding<Note> = {
  readonly url: string;
  readonly lastModified: string | null;
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
  abstract read(
    visit: Visit<Note>,
    state: State,
  ): Promise<readonly Finding<Note>[]> | readonly Finding<Note>[];
}
