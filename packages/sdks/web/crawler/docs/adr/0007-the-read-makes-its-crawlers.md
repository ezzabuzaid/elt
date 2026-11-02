# The read makes its crawlers

ADR 0006 made `Origins` the record of each origin for one read: the host made one when the read opened and gave it to each crawler, `new WebCrawler(http, origins, readers, revisit)`. Thus `Origins` was two things at once: the record that the engine asks before each request, and the host's handle on the read. A host got every member that the engine uses: `rules`, `robotsTxt`, `pace`, `ready`, `answered`, `until`, `expands`, `spend` and `retry`. A host could call `spend()` or `answered()` and change the record of an origin that every crawl of the read shares. The only host, the web source, used three members: the constructor, `http` and `snapshot()` (backlog item 3578).

The established crawlers keep the record of each host inside the object that runs the crawl. Scrapy's `Downloader` keeps a `Slot` for each domain, with its delay and its concurrency, and a spider never reaches a slot. Heritrix's `CrawlController` holds the `ServerCache` and the frontier, and the processors that it runs get the record of a host through it.

Thus:

1. **The engine's record is internal.** `OriginRecords` keeps the record of each origin, with every member that the engine uses. The package does not export it.
2. **`Origins` is the host's handle on the read.** It makes the records from the client and the memento, gives the client for requests outside a crawl (`http`) and the memento (`snapshot()`), and makes each crawler of the read: `origins.crawler(http, readers, revisit)`. A crawler gets the records of the read that made it, and no other.
3. **A host does not construct a crawler.** The package exports `WebCrawler` as a type only.

## Considered Options

- **Keep the constructors, and hide the engine's members behind a module-internal accessor.** Hosts would see fewer members, but each host would still hand the record to each crawler.
- **The read makes its crawlers.** This option was selected.

## Consequences

- A host cannot change a record or give a crawler the record of another read: the types do not let it.
- Each crawler still has its own client, so the web source gives the crawler of each input the extractor's negotiation hooks.
- Hosts and tests write `origins.crawler(http, readers, revisit)` in place of `new WebCrawler(http, origins, readers, revisit)`.
