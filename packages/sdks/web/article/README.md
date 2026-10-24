# Web article fetching and extraction

`WebArticle.fetch(url, signal)` downloads one page and extracts readable content and metadata. It accepts URLs returned by `@workspace/sdk-web-discovery` and contains no publisher rules.

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

The example's publisher and URL selection belong to the caller. The constructor takes a Got client; use `got.extend(...)` for timeouts, retries or request hooks. HTTP retries finish before extraction, so parsing failures do not repeat downloads. A 304 fails because the SDK has no cached representation. The SDK does not render JavaScript, retrieve authenticated content, schedule crawls or store checkpoints.

## Result

The exported `Article` type follows the method's return type. Metadata retains Mozilla Readability's field names and missing-value semantics.

| Field                                | Meaning                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `url`                                | Final HTTP response URL, including its query                                                 |
| `canonicalUrl`                       | Resolved HTTP(S) HTML canonical declaration, without a fragment; null when absent or invalid |
| `content`                            | Extracted HTML with insignificant whitespace normalized, then sanitized                      |
| `textContent`, `length`              | Text with paragraph breaks and formatted data tables; its JavaScript string length           |
| `title`, `byline`, `publishedTime`   | Readability's title, author text and raw publication metadata                                |
| `excerpt`, `siteName`, `lang`, `dir` | Readability's description, publisher, language and text direction                            |

Publication dates are not inferred from prose, URL paths, HTTP timestamps or sitemap hints. The method returns null for no readable content or for an unmarked result consisting entirely of hyperlinks. A non-null result is heuristic extraction, not proof that every part of an article was captured. Errors carry the failed URL in `ArticleError.url` and preserve their cause. Cancellation rejects with the supplied signal's original reason.

## Package ownership

The packages' export maps, options, types and shipped implementations were inspected before integration.

| Package                          | Responsibility                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Got 14.6.6                       | HTTP, redirects, decompression, selective retries, deadlines and cancellation      |
| jsdom 30.1.3                     | Charset decoding, HTML base/link resolution, canonical declaration and DOM queries |
| Defuddle 0.19.5, `defuddle/node` | Content selection, including introductions, linked captions and appendices         |
| Mozilla Readability 0.6.0        | Metadata with the existing publication-date and missing-value contract             |
| html-minifier-next 9.0.1         | Stable whitespace/comment normalization while preserving preformatted content      |
| DOMPurify 3.4.17                 | Final HTML sanitization using its native policy                                    |
| html-to-text 10.0.1              | Paragraph boundaries, text conversion and data-table formatting                    |
| `@zukhruf/testing/http`          | Disposable real HTTP fixtures for public black-box tests                           |

Defuddle uses `removePartialSelectors: false`: substring class matching otherwise removes prose in containers such as `frontMatter`. Its content scoring and exact-selector cleanup remain enabled. `standardize: false` preserves original inline punctuation; the default inserted a space in linked `HKDF-SHA-256`, changed `1.44 : 1`, and left variable whitespace where comments were removed. `useAsync: false` disables additional extractor requests. The SDK supplies no publisher selectors or custom scoring.

Defuddle's public Node string entry owns its LinkeDOM parsing. Passing the existing JSDOM document was probed first: Defuddle's selector exceeds jsdom's hardcoded 2048-character selector limit, causing an internal fallback and losing the intended cleanup. The package-owned string path is retained instead of a local DOM adapter or disabling the selector guard. Defuddle marks that input form deprecated for its next major version; this package pins 0.19.5.

The minifier enables only `collapseWhitespace`, `conservativeCollapse` and `removeComments`. It preserves spaces separating inline words and the exact contents of `pre`; its installed implementation was checked and public tests cover punctuation and code indentation. DOMPurify runs after these transformations. Text conversion disables wrapping and enables `dataTable` formatting.

## Retained acceptance behavior

Before extraction, standard DOM operations remove explicit HTML/ARIA navigation landmarks (`nav`, `[role="navigation"]`). After sanitization, a separate `JSDOM.fragment` removes links outside `article`, `[role="article"]` and `table` solely to test whether any prose remains. The returned HTML and text retain their links. Short posts with prose, fully linked declared articles and linked tables remain eligible. No minimum prose length or publisher rule is added.

These rules retain the public regressions for 2914, 2915 and 2917: Simon-style short linked posts exclude subscription boilerplate; plain-div prose and standalone data tables are accepted; unmarked link-only menus are rejected. `isProbablyReaderable` remains removed because its tag-limited pre-check rejected valid content.

## Decisions and verification

REJECTED: Readability candidate-count, character-threshold and link-density tuning for 2919. Executable probes could recover the linked caption in isolation, but still lost the introduction and appendix. Readability remains the metadata owner, with `charThreshold: 1` allowing short pages.

REJECTED: `@extractus/article-extractor` 9.0.1. Its shipped implementation wraps the same Readability algorithm with fixed candidate/threshold options; it does not solve these losses. Earlier public probes also found subscription text and publication-date inference incompatible with this SDK's contract.

REJECTED: Crawlee for content selection. Its crawler requires an extraction handler, and its HTML-to-text helper is not an article selector. The web source already uses Got, p-map, p-queue and the ELT engine for downloading, scheduling and persistence.

RETAINED: jsdom decoding and base URLs, Readability metadata, native sanitization, text/table conversion, attributed errors, cancellation, navigation exclusion and the link-only acceptance check. Removed Readability content selection and its link-density tuning. Added package-owned content selection and whitespace normalization; no custom parser, content-recovery loop or fallback was introduced.

Five public regressions first failed and then passed: introductory summary retention; descriptive caption text and link retention; acknowledgments/authorship disclosure retention; unchanged inline punctuation and preformatted spacing; identical HTML when ignored comments and surrounding whitespace change. Tests exercise `WebArticle.fetch`, and the content regressions also exercise discovery, through real HTTP. The full article suite includes short posts, link-only pages, tables, metadata, charset, cancellation and sanitization.

Live verification evidence is recorded in the [web source reference](../../../sources/web/articles/docs/reference.md). Those checks use the actual source, ELT engine and SQLite destination. Downloads remain buffered and CPU parsing remains synchronous; cancellation does not interrupt a synchronous parse. No complete-crawl quality guarantee is implied by the sampled sites.
