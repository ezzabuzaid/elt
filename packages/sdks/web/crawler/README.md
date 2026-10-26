# Web crawler

Find pages on the public web from the websites, sitemaps and feeds you choose. One engine downloads; readers read responses and find more URLs. There is no elt dependency.

```ts
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
const crawl = crawler.run(['https://example.com/news'], {
  signal: AbortSignal.timeout(600_000),
});
for await (const entry of crawl) {
  if ('progress' in entry) continue; // a URL read for the readers
  if ('error' in entry)
    console.error(entry.error); // CrawlError: url, cause
  else console.log(entry.url, entry.listingUrl, entry.response.statusCode);
}
```

## Engine

`WebCrawler` owns the crawl frontier: the URLs still to download, and every URL already pending or downloaded. It downloads each URL once through the Got client you supply. Got owns redirects, retries, timeouts, caching and rate limiting. The engine gives each response to every reader, in the order you list them, and adds what they find to the frontier. It has no format knowledge.

- **Starting URLs** are downloaded and read, but not handed back. A failed starting URL is an error.
- **Pages** are URLs a reader marks as pages. The crawl hands back a page with its Got response when the page matches `include`, or always when you omit `include`. The engine downloads a page that does not match only when a reader `wants` it.
- **Documents** are URLs a reader reads itself, such as sitemaps.
- **Lists** are HTML pages that list pages, such as archives. Only the reader that finds a URL knows it is a list, so it says so on its finding; the engine carries that to the request, and a reader of lists reads every request that a reader found as a list. A list can also be a page.
- **Priorities**: every finding has one. Starting URLs and listings (`robots.txt`, sitemaps, feeds) go strictly first, so their provenance and `lastModified` reach pages before the pages download. Pages, links and archive backfill then share the downloads by smooth weighted round-robin, 4:2:1: the deterministic form of the biased front-queue selector in a crawl frontier (Introduction to Information Retrieval §20.2.3). Backfill never blocks new pages and still progresses. A URL found again with a more urgent priority moves up.
- **Provenance**: `listingUrl` is the final URL of the response that first named the URL. A listing's provenance replaces a link's while the URL is pending.
- **Hops** count ordinary links from a starting or listed page. When a URL is both a document and a page, its page findings decide its hops. `LinkReader` limits them.
- **Failures**: a reader states which statuses are ordinary answers for each URL it finds, for example 404 for a dead link. Any other failure is handed out as `{ url, listingUrl, lastModified, error, page }`, and the crawl continues. `page` is true when the failed URL is a page the crawl would have handed back, so a caller can keep it for a later crawl; a failed listing is found again from the starting URLs. A reader that throws, such as on a malformed declared sitemap, produces a failure for that URL with `page: false`; the other readers still read the response, and a page is still handed back. Cancellation throws the signal's exact reason.
- **Identity**: fragments are removed. Queries and trailing slashes stay meaningful. Each found URL is requested once; `url` is the URL as found, and `response.url` is the final URL.
- Got hooks can read `options.context.page`. It is true when the download is a page handed back and no reader reads it as a document. It is false for starting URLs, documents and pages downloaded only for a reader, so a feed that is also a page keeps the representation its reader needs.
- **Progress**: every downloaded URL that is not handed back as a page or failure produces `{ progress: url }`. Take a snapshot there to keep the work done on documents.

`run(starts, { signal, include, pages })` starts a crawl. `pages` adds known pages, such as earlier failures, as listed pages ahead of other pages. `crawl.snapshot()` returns the crawl so far as plain data, and `crawler.resume(snapshot, { signal, include, pages })` continues it; `pages` there returns pages even when the snapshot already tried them. The entry handed out last stays pending in a snapshot until you request the next one, so a snapshot taken at any time loses nothing; an older snapshot only repeats some work. Storage of snapshots is yours.

## Readers

| Reader             | Reads                                            | Finds                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ListingReader`    | Starting pages, `robots.txt`, sitemaps and feeds | Feed and sitemap declarations in HTML and HTTP `Link` headers, labeled feed anchors, `robots.txt` sitemaps, a `/sitemap.xml` guess, and the pages, child sitemaps and pagination of XML url sets and indexes, text lists, RSS 2.0, Atom, RSS 1.0/RDF and JSON Feed |
| `ArchiveReader`    | Every HTML page                                  | Archives that the page links, as lists: `rel="archives"`, archive paths, year and month indexes, and labels such as "Older posts"                                                                                                                                  |
| `PaginationReader` | Starting pages and lists                         | The pages each list links outside `nav`, `footer` and navigation landmarks, and its pagination (`rel="next"`, `prev`, `next-archive`, `prev-archive` in link elements, anchors and HTTP `Link` headers), as lists                                                  |
| `LinkReader`       | HTML and Markdown pages                          | Anchors and Markdown links on the starting pages' origins                                                                                                                                                                                                          |

`ListingReader` documents have the `listing` priority and the pages they list `page`. `ArchiveReader` archives and `PaginationReader` pagination are `backfill`, and the pages they list `page`. `LinkReader` links are `link`.

`ListingReader` reads every listing completely, wherever it was declared. On a page that was not a starting page, a cross-origin feed needs an explicit declaration or Feedscout's feed URL hints. A declared listing that fails or is malformed is an error. A possible feed, such as a labeled anchor or a generic JSON alternate, is read only when Feedscout's `defaultExtractFn` validates it. A missing `robots.txt` is ordinary. The `/sitemap.xml` guess happens when `robots.txt` lists no sitemap, the starting page declares no listing, and no listing was read before it. A missing or unreadable guess, such as a soft 404 page, is ignored.

`ArchiveReader` guesses archives on every HTML page and finds them as lists; it lists no pages and follows no pagination, so give `PaginationReader` with it. Discovered archives that return 404 or 410 are skipped. Calendar months match 1–12 or English month names from the platform's date formatter.

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
