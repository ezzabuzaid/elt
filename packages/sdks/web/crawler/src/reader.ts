import type { Response } from 'got';
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
};

/** One URL a reader found in a response. */
export type Finding<Note> = {
  readonly url: string;
  readonly lastModified: string | null;
  /** False for a document only a reader reads, such as a sitemap. */
  readonly page: boolean;
  /** Found through a link: one more hop, and a listing's provenance replaces it. */
  readonly linked: boolean;
  /** Failure statuses that are ordinary answers rather than errors. */
  readonly tolerate: readonly number[] | 'any';
  /** The finding reader's own record of why it wants the response. */
  readonly note: Note | null;
};

export function isHtml(type: string | null) {
  return type === 'text/html' || type === 'application/xhtml+xml';
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
