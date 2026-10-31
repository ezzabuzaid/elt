# The crawl expands only the starting origins

Replaced by [ADR 0003](./0003-a-page-that-a-list-hands-back-on-another-origin-is-expanded-one-step.md).

A host chooses websites and gives the crawl their starting URLs. The pages of a chosen website link other origins, and a list can link many origins. If the crawl followed every link and read every `robots.txt` that it found, one starting URL could reach the whole web.

Thus the crawl expands only the starting origins:

- `LinkReader` learns the starting origins from the starting URLs. It follows ordinary links only on those origins.
- `ListingReader` reads `robots.txt` and guesses `/sitemap.xml` only for a starting URL.

On every other origin, the crawl reads only declared URLs. `ListingReader` reads a feed or a sitemap that a page declares. A feed on another origin needs an explicit declaration or the feed URL hints of Feedscout. `PaginationReader` with the strategy `'all'` hands back the pages that a list links on every origin, but it follows the pagination of the list only on the origin of the list (backlog item 3351).

The rule comes from `WebLinks` (commit c90fd093): "Each successful HTML starting response establishes an allowed origin. … Pages from remote feeds are emitted, but cannot expand an unseeded origin." `WebCrawler` kept it when it replaced `WebLinks` (commit 26768c44, [ADR 0001](./0001-one-engine-downloads-and-each-reader-finds-one-kind-of-url.md)). The crawl also drops a URL that no reader wants and that `include` does not select before it asks the origin for `robots.txt`, as Scrapy drops an off-site request.

## Considered Options

- **Expand every origin that the crawl finds.** One starting URL then reaches every website that its pages link, and the work has no limit.
- **Expand only the starting origins, and read declared URLs everywhere.** This option was selected.

## Consequences

- Each crawl downloads every starting URL again, because `LinkReader` learns the starting origins from them.
- To expand another origin, a host gives one of its URLs as a starting URL.
- A change that lets the crawl expand an origin that no starting URL names changes this decision. Write a new decision that replaces this one, and name the case. The first case is the startup-credits app in context-compiler (backlog item 3396): a list of startup programs links the home page of a company, and the program page is at another URL of that website or on another origin.
- A crawl that follows links from page to page across origins by topic is a focused crawler. That is a separate design (backlog item 3327).
