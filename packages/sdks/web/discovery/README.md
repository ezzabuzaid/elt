# Web discovery

Discover candidate page URLs from a website, sitemap or feed you choose. The upstream is the public web; this package has no elt dependency or publisher rules.

```ts
import { WebDiscovery } from '@workspace/sdk-web-discovery';

const pages = await new WebDiscovery().discover(
  'https://www.anthropic.com/',
  AbortSignal.timeout(60_000),
);
// [{ url, lastModified, listingUrl }]
```

The caller supplies an absolute HTTP(S) URL and an abort signal, choosing the deadline for the whole operation. There is no hidden per-request timeout.

## Discovery

| Input                                 | Behavior                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website HTML                          | Reads explicit feed and `rel="sitemap"` declarations in HTML and HTTP `Link` headers, labeled feed anchors, and the origin's `robots.txt` sitemaps. |
| XML sitemap or index                  | Reads page locations and recursively linked maps, including gzip.                                                                                   |
| Plain text URL list                   | Reads the listed locations.                                                                                                                         |
| RSS 2.0, Atom, RSS 1.0/RDF, JSON Feed | Reads item/entry page links; entries without a page URL contribute no candidate.                                                                    |

HTML must be served as `text/html` or `application/xhtml+xml`. Other supported formats are detected from content. Relative links resolve against the final response URL; HTML links respect `<base>`. Queries and trailing slashes remain meaningful. Fragments are removed because they address a section of the same page.

Feedscout's exported feed labels and attributes identify anchor candidates, including visible text, `title` and `aria-label`. Labels match whole words, so `Feedback` is not a `feed` label. URL suffixes alone do not make an anchor a candidate. Ordinary sitemap navigation anchors are not crawled; sitemap declarations use `rel="sitemap"`.

An alternate link with generic `application/json` and a labeled anchor are **candidates**, not promises of a feed. Feedscout's public `defaultExtractFn` validates their responses. A candidate returning a non-success HTTP status or non-feed content contributes nothing. Valid JSON Feed still works when advertised as `application/json`.

Explicit sitemaps and feed declarations remain required: a failed or malformed listing rejects the call, even if another listing succeeded. A directly supplied non-feed JSON URL also rejects. Transport errors, decoding errors and cancellation are not swallowed for candidates. HTTP 404/410 means an optional robots file is absent. If no explicit listing is advertised and no candidate has validated into a listing, discovery tries `/sitemap.xml`. A valid empty feed counts as a listing.

## Results

- `url`: the candidate's HTTP(S) URL. Categories, landing pages and cross-origin locations remain candidates.
- `lastModified`: the sitemap's raw `lastmod`, or `null`. Date-only precision is retained; publication dates are never substituted. Feeds and text lists return `null`.
- `listingUrl`: provenance, the final URL of the listing that first supplied the candidate.

Listings are visited once per requested URL; cycles terminate. Results are unique in discovery order, keeping the first occurrence's metadata. Each call starts fresh. Reads are sequential. Errors use `DiscoveryError` with the failing `url` and original `cause`; cancellation preserves the caller's exact reason.

Discovery does not execute JavaScript, authenticate, crawl arbitrary page links, follow feed archive pagination, classify articles, fetch article bodies or load a destination. A feed may expose only a recent window. A site with no supported listing fails explicitly.

## Package ownership

| Public API                                                                                 | Responsibility                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `@workspace/codec-sitemap`: `decodeSitemap`, `parseSitemap`                                | Gzip, XML indexes/url sets, text, RSS and Atom; raw hints and strict validation.                                               |
| `@crawlee/utils`: `RobotsTxtFile.from().getSitemaps({ enqueueStrategy: 'all' })`           | Robots declarations, including maps hosted elsewhere.                                                                          |
| `feedscout/methods`: `discoverUrisFromHtml`, `discoverUrisFromHeaders`                     | HTML parsing, entities, base URLs, link selection and HTTP Link parsing.                                                       |
| `feedscout/feeds`: `linkSelectors`, `anchorLabels`, `anchorAttributes`, `defaultExtractFn` | Published selectors/labels and validation of possible feeds. Generic JSON is configured separately from required declarations. |
| `feedsmith`: JSON Feed and RDF detect/parse APIs                                           | Format decoding not supplied by the sitemap codec.                                                                             |
| `fast-xml-parser`: `XMLValidator.validate`                                                 | Strict RDF validation; Feedsmith's RDF parser does not enable it.                                                              |
| `@zukhruf/testing/http`: `HttpServer.start()`                                              | Disposable loopback HTTP fixtures for the three regression tests; `await using` closes their sockets.                          |

No runtime dependency was added for the fixes. The already-installed `@zukhruf/testing` 0.3.24 is now an explicit development dependency. Existing MSW tests retain `onUnhandledRequest: 'error'`; tests make no external network requests.

## Verification — 2026-10-24

Baseline: all six existing tests and the package typecheck passed. Each new regression failed against the preceding implementation before its fix, then passed through the public `WebDiscovery.discover` API with real local HTTP requests:

| Regression                  | Red observation                                | Green observation                                                                                         |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| HTML sitemap without robots | Older page missing                             | RSS and nested sitemap both contribute pages, with raw metadata.                                          |
| Ordinary JSON alternate     | WordPress-shaped JSON aborts discovery         | Non-feed JSON ignored; valid generic JSON Feed retained; direct and explicit bad listings still fail.     |
| Labeled RSS anchor          | Fallback sitemap fails instead of finding feed | Visible and attribute labels discover feeds, preserve redirect provenance and exclude non-feed responses. |

Review assertions also cover HTML and HTTP declarations separately, empty candidate feeds, and sitemap fallback after invalid candidates. All nine tests pass; typecheck includes formatting and linting.

```sh
nx run sdk-web-discovery:typecheck
nx run sdk-web-discovery:test --skip-nx-cache
```

Live checks used the built public export, with only the following URLs as input:

| Input                                 | Unique candidate URLs |
| ------------------------------------- | --------------------: |
| https://www.anthropic.com/            |                   582 |
| https://simonwillison.net/            |                17,097 |
| https://jvns.ca/                      |                   768 |
| https://blog.cloudflare.com/          |                10,210 |
| https://blog.python.org/              |                   433 |
| https://martinfowler.com/             |                    29 |
| https://github.blog/                  |                 9,661 |
| https://www.jsonfeed.org/feed.json    |                     2 |
| https://daringfireball.net/feeds/main |                    45 |

Python's result includes the 383 sitemap URLs previously missed. Fowler's HTML anchors now reach its feed. GitHub's ordinary REST JSON is ignored, allowing RSS and the robots-advertised sitemap index to complete. Anthropic's current sitemap contains 582 locations; its earlier 575 count was an older live snapshot.

An independent Python standard-library XML/JSON parser matched every URL, modification hint and listing URL against all fetched listings, with zero missing, extra, mismatched or duplicate records. This verifies the returned listings, not universal website completeness. These are compatibility checks, not sustained load or memory benchmarks. Captured responses and comparison results are in `/tmp/elt-discovery-after-fixes`; pre-fix evidence is in `/tmp/elt-discovery-cross-site` and `/tmp/elt-discovery-before-fixes.json`.

## Fix audit

**Verdict:** all three gaps are fixed with package APIs and no publisher-specific branches.

**Removed:** blanket disabling of labeled-anchor discovery and the assumption that every generic JSON alternate is a required feed. Their executed observations are the anchor and JSON red/green regressions above. Stale documentation of those assumptions is removed. No production wrapper or parser was deleted; this is principally an additive behavior correction, not a claimed reduction in maintained code.

**Net delta:** +358 / −85 lines against the start of this fix across five files. This is net-additive because it adds candidate validation and three public-API regression tests; no new runtime dependency or source file was added.

**Retained:** public exports and return shape, the SDK file, its documentation, traversal/deduplication, raw metadata, strict explicit-listing failures and cancellation. The parsed-listing flag preserves valid empty feeds, verified through the public API. The codec's strict malformed-entry constraint is documented by commit `aa4dd782787da699d4aec2361e84c356478d625d`; no codec change was needed. The three tracked gaps are 2911–2913. Temporary probe scripts are removed after retaining their outputs.

**Radius:** the changed configuration had two runtime consumers, `discoverUrisFromHtml` and `discoverUrisFromHeaders`, both in `src/web-discovery.ts`. The behavioral consumers are one test module (`src/web-discovery.test.ts`, six tests before this fix) and two documentation examples (this README and the workspace README). The public re-export in `src/index.ts`, package/project identities and root TypeScript/workspace registrations remain. No shell, CI or dynamic consumer of the removed configuration was found.

**REJECTED:** full `discoverFeeds` orchestration. Its shipped `runDiscover` catches extraction/read failures and filters invalid results; adopting it would erase the explicit-listing failure contract and require another transport adapter. Its public URI and extraction functions provide the needed seams directly.

**REJECTED:** restoring URL-suffix guesses or raw substring labels. They can mistake navigation such as `/rss/help` or `Feedback` for a feed. Exported labels are configured as whole-word patterns; candidate content is still validated. No custom HTML or HTTP Link parser was introduced.

**Self-audit:** export maps, options, constants, runtime, underlying MIME definitions and observation hooks were inspected. No relevant environment/debug hook exists; the high-level progress hooks belong to the rejected orchestration API. No new compatibility branch, logging, environment read, type assertion or suppression was added. `LinkSelector.types` is genuinely optional in Feedscout's public types (the `rel="feed"` selector omits it); the code preserves that contract. The required empty anchor-option arrays select declarations independently of candidate heuristics. Existing parser defaults and public shapes remain unchanged.

**Unproven:** sustained load behavior and complete coverage of websites with no supported listing are not claimed. **Unresolved:** none within the three requested gaps.
