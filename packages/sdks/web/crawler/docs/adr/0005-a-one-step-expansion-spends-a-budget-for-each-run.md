# A one-step expansion spends a budget for each run

This decision amends [ADR 0003](./0003-a-page-that-a-list-hands-back-on-another-origin-is-expanded-one-step.md). ADR 0003 limits the reach of an expansion to one step. It does not limit the cost of the documents inside that step.

A page that the crawl expands one step reads every sitemap that its origin's `robots.txt` names, also through sitemap indexes. Listings go strictly first, so all of these sitemaps were read before any page. On 2026-10-31, a 10-minute live run of the startup-credits app in context-compiler (backlog item 3486) read 505 sitemaps of www.microsoft.com (332 MB decoded, 46,526 entries, none that matches `expand`) and 23 sitemaps of aws.amazon.com (41 MB, 267,318 entries, 3,171 that match). In that time, the crawl stored 3 pages. The documents of one origin held up every other origin: head-of-line blocking.

Thus the crawl uses three layers of one pattern. It leaves nothing out, and the complete set arrives over runs:

1. **A child sitemap of an index is backfill.** It is a frontier entry with the `backfill` priority, and it shares the downloads with the pages. It does not go strictly first. Crawlee's `SitemapRequestLoader` keeps its `pendingSitemapUrls` and restores them (`sitemap-request-loader.ts`, lines 375 to 401, at 65254412). StormCrawler's `SiteMapParserBolt` gives the children as discovered outlinks (5452c1c0). Heritrix's `ExtractorSitemap` gives them as outlinks with the hop `M` (65529301).
2. **Origins take turns.** Inside each priority, each download takes the oldest URL of the origin whose turn it is, and that origin goes to the back. An origin that must still wait out its `Crawl-delay` or slowdown lets a ready origin go first. Heritrix's `WorkQueueFrontier` deactivates a queue that used its `balanceReplenishAmount` and puts it at the back (`WorkQueueFrontier.java`, lines 644 to 648). StormCrawler limits each bucket with `max.urls.per.bucket`. _Introduction to Information Retrieval_ (§20.2.3) keeps one back queue for each host, ordered by the earliest time that the host can be asked again.
3. **An expansion budget for each run.** One run downloads at most 8 documents for the one-step expansions on each origin that no starting URL names. The other documents stay in the frontier, so the crawl is unfinished. Its memento keeps them, and `crawl.nextDue()` makes the next run due at once. Nutch's `generate.max.count` with `generate.count.mode=host` does the same: the URLs over the limit stay in the crawl database for the next cycle (`Generator.java`, lines 597 to 610, at e29a1d46). Starting origins have no budget: the host chose them.

## Why the budget is 8

The budget is a fact about the domain of the crawler, not an option of a host. An expansion reads one `robots.txt` and the sitemaps that it names. A small site names one to three. vercel.com names one, `crawled-sitemap.xml`, so the expansion of `vercel.com/` needs two documents. With 8, such a site finishes in one run, together with a `/sitemap.xml` guess, a sitemap index and a few children. A site with hundreds of sitemaps is read in many runs: www.microsoft.com's 505 in about 64. The sitemaps protocol limits one file to 50 MB, so one run reads at most 400 MB from one origin.

## Considered Options

- **Drop the documents over a limit**, as crawler-commons' `maxUrls`, an age filter (StormCrawler's `sitemap.filter.hours.since.modified`) or a time limit (Nutch's `fetcher.timelimit.mins`). Each one loses entries.
- **Follow only the sitemaps whose URL matches**, as Scrapy's `sitemap_follow`. It finds aws.amazon.com's `sitemap_startups_locales`, but vercel.com/startups is in a generic `crawled-sitemap.xml`.
- **Make the budget an option of the host.** A performance option at a call site is a decision that each host must make again.
- **Backfill children, turns of origins, and a budget for each run.** This option was selected.

## Consequences

- A small site's program page comes back in the first run. A large site's sitemaps arrive over later runs.
- A crawl that a budget left unfinished does not start a new crawl: the next run continues it with the documents that it left pending.
- Across runs, only the revisit policy decides whether a URL is requested; the crawl does not. Every run requests each starting URL that it never visited or that its policy makes due, in a new crawl and in one that it continues, whatever ended the last run: a budget, an interruption or a block. A known URL that a listing names, or that is due and that no listing names, goes in when its policy makes it due, also when an earlier run of the same crawl downloaded it. Inside one run, a URL is downloaded once for each role and handed back once. Thus a list that is due every hour is read every hour, and an hourly page that it names is requested every hour, while a large site's sitemaps arrive over many runs. Nutch keeps one record for each URL with its status and its next fetch time, and its generate step selects every due entry, seeds included, in each cycle (`Generator.java` at e29a1d46). StormCrawler gives each URL a status, `DISCOVERED` or `FETCHED`, and a next fetch date in its status index, and its spout takes what is due. Neither has a crawl epoch that keeps a due URL out. Heritrix resumes a job without its seeds, but that is for one-shot archive jobs.
- The crawl snapshot keeps only what a continued run needs: the pending entries, the readers' states, the blocks and the starting origins. The completion of a crawl still sets the boundary of the deferred pages that a host keeps unread, as the web source's diff needs.
- The memento keeps the origin that each starting HTML or Markdown page answered from, so `LinkReader` follows links on the starting origins also in a run that does not read the starting page.
- Each run is timed at its own start, also a run that continues a crawl, so a URL that it read is due again one interval after that run.
- The order of downloads across origins changes: the origins alternate.
- `ListingReader` keeps the origins where a listing was declared or read, so the `/sitemap.xml` guess is decided for each origin (backlog item 3474).
