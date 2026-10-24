# Web article fetching and extraction

`WebArticle.fetch(url, signal)` downloads one page and extracts its readable content and metadata. It accepts URLs returned by `@workspace/sdk-web-discovery` and has no publisher-specific rules.

```ts
import got from 'got';

import { WebArticle } from '@workspace/sdk-web-article';
import { WebDiscovery } from '@workspace/sdk-web-discovery';

const signal = AbortSignal.timeout(30_000);
const pages = await new WebDiscovery(got).discover(
  'https://www.anthropic.com/',
  signal,
);
const reader = new WebArticle(got);
const page = pages.find((page) => page.url.includes('/news/'));
if (page) {
  const article = await reader.fetch(page.url, signal);
  // article.content: sanitized HTML; article.textContent: readable plain text
}
```

The constructor takes a Got client. Pass `got.extend(...)` to configure request timeouts, retry policy or request hooks; the SDK adds no separate retry loop or timeout. HTTP retries finish before extraction starts, so parsing failures do not repeat downloads. A 304 response fails because this SDK has no cached representation.

The selection above is an example caller choice. The SDK accepts any HTTP(S) page URL; it does not select publishers or article paths.

## Result

The exported `Article` type follows the method's return type. Metadata retains Mozilla Readability's field names and missing-value semantics:

| Field                                | Meaning                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `url`                                | Final HTTP response URL, including its query, after redirects                                         |
| `canonicalUrl`                       | Resolved HTTP(S) HTML canonical declaration, with its fragment removed; `null` when absent or invalid |
| `content`                            | Extracted HTML sanitized by DOMPurify                                                                 |
| `textContent`, `length`              | Plain text with paragraph breaks and formatted data tables; its character count                       |
| `title`, `byline`, `publishedTime`   | Readability's title, author text, and publication metadata                                            |
| `excerpt`, `siteName`, `lang`, `dir` | Readability's description, publisher, language, and text direction                                    |

`publishedTime` preserves the supplied value. Missing metadata remains missing; publication dates are not guessed from body text, URL paths, HTTP timestamps, or discovery's sitemap hints. An extracted result does not prove that the page is an article or that every metadata field is present.

The method returns `null` for a page without readable content. Fetching or parsing failures throw `ArticleError`, whose `url` identifies the failed page and whose `cause` preserves the underlying error. Aborting the supplied signal rejects with the caller's original reason.

## Package ownership

The installed export maps, public options/types, and shipped runtime were inspected and probed before integration:

| Package / API                                                        | Owns                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `got` and `AbortSignal`                                              | HTTP, redirects, decompression, selective retries, timeouts and cancellation                                                        |
| `jsdom` / `JSDOM`                                                    | HTML parsing, HTTP/meta charset decoding, HTML base and link resolution; scripts and subresource loading remain disabled by default |
| `@mozilla/readability` / `isProbablyReaderable`, `Readability.parse` | Readability detection, boilerplate removal, JSON-LD/Open Graph metadata                                                             |
| `dompurify` / `sanitize`                                             | Sanitizing extracted HTML without a local tag/attribute allowlist                                                                   |
| `html-to-text` / `convert`                                           | Text conversion, paragraph boundaries, `dataTable` formatting                                                                       |
| `@zukhruf/testing/http` / `HttpServer.start`                         | Disposable real HTTP fixtures for public black-box tests                                                                            |

The readability pre-check uses `minContentLength: 0` and `minScore: 0` so short posts and table-heavy articles reach the full parser. The full parser retains its native scoring. Text conversion disables line wrapping and enables the package's data-table formatter. Other package defaults remain native.

REJECTED: `@extractus/article-extractor` 9.0.1 as the complete extractor. A probe with no publication metadata and a historical date in the prose returned that historical date as the publication date. Its shipped `findDate` scans body paragraphs; its public options do not disable this inference. A relative canonical declaration was also discarded in the probe.

REJECTED: `JSDOM.fromURL` as the HTTP owner. Its public options and shipped fetch path do not expose caller cancellation. Got byte responses plus the `JSDOM` constructor preserves the response URL and byte decoding without replacing jsdom's parser.

Retained local behavior: compose those APIs, preserve HTTP provenance and cancellation, expose declared canonical identity, attribute errors to the failed URL, and close the DOM. There is no custom content scorer, metadata parser, HTML sanitizer, encoding detector, retry loop, or publisher adapter.

## Verification

```sh
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run sdk-web-article:typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false npx nx run sdk-web-article:test
```

Twelve public black-box tests use local HTTP pages and real dependencies. Ten implementation slices were observed failing before their fix; structured-metadata and charset regressions passed directly using package capabilities. Tests cover redirects/base URLs, canonical declarations, metadata, Unicode/legacy encodings, short posts, navigation-only pages, paragraph/table formatting, sanitization, HTTP/transport failures, and cancellation. No tests call live publishers or mock internal modules.

On 2026-10-24, live discovery supplied 26 sampled page URLs across the nine previously checked inputs. Extracted bodies were compared with independently fetched source HTML; metadata and omissions were inspected. This is sampled compatibility evidence, not a crawl of every discovered URL or a sustained load test.

| Input                                           | Samples retaining main prose |
| ----------------------------------------------- | ---------------------------: |
| Anthropic                                       |                        3 / 3 |
| Simon Willison                                  |                        2 / 3 |
| Julia Evans                                     |                        3 / 3 |
| Cloudflare                                      |                        3 / 3 |
| Python Insider                                  |                        3 / 3 |
| Martin Fowler                                   |                        3 / 3 |
| GitHub Blog                                     |                        3 / 3 |
| JSON Feed                                       |                        2 / 2 |
| Daring Fireball Atom feed, its own-site entries |                        3 / 3 |

Known quality failure: [this short Simon Willison link post](https://simonwillison.net/2026/Oct/22/de-staat-freedom/) yields the subscription/footer section instead of its main prose. The result is non-null, so callers cannot treat a non-null result as a quality guarantee. The installed parser's public `charThreshold` option was also probed and did not recover that prose. Backlog **2914** tracks a generic quality check or package alternative; no publisher workaround was added.

Readability also omits some author biographies, acknowledgements, related cards, and introductory blurbs. It cannot render JavaScript-only content or retrieve authenticated content. This package does not schedule requests, enforce crawl policy, persist checkpoints, or implement conditional fetching; those remain ingestion orchestration work. Downloads are buffered, and CPU parsing is synchronous. Caller cancellation covers network work, not interruption of a running synchronous parser.

Live evidence is retained at `/tmp/elt-article-live/final-results.json` with the independently fetched HTML files beside it.
