# Web links

Follow links on the public web and consume downloaded pages. `WebLinks` owns traversal, deduplication and its per-call queue. Got owns HTTP, redirects, retries, timeouts, caching and rate limiting. There is no elt dependency.

```ts
import got from 'got';

import { WebLinks } from '@workspace/sdk-web-links';

const http = got.extend({ timeout: { request: 30_000 } });
const links = new WebLinks(http, { maxDepth: 3, maxPages: 100 });

for await (const page of links.crawl(['https://example.com/category'], {
  signal: AbortSignal.timeout(120_000),
})) {
  // page: { url, listingUrl, lastModified, response }
  // response is the original Got response; response.rawBody contains its bytes.
}
```

`crawl(inputs, { signal })` accepts an iterable of absolute HTTP(S) URL strings, existing Got responses, or page locations (`{ url, listingUrl, lastModified }`). Downloaded starting responses are reused unchanged, including responses whose `body` is a string. URL inputs are fetched with `responseType: 'buffer'`. Starting pages are included in the output. A location retains its supplied metadata; a URL or response starts with its own URL as provenance and `lastModified: null`.

All starting inputs enter one queue before traversal. Duplicate URLs keep their first provenance. Fragments are removed; query order and trailing slashes remain meaningful. Output uses the final response URL. Known redirect targets are emitted once; previously unknown redirect aliases can still cause an additional HTTP request. Each successful HTML starting response establishes an allowed origin. Ordinary anchors, navigation and archive links stay on that origin, resolve against the response URL and honor HTML `<base>`.

The iterator applies backpressure: it fetches another page only when the consumer requests another result. Breaking the loop drops the queue. Exhaustion, errors and cancellation also dispose it. Each call has fresh state, so sequential and concurrent calls on one instance are independent. The supplied HTTP client and its cache resources remain caller-owned.

## Limits and feeds

`maxDepth` and `maxPages` are non-negative safe integers that bound **additional page expansion**, not downloads or output count. Starting HTML pages always contribute links. Their children are at depth 1. With `maxDepth: 1`, children can contribute links but grandchildren cannot. `maxPages` counts additional eligible pages admitted for expansion, including requests that later fail or return non-HTML. Zero disables expansion beyond the starting pages; their direct candidates are still downloaded and emitted.

Expanded HTML can advertise RSS, Atom, RDF, JSON feeds or sitemaps through markup and HTTP Link headers. Each secondary listing contributes one document's page URLs; pagination and child sitemaps are not traversed. Explicit feed declarations are required to be readable. Heuristic candidates are validated with Feedscout; non-feeds are ignored as feeds but can still be ordinary page links. Cross-origin feed hints require a declaration or Feedscout's feed URL/path hints. Pages from remote feeds are emitted, but cannot expand an unseeded origin. A listing read only for discovery is not emitted as a page.

There is no robots/sitemap guessing, primary listing pagination, article extraction, JavaScript execution or checkpoint storage. Those are separate responsibilities. An input response is a starting page, not a request for primary feed discovery.

## Failures

Got's configured retry policy applies. Discovered page requests returning 404/410 are skipped. Missing starting pages and explicitly declared listings remain errors. Independent page and listing failures are collected while other queued work continues; after the crawl drains, it throws an `AggregateError` containing `CrawlError` entries with the failing `url` and original `cause`. A later call starts fresh and can retry them. Cancellation immediately throws the caller's exact abort reason. Queue failures stop traversal.

## Duplication ledger

The existing discovery package and its consumers remain unchanged while this standalone API is built. `web-url.ts`, feed declaration selection in `read-links.ts`, and JSON/RDF listing parsing in `read-listing.ts` retain the existing discovery rules here as a second implementation. Primary discovery needs complete listings and pagination; this crawler needs only the linked document's pages. The shared sitemap codec and installed Feedscout APIs already own their common format behavior. Revisit these small overlaps when migrating the existing consumers, rather than adding a dependency on the old traversal API.
