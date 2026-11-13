# Code copied from the Search Console SDK

The Google Health SDK keeps its requests under a per-minute quota the way the Search Console SDK does. It keeps its own copy of that code and does not share it yet.

The reason is the Rule of Three: code that a second place needs is copied, and it is extracted only when a third place needs it, so the shared boundary comes from three working copies. When a third Google SDK needs this code, the shared parts move to one place. Until then, a fix in one copy is made in the other copy too, and the commit names both files.

The retry is not a copy: both SDKs take the policy from `googleRetry` of `@eltjs/google-auth`. The Google Health SDK gives it the reason `RESOURCE_EXHAUSTED` as its rate limit, because Google Health gives its reason in an ErrorInfo detail (AIP-193), and its error catalog names `RESOURCE_EXHAUSTED` for quota.

Paths on the left are in `packages/sdks/google/search-console/src`. Paths on the right are in `packages/sdks/google/health/src`.

## Copied with changes

**`url-inspection.ts` `inspectUrls` `pace` → `google-health-api.ts` `GoogleHealthApi#pace`.**

- The window of start times belongs to the API object and covers every request, retries included, not one function's inspections. A retry waits for room in the window after its back-off: `GoogleHealthApi#send` adds that wait to the `retryBackoff` of `googleRetry`.
  Why: Google Health's quota is 300 requests a minute per user for every call, and the source's streams read through one API object at once.
- The ceiling is `REQUESTS_PER_MINUTE` (300), not `URL_INSPECTION_QUOTA.perMinute` (600).
