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
To look for URLs that no response names: to follow the ordinary links of a page, or to read the `robots.txt` of its origin for sitemaps and guess `/sitemap.xml`. The crawler marks how readers expand each request: a starting URL expands its origin, and a one-step page expands one step ([ADR 0003](./docs/adr/0003-a-page-that-a-list-hands-back-on-another-origin-is-expanded-one-step.md)).
_Avoid_: Scope, follow, crawl (a crawl is one pass)

**One-step page**:
A page that a list hands back on an origin that no starting URL names, when the host gives `expand` URL patterns. Readers find its links on every origin and the sitemaps of its origin. The crawler keeps only the pages and lists that match `expand`, and it expands none of them. A sitemap entry or a feed item is not a one-step page.
_Avoid_: Seed, promoted URL, second start

**Expand patterns**:
The URL patterns that select what a one-step page gives: its pages and lists, and the pages and lists of the sitemaps that it gives. `include` still selects the pages that the crawl hands back.
_Avoid_: Scope, filter, allowlist

**Declared URL**:
A URL that a response names for a stated job: a feed or a sitemap that a page names in a `<link>` element or an HTTP `Link` header, or a page that a list or a sitemap lists. Each reader has its own rule for the origins of declared URLs.
_Avoid_: Discovered URL, link

**Route**:
The fact "listing L named URL U". The listing is a response that a reader read, by its final URL. U is a URL in the crawl's scope that the read found, whether the crawl knows U or not. Each read gives all its routes ([ADR 0004](./docs/adr/0004-every-route-is-kept.md)).
_Avoid_: Link (a link is one kind of route), edge, provenance (`listingUrl` is the first route only), parent

**How**:
The way that a listing named the URL of a route, such as `list-item`, `link`, `robots-sitemap`, `sitemap-entry`, `feed-item` or `redirect`. The reader that found the URL gives it. `routeHows` lists every value, from the most specific.
_Avoid_: Kind, type, rel

**Route text**:
The text that a listing named the URL of a route with: the anchor text of a link or a list item, or the title of a feed item. It is null for a document, a sitemap entry and a link without text.
_Avoid_: Label, title alone, anchor

**`ListingReader`**:
The reader of `robots.txt`, sitemaps and feeds. It finds the feeds and sitemaps that a page declares, also on other origins, and reads each one completely. It reads `robots.txt` and guesses `/sitemap.xml` only for a starting URL and a one-step page.
_Avoid_: Sitemap reader, feed reader

**`ArchiveReader`**:
The reader that guesses the archives that an HTML page links. It finds each archive as a list, and it lists no pages.
_Avoid_: Pagination reader

**`PaginationReader`**:
The reader of lists. It reads the starting URLs and the URLs that another reader found as lists. It hands back the pages that each list links outside `nav`, `footer` and navigation landmarks, because the links of a menu are not the items of a list. With the strategy `'all'`, it hands back pages on every origin. It follows the pagination of a list only on the origin of the list.
_Avoid_: Archive reader, link reader

**`LinkReader`**:
The reader of ordinary links. It follows the links of pages on the starting origins, within `maxDepth` hops and `maxPages` admitted pages. It also finds the links of a one-step page, on every origin.
_Avoid_: Spider, link follower

**`StartReader`**:
The reader of starting URLs. It hands back each starting URL as a page, and it finds no other URL.
_Avoid_: Seed reader, home page reader
