# Web crawler

A host wants the pages of the websites, sitemaps and feeds that it chooses. The crawler downloads each URL one time and hands back the pages. One engine downloads. Readers read each response and find more URLs. This glossary gives the words that the README and the decisions use.

## Language

**Crawler**:
The `WebCrawler` engine. It keeps the frontier, and it is the only part that downloads. It obeys `robots.txt`, `Crawl-delay`, the slowdown and the block of each origin. It knows no format ([ADR 0001](./docs/adr/0001-one-engine-downloads-and-each-reader-finds-one-kind-of-url.md)).
_Avoid_: Spider, scraper, fetcher

**Crawl**:
One pass of the crawler from its starting URLs. A crawl that stops continues from its memento.
_Avoid_: Run, scan, job

**Frontier**:
The URLs that the crawl must still download, and the URLs that it already knows.
_Avoid_: Queue, visited set

**Reader**:
A class that reads one response and returns the URLs that it finds there. Each reader finds one kind of URL. A reader does not download, queue or call another reader. The crawler gives each response to every reader.
_Avoid_: Parser, extractor (an extractor reads pages for a host), plugin

**Starting URL**:
A URL that the host gives to a crawl. The host chose its website. Each crawl downloads every starting URL, and a starting URL that fails is an error.
_Avoid_: Seed, input (input is the word of the web source), entry

**Origin**:
The scheme, the host name and the port of a URL, for example `https://vercel.com`.
_Avoid_: Site, domain, host

**Starting origin**:
The origin of a starting URL.
_Avoid_: Allowed origin, seeded origin

**Page**:
A URL that a reader marks as a page. The crawl hands it back when it matches `include`, or always when the host gives no `include`.
_Avoid_: Article, record

**Document**:
A URL that only a reader reads, such as `robots.txt` or a sitemap. The crawl does not hand it back.
_Avoid_: Page, file

**List**:
An HTML page that lists pages, such as an archive or a category page. Only the reader that finds a list knows that it is one, so the reader tells the crawler.
_Avoid_: Index, hub

**Hops**:
The number of ordinary links from a starting URL, or from a page that a list, a sitemap or a feed at zero hops names.
_Avoid_: Depth (`maxDepth` is the limit, not the count), level

**Include**:
The URL patterns that select the pages that the crawl hands back. A URL that no pattern selects and that no reader wants costs its origin no request.
_Avoid_: Filter, allowlist, scope

**Expand**:
To look for URLs on an origin that no response names: to follow the ordinary links of its pages, or to read its `robots.txt` for sitemaps and guess `/sitemap.xml`. The crawl expands only the starting origins ([ADR 0002](./docs/adr/0002-the-crawl-expands-only-the-starting-origins.md)).
_Avoid_: Scope, follow, crawl (a crawl is one pass)

**Declared URL**:
A URL that a response names for a stated job: a feed or a sitemap that a page names in a `<link>` element or an HTTP `Link` header, or a page that a list or a sitemap lists. Each reader has its own rule for the origins of declared URLs.
_Avoid_: Discovered URL, link

**`ListingReader`**:
The reader of `robots.txt`, sitemaps and feeds. It finds the feeds and sitemaps that a page declares, also on other origins, and reads each one completely. It reads `robots.txt` and guesses `/sitemap.xml` only for a starting URL.
_Avoid_: Sitemap reader, feed reader

**`ArchiveReader`**:
The reader that guesses the archives that an HTML page links. It finds each archive as a list, and it lists no pages.
_Avoid_: Pagination reader

**`PaginationReader`**:
The reader of lists. It reads the starting URLs and the URLs that another reader found as lists. It hands back the pages that each list links outside `nav`, `footer` and navigation landmarks, because the links of a menu are not the items of a list. With the strategy `'all'`, it hands back pages on every origin. It follows the pagination of a list only on the origin of the list.
_Avoid_: Archive reader, link reader

**`LinkReader`**:
The reader of ordinary links. It follows the links of pages on the starting origins, within `maxDepth` hops and `maxPages` admitted pages.
_Avoid_: Spider, link follower
