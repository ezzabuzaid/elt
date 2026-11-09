# The crawler owns the frontier

The source must find the pages of each input in sitemaps, feeds, archives and links. To find them, a crawl needs a frontier. When two classes each keep a frontier, one job has two queues, two visited sets and two download loops.

Thus the source keeps no frontier. It gives each input to `WebCrawler` from `@eltjs/sdk-web-crawler`, with the readers and the `include` patterns of the web stream. The crawler downloads each URL one time and hands back the pages. The source reads the pages in the order that the crawl hands them back, one page at a time. Got owns timeouts, the retries of network errors and the HTTP cache. The crawler's record of each origin spaces the requests to it ([ADR 0014](./0014-the-crawls-of-a-read-share-the-record-of-each-origin.md)).

## Considered Options

- **The source keeps its own queue and downloads pages concurrently.** The source then keeps a second frontier beside the frontier of the crawler, and the two must agree on duplicates, failures and resume.
- **The crawler keeps the frontier, and the source reads what the crawl hands back.** This option was selected.

## Consequences

- The source has no queue, no visited set and no concurrent downloads. The delay of each origin, not concurrency, sets the speed of a crawl.
- The readers of the web stream decide what the crawl finds. The source has no rules for a publisher.
- A crawl that stops continues from its crawl snapshot ([ADR 0003](./0003-the-state-has-diff-crawl-and-retry.md)).
- The crawler applies the Disallow rules, the `Content-Signal` and the crawl delay of `robots.txt` (crawler README, Robots).
