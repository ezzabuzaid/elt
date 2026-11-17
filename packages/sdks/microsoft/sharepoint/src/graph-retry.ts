import { Backoff } from '@zukhruf/async';

// Copied from packages/google-auth/src/retry.ts (strike 2 of the Rule of
// Three): docs/copied-from-google-auth-retry.md lists what changed. Mirror
// every fix in both copies and name both files in the commit.

/** Total tries, including the first. */
const ATTEMPTS = 5;
/**
 * The longest single wait. A Retry-After beyond it fails the call at once
 * rather than stalling a pipeline for longer than anyone would wait.
 */
const MAX_DELAY_MS = 60_000;
// Graph's throttling answers: 429 Too Many Requests, and 503 and 504 when the
// service is busy (Microsoft Graph throttling guidance).
const TRANSIENT_STATUSES = [429, 503, 504];
// Without a Retry-After the wait doubles from 1 s to at most 60 s with full
// jitter, so concurrent callers do not retry in lockstep.
const backoff = new Backoff({
  initial: 1000,
  multiplier: 2,
  max: MAX_DELAY_MS,
  jitter: { kind: 'full' },
});

/**
 * The milliseconds to wait before the request that `response` refused is
 * sent again, or undefined when it is not sent again. `attempt` counts the
 * tries so far, the refused one included; `now` is the wall time of the
 * caller's clock.
 */
export function retryWait(
  response: Response,
  attempt: number,
  now: number,
): number | undefined {
  if (attempt >= ATTEMPTS || !TRANSIENT_STATUSES.includes(response.status))
    return undefined;
  const asked = retryAfterMs(response.headers.get('retry-after'), now);
  if (asked === undefined) return backoff.duration(attempt - 1);
  return asked <= MAX_DELAY_MS ? asked : undefined;
}

// Retry-After is either whole seconds or an HTTP date (RFC 9110 section
// 10.2.3), which counts from now.
function retryAfterMs(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
