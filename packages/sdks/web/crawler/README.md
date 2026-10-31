# Web crawler

Find pages on the public web from the websites, sitemaps and feeds you choose. One engine downloads; readers read responses and find more URLs. There is no elt dependency.

```ts
import { readFile, writeFile } from 'node:fs/promises';

import got from 'got';

import {
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from '@workspace/sdk-web-crawler';

const crawler = new WebCrawler(got.extend({ timeout: { request: 30_000 } }), [
  new ListingReader(),
  new ArchiveReader(),
  new PaginationReader(),
  new LinkReader({ maxDepth: 3, maxPages: 100 }),
]);
const memento = await readFile('crawl.json', 'utf8').then(
  JSON.parse,
  () => null,
);
const crawl = crawler.crawl(['https://example.com/news'], memento, {
  signal: AbortSignal.timeout(600_000),
});
for await (const entry of crawl) {
  if ('progress' in entry) continue; // a URL read for the readers
  if ('deferred' in entry) continue; // a known page that is not due
  if ('error' in entry)
    console.error(entry.error); // CrawlError: url, cause
  else console.log(entry.url, entry.change, entry.response.statusCode);
}
await writeFile('crawl.json', JSON.stringify(crawl.snapshot()));
```

## Engine

`WebCrawler` owns the crawl frontier: the URLs still to download, and every URL already pending or downloaded. It downloads each URL once through the Got client you supply. Got owns redirects, retries, timeouts and caching. The engine paces each origin: its `Crawl-delay` and its slowdown. The engine gives each response to every reader, in the order you list them, and adds what they find to the frontier. It has no format knowledge.

- **Starting URLs** are downloaded and read. A starting URL is handed back as a page only when a reader finds it as one, such as a sitemap that lists it, a page that links it, or `StartReader`, as Nutch and StormCrawler treat a seed like any other URL. A failed starting URL is an error.
- **Pages** are URLs a reader marks as pages. The crawl hands back a page with its Got response when the page matches `include`, or always when you omit `include`. The engine downloads a page that does not match only when a reader `wants` it.
- **Documents** are URLs a reader reads itself, such as sitemaps.
- **Lists** are HTML pages that list pages, such as archives. Only the reader that finds a URL knows it is a list, so it says so on its finding; the engine carries that to the request, and a reader of lists reads every request that a reader found as a list. A list can also be a page.
- **Priorities**: every finding has one. Starting URLs and listings (`robots.txt`, sitemaps, feeds) go strictly first, so their provenance, `lastModified` and `published` reach pages before the pages download. Pages, links and archive backfill then share the downloads by smooth weighted round-robin, 4:2:1: the deterministic form of the biased front-queue selector in a crawl frontier (Introduction to Information Retrieval §20.2.3). Backfill never blocks new pages and still progresses. A URL found again with a more urgent priority moves up.
- **Provenance**: `listingUrl` is the final URL of the response that first named the URL. `lastModified` is the raw text of the listing's modification hint: a sitemap's `lastmod`, an Atom entry's `updated` or a JSON Feed item's `date_modified`. `published` is when the listing says the page was published: an RSS item's `pubDate` (RFC 822), an Atom entry's `published` or a JSON Feed item's `date_published` (RFC 3339), read by `Date` and given in ISO 8601 UTC, or null when the listing gives none or `Date` cannot read it. A modification is not a publication, so an Atom entry with only `updated` has no `published`. A listing's provenance replaces a link's while the URL is pending.
- **Hops** count ordinary links from a starting or listed page. When a URL is both a document and a page, its page findings decide its hops. `LinkReader` limits them.
- **Expand**: the engine marks how readers expand each request, in `request.expand` ([ADR 0003](./docs/adr/0003-a-page-that-a-list-hands-back-on-another-origin-is-expanded-one-step.md)). A starting URL is `'origin'`: readers expand its origin within their limits. When you give `expand` URL patterns, a page that a list hands back on an origin that no starting URL names is a one-step page, `'step'`: `LinkReader` finds its links on every origin, and `ListingReader` reads its declarations and the `robots.txt` of its origin. From a one-step page, the engine keeps only the pages and lists that match `expand`. It keeps every document, such as `robots.txt`, a sitemap index and a sitemap, and it applies the same rule to their findings. The engine expands nothing that an expansion found. A sitemap entry or a feed item on another origin is not a one-step page. The crawl downloads a one-step page only when `include` selects it or a reader wants it. Without `expand`, the crawl expands only the starting origins. The memento keeps the marks and the starting origins.
- **Failures**: a reader states which statuses are ordinary answers for each URL it finds, for example 404 for a dead link. Any other failure is handed out as `{ url, listingUrl, lastModified, published, error, page }`, and the crawl continues. `page` is true when the failed URL is a page the crawl would have handed back. The memento keeps every failed URL, and the revisit policy makes it due again. A 429 that the entry does not tolerate, after Got's own retries, or a run of three 403s from one origin, is a block of the host, not a failure of the page; a single 403 can close one page, such as a members-only one, so it stays a failure of that page: a circuit breaker (Nygard, _Release It!_) opens for the response URL's origin, and for the URL's own origin when a redirect led there, until its `Retry-After`, in seconds or as an HTTP-date (RFC 9110 §10.2.3), or for one hour without one. The crawl hands out one failure that names the origin, the status and the time the breaker closes, and then requests nothing more on that origin, as Nutch's `fetcher.max.exceptions.per.queue` clears a host's queue for the round. The blocked URL and every later URL of the origin stay pending and spend no reader budget; the revisit policy does not schedule them. Other origins continue. When only blocked URLs remain, the crawl ends unfinished: it hands out no deferred pages, `snapshot().crawl` keeps the frontier and the breakers, and `nextDue()` gives when the first breaker closes. A resumed crawl compares the breakers with the clock when it runs, and downloads the URLs of each closed one. A reader that throws, such as on a malformed declared sitemap, produces a failure for that URL with `page: false`; the other readers still read the response, and a page is still handed back. Cancellation throws the signal's exact reason.
- **Robots**: before its first request to an origin, the crawl reads that origin's `robots.txt` through the same Got client, so its HTTP cache applies, and parses it with `robots-parser` (RFC 9309). It asks an origin nothing for a URL that it does not need: a URL that is not a starting URL, a document or a page that `include` selects, and that no reader admits, is dropped before the crawl reads the rules of its origin, as Scrapy drops an off-site request before its robots.txt check. The rules last for the crawl; a resumed crawl reads them again. The crawl matches the groups by the product token of the client's `user-agent` header: `WhatIsGoingOn/0.1 (+https://example.com)` obeys the group `User-agent: WhatIsGoingOn`, or the `*` group when no group names that token or the client sends no `user-agent`. Groups for other crawlers, such as `ClaudeBot`, do not apply. A URL that the rules disallow is not requested, starting URLs included. The crawl also reads Cloudflare's `Content-Signal` line in that group (`Content-Signal: search=yes, ai-train=no`), which `robots-parser` ignores. The crawl indexes pages and gives their links and titles, which is the `search` use, so `search=no` disallows every URL of the origin. Other signals, and a group with no `search` signal, change nothing. It is no failure, and the revisit policy does not schedule it. `robots.txt` itself is always allowed. A 4xx answer, or more than five redirects, allows everything. A 5xx answer or a network error disallows everything for now: the origin's breaker opens as for a 429, with one failure that names the origin, until `Retry-After` or for one hour. A `Crawl-delay` for the user agent, which Bing and Yandex honor and RFC 9309 does not define, spaces the starts of two requests to the origin by that many seconds, at most 60; cancellation stops the wait.
- **Slowdown**: an origin that refuses requests gets a slowdown, as Google's crawler lowers its crawl rate for a host that answers 429 or 5xx. Each refusal doubles the origin's slowdown, from one second up to one minute. A refusal is an answer of 429 or any 5xx that the entry does not tolerate, `robots.txt` included, and each attempt that Got retried before the answer because it answered 429 or 5xx. A retry after a network error, such as a dropped connection, or after a 408 is no refusal, because the site refused nothing. Each other answer shortens the slowdown by a tenth, and a slowdown under 100 ms ends. Before each request, the crawl waits out the longer of the origin's `Crawl-delay` and its slowdown since the last request to the origin started. The memento keeps the slowdowns beside the URLs, so a later crawl, also after a complete one, starts at the slowdown that the last crawl left.
- **Identity**: fragments are removed. Queries and trailing slashes stay meaningful. Each found URL is requested once per role it adds: when a reader finds a downloaded URL as a page that `include` selects, or as a list, and the download was not one, the crawl requests it again with both roles, and Got's cache makes that a revalidation. A page that `include` does not select adds no role, because the crawl does not hand it back. A starting URL is already read as a list, so a list finding adds no role to it: page 2 of a tag page links page 1 as pagination, and page 1 is the starting URL. A URL is handed back as a page at most once per crawl, also across a snapshot. `url` is the URL as found, and `response.url` is the final URL.
- Got hooks can read `options.context.page`. It is true when the download is a page handed back and no reader reads it as a document. It is false for starting URLs, documents and pages downloaded only for a reader, so a feed that is also a page keeps the representation its reader needs.
- **Progress**: every downloaded URL that is not handed back as a page or failure produces `{ progress: url }`. Take a snapshot there to keep the work done on documents.

`crawl(starts, memento, { signal, include, expand })` continues the memento's unfinished crawl, or starts a new crawl. A null memento knows no URL. `crawl.snapshot()` returns the memento as plain data: the unfinished crawl, or null once it is complete, every URL that a crawl visited, with its body digest and when it is due again, and the slowdown of each origin that refused requests. The entry handed out last stays pending in a snapshot until you request the next one, so a snapshot taken at any time loses nothing; an older snapshot only repeats some work. Storage of the memento is yours.

## Revisits

A new crawl requests the starting URLs and every URL that its readers find. A known URL that is not due stays out of the crawl, whatever finds it; it spends no reader budget. A known URL that is due and that no listing names in this crawl goes in after the crawl's own findings, as in Nutch's generate step, so a page that leaves every listing is not lost. Starting URLs are always due, because readers learn from them, such as `LinkReader`'s origins.

- **Change**: the crawler compares the SHA-256 of each body with the last one. A handed-back page carries `change`: `unknown` on its first download or after a failure, then `modified` or `unmodified`.
- **Deferred**: after the pages, the crawl hands out `{ deferred: { url, listingUrl, lastModified, published } }` for each known page that matches `include`, that it did not request, and whose last download succeeded. The page still exists, unchanged as far as the crawl knows.
- **Fail**: `crawl.fail(url)` tells the crawler that you could not use a page it handed back, so the page is due again as a failed one. This is a negative acknowledgement.
- **Timing**: a visit is timed at the start of its crawl, so a URL due one interval later is due in the crawl that starts then.
- **Next crawl**: `crawl.nextDue()` gives when the next crawl has a known URL due, starting URLs included, or null when none ever is. Start the next crawl then. For a crawl that blocked hosts left unfinished, it gives when the first breaker closes.
- **Feed window**: a feed rolls its oldest items off. `ListingReader` measures the time its items cover, from the oldest publication date to the newest, and the feed is due again within half that time, whatever the policy. A reader gives such a limit for the URL it reads with `visit.revisitWithin(ms)`.

A `RevisitPolicy` decides when a URL is due; the third argument of `new WebCrawler` sets it, and `AdaptiveRevisit` is the default. A listing that gives a page another `lastModified` than at the last visit makes the page due at once. In the policies below, which extend `IntervalRevisit`, a failed URL is due two hours later, as StormCrawler's `fetchInterval.fetch.error`, and a gone URL, 404 or 410, a day later, as Nutch asks gone pages again.

| Policy              | A URL is due                                                                                                                                                                                                                 | Use it when                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdaptiveRevisit`   | One day after its first download; then the interval grows by half while the body is unchanged, up to 14 days, and moves halfway to one hour when it changed (StormCrawler's `AdaptiveScheduler`)                             | You do not know how often the pages change, such as a blog whose new posts change and whose old posts do not                                                     |
| `FixedRevisit`      | One fixed interval after each visit (Nutch's `DefaultFetchSchedule`)                                                                                                                                                         | Every page needs one fixed freshness, such as a news site checked every hour                                                                                     |
| `HintRevisit`       | When its response stops being fresh by the lifetime its server declares (RFC 9111: `Cache-Control: max-age`, `Expires`, or the heuristic from `Last-Modified`), between one hour and 14 days; a day when it declares nothing | The server's cache headers tell the truth, such as documentation sent with `max-age=86400`                                                                       |
| `ChangeRateRevisit` | After the estimated time between its changes, from how many compared visits found a change (Cho and Garcia-Molina's estimator), between one hour and 14 days                                                                 | A watch runs for months and each page's own history counts, such as a catalog where some pages change daily and some never                                       |
| `OnceRevisit`       | Never again after a download that succeeded, as a request queue keeps the detail pages it handled; a failed or gone URL as in the other interval policies                                                                    | Each page is read once and its later changes do not matter, such as the listings of a marketplace, where only the category pages are read again for new listings |
| `AlwaysRevisit`     | In every crawl, failed and gone URLs too, as a full refresh needs                                                                                                                                                            | Every crawl must see every page, as a full refresh does; not for a watch, which then crawls again at once                                                        |

`CompositeRevisit` routes each URL to the policy of the first `URLPattern` that matches it, or to a fallback. Use it when parts of one website need different policies, for example `FixedRevisit` every hour for `/news/*` and `AdaptiveRevisit` for the rest. A website whose markup differs on each request, such as a page that streams scripts with request-specific values, makes every body look changed, so `AdaptiveRevisit` moves its pages toward one hour; give such pages `OnceRevisit` or `FixedRevisit`. Each routed policy keeps its own failure rule and history.

A policy schedules nothing: it only gives each known URL the time it is due. A crawl starts when the caller starts it, for example `pipeline.run()` from a sync button or the host's own scheduler, or when `Pipeline.watch()` wakes at `crawl.nextDue()`. A crawl requests only the known URLs that are due then.

A policy's history is plain data that its `histories` schema parses, so the memento can carry it. For another rule, extend `IntervalRevisit` and implement `visited`, or extend `RevisitPolicy` and implement `schedule` to decide failed and gone URLs too. Override `due` to read a hint before the download. See [Write your own revisit policy](./docs/recipes/write-your-own-revisit-policy.md).

## Readers

Each reader finds one kind of URL ([ADR 0001](./docs/adr/0001-one-engine-downloads-and-each-reader-finds-one-kind-of-url.md)). The engine marks which requests the readers expand: the starting URLs, and the one-step pages when you give `expand` ([ADR 0003](./docs/adr/0003-a-page-that-a-list-hands-back-on-another-origin-is-expanded-one-step.md)). The words are in [CONTEXT.md](./CONTEXT.md).

| Reader             | Reads                                                         | Finds                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ListingReader`    | Starting and one-step pages, `robots.txt`, sitemaps and feeds | Feed and sitemap declarations in HTML and HTTP `Link` headers, labeled feed anchors, `robots.txt` sitemaps, a `/sitemap.xml` guess, and the pages, child sitemaps and pagination of XML url sets and indexes, text lists, RSS 2.0, Atom, RSS 1.0/RDF and JSON Feed |
| `ArchiveReader`    | Every HTML page                                               | Archives that the page links, as lists: `rel="archives"`, archive paths, year and month indexes, and labels such as "Older posts"                                                                                                                                  |
| `PaginationReader` | Starting pages and lists                                      | The pages each list links outside `nav`, `footer` and navigation landmarks, and its pagination (`rel="next"`, `prev`, `next-archive`, `prev-archive` in link elements, anchors and HTTP `Link` headers, and links to its other page numbers), as lists             |
| `LinkReader`       | HTML and Markdown pages                                       | Anchors and Markdown links on the starting pages' origins, and on every origin from a one-step page                                                                                                                                                                |
| `StartReader`      | Starting pages                                                | Each starting URL itself, as a page                                                                                                                                                                                                                                |

`ListingReader` documents have the `listing` priority and the pages they list `page`. `ArchiveReader` archives and `PaginationReader` pagination are `backfill`, and the pages they list `page`. `LinkReader` links are `link`. `StartReader` starting pages are `page`.

`StartReader` is for a host whose starting URLs are the pages to read, such as a home page whose menu lists the categories of a site. Used alone, it hands back each starting URL and requests no other page. The crawl downloads a starting URL a second time to hand it back as a page, so a page without an ETag or a Last-Modified header costs two downloads.

`ListingReader` reads every listing completely, wherever it was declared. On a page that is not a starting page or a one-step page, a cross-origin feed needs an explicit declaration or Feedscout's feed URL hints. A declared listing that fails or is malformed is an error. A possible feed, such as a labeled anchor or a generic JSON alternate, is read only when Feedscout's `defaultExtractFn` validates it. A missing `robots.txt` is ordinary. The `/sitemap.xml` guess happens when `robots.txt` lists no sitemap, the starting or one-step page declares no listing, and no listing was read before it in the crawl. A missing or unreadable guess, such as a soft 404 page, is ignored.

`ArchiveReader` guesses archives on every HTML page and finds them as lists; it lists no pages and follows no pagination, so give `PaginationReader` with it. Discovered archives that return 404 or 410 are skipped. A calendar archive has a year from 1900 to next year at the start of its path, after at most a language code and one blog section, such as `/2026/Oct/`, `/blog/2024/` or `/en/2023/05/`; a year anywhere else, such as a model-year filter, and a number out of those years, such as `/products/2048`, are pages. Calendar months match 1–12 or English month names from the platform's date formatter.

`PaginationReader` reads lists. It reads the starting pages, the URLs another reader found as lists, such as `ArchiveReader`'s archives, and the pages that their pagination reaches. It hands back the pages each list links and follows the list's pagination completely; the links of other pages do not change the crawl. A list without pagination still lists its pages. A listed page that returns 404 or 410 is skipped, such as a sold listing that a category still links. Use it alone when the site's paths only look like archives: OpenSooq's year filters, such as `/en/cars/motorcycles/2024`, end in a year.

Many sites declare no `rel="next"`. Fortune, Ars Technica and Google DeepMind link page 2 of a tag page as `/tag/anthropic/page/2/`. Thus a link from a list to the same list with another page number is pagination too. The page number has one of the forms that content management systems use: `/page/N/` (WordPress, Ghost, Hugo), `?page=N` (Django, Drupal) and `?paged=N` (WordPress). A trailing slash does not change the list. A year, a filter or another list's page, such as `/tag/anthropic/2024`, `/tag/anthropic/?sort=new` or `/tag/openai/page/2/`, is not pagination. When a site uses another form, give it: `new PaginationReader({ pagination: [new URLPattern({ pathname: '/tag/:tag/page:n/' })] })` follows jekyll-paginate's `/page2/`, and then the page-number rule is off. A declared `rel="next"` page that fails is an error. A page that only a link or a form names, such as Fortune's linked `/page/0/` that returns 404, is skipped when it returns 404 or 410.

A list hands back the pages it links on its own origin: the strategy `'same-origin'`, the default. Give the strategy `'all'` for a list whose links go to other origins, as Crawlee's enqueue strategy `all`: `new PaginationReader({ strategy: 'all' })` hands back the posts on blog.google that the cards of deepmind.google/blog link. The caller's `include` still selects the pages that the crawl hands back, and a link that it does not select costs its website no request, not even for its `robots.txt`. Pagination stays on the list's own origin. To leave out one website, such as the list's own, give a pattern with a negative lookahead in a regular expression group: see [Follow a list to other websites](./docs/recipes/follow-a-list-to-other-websites.md). When the page you want is not the page that the list links, but is on its website or one link away, give `expand`: see [Search inside the sites a list links](./docs/recipes/search-inside-the-sites-a-list-links.md).

`LinkReader({ maxDepth, maxPages })` takes non-negative safe integers. Pages at zero hops always contribute links: starting pages, and the pages and lists that a listing or a list at zero hops names. Any other page contributes links only when `LinkReader` admits it: within `maxDepth` hops, on a starting origin, and within `maxPages` admitted pages. Admission happens before the download, so `maxPages` also counts admitted pages that fail or are not HTML. A linked page that returns 404 or 410 is skipped. A one-step page contributes its links on every origin, and the engine keeps only the links that match `expand`; `LinkReader` admits none of them, because the engine expands nothing that an expansion found.

Readers decode HTML and Markdown pages by their byte order mark, their `Content-Type` charset or their `<meta charset>`, in that order (the WHATWG encoding sniffing algorithm, through `html-encoding-sniffer`). An unlabeled page is read as UTF-8; bytes that do not decode become U+FFFD rather than failing the page. Listings are decoded as UTF-8, as the sitemaps protocol requires.

No JavaScript runs. Article extraction, checkpoints and destinations are outside this package.

## Recipes

One use case each, with a full program that you can run.

1. [Resume an interrupted crawl](./docs/recipes/resume-an-interrupted-crawl.md)
2. [Check some pages every hour and the rest by change](./docs/recipes/check-some-pages-every-hour.md)
3. [Write your own revisit policy](./docs/recipes/write-your-own-revisit-policy.md)
4. [Crawl a website that rate-limits you](./docs/recipes/crawl-a-website-that-rate-limits-you.md)
5. [Follow a list to other websites](./docs/recipes/follow-a-list-to-other-websites.md)
6. [Search inside the sites a list links](./docs/recipes/search-inside-the-sites-a-list-links.md)
7. [Sync again the next day](../../../sources/web/pages/docs/recipes/sync-again-the-next-day.md), with `@workspace/source-web-pages`
8. [Refresh from a Sync button or a watch](../../../sources/web/pages/docs/recipes/refresh-from-a-sync-button-or-a-watch.md), with `@workspace/source-web-pages`

## Package ownership

| Public API                       | Responsibility                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Got                              | HTTP, redirects, decompression, retries, timeouts, caching, cancellation         |
| `@workspace/codec-sitemap`       | Gzip and text decoding, XML url sets and indexes, RSS and Atom items, text lists |
| `@crawlee/utils` `RobotsTxtFile` | `robots.txt` sitemap declarations                                                |
| `robots-parser`                  | `robots.txt` rules and `Crawl-delay` for the engine                              |
| `feedscout`                      | Feed and sitemap declarations, anchors, HTTP `Link` headers, feed validation     |
| Feedsmith, `fast-xml-parser`     | JSON Feed and RDF items, feed pagination, strict RDF validation                  |
| jsdom                            | Archive HTML                                                                     |
| `html-encoding-sniffer`          | Page encoding: byte order mark, transport charset, `<meta>` prescan              |
| `marked`                         | Markdown links                                                                   |
| zod                              | Snapshot validation                                                              |

Crawlee's `RequestQueue` is not used: it cannot list pending requests without taking them, so it cannot give a snapshot.

## Verification

```sh
nx run sdk-web-crawler:test
nx run sdk-web-crawler:typecheck
```
