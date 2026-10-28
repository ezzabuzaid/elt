# Web pages

A user wants the records that a website shows, for example the articles of a blog or the listings of a marketplace category. The website gives no API for them. A host gives the web source its inputs and a web stream. The source crawls each input, gives each page to the extractor of the web stream, and loads the records that the extractor returns.

## Language

**Input**:
A website, sitemap or feed URL that the host chooses. The source crawls each input separately. Each input is one partition, and `inputUrl` is the first column of the primary key.
_Avoid_: Seed, site, source (the source is the `WebSource`)

**Crawl**:
One pass of the crawler from one input. The crawl finds URLs, downloads them and hands back the pages. A crawl that stops continues from its crawl snapshot.
_Avoid_: Scan, run (a pipeline run does one crawl for each input), sync

**Frontier**:
The URLs that the crawl must still download, and the URLs that it already knows. The crawler keeps it. The URLs of a blocked origin stay in it until the block ends.
_Avoid_: Visited set, queue (the rate limit of the HTTP module has its own queue)

**Origin**:
The start of a URL up to its path: the scheme, the host name and the port, for example `https://shop.example`. The crawler reads `robots.txt`, waits out `Crawl-delay` and blocks requests for each origin.
_Avoid_: Host (the host is the program that gives the source its inputs), domain, site

**Block**:
A period in which the crawl sends no request to one origin. It is a circuit breaker for each origin (Nygard, _Release It!_). It starts when the origin answers 429, answers 403 three times in a row, or cannot give its `robots.txt` (a 429, a 5xx or a network error). It ends at the `Retry-After` time of that answer, or one hour later when the answer gives none. In the crawl where it starts, a block lasts until that crawl ends, even when its end time comes first. The crawl reports each block once, as a failure that names the origin. The crawl snapshot keeps the block, and `Crawl.nextDue()` gives the earliest end of a block.
_Avoid_: Ban, throttle, rate limit (the rate limit of the HTTP module is a different thing)

**Page**:
A URL that the crawl hands back because it matches the `include` patterns of the web stream. The extractor reads it.
_Avoid_: Article (an article is the record of `ArticleExtractor`), document (the crawler uses document for a URL that only a reader reads, such as a sitemap)

**Listing**:
The response that first named a page: a sitemap, a feed, an archive or a linked page. `listingUrl` keeps its URL.
_Avoid_: Index, parent

**Web stream**:
The configuration of the one stream of the source: its name, its primary key, the readers of the crawler, the `include` patterns and the extractor.
_Avoid_: Wrapper, site adapter, scraper

**Extractor**:
The `RecordExtractor` that reads one page. It gives the fingerprint of the page and its records.
_Avoid_: Parser, scraper, wrapper

**Record**:
One row that the extractor returns for a page. The source adds the provenance columns to it.
_Avoid_: Item, entry (the crawler hands back entries), result

**Article URL**:
The identity of an article that `ArticleExtractor` gives: the canonical URL that the page declares, or its final URL when it declares none. Two pages with one article URL are one article.
_Avoid_: Page URL (the page URL is the URL as the crawl found it), canonical URL alone (a page can declare none)

**Provenance**:
The four columns that the source adds to each record: `inputUrl`, `pageUrl`, `listingUrl` and `lastModified`.
_Avoid_: Metadata (the article extractor has its own metadata)

**Fingerprint**:
A value that changes when the records of a page can change. The extractor gives it before it extracts. A null fingerprint means that the extractor cannot know, so the source always extracts the page.
_Avoid_: Hash, ETag (an ETag is an HTTP validator), version

**Failure**:
A page that the crawl could not download, or that the extractor could not read. The crawler keeps it in the crawl memento, and the revisit policy makes it due again. A block is not a failure of the pages of its origin: the revisit policy does not schedule them, and the crawl requests them when the block ends.
_Avoid_: Error page, dead link

**State**:
What the source saves for one input: the diff and the crawl memento. The engine keeps it in the checkpoint store.
_Avoid_: Cursor (the stream has no cursor field)

**Crawl snapshot**:
The plain data of an unfinished crawl: its frontier and the state of its readers. It is null when the crawl is complete.
_Avoid_: Snapshot alone (elt uses snapshot for the records of a complete read)

**Crawl memento**:
What the crawler gives back as plain data: the crawl snapshot, and every URL that a crawl visited, with the digest of its last body and when it is due again. The source keeps it in its state.
_Avoid_: Visited set, history alone (a revisit policy has its own history of each URL)

**Revisit policy**:
The rule that decides when a known URL is due again, across crawls. The web stream gives it; a full refresh uses `AlwaysRevisit`.
_Avoid_: Schedule alone, poll interval (a watch checks again when the earliest known URL is due)

**Deferred page**:
A known page that the crawl did not request because it is not due, and whose last download succeeded. Its row stays.
_Avoid_: Skipped page, cached page
