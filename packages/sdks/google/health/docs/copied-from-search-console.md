# Code copied from the Search Console SDK

The Google Health SDK retries a refused call, and keeps its requests under a per-minute quota, the way the Search Console SDK does. It keeps its own copy of that code and does not share it yet.

The reason is the Rule of Three: code that a second place needs is copied, and it is extracted only when a third place needs it, so the shared boundary comes from three working copies. When a third Google SDK needs this code, the shared parts move to one place (backlog #2636). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

Paths on the left are in `packages/sdks/google/search-console/src`. Paths on the right are in `packages/sdks/google/health/src`.

## Copied without a change

| Search Console                                   | Google Health                                  |
| ------------------------------------------------ | ---------------------------------------------- |
| `search-console-api.ts` `RETRY`                  | `google-health-api.ts` `RETRY`                 |
| `search-console-api.ts` `TRANSIENT_STATUSES`     | `google-health-api.ts` `TRANSIENT_STATUSES`    |
| `search-console-api.ts` `SearchConsoleApi#delay` | `google-health-api.ts` `GoogleHealthApi#delay` |
| `search-console-api.ts` `retryAfterMs`           | `google-health-api.ts` `retryAfterMs`          |

## Copied with changes

**`SearchConsoleApi#send` → `GoogleHealthApi#send`.**

- A rate limit is status 429 or the reason `RESOURCE_EXHAUSTED`, not the reasons `rateLimitExceeded` and `userRateLimitExceeded`.
  Why: Google Health gives its reason in an ErrorInfo detail (AIP-193), and its error catalog names `RESOURCE_EXHAUSTED` for quota. Search Console gives the older `errors[].reason`.
- The reason `ACCOUNT_NOT_LINKED` throws `GoogleHealthAccountNotLinkedError` and is not retried.
  Why: only the user can fix it, by signing in to the Google Health app.
- The error after the last try is `GoogleHealthRateLimitError`, which keeps the number of tries but not the status.
  Why: every Health rate limit is a 429.
- The method takes `{ data }` and leaves the query to the caller (`#get`).
  Why: list calls send their page token and filter in the query; Search Console sends its parameters in a body.

**`url-inspection.ts` `inspectUrls` `pace` → `google-health-api.ts` `GoogleHealthApi#pace`.**

- The window of start times belongs to the API object and covers every request, retries included, not one function's inspections.
  Why: Google Health's quota is 300 requests a minute per user for every call, and the source's streams read through one API object at once.
- The ceiling is `REQUESTS_PER_MINUTE` (300), not `URL_INSPECTION_QUOTA.perMinute` (600).
