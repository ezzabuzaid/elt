import type { z } from 'zod';

import type { CrawlRequest } from './reader.ts';

export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;

/** What a download found, by the body digest: unknown when the crawl has no earlier body to compare. */
export type Change = 'modified' | 'unmodified' | 'unknown';

/** What one visit of a URL ended with. Gone is a 404 or 410 answer. */
export type Outcome = Change | 'failed' | 'gone';

export type Revisit = {
  readonly request: CrawlRequest;
  readonly outcome: Outcome;
  /** The response headers, or null when no response came. */
  readonly headers: Headers | null;
  /** When the crawl that made the visit started, so a URL due at the next crawl's start is not missed by seconds. */
  readonly at: number;
};

/** When a URL is due again (null: never), and the policy's plain-data history of it. */
export type Schedule<History> = {
  readonly due: number | null;
  readonly history: History | null;
};

/** A known URL's schedule, with the lastModified hint its listing gave at the last visit. */
export type Known<History> = Schedule<History> & {
  readonly lastModified: string | null;
};

/**
 * When a known URL is requested again, across crawls. The crawler detects
 * change and stores each URL's schedule; a policy decides only when the URL
 * is due. Its history is plain data, so the crawl memento can carry it.
 */
export abstract class RevisitPolicy<History> {
  abstract readonly histories: z.ZodType<History>;
  /** How long a failed URL waits, as StormCrawler's fetchInterval.fetch.error. */
  protected readonly retryAfter: number = 2 * hour;
  /**
   * How long a gone URL waits. A listing can still name a page that answers
   * 404 and comes back later, so it is asked again, as Nutch's
   * setPageGoneSchedule does, not never, as StormCrawler's default does.
   */
  protected readonly goneAfter: number = day;

  /** After a visit. */
  schedule(revisit: Revisit, history: History | null): Schedule<History> {
    if (revisit.outcome === 'failed')
      return { due: revisit.at + this.retryAfter, history };
    if (revisit.outcome === 'gone')
      return { due: revisit.at + this.goneAfter, history };
    return this.visited({ ...revisit, outcome: revisit.outcome }, history);
  }

  /**
   * Whether a known URL is due in the crawl that starts at `at`. A listing
   * that gives a lastModified other than at the last visit says the page
   * changed, so it is due at once.
   */
  due(request: CrawlRequest, known: Known<History>, at: number): boolean {
    return (
      (known.due !== null && known.due <= at) ||
      (request.lastModified !== null &&
        request.lastModified !== known.lastModified)
    );
  }

  /** After a download that succeeded. */
  protected abstract visited(
    revisit: Revisit & { readonly outcome: Change },
    history: History | null,
  ): Schedule<History>;
}
