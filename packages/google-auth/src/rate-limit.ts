import { reasonsOf, statusOf } from './platform/google/google-errors.ts';

// Google reports some rate limits as 403 with one of these reasons. Every other
// 403, such as an insufficient scope or a disabled API, is a refusal.
const RATE_LIMIT_REASONS: readonly string[] = [
  'rateLimitExceeded',
  'userRateLimitExceeded',
];

/**
 * Whether an answer of Google says that the caller sent too much: a 429, or a
 * refusal that names one of `reasons`. An API that names its rate limit
 * otherwise, such as Google Health's `RESOURCE_EXHAUSTED` in an ErrorInfo
 * detail, passes its own reasons, which take the place of the usual two.
 */
export function isRateLimit(
  error: unknown,
  reasons: readonly string[] = RATE_LIMIT_REASONS,
): boolean {
  return (
    statusOf(error) === 429 ||
    reasonsOf(error).some((reason) => reasons.includes(reason))
  );
}
