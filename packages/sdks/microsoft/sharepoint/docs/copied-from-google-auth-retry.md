# Code copied from the retry of google-auth

A request to Microsoft Graph can get 429, 503 or 504 when Graph throttles the app. The client must then wait and send the request again. `@eltjs/google-auth` already does this for Google's APIs in `packages/google-auth/src/retry.ts`. This package keeps its own copy of that knowledge in `src/graph-retry.ts`, and does not share it with google-auth yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of a shared package then comes from three working copies, not from a guess. When a third consumer needs this code, the shared parts move to one package (backlog #4563). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths on the left are in `packages/google-auth/src`. Paths on the right are in `packages/sdks/microsoft/sharepoint/src`.

## Copied without a change

These rules are the same in both copies:

- Five tries in all, the first one included (`ATTEMPTS`).
- The longest single wait is 60 seconds (`MAX_DELAY_MS`). A `Retry-After` of more than 60 seconds fails the call at once, rather than stalling a pipeline for longer than anyone would wait.
- A `Retry-After` is either whole seconds or an HTTP date that counts from the wall time of the clock (RFC 9110 section 10.2.3): `retryAfterMs`.
- Without a `Retry-After`, the wait doubles from 1 second to at most 60 seconds, with full jitter: a random time from 0 to that wait.
- Each wait runs on the `WallClock` that the caller gives, through `delay` of `@zukhruf/async`, and rejects with the reason of the signal when it aborts.

## Copied with changes

**`retry.ts` → `graph-retry.ts`.**

- The transport. google-auth gives the fields that turn on the retry of gaxios (`retry`, `retryConfig.shouldRetry`, `retryConfig.retryBackoff`), which read a `GaxiosError`. This package gives one function, `retryWait(response, attempt, now)`, over the `Response` of `fetch`: the wait before the next try, or `undefined` when there is none. The loop and the `delay` are in `Graph.get` (`graph.ts`).
  Why: this package sends its requests with `fetch`. MSAL gets the token, so no gaxios client exists here.
- The count of tries. google-auth reads it from the error (`attemptsOf`: gaxios keeps `currentRetryAttempt` on the request of the error). This package gets it from the loop of `Graph.get`. `attemptsOf` is not copied.
  Why: `fetch` keeps no count.
- The statuses. google-auth sends again on a rate limit (`isRateLimit`: 429, or 403 with a rate-limit reason, and the `rateLimitReasons` of the caller) and on 408, 500, 502, 503 and 504. This package sends again on 429, 503 and 504 only. `isRateLimit` and `rateLimitReasons` are not copied.
  Why: these are the answers that Graph's throttling guidance names. Graph gives no 403 for a rate limit: its 403 is a refused access (`SharePointAccessError`).
- The back-off. google-auth computes `Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (tries - 2))` by hand. This package asks `Backoff` of `@zukhruf/async` with `{ initial: 1000, multiplier: 2, max: 60_000, jitter: { kind: 'full' } }` for `duration(attempt - 1)`. The waits are the same.
  Why: `@zukhruf/async` already owns a capped exponential back-off, and this package already depends on it.
