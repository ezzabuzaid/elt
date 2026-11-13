import type { Clock } from '@zukhruf/async';
import { z } from 'zod';

import {
  type GoogleRequester,
  attemptsOf,
  googleRetry,
  reasonsOf,
  statusOf,
} from '@eltjs/google-auth';

const BASE = 'https://searchconsole.googleapis.com/';

/** The daily and per-minute ceilings Search Console applies to URL inspection. */
export const URL_INSPECTION_QUOTA = { perDay: 2000, perMinute: 600 } as const;

/**
 * The API refused the call for quota. Surfaced as its own type so a connector
 * fails the copy instead of loading a silently truncated set of URLs.
 */
export class SearchConsoleQuotaError extends Error {
  override readonly name = 'SearchConsoleQuotaError';
  readonly status: number;
  readonly attempts: number;

  constructor(
    status: number,
    attempts: number,
    message: string,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.status = status;
    this.attempts = attempts;
  }
}

// Google reports some rate limits as 403 with one of these reasons. Every other
// 403, such as an insufficient scope or a disabled API, is not a quota error.
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

export type SearchAnalyticsRequest = {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions?: readonly string[];
  readonly type?: string;
  readonly dataState?: 'FINAL' | 'ALL';
  readonly rowLimit?: number;
  readonly startRow?: number;
  readonly aggregationType?: string;
};

/** The time and the timers of a caller: a host gives globalThis, a test a fake clock that it moves. */
export type SearchConsoleClock = Clock & { readonly Date: { now(): number } };

/** A call stops when signal aborts, and waits its retries on clock. */
export type CallOptions = {
  readonly signal?: AbortSignal;
  readonly clock: SearchConsoleClock;
};

// Response shapes as the API returns them live, parsed at the one place each
// body is read. int64 counts arrive as decimal strings; proto3 omits unset
// fields, such as position on feed reports and the arrays of an inspection
// that has none.
const sitesResponse = z.object({
  siteEntry: z
    .array(z.object({ siteUrl: z.string(), permissionLevel: z.string() }))
    .optional(),
});

const sitemapsResponse = z.object({
  sitemap: z
    .array(
      z.object({
        path: z.string(),
        type: z.string(),
        lastSubmitted: z.string(),
        // Absent until Google has downloaded the sitemap once.
        lastDownloaded: z.string().optional(),
        isPending: z.boolean(),
        isSitemapsIndex: z.boolean(),
        warnings: z.string(),
        errors: z.string(),
        contents: z
          .array(
            z.object({
              type: z.string(),
              submitted: z.string(),
              // Deprecated by Google; live it reports "0" regardless.
              indexed: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const searchAnalyticsResponse = z.object({
  rows: z
    .array(
      z.object({
        keys: z.array(z.string()),
        clicks: z.number(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number().optional(),
      }),
    )
    .optional(),
  metadata: z.object({ firstIncompleteDate: z.string().optional() }).optional(),
});

const verdict = z.object({ verdict: z.string().optional() }).optional();

const inspectionResult = z.object({
  inspectionResultLink: z.string().optional(),
  indexStatusResult: z
    .object({
      verdict: z.string().optional(),
      coverageState: z.string().optional(),
      robotsTxtState: z.string().optional(),
      indexingState: z.string().optional(),
      lastCrawlTime: z.string().optional(),
      pageFetchState: z.string().optional(),
      googleCanonical: z.string().optional(),
      userCanonical: z.string().optional(),
      crawledAs: z.string().optional(),
      sitemap: z.array(z.string()).optional(),
      referringUrls: z.array(z.string()).optional(),
    })
    .optional(),
  mobileUsabilityResult: verdict,
  richResultsResult: verdict,
  ampResult: verdict,
});

export type InspectionResult = z.infer<typeof inspectionResult>;

const inspectResponse = z.object({
  inspectionResult: inspectionResult.optional(),
});

/**
 * The transport for one Search Console property. `sites`, `sitemaps` and
 * `searchAnalytics` still live under the original `webmasters/v3` prefix while
 * URL inspection is served from `v1` on the same host, so the path is modeled
 * per call rather than derived from a single version.
 */
export class SearchConsoleApi {
  readonly #requester: GoogleRequester;

  constructor(requester: GoogleRequester) {
    if (typeof requester?.request !== 'function')
      throw new TypeError('Search Console requires an authenticated requester');
    this.#requester = requester;
    Object.freeze(this);
  }

  async sites(options: CallOptions) {
    return sitesResponse.parse(
      await this.#send('GET', 'webmasters/v3/sites', undefined, options),
    );
  }

  async sitemaps(siteUrl: string, options: CallOptions) {
    return sitemapsResponse.parse(
      await this.#send(
        'GET',
        `webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
        undefined,
        options,
      ),
    );
  }

  async searchAnalytics(
    siteUrl: string,
    request: SearchAnalyticsRequest,
    options: CallOptions,
  ) {
    return searchAnalyticsResponse.parse(
      await this.#send(
        'POST',
        `webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { ...request },
        options,
      ),
    );
  }

  async inspect(siteUrl: string, inspectionUrl: string, options: CallOptions) {
    return inspectResponse.parse(
      await this.#send(
        'POST',
        'v1/urlInspection/index:inspect',
        { inspectionUrl, siteUrl },
        options,
      ),
    );
  }

  /**
   * An abort cancels both the request in flight and any retry wait. gaxios
   * wraps a cancelled fetch in a generic error, so the signal's own reason is
   * rethrown to keep an abort recognizable as one.
   */
  async #send(
    method: 'GET' | 'POST',
    path: string,
    data: Record<string, unknown> | undefined,
    { signal, clock }: CallOptions,
  ): Promise<unknown> {
    try {
      const response = await this.#requester.request({
        method,
        url: `${BASE}${path}`,
        ...(data === undefined ? {} : { data }),
        ...(signal === undefined ? {} : { signal }),
        ...googleRetry({ clock, signal }),
      });
      return response.data;
    } catch (cause) {
      signal?.throwIfAborted();
      const status = statusOf(cause);
      // Live, an exhausted daily inspection quota is a 429 with reason
      // rateLimitExceeded and no Retry-After, like a per-minute limit.
      const rateLimited =
        status === 429 ||
        reasonsOf(cause).some((reason) => RATE_LIMIT_REASONS.has(reason));
      if (!rateLimited) throw cause;
      const attempts = attemptsOf(cause);
      throw new SearchConsoleQuotaError(
        status ?? 403,
        attempts,
        `Search Console rate limited ${method} ${path} after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`,
        { cause },
      );
    }
  }
}
