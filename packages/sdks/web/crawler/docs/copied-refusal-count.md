# Code copied inside the crawler: the refusal count

The crawl sends two kinds of request through the Got client: a page or a document, and an origin's `robots.txt`. Both count the attempts that Got retried because the site refused them, so that the origin's slowdown grows only for refusals. Each request keeps its own copy of that count, and the copies are not shared yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. A third request that the crawl sends itself is the third place. When it comes, the count moves to one place (backlog #3292). Until then, a fix in one copy is made in the other copy too, and the commit names both.

Both copies are in `src/web-crawler.ts`, in the class `CrawlRun`.

## Copied without changes

**The page request in `[Symbol.asyncIterator]` → the request in `#robots`.**

- A `refusals` counter that starts at zero for the request.
- A `beforeRetry` hook that adds one when the retried attempt has a response whose status `refused()` accepts, a 429 or a 5xx.
- `this.#answered(origin, refusals + (refused(status) ? 1 : 0))` after the answer.

Why each request keeps its own counter: a counter on the crawl would carry the retries of a request that ends in an error, which `#answered` never sees, into the next answer, possibly of another origin.
