# Web discovery

Discover candidate page URLs from a website, archive, sitemap or feed you choose. The upstream is the public web; this package has no elt dependency or publisher rules.

```ts
import got from 'got';

import { WebDiscovery, WebLinks } from '@workspace/sdk-web-discovery';

await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
const discovery = new WebDiscovery(got, links);
const pages = await discovery.discover(
  'https://www.anthropic.com/news',
  AbortSignal.timeout(60_000),
);
// Primary feed/sitemap/archive pages: [{ url, lastModified, listingUrl }]

// On the article client, collect links from the response already downloaded.
const articleHttp = got.extend({
  hooks: { afterResponse: [(response) => links.collect(response, 0)] },
});
// Pass articleHttp to the article reader. After reading each batch:
const pending = await links.take(
  got,
  new Set(pages.map((page) => page.url)),
  AbortSignal.timeout(60_000),
);
// New work: [{ url, lastModified, listingUrl, depth, follow }]
```

The constructor takes a Got client; use `got.extend(...)` for timeouts, retries and request hooks. The caller supplies an absolute HTTP(S) URL and an abort signal for the whole traversal. The SDK adds no separate retry policy or per-request deadline. A large archive can take minutes; the caller chooses its time budget. Omit the second constructor argument to read only the existing feeds, sitemaps and advertised archives.

`WebLinks` is a response consumer: it never downloads an ordinary page itself. The caller downloads articles once, then passes their responses to `collect(response, depth)`. `take(http, known, signal)` reads newly advertised feeds and returns unseen candidates; `known` contains URLs the caller already scheduled. A returned `follow` flag permits passing that page’s response back to `collect`. The caller owns downloading, extraction, checkpoints and resuming pending work.

`maxPages` bounds linked queue entries eligible for expansion per `WebLinks` instance, including articles already scheduled for extraction; `maxDepth` bounds their hops from primary HTML responses. Scheduled articles keep their place in that budget: reuse does not refill their slots with extra helper requests. Primary article responses can still contribute links without an additional download. Both limits are non-negative safe integers; zero disables expansion of additional pages while retaining candidates from primary responses. The limits do not cap article extraction, candidate count, primary feeds, sitemaps or advertised archives.

Original listing traversal still follows complete feed pagination. A feed first advertised by an article or additional link page contributes **one document**: its item URLs are retained, but its pagination and child listings are not followed. This changes traversal policy only; `readListing` is unchanged. Direct RSS/JSON Feed inputs retain their feed-only scope. Secondary cross-origin feed candidates require an explicit declaration or Feedscout’s exported feed URL/path hints; an incidental external link labeled “Atom” is insufficient. Primary feed discovery remains unchanged.

## Discovery

| Input                                 | Behavior                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website HTML                          | Reads feed and `rel="sitemap"` declarations in HTML and HTTP `Link` headers, labeled feed anchors, advertised archives and the origin's `robots.txt` sitemaps.                                              |
| HTML archive                          | Collects same-origin candidate anchors outside navigation/footer landmarks; follows archive indexes and pagination without downloading article bodies.                                                      |
| XML sitemap or index                  | Reads page locations and recursively linked maps, including gzip.                                                                                                                                           |
| Plain text URL list                   | Reads the listed locations.                                                                                                                                                                                 |
| RSS 2.0, Atom, RSS 1.0/RDF, JSON Feed | Reads item/entry page links; entries without a page URL contribute no candidate. JSON Feed `next_url`, Atom pagination links (including RSS's Atom namespace) and HTTP pagination links extend the listing. |

HTML must be served as `text/html` or `application/xhtml+xml`. Other supported formats are detected from content. Relative links resolve against the final response URL; HTML respects `<base>`. Queries and trailing slashes remain meaningful. Fragments are removed.

Feedscout's exported feed labels and attributes identify anchor candidates, including visible text, `title` and `aria-label`. Labels match whole words, so `Feedback` is not a `feed` label. An alternate with generic `application/json` and a labeled anchor are possible feeds, validated by Feedscout's public `defaultExtractFn`. A non-success status or non-feed response contributes nothing; transport and decoding errors still fail. Explicit sitemap declarations use `rel="sitemap"`.

Archive traversal recognizes HTML `rel="archives"`, `next` and `prev`, HTTP archive/pagination relations, archive paths, year/month indexes, and common labels such as “Archives”, “Older posts”, “All Content” and “Content Index”. Calendar months match 1–12 or English month names/abbreviations generated by the platform's date formatter; `/2008/talks/` remains a page candidate. Feed pagination also recognizes `prev-archive` and `next-archive`. All HTML archive links are restricted to the resolved listing's origin. A root containing archive links, a self-linked archive, or a directly chosen `/archive/` or `/archives/` page also supplies candidate anchors. Archive labels are generic English hints; there are no publisher hosts or selectors in production.

With `WebLinks`, **bounded traversal** expands same-origin anchors from responses the caller already has. Crawlee owns queueing, deduplication and link admission. Candidates can include categories, resources and other non-article pages. The caller selects URLs and the article SDK decides whether a fetched page has readable content. Expansion only accepts HTML from origins seeded by primary discovery.

## Failures and results

Explicit sitemap/feed failures and malformed listings reject the call even if another listing succeeded. A directly supplied invalid or missing URL also rejects. Discovered HTML archive reads returning 404/410 are skipped; other failures remain errors. Ordinary-page download policy belongs to the caller. An absent robots file (404/410) is optional. If no listing or archive is found or queued, discovery tries `/sitemap.xml`. With ordinary candidates available, a missing guessed sitemap is optional; an explicitly declared sitemap remains mandatory. A valid empty feed counts as a listing.

- `url`: the candidate HTTP(S) URL. Sitemaps and feeds can explicitly supply cross-origin pages.
- `lastModified`: the sitemap's raw `lastmod`, or `null`. Publication dates are never substituted. Feed, text and HTML archive candidates return `null`.
- `listingUrl`: provenance, the final listing URL that first supplied the candidate.

Requested listing URLs and known redirect targets are recorded to terminate cycles. Different redirect aliases can still cause another HTTP request to the same final URL. Results are unique in discovery order and keep the first listing occurrence's metadata. The source keeps primary listing metadata when merging linked candidates. Each discovery call starts fresh. Each `WebLinks` instance isolates its queue in memory and drops it on disposal. Errors use `DiscoveryError` with the failing `url` and original `cause`. Cancellation preserves the caller's exact reason.

No JavaScript executes. Authentication, article classification and destination loading are outside this SDK. A feed without pagination exposes only its recent window; choosing its website can additionally expose archives and ordinary links. Hidden archives or unfamiliar markup are not guaranteed to be discovered.

## Package ownership

| Public API                                                             | Responsibility                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Got                                                                    | HTTP, redirects, decompression, configured retries/timeouts and cancellation.                             |
| `@workspace/codec-sitemap`: `decodeSitemap`, `parseSitemap`            | Gzip, XML indexes/url sets, text, RSS and Atom; raw hints and strict validation.                          |
| `@crawlee/utils`: `RobotsTxtFile.from().getSitemaps(...)`              | Robots sitemap declarations.                                                                              |
| `@crawlee/core`: `RequestQueue`, `enqueueLinks`, `EnqueueStrategy`     | Isolated ordinary-link scheduling, deduplication and same-origin admission.                               |
| `feedscout/methods`: `discoverUrisFromHtml`, `discoverUrisFromHeaders` | Feed/sitemap HTML selection and HTTP Link parsing.                                                        |
| `feedscout/feeds`: selectors, labels, attributes, `defaultExtractFn`   | Published feed conventions and validation of possible feeds.                                              |
| Feedsmith                                                              | JSON Feed/RDF decoding and typed feed pagination fields.                                                  |
| `fast-xml-parser`: `XMLValidator.validate`                             | Strict RDF validation, absent from Feedsmith's RDF parser.                                                |
| jsdom                                                                  | Archive HTML parsing, base/link resolution and DOM queries; scripts and resource loading remain disabled. |
| `@zukhruf/testing/http`: `HttpServer.start()`                          | Disposable local HTTP fixtures for public regression tests.                                               |

`web-discovery.ts` owns primary traversal and Got requests; `web-links.ts` consumes responses, queues linked work and reads secondary feed documents. `listing.ts` retains the existing feed/sitemap parser unchanged; `html-discovery.ts` owns HTML declarations, archives and anchors; `web-url.ts` retains URL identity. No public reader registry or crawler wrapper is needed. Feedscout exposes no archive crawler. Its high-level `discoverFeeds` was rejected because it catches failures. Crawlee's `BasicCrawler` was rejected because its error/timeout behavior would duplicate or conflict with Got. The exported `enqueueLinks.limit` limits one admission batch, not the number of pages fetched across a crawl, so this SDK owns the total page budget. Crawlee's native queue iterator needs no custom polling loop. Existing jsdom handles HTML; no custom format parser was added.

## Verification

```sh
nx run sdk-web-discovery:test
nx run sdk-web-discovery:typecheck
```

Public black-box tests call `WebDiscovery` and `WebLinks`; no test calls a publisher. Existing feed/sitemap/archive regressions remain. Additional controls cover response reuse, primary versus secondary feed pagination, page/depth budgets, URL identity, HTTP archive provenance, attributed failures, exact cancellation, more than 1,000 links and disabled persistence despite ambient Crawlee settings. Typecheck includes formatting and lint.

The production consumer is `WebSource`, which enables three linked hops and at most 100 expanding linked queue entries per input scan. Real pipeline/SQLite regressions verify one download per HTML article, cached 304 response reuse, Markdown companions, secondary-feed limits, unchanged reruns and durable linked work across interruption. Feed parsing and primary `PageLocation` results remain unchanged.
