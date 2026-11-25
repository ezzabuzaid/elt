# A gone page is handed out as gone

Before this decision, a page that the crawl would hand back and that answered 404 or 410 came out in one of two ways. When its finding tolerated the status, as a list's item or a link does, the crawl handed out only progress, so the host could not tell the page from one that it never requested. When its finding tolerated nothing, as a sitemap's page does, the crawl handed out a failure, so a shop that removed one product failed its host's read on every run. Either way the host kept the records that the page gave, and a product search showed a product that its shop had removed (elt backlog item 3235).

The crawl already knew the answer: a 404 or a 410 is a gone visit at once, and the third failed visit in a row is one too ([ADR 0008](./0008-a-failure-has-a-lifecycle.md)). Apache Nutch gives such a URL the status `STATUS_FETCH_GONE`, a status and not an error, and its indexer deletes the document of a `db_gone` URL when it runs with `-deleteGone`. StormCrawler sends a URL whose status becomes `ERROR`, after `max.fetch.errors` failures, to its deletion stream, and its deletion bolts remove the document from the index.

## Decision

1. **A gone page is handed out as gone.** A page that the crawl would hand back, whose visit is gone, is handed out as `{ gone, routes }`: its location, and what the read named, which is nothing when no reader read the response. This holds whether its finding tolerated the status or not, and it replaces the failure and the progress that the crawl handed out before. The crawl hands a page out as gone once in a run, as it hands back a page once.
2. **A document that is gone does not change.** A sitemap, a feed or a list that is not a page is still a failure, or a tolerated answer that only its readers see.
3. **A gone page is no dead letter.** The memento keeps, for each failed visit, whether it was a gone visit (`goneVisit`), and `crawl.failures()` leaves out a page whose last visit was gone.
4. **Gone is not final.** The revisit policy asks a gone page again, as ADR 0008 says, and a page that comes back is handed back again.

## Considered Options

- **Keep the failure, and let the host read the status from its cause.** Each host would decode an `HTTPError` to learn a fact that the crawl already decided, and a tolerated page would still give the host nothing. This option was rejected.
- **A gone page is a progress entry with a flag.** A progress entry is a moment to take a snapshot, not an answer about a page. This option was rejected.
- **An entry of its own for a gone page.** This option was selected.

## Consequences

- A host that keeps what pages give can remove what a gone page gave, as `@eltjs/source-web-pages` does.
- A host that handled only pages, failures, progress and deferrals gets a fifth kind of entry.
- The diagnostics channel `crawlChannels.handOff` names the kind `gone`.
