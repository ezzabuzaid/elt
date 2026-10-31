# Every route is kept

A route is "listing L named URL U". L is a response that a reader read: a starting page, a list, a one-step page, a `robots.txt`, a sitemap index, a sitemap, a feed or a linked page. U is a URL that the read found.

Before this decision, the crawl kept one route for each URL. A page kept only `listingUrl`, the response that first named it. The URL-seen test of the frontier dropped every later route to a known URL. The rule came from sdk-web-discovery (commit da428e4e, 2026-10-24), to select one `lastmod` hint for each URL in one website. No consumer decided anything from a route.

The startup-credits app in context-compiler (backlog item 3407) must decide, for each page that a list links, whether a route from it reaches a program page. On 2026-10-31, a live probe with the configuration of the app found four cases that one route cannot serve:

1. The list links `https://vercel.com/`. The expansion finds `https://vercel.com/startups`. Its `listingUrl` is `https://vercel.com/crawled-sitemap.xml`, the sitemap that `vercel.com/robots.txt` names. Nothing connects `/startups` to `https://vercel.com/`.
2. A list links both `https://vercel.com/` and `https://vercel.com/startups`. `/startups` has the list as its `listingUrl`. The routes from the expansion of `vercel.com/`, its link and its sitemap, are dropped.
3. A `robots.txt` names a sitemap on another host: `elevenlabs.io/robots.txt` names `showcase.elevenlabs.io/sitemap.xml`, and `manus.im/robots.txt` names `events.manus.im/sitemap.xml`. A group by origin does not connect them.
4. The text of a list names the program. avinash201199/awesome-startup-credits links `https://www.anthropic.com/` as "Anthropic Startup Program". doanbactam/awesome-builder-programs links `https://claude.com/programs/startups` with the same text. The app matches the rows of two lists by this text, but the readers did not keep it.

Thus each read gives every route that it found:

- Each page entry and each progress entry carries `routes`: the final URL of the response, and each URL in the crawl's scope that the response names. The scope is the rule that the crawl applies before a download: the expand rule of a one-step expansion, then a document, a page that `include` selects, a URL that a crawl downloaded, or a page that a reader would admit now. A downloaded URL stays in scope after a reader's budget is spent.
- A URL gets its route when it is new, pending, downloaded, or known and not due. The route does not change the frontier, so the crawl downloads nothing more.
- Each reader says how the response named the URL, in `Finding.naming`: `how` and `text`. Only the reader knows it. `text` is the anchor text of a link or a list item, or the title of a feed item, and null for a document or a sitemap entry. `StartReader` names nothing.
- A URL that one response names in two ways gets one route: the more specific `how`, in the order of `routeHows`, and the first text.
- A request that was redirected gives a second group: the requested URL names the final URL with `redirect`. `listingUrl` stays the final URL, as on a page, so a page's `listingUrl` joins its routes. A walk from the URL that a list names thus reaches everything that its read named.
- Every one-step page names the `robots.txt` of its origin, also when the crawl read that `robots.txt` for another page. The crawl reads the `robots.txt` one time.
- Each group says whether it is `complete`: every reader read the response. A reader that throws, or that skips a response that it reads at other times, makes the group incomplete. `LinkReader` skips a linked page that it does not admit, such as a page past `maxPages`, and its `read` returns null for it. An incomplete group names only part of what the response names, so a consumer adds its routes and deletes none.
- The routes are on the entry of the read, so they need no space in the memento. A crawl that stops after an entry reads the URL of that entry again when it resumes, so its routes come again.

The leading crawlers keep every route as data:

- Heritrix (master 65529301b5, `modules/src/main/java/org/archive/modules/warc/MetadataRecordBuilder.java`) writes one `outlink: <uri> <hop> <via-context>` line for each outlink of each fetched URI, seen or not. Its comment says that outlinks are "effectively useless without anchor text".
- Apache Nutch (f2c7555d09, `src/java/org/apache/nutch/crawl/LinkDb.java`) "Maintains an inverted link map, listing incoming links for each url". Each `Inlink` has `fromUrl` and `anchor`.
- The URL Inspection API of Google Search Console (discovery revision 20261028), `IndexStatusInspectionResult`, gives `sitemap`, "Any sitemaps that this URL was listed in", and `referringUrls`, "URLs that link to the inspected URL, directly and indirectly".

StormCrawler's `MetadataTransfer` keeps one path (`url.path`). Crawlee and Scrapy keep none.

## Considered Options

- **Keep one route, `listingUrl`.** Cases 1 to 4 then have no answer.
- **A separate kind of crawl entry for the routes.** Each consumer then must recognize one more kind, and the routes are no longer next to the read that gave them.
- **Give each read's routes on its entry.** This option was selected.

## Consequences

- `listingUrl` keeps its meaning: the response that first named the page.
- `robots.txt` rules do not filter the routes. The rules apply to requests, and a route records what a response that the crawl could read names. The crawl reads the `robots.txt` of an origin only before its first request there, so a filter would need another request.
- A large sitemap gives a large entry: every entry that the scope keeps is a route.
- `CrawlError.page` replaces `CrawlFailure.page`, so a host that gets only the error can tell a page from a document.
