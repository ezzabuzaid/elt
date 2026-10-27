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

`WebCrawler` owns the crawl frontier: the URLs still to download, and every URL already pending or downloaded. It downloads each URL once through the Got client you supply. Got owns redirects, retries, timeouts, caching and rate limiting. The engine gives each response to every reader, in the order you list them, and adds what they find to the frontier. It has no format knowledge.

- **Starting URLs** are downloaded and read. A starting URL is handed back as a page only when a reader finds it as one, such as a sitemap that lists it or a page that links it, as Nutch and StormCrawler treat a seed like any other URL. A failed starting URL is an error.
- **Pages** are URLs a reader marks as pages. The crawl hands back a page with its Got response when the page matches `include`, or always when you omit `include`. The engine downloads a page that does not match only when a reader `wants` it.
- **Documents** are URLs a reader reads itself, such as sitemaps.
- **Lists** are HTML pages that list pages, such as archives. Only the reader that finds a URL knows it is a list, so it says so on its finding; the engine carries that to the request, and a reader of lists reads every request that a reader found as a list. A list can also be a page.
- **Priorities**: every finding has one. Starting URLs and listings (`robots.txt`, sitemaps, feeds) go strictly first, so their provenance and `lastModified` reach pages before the pages download. Pages, links and archive backfill then share the downloads by smooth weighted round-robin, 4:2:1: the deterministic form of the biased front-queue selector in a crawl frontier (Introduction to Information Retrieval §20.2.3). Backfill never blocks new pages and still progresses. A URL found again with a more urgent priority moves up.
- **Provenance**: `listingUrl` is the final URL of the response that first named the URL. A listing's provenance replaces a link's while the URL is pending.
- **Hops** count ordinary links from a starting or listed page. When a URL is both a document and a page, its page findings decide its hops. `LinkReader` limits them.
- **Failures**: a reader states which statuses are ordinary answers for each URL it finds, for example 404 for a dead link. Any other failure is handed out as `{ url, listingUrl, lastModified, error, page }`, and the crawl continues. `page` is true when the failed URL is a page the crawl would have handed back. The memento keeps every failed URL, and the revisit policy makes it due again. A 429 that the entry does not tolerate, after Got's own retries, or a run of three 403s from one origin, is a block of the host, not a failure of the page; a single 403 can close one page, such as a members-only one, so it stays a failure of that page: a circuit breaker (Nygard, _Release It!_) opens for the response URL's origin, and for the URL's own origin when a redirect led there, until its `Retry-After`, in seconds or as an HTTP-date (RFC 9110 §10.2.3), or for one hour without one. The crawl hands out one failure that names the origin, the status and the time the breaker closes, and then requests nothing more on that origin, as Nutch's `fetcher.max.exceptions.per.queue` clears a host's queue for the round. The blocked URL and every later URL of the origin stay pending and spend no reader budget; the revisit policy does not schedule them. Other origins continue. When only blocked URLs remain, the crawl ends unfinished: it hands out no deferred pages, `snapshot().crawl` keeps the frontier and the breakers, and `nextDue()` gives when the first breaker closes. A resumed crawl compares the breakers with the clock when it runs, and downloads the URLs of each closed one. A reader that throws, such as on a malformed declared sitemap, produces a failure for that URL with `page: false`; the other readers still read the response, and a page is still handed back. Cancellation throws the signal's exact reason.
- **Identity**: fragments are removed. Queries and trailing slashes stay meaningful. Each found URL is requested once per role it adds: when a reader finds a downloaded URL as a page or a list and the download was not one, the crawl requests it again with both roles, and Got's cache makes that a revalidation. A URL is handed back as a page at most once per crawl, also across a snapshot. `url` is the URL as found, and `response.url` is the final URL.
- Got hooks can read `options.context.page`. It is true when the download is a page handed back and no reader reads it as a document. It is false for starting URLs, documents and pages downloaded only for a reader, so a feed that is also a page keeps the representation its reader needs.
- **Progress**: every downloaded URL that is not handed back as a page or failure produces `{ progress: url }`. Take a snapshot there to keep the work done on documents.

`crawl(starts, memento, { signal, include })` continues the memento's unfinished crawl, or starts a new crawl. A null memento knows no URL. `crawl.snapshot()` returns the memento as plain data: the unfinished crawl, or null once it is complete, and every URL that a crawl visited, with its body digest and when it is due again. The entry handed out last stays pending in a snapshot until you request the next one, so a snapshot taken at any time loses nothing; an older snapshot only repeats some work. Storage of the memento is yours.

## Revisits

A new crawl requests the starting URLs and every URL that its readers find. A known URL that is not due stays out of the crawl, whatever finds it; it spends no reader budget. A known URL that is due and that no listing names in this crawl goes in after the crawl's own findings, as in Nutch's generate step, so a page that leaves every listing is not lost. Starting URLs are always due, because readers learn from them, such as `LinkReader`'s origins.

- **Change**: the crawler compares the SHA-256 of each body with the last one. A handed-back page carries `change`: `unknown` on its first download or after a failure, then `modified` or `unmodified`.
- **Deferred**: after the pages, the crawl hands out `{ deferred: { url, listingUrl, lastModified } }` for each known page that matches `include`, that it did not request, and whose last download succeeded. The page still exists, unchanged as far as the crawl knows.
- **Fail**: `crawl.fail(url)` tells the crawler that you could not use a page it handed back, so the page is due again as a failed one. This is a negative acknowledgement.
- **Timing**: a visit is timed at the start of its crawl, so a URL due one interval later is due in the crawl that starts then.
- **Next crawl**: `crawl.nextDue()` gives when the next crawl has a known URL due, starting URLs included, or null when none ever is. Start the next crawl then. For a crawl that blocked hosts left unfinished, it gives when the first breaker closes.
- **Feed window**: a feed rolls its oldest items off. `ListingReader` measures the time its items cover, from the oldest publication date to the newest, and the feed is due again within half that time, whatever the policy. A reader gives such a limit for the URL it reads with `visit.revisitWithin(ms)`.

A `RevisitPolicy` decides when a URL is due; the third argument of `new WebCrawler` sets it, and `AdaptiveRevisit` is the default. A listing that gives a page another `lastModified` than at the last visit makes the page due at once. In the policies below, which extend `IntervalRevisit`, a failed URL is due two hours later, as StormCrawler's `fetchInterval.fetch.error`, and a gone URL, 404 or 410, a day later, as Nutch asks gone pages again.

| Policy              | A URL is due                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdaptiveRevisit`   | One day after its first download; then the interval grows by half while the body is unchanged, up to 14 days, and moves halfway to one hour when it changed (StormCrawler's `AdaptiveScheduler`)                             |
| `FixedRevisit`      | One fixed interval after each visit (Nutch's `DefaultFetchSchedule`)                                                                                                                                                         |
| `HintRevisit`       | When its response stops being fresh by the lifetime its server declares (RFC 9111: `Cache-Control: max-age`, `Expires`, or the heuristic from `Last-Modified`), between one hour and 14 days; a day when it declares nothing |
| `ChangeRateRevisit` | After the estimated time between its changes, from how many compared visits found a change (Cho and Garcia-Molina's estimator), between one hour and 14 days                                                                 |
| `AlwaysRevisit`     | In every crawl, failed and gone URLs too, as a full refresh needs                                                                                                                                                            |

`CompositeRevisit` routes each URL to the policy of the first `URLPattern` that matches it, or to a fallback, for example `FixedRevisit` for a feed and `AdaptiveRevisit` for its articles. Each routed policy keeps its own failure rule and history.

A policy's history is plain data that its `histories` schema parses, so the memento can carry it. For another rule, extend `IntervalRevisit` and implement `visited`, or extend `RevisitPolicy` and implement `schedule` to decide failed and gone URLs too. Override `due` to read a hint before the download.

## Readers

| Reader             | Reads                                            | Finds                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ListingReader`    | Starting pages, `robots.txt`, sitemaps and feeds | Feed and sitemap declarations in HTML and HTTP `Link` headers, labeled feed anchors, `robots.txt` sitemaps, a `/sitemap.xml` guess, and the pages, child sitemaps and pagination of XML url sets and indexes, text lists, RSS 2.0, Atom, RSS 1.0/RDF and JSON Feed |
| `ArchiveReader`    | Every HTML page                                  | Archives that the page links, as lists: `rel="archives"`, archive paths, year and month indexes, and labels such as "Older posts"                                                                                                                                  |
| `PaginationReader` | Starting pages and lists                         | The pages each list links outside `nav`, `footer` and navigation landmarks, and its pagination (`rel="next"`, `prev`, `next-archive`, `prev-archive` in link elements, anchors and HTTP `Link` headers), as lists                                                  |
| `LinkReader`       | HTML and Markdown pages                          | Anchors and Markdown links on the starting pages' origins                                                                                                                                                                                                          |

`ListingReader` documents have the `listing` priority and the pages they list `page`. `ArchiveReader` archives and `PaginationReader` pagination are `backfill`, and the pages they list `page`. `LinkReader` links are `link`.

`ListingReader` reads every listing completely, wherever it was declared. On a page that was not a starting page, a cross-origin feed needs an explicit declaration or Feedscout's feed URL hints. A declared listing that fails or is malformed is an error. A possible feed, such as a labeled anchor or a generic JSON alternate, is read only when Feedscout's `defaultExtractFn` validates it. A missing `robots.txt` is ordinary. The `/sitemap.xml` guess happens when `robots.txt` lists no sitemap, the starting page declares no listing, and no listing was read before it. A missing or unreadable guess, such as a soft 404 page, is ignored.

`ArchiveReader` guesses archives on every HTML page and finds them as lists; it lists no pages and follows no pagination, so give `PaginationReader` with it. Discovered archives that return 404 or 410 are skipped. A calendar archive has a year from 1900 to next year at the start of its path, after at most a language code and one blog section, such as `/2026/Oct/`, `/blog/2024/` or `/en/2023/05/`; a year anywhere else, such as a model-year filter, and a number out of those years, such as `/products/2048`, are pages. Calendar months match 1–12 or English month names from the platform's date formatter.

`PaginationReader` reads lists and guesses nothing. It reads the starting pages, the URLs another reader found as lists, such as `ArchiveReader`'s archives, and the pages that their pagination reaches. It hands back the pages each list links and follows the list's pagination completely; the links of other pages do not change the crawl. A list without pagination still lists its pages. A listed page that returns 404 or 410 is skipped, such as a sold listing that a category still links; a pagination page that fails is an error. Use it alone when the site's paths only look like archives: OpenSooq's year filters, such as `/en/cars/motorcycles/2024`, end in a year.

`LinkReader({ maxDepth, maxPages })` takes non-negative safe integers. Pages at zero hops always contribute links: starting pages, and the pages and lists that a listing or a list at zero hops names. Any other page contributes links only when `LinkReader` admits it: within `maxDepth` hops, on a starting origin, and within `maxPages` admitted pages. Admission happens before the download, so `maxPages` also counts admitted pages that fail or are not HTML. A linked page that returns 404 or 410 is skipped.

Readers decode HTML and Markdown pages by their byte order mark, their `Content-Type` charset or their `<meta charset>`, in that order (the WHATWG encoding sniffing algorithm, through `html-encoding-sniffer`). An unlabeled page is read as UTF-8; bytes that do not decode become U+FFFD rather than failing the page. Listings are decoded as UTF-8, as the sitemaps protocol requires.

No JavaScript runs. Article extraction, checkpoints and destinations are outside this package.

## Package ownership

| Public API                       | Responsibility                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Got                              | HTTP, redirects, decompression, retries, timeouts, caching, cancellation         |
| `@workspace/codec-sitemap`       | Gzip and text decoding, XML url sets and indexes, RSS and Atom items, text lists |
| `@crawlee/utils` `RobotsTxtFile` | `robots.txt` sitemap declarations                                                |
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
