import { type WallClock, delay } from '@zukhruf/async';

import {
  GaxiosError,
  reasonsOf,
  statusOf,
} from './platform/google/google-errors.ts';

/** Total tries, including the first. */
const ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
/**
 * The longest single wait. A Retry-After beyond it fails the call at once
 * rather than stalling a pipeline for longer than anyone would wait.
 */
const MAX_DELAY_MS = 60_000;
const TRANSIENT_STATUSES = [408, 500, 502, 503, 504];

// Google reports some rate limits as 403 with one of these reasons. Every other
// 403, such as an insufficient scope or a disabled API, is a refusal.
export const RATE_LIMIT_REASONS: readonly string[] = [
  'rateLimitExceeded',
  'userRateLimitExceeded',
];

/**
 * The fields that turn on the retry of gaxios for one request, spread into
 * the request: `requester.request({ url, ...googleRetry({ clock, signal }) })`.
 *
 * A rate limit (a 429, or a refusal with one of `rateLimitReasons`) and a
 * transient status are sent again, five times in all. The Retry-After of
 * Google is the wait; without one the wait doubles from 1 s to at most 60 s
 * with full jitter, so concurrent callers do not retry in lockstep. The wait
 * runs on `clock` and rejects with the reason of `signal` when it aborts.
 *
 * `shouldRetry` takes the place of every check of gaxios, so its limits are
 * stated here. gaxios's limit on methods has no line: a requester sends only
 * GET and POST, and the policy sends both again. Its abort check has none
 * either: an aborted request has no response, so no status, and a wait on an
 * aborted signal rejects before it starts.
 */
export function googleRetry({
  clock,
  signal,
  rateLimitReasons = RATE_LIMIT_REASONS,
}: {
  readonly clock: WallClock;
  readonly signal?: AbortSignal;
  readonly rateLimitReasons?: readonly string[];
}): {
  readonly retry: true;
  readonly retryConfig: {
    shouldRetry(error: unknown): boolean;
    retryBackoff(error: unknown): Promise<void>;
  };
} {
  return {
    retry: true,
    retryConfig: {
      // gaxios counts the next try before it asks for the wait, so the try
      // that failed is one less than the count.
      retryBackoff: (error) =>
        delay(
          retryAfterMs(error, clock.Date.now()) ??
            Math.random() *
              Math.min(
                MAX_DELAY_MS,
                BASE_DELAY_MS * 2 ** (attemptsOf(error) - 2),
              ),
          { clock, signal },
        ),
      shouldRetry(error) {
        const status = statusOf(error);
        return (
          attemptsOf(error) < ATTEMPTS &&
          (status === 429 ||
            (status !== undefined && TRANSIENT_STATUSES.includes(status)) ||
            reasonsOf(error).some((reason) =>
              rateLimitReasons.includes(reason),
            )) &&
          (retryAfterMs(error, clock.Date.now()) ?? 0) <= MAX_DELAY_MS
        );
      },
    },
  };
}

/**
 * How many times a failed request was sent. gaxios counts the retries on the
 * request of the error, and only for a request with its retry on (retry.js
 * `getRetryConfig` returns before it sets the count otherwise).
 */
export function attemptsOf(error: unknown): number {
  return error instanceof GaxiosError
    ? 1 + (error.config.retryConfig?.currentRetryAttempt ?? 0)
    : 1;
}

// Retry-After is either whole seconds or an HTTP date (RFC 9110 section
// 10.2.3), which counts from now.
function retryAfterMs(error: unknown, now: number): number | undefined {
  if (!(error instanceof GaxiosError)) return undefined;
  const value = error.response?.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
