# A failure has a lifecycle

Before this decision, a failure of a URL had no history. A failed URL was due again two hours later, and a gone URL (404 or 410) one day later, at each visit and for all time. A URL that failed for a year was requested 4,380 times, and each failure that its entry did not tolerate was an error of each run. A failure also replaced the body digest of the URL. Thus the first download after a failure had no body to compare, its change was `unknown`, and `AdaptiveRevisit` and `ChangeRateRevisit` lost one comparison. A 304 answer was a failure, because its status is not 2xx (backlog item 3506).

Apache Nutch keeps a failure history for each URL. These citations are of Nutch's `master` at 35734ec8:

- `CrawlDbReducer.java`, lines 308 to 321: a temporary failure (`STATUS_FETCH_RETRY`) keeps the old signature, adds one to `retriesSinceFetch` through `setPageRetrySchedule`, and makes the URL gone (`STATUS_DB_GONE`) when the count gets to `db.fetch.retry.max`. Line 64 reads that setting, and its default is 3 (`nutch-default.xml`, line 926).
- `CrawlDbReducer.java`, lines 331 to 337: a permanent failure (`STATUS_FETCH_GONE`) keeps the old signature and goes to `setPageGoneSchedule`.
- `AbstractFetchSchedule.java`, lines 110 to 120: `setPageGoneSchedule` makes the interval of a gone URL half again as long at each gone visit, below `db.fetch.interval.max`. The comment says: "no page is truly GONE". The default maximum is 90 days (`nutch-default.xml`, line 629): "After this period every page in the db will be re-tried, no matter what is its status."
- `AbstractFetchSchedule.java`, lines 86 to 91: `setFetchSchedule`, which every visit that succeeded calls, sets `retriesSinceFetch` to 0.
- `HttpBase.java`, line 407, maps a 304 to `NOTMODIFIED`. `FetcherThread.java`, lines 506 to 508, gives it `STATUS_FETCH_NOTMODIFIED`, with no content. `CrawlDbReducer.java`, lines 236 to 275, schedules it as a visit that succeeded, with the change `STATUS_NOTMODIFIED`, and keeps the old signature.
- Nutch does not read `Retry-After`: a code search of the repository for `Retry-After` and `retry.after` finds no file, and `HttpBase.java` maps every status that it does not name to `EXCEPTION` (line 432).

## Decision

1. **The crawler counts the visits since the last visit that succeeded.** The memento keeps each failed URL with the failed visits and the gone visits since its last visit that succeeded, as Nutch's `retriesSinceFetch`. The crawler counts, because the count is a fact of the URL, as Nutch's `CrawlDbReducer` counts and decides the status. A visit that succeeded, a redirect or a 304, ends the history.
2. **The third failed visit is gone.** The third failed visit since the last visit that succeeded, and each failed visit after it, is a gone visit, as `db.fetch.retry.max` 3. The first two failed visits wait two hours, as before, as StormCrawler's `fetchInterval.fetch.error`. A 404 or a 410 is a gone visit at once. A gone visit after a 404 does not add to the failed visits, as `setPageGoneSchedule` does not change `retriesSinceFetch`.
3. **A gone URL waits longer at each gone visit, to at most 90 days.** The policy gets the outcome `{ gone }`, with the number of gone visits since the last visit that succeeded. Every `IntervalRevisit` waits one day after the first gone visit, as before, and half again as long after each later one, as `setPageGoneSchedule`. The longest wait is 90 days, Nutch's `db.fetch.interval.max`. Nothing is dropped: a gone URL is asked again, and a listing that gives it another `lastModified` still makes it due at once.
4. **A failure keeps the body digest.** A failed or gone visit keeps the digest of the last body, as Nutch keeps the old signature. Thus the first download after a failure compares its body with that body. `crawl.fail(url)` keeps the digest of the visit before the page that the host could not use, as Nutch keeps the old signature for `STATUS_PARSE_FAILED`. A redirect keeps no digest, as Nutch's signature of a redirect is the one of its empty fetch.
5. **A 304 is unmodified.** A 304 is a visit that succeeded, with the change `unmodified`, and it keeps the digest of the body before it. It has no body, so no reader reads it: its routes give `null` for each reader, so a host keeps the routes that it had. A page that `include` selects is handed out as deferred, because it is unchanged as far as the crawl knows. Got sends a 304 to the crawl only when its cache does not answer for it, such as when a hook of the host sends `If-None-Match` itself.
6. **The breaker and the limit of `Retry-After` stay as they are.** A 503 with `Retry-After` opens the breaker of its origin, and the breaker closes at most one day later ([ADR 0006](./0006-every-crawl-of-a-read-asks-one-record-of-each-origin.md)). Nutch does not read `Retry-After`, so the decision follows StormCrawler (`urlfrontier.max.retry.after`, 86,400 seconds).

## Considered Options

- **Keep the history in each policy's `histories`.** Each policy would have to keep the counts beside its own history, and a policy that a host writes would have to know them. The counts are facts of the visits, not a rule of a policy. This option was rejected.
- **Wait the policy's own interval times 1.5 after a gone visit, as Nutch.** Nutch's first gone wait is its default interval, 30 days, times 1.5. The policies of this package have no shared interval: `OnceRevisit` and `AlwaysRevisit` have none, and `HintRevisit` takes its interval from the server. The first gone wait stays one day. This option was rejected.
- **Count the visits in the crawler, and give the policy `{ gone }`.** This option was selected.

## Consequences

- A URL that answers 404 for a year is requested 14 times, not 365 times, and a URL that fails for a year 16 times, not 4,380 times. Its error comes from these visits only.
- `Outcome` has `{ gone: number }` in place of `'gone'`. A policy that extends `RevisitPolicy` and decides gone URLs reads the count.
- `IntervalRevisit` has no `goneAfter` field. No policy set it. A subclass still sets the wait of a failed visit with `retryAfter`.
