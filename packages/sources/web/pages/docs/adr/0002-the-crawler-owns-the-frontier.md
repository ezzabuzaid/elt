# The crawler owns the frontier

The source must find the pages of each input in sitemaps, feeds, archives and links. To find them, a crawl needs a frontier. When two classes each keep a frontier, one job has two queues, two visited sets and two download loops.

Thus the source keeps no frontier. It gives each input to `WebCrawler` from `@workspace/sdk-web-crawler`, with the readers and the `include` patterns of the web stream. The crawler downloads each URL one time and hands back the pages. The source reads the pages in the order that the crawl hands them back, one page at a time. Got owns retries, redirects, timeouts and the HTTP cache. The HTTP module of the source starts at most two requests each second.

## Considered Options

- **The source keeps its own queue and downloads pages concurrently.** The source then keeps a second frontier beside the frontier of the crawler, and the two must agree on duplicates, failures and resume.
- **The crawler keeps the frontier, and the source reads what the crawl hands back.** This option was selected.

## Consequences

- The source has no queue, no visited set and no concurrent downloads. The rate limit, not concurrency, sets the speed of a crawl.
- The readers of the web stream decide what the crawl finds. The source has no rules for a publisher.
- A crawl that stops continues from its crawl snapshot ([ADR 0003](./0003-the-state-has-diff-crawl-and-retry.md)).
- The source does not apply the Disallow rules or the crawl delay of `robots.txt`. Backlog item 2934 records this.
