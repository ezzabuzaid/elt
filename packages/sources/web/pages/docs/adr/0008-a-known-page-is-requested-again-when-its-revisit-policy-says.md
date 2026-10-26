# A known page is requested again when its revisit policy says

Supersedes the `retry` part of [ADR 0003](./0003-the-state-has-diff-crawl-and-retry.md), and [ADR 0004](./0004-a-failed-page-is-tried-again-on-the-next-run.md).

Each refresh started a new crawl, and the crawl requested every page that the listings named again. On simonwillison.net, more than 300 archive pages answered 304 on every crawl. A page that left every listing came back only when it had failed, through the `retry` part of the state.

An incremental crawler keeps every URL that it knows and requests each one again when its revisit policy says that the URL is due (Cho and Garcia-Molina, VLDB 2000; Nutch's `FetchSchedule`; StormCrawler's `Scheduler`). Only the crawler can know this, because it sees each response. It also serves a caller that uses the crawler without elt.

## Decision

- The crawler keeps a memento: the unfinished crawl, and every URL that a crawl visited, with the SHA-256 of its last body and when it is due again. The `crawl` part of the state holds the memento. The `retry` part is removed.
- `WebStream` takes a `revisit` policy. The default is the crawler's `AdaptiveRevisit`. A full refresh uses `AlwaysRevisit`, because it replaces the collection and must see every page that still exists.
- A page that the extractor cannot read is failed back to the crawler through `crawl.fail(url)`, so the crawler makes it due again.
- A page that is not due keeps its row. The crawl hands it out as deferred, and the source gives it to the diff as a kept group (`@zukhruf/snapshot-differential` ADR 0004), so the diff keeps its fingerprint and records unread. Once due, the page is extracted again only when it changed.

## Considered Options

- **The source keeps its own retry list, and the crawler requests every listed page.** This was the old design. It cannot defer a page, so it requests every page on every crawl.
- **The source schedules the pages.** The source does not see the responses of documents and lists, and a caller without elt would have no revisit.
- **A revisit policy in the crawler.** This option was selected.

## Consequences

- An unchanged page is requested again after one day, then after longer intervals, up to 14 days. An edit can wait that long, unless a listing gives the page another `lastModified`.
- A failed page is due two hours later, and a gone page one day later, even after it leaves every listing.
- The memento grows with every URL that a crawl knows, and the source saves it after each page. Backlog item 2920 records this.
