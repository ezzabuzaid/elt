# An exhausted inspection quota waits until midnight in Pacific Time

Google permits 2000 URL inspections each day for a property. The error reference of Google tells that an exhausted quota is `403 quotaExceeded`. A live run spent the 2000 inspections of `limerence.sh`, and Google answered `429` with the reason `rateLimitExceeded`. Thus the source treats that `429` as the exhausted daily quota, and the branch for `403 quotaExceeded`, which no run saw, was removed (27b0cff5).

000da177 lists this as a behavior fix: the checkpoint keeps the exhausted quota. Thus the next run makes no inspection request before midnight in Pacific Time (000da177). The daily Google Cloud quotas reset at that time, and the code computes it with Temporal in the `America/Los_Angeles` zone (9b7914c5).

## Considered Options

- **Try the inspections again at the next run.** This was the behavior before 000da177.
- **Keep the time of the quota reset in the checkpoint.** This option was selected.

## Consequences

- The inspections that succeeded before the refusal are committed.
- Each inspection stream keeps `quotaResetAt` in its checkpoint, so the next run and the watch wait until that time.
- A pass that the quota limited can succeed and still leave due URLs until midnight in Pacific Time.

Sources: commits 27b0cff5, 000da177 and 9b7914c5.
