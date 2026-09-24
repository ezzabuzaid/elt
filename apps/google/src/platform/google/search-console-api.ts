import { setTimeout as wait } from 'node:timers/promises';

import type { GoogleRequester } from 'google-auth';

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

export type RetryPolicy = {
  /** Total tries, including the first. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  /**
   * The longest single wait. A Retry-After beyond it fails the call at once
   * rather than stalling a pipeline for longer than anyone would wait.
   */
  readonly maxDelayMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  attempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
});

// Google reports some rate limits as 403 with one of these reasons. Every other
// 403, such as an insufficient scope or a disabled API, is not worth retrying.
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

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

export type CallOptions = { readonly signal?: AbortSignal };

/**
 * The transport for one Search Console property. `sites`, `sitemaps` and
 * `searchAnalytics` still live under the original `webmasters/v3` prefix while
 * URL inspection is served from `v1` on the same host, so the path is modeled
 * per call rather than derived from a single version.
 */
export class SearchConsoleApi {
  readonly #requester: GoogleRequester;

  readonly #retry: RetryPolicy;

  constructor(
    requester: GoogleRequester,
    { retry = DEFAULT_RETRY }: { retry?: RetryPolicy } = {},
  ) {
    if (typeof requester?.request !== 'function')
      throw new TypeError('Search Console requires an authenticated requester');
    this.#requester = requester;
    if (
      !Number.isSafeInteger(retry.attempts) ||
      retry.attempts < 1 ||
      !(retry.baseDelayMs >= 0) ||
      !(retry.maxDelayMs >= retry.baseDelayMs)
    )
      throw new TypeError(
        'retry needs at least one attempt and 0 <= baseDelayMs <= maxDelayMs',
      );
    this.#retry = Object.freeze({ ...retry });
    Object.freeze(this);
  }

  sites(options: CallOptions = {}): Promise<unknown> {
    return this.#send('GET', 'webmasters/v3/sites', undefined, options);
  }

  sitemaps(siteUrl: string, options: CallOptions = {}): Promise<unknown> {
    return this.#send(
      'GET',
      `webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
      undefined,
      options,
    );
  }

  searchAnalytics(
    siteUrl: string,
    request: SearchAnalyticsRequest,
    options: CallOptions = {},
  ): Promise<unknown> {
    return this.#send(
      'POST',
      `webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { ...request },
      options,
    );
  }

  inspect(
    siteUrl: string,
    inspectionUrl: string,
    options: CallOptions = {},
  ): Promise<unknown> {
    return this.#send(
      'POST',
      'v1/urlInspection/index:inspect',
      { inspectionUrl, siteUrl },
      options,
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
    { signal }: CallOptions,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.#requester.request({
          method,
          url: `${BASE}${path}`,
          ...(data === undefined ? {} : { data }),
          ...(signal === undefined ? {} : { signal }),
        });
        return response.data;
      } catch (cause) {
        signal?.throwIfAborted();
        const status = statusOf(cause);
        const rateLimited = status === 429 || rateLimitReason(cause);
        if (!rateLimited && !(status && TRANSIENT_STATUSES.has(status)))
          throw cause;
        const delay = this.#delay(cause, attempt);
        if (attempt < this.#retry.attempts && delay !== undefined) {
          await wait(delay, undefined, { signal });
          continue;
        }
        if (!rateLimited) throw cause;
        throw new SearchConsoleQuotaError(
          status ?? 403,
          attempt,
          `Search Console rate limited ${method} ${path} after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}`,
          { cause },
        );
      }
    }
  }

  /**
   * How long to wait before the next try, or undefined when the server asked
   * for longer than the policy allows. The server's Retry-After wins over the
   * backoff; otherwise the wait doubles per attempt with full jitter, so
   * concurrent callers do not retry in lockstep.
   */
  #delay(error: unknown, attempt: number): number | undefined {
    const requested = retryAfterMs(error);
    if (requested !== undefined)
      return requested <= this.#retry.maxDelayMs ? requested : undefined;
    const ceiling = Math.min(
      this.#retry.maxDelayMs,
      this.#retry.baseDelayMs * 2 ** (attempt - 1),
    );
    return Math.random() * ceiling;
  }
}

function responseOf(error: unknown): object | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const response: unknown = Reflect.get(error, 'response');
  return response !== null && typeof response === 'object'
    ? response
    : undefined;
}

// Retry-After is either whole seconds or an HTTP date (RFC 9110 section 10.2.3).
function retryAfterMs(error: unknown): number | undefined {
  const headers: unknown = Reflect.get(responseOf(error) ?? {}, 'headers');
  if (!(headers instanceof Headers)) return undefined;
  const value = headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function rateLimitReason(error: unknown): boolean {
  const body: unknown = Reflect.get(responseOf(error) ?? {}, 'data');
  const failure: unknown =
    body !== null && typeof body === 'object'
      ? Reflect.get(body, 'error')
      : undefined;
  const errors: unknown =
    failure !== null && typeof failure === 'object'
      ? Reflect.get(failure, 'errors')
      : undefined;
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        RATE_LIMIT_REASONS.has(String(Reflect.get(entry, 'reason'))),
    )
  );
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const status: unknown = Reflect.get(error, 'status');
  if (typeof status === 'number') return status;
  const response: unknown = Reflect.get(error, 'response');
  if (response === null || typeof response !== 'object') return undefined;
  const code: unknown = Reflect.get(response, 'status');
  return typeof code === 'number' ? code : undefined;
}
