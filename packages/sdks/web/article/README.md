# Web article fetching and extraction

`WebArticle.fetch(url, signal)` downloads one page and extracts readable content and metadata. `WebArticle.read(response, signal)` extracts from a Got response that someone else downloaded, such as a page from `@workspace/sdk-web-crawler`. The SDK contains no publisher rules.

```ts
import got from 'got';

import {
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from '@workspace/sdk-web-article';
import { ListingReader, WebCrawler } from '@workspace/sdk-web-crawler';

const signal = AbortSignal.timeout(30_000);
const reader = new WebArticle(
  [new MarkdownExtraction(), new HTMLExtraction()],
  got,
);
const crawler = new WebCrawler(
  got.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          // Pages the crawl hands back ask for the reader's preferred format.
          if (options.context.page === true)
            options.headers.accept = reader.accept;
        },
      ],
    },
  }),
  [new ListingReader()],
);
for await (const entry of crawler.run(['https://www.anthropic.com/'], {
  signal,
  include: [new URLPattern('https://www.anthropic.com/news/*')],
})) {
  if ('error' in entry || 'progress' in entry) continue;
  const article = await (await reader.read(entry.response, signal)).extract();
  // article.content: sanitized HTML; article.markdown: Markdown
  // article.textContent: readable plain text
}
```

The example's publisher and URL selection belong to the caller. The constructor takes an ordered array of extraction instances and a Got client; use `got.extend(...)` for timeouts, retries or request hooks. Got owns HTTP retries. When negotiated Markdown is unusable, the reader makes one HTML-only attempt. A raw 304 without a Got-cached representation fails; with Got caching, revalidation restores the response body before it reaches the SDK. The SDK does not render JavaScript, retrieve authenticated content, schedule crawls or store checkpoints.

`WebArticle.download(url, signal)` and `read(response, signal)` return a lazy extraction with `fingerprint` and `extract()`. The fingerprint covers response bytes, final URL and Content-Type. A caller can compare it with committed input state before running extraction. Got can restore those same bytes after HTTP cache revalidation, so a 304 and an identical 200 have the same fingerprint. Advertised alternate representations and negotiated Markdown with HTML fallback return a null fingerprint: their additional responses can change independently and must remain eligible for extraction. Cancellation and attributed errors also apply when extraction is deferred.

## Extraction chain

`WebArticle` derives its HTTP `Accept` preference from the extraction array and tries each `Extraction` in order on the downloaded response. The first non-null article ends that representation's chain. For preferred native Markdown, an available HTML counterpart supplies normalized article content and missing metadata, as described below. If every extraction returns null, the reader returns null. An exception stops that representation’s chain and becomes an `ArticleError` if no HTML fallback succeeds; cancellation preserves the supplied reason. An empty chain is invalid.

`Extraction` is a format-neutral contract. Subclasses declare `mediaTypes` and implement `extract(page, signal)` and return an `Article` or null. `ArticlePage` carries the final response `url`, the unparsed `body` (`string | Buffer`) and the `contentType` header; `WebArticle` supplies the downloaded bytes as a Buffer. The shared contract imports no HTML parser or converter.

`HTMLExtraction` owns charset decoding, a fresh DOM per attempt, content selection with Defuddle, metadata with Readability, sanitization, the prose acceptance check, Markdown/text conversion and DOM cleanup. Its protected `select(dom, signal)` extension returns an `ArticleSelection` or null. Original response bytes are retained so every HTML attempt sees the same charset and unmodified HTML. State stays within each call, so one reader can fetch concurrent pages.

Before Readability receives that DOM, `dateline` substrings are removed from class/id hints. Readability 0.6.0 otherwise accepts those hints as authors without checking their meaning. This happens after Defuddle selects content, so it changes metadata eligibility without changing the selected article. Explicit author metadata, `rel`/`itemprop` authors, author/byline classes and microformats remain available. No date strings are parsed or promoted to publication metadata.

`MarkdownExtraction` accepts `text/markdown`, plus direct `.md`/`.markdown` files served as plain text or without a content type. It uses Marked for Markdown parsing, gray-matter for front matter, YAML 1.2 for metadata, DOMPurify for HTML sanitization and html-to-text for text/tables. Front-matter `title`, `author`, `date` and `description` remain strings; H1 and the first paragraph supply the title/excerpt when absent. Other metadata is null. Executable JavaScript front matter is disabled. Each call owns and closes its DOM.

With Markdown first, the reader requests `text/markdown` ahead of HTML. If the server returns HTML, Feedscout follows explicit `rel="alternate"; type="text/markdown"` links in HTTP headers or HTML, including relative links and HTML base URLs. Alternatives are deduplicated and followed one hop. Their errors, empty bodies or incompatible formats preserve the original HTML response; cancellation still propagates. A 406 or unreadable negotiated Markdown triggers one request accepting HTML only. No blind extension/path guessing, browser or model fallback is used.

## Result

The exported `Article` type defines the shared output contract independently of the extraction packages. `HTMLExtraction` preserves Mozilla Readability's metadata field names and missing-value semantics. The HTML-specific field descriptions below describe its output; native Markdown differences follow the table.

| Field                                | Meaning                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `url`                                | Final HTTP response URL, including its query                                                 |
| `canonicalUrl`                       | Resolved HTTP(S) HTML canonical declaration, without a fragment; null when absent or invalid |
| `content`                            | Extracted HTML with insignificant whitespace normalized, then sanitized                      |
| `markdown`                           | Markdown converted from that same sanitized HTML, including links and pipe tables            |
| `textContent`, `length`              | Text with paragraph breaks and formatted data tables; its JavaScript string length           |
| `title`, `byline`, `publishedTime`   | Readability's title, author text and raw publication metadata                                |
| `excerpt`, `siteName`, `lang`, `dir` | Readability's description, publisher, language and text direction                            |

**Native Markdown:** `markdown` preserves the publisher’s body verbatim after removing front matter. When HTML extraction is configured, `WebArticle` uses a readable HTML counterpart for `content`, `textContent` and `length`, and fills null or undefined metadata fields from it. Native metadata and the final Markdown URL retain precedence. Advertised alternatives reuse the original HTML response; negotiated Markdown makes one additional HTML-only request to the final URL. Companion failure, incompatible media types or empty extraction preserve the native article; cancellation still rejects. No recursive alternative lookup or quality-ranking heuristic is added.

Without a readable HTML counterpart, `content` is sanitized HTML rendered from the native body and `textContent` derives from it. Relative URLs resolve against the representation supplying that content. Raw `markdown` remains untrusted source: it can contain navigation, footer text or raw HTML even when normalized `content` and `textContent` are clean. Consumers rendering raw Markdown must sanitize it. This distinction preserves source fidelity; it does not promise a cleaned native Markdown field. `MarkdownExtraction` itself performs no network requests or article-selection heuristics.

Publication dates are not inferred from prose, URL paths, HTTP timestamps or sitemap hints. The method returns null for no readable content. HTML extraction also rejects an unmarked result consisting entirely of hyperlinks; explicit native Markdown retains short linked posts. A non-null result is heuristic extraction, not proof that every part of an article was captured. Errors carry the failed URL in `ArticleError.url` and preserve their cause. Cancellation rejects with the supplied signal's original reason.

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
| node-html-markdown 2.0.0         | Markdown conversion through its public `NodeHtmlMarkdown.translate` API            |
| Marked 18.1.1                    | Native Markdown parsing, including GFM tables and fenced code                      |
| gray-matter 4.0.3, YAML 2.9.0    | Front-matter splitting and YAML 1.2 metadata without date coercion                 |
| Feedscout 2.2.1                  | Advertised alternate representations in HTTP Link headers and HTML                 |
| `@zukhruf/testing/http`          | Disposable real HTTP fixtures for public black-box tests                           |

Defuddle's `contentSelector` recognizes microformat post containers (`.h-entry`, `.hentry`) and the common `.entry` convention when semantic article/main markup is absent. If none matches, Defuddle detects the main content normally. An incidental entry widget therefore cannot override an HTML/ARIA article or main landmark.

Exact-selector removal is disabled within declared article/main or post boundaries: its blanket `aside`/sidebar removal discards editorial explanations and contributor lists. Content scoring stays enabled except for the explicitly selected post containers, where link density otherwise discards a title row containing category and resource links. Unmarked pages retain both filters, including navigation and advertising cleanup. `removePartialSelectors: false` preserves prose in containers such as `frontMatter`. These are package options, not publisher selectors or a custom scoring algorithm.

`standardize: false` preserves original inline punctuation; the default inserted a space in linked `HKDF-SHA-256`, changed `1.44 : 1`, and left variable whitespace where comments were removed. `useAsync: false` disables additional extractor requests.

Defuddle's public Node string entry owns its LinkeDOM parsing. Passing the existing JSDOM document was probed first: Defuddle's selector exceeds jsdom's hardcoded 2048-character selector limit, causing an internal fallback and losing the intended cleanup. The package-owned string path is retained instead of a local DOM adapter or disabling the selector guard. Defuddle marks that input form deprecated for its next major version; this package pins 0.19.5.

The minifier enables only `collapseWhitespace`, `conservativeCollapse` and `removeComments`. It preserves spaces separating inline words and the exact contents of `pre`; its installed implementation was checked and public tests cover punctuation and code indentation. DOMPurify runs after these transformations. Its `FORBID_TAGS` and `ADD_FORBID_CONTENTS` options exclude footer markup and prose after Readability has extracted metadata, preserving authors credited in a footer. The additive option retains the sanitizer's existing forbidden-content policy. Text conversion disables wrapping and enables `dataTable` formatting.

Markdown conversion runs after sanitization, so HTML, Markdown and text share the same article selection. The converter owns headings, emphasis, lists, block quotes, links, images and tables. Its `codeBlockStyle: 'indented'` preserves code containing literal backtick fences; language annotations are not retained. Its `textReplace` option escapes ampersands and less-than signs in prose so literal HTML examples remain text when rendered. Code spans and blocks bypass that replacement. No custom translator or Markdown parser is shipped.

Defuddle's integrated Markdown was rejected because it runs before our final sanitization; its standalone browser export also required a browser `document` in a Node probe. Installed Turndown lacks tables, and the standard GFM plugin does not escape literal pipes in cells. The typed `node-html-markdown` API handles these cases without local rendering rules. Marked now parses native Markdown in production; public black-box tests render the returned Markdown independently and verify table cells, links, literal HTML and exact code text.

## Retained acceptance behavior

Before extraction, standard DOM operations remove explicit HTML/ARIA navigation landmarks (`nav`, `[role="navigation"]`). After sanitization, a separate `JSDOM.fragment` removes links outside `article`, `[role="article"]` and `table` solely to test whether any prose remains. The returned HTML and text retain their links. Short posts with prose, fully linked declared articles and linked tables remain eligible. No minimum prose length or publisher rule is added.

These rules retain the public regressions for 2914, 2915 and 2917: Simon-style short linked posts exclude subscription boilerplate; plain-div prose and standalone data tables are accepted; unmarked link-only menus are rejected. `isProbablyReaderable` remains removed because its tag-limited pre-check rejected valid content.

## Decisions and verification

REJECTED: Readability candidate-count, character-threshold and link-density tuning for 2919. Executable probes could recover the linked caption in isolation, but still lost the introduction and appendix. Readability remains the metadata owner, with `charThreshold: 1` allowing short pages.

REJECTED: `@extractus/article-extractor` 9.0.1. Its shipped implementation wraps the same Readability algorithm with fixed candidate/threshold options; it does not solve these losses. Earlier public probes also found subscription text and publication-date inference incompatible with this SDK's contract.

REJECTED: Crawlee for content selection. Its crawler requires an extraction handler, and its HTML-to-text helper is not an article selector. The web source already uses Got, p-map, p-queue and the ELT engine for downloading, scheduling and persistence.

RETAINED: jsdom decoding and base URLs, Readability metadata, native sanitization, text/table conversion, attributed errors, cancellation, navigation exclusion and the link-only acceptance check. Removed Readability content selection and its link-density tuning. Content selection and whitespace normalization remain package-owned. The ordered extraction chain supplies Markdown and HTML extraction.

Five public regressions first failed and then passed: introductory summary retention; descriptive caption text and link retention; acknowledgments/authorship disclosure retention; unchanged inline punctuation and preformatted spacing; identical HTML when ignored comments and surrounding whitespace change. Tests exercise `WebArticle.fetch`, and the content regressions also exercise the crawler's listing readers, through real HTTP. The full article suite includes short posts, link-only pages, tables, metadata, charset, cancellation and sanitization.

Live verification evidence is recorded in the [web source reference](../../../sources/web/articles/docs/reference.md). Those checks use the actual source, ELT engine and SQLite destination. Downloads remain buffered and CPU parsing remains synchronous; cancellation does not interrupt a synchronous parse. No complete-crawl quality guarantee is implied by the sampled sites.

Public regressions cover editorial asides (2924), surrounding sponsorship/recommendations (2926), and linked titles (2927), plus controls for semantic landmarks, unmarked-page clutter and footer bylines. A blanket filter disable was rejected after manual inspection exposed Daring Fireball ads; the final configuration scopes those options to declared content boundaries. The web source reference records the live verification summary; benchmark scripts and captures are temporary scratch files.

Native Markdown package audit: REJECTED `front-matter` 4.0.2 because its published callable type failed under this package’s NodeNext setup; no interop shim was added. REJECTED gray-matter’s default YAML engine because it coerces publication dates to Date objects. Its official custom-engine API uses the installed YAML 1.2 parser instead. REJECTED its default JavaScript engine because front matter is untrusted data; the engine override throws. No handwritten Markdown, YAML or alternate-link parser was added.

For 2941, the installed Defuddle `Defuddle()` options and Readability `parse()` were probed on both full HTML documents rendered from the live Markdown bodies. REJECTED recovering article boundaries from that flattened representation: both packages retained home navigation and serialized JSON-LD as prose, including with Defuddle's default scoring/content-pattern cleanup. Marked exposes tokens and raw source, but no article-isolation or metadata API; a custom token classifier or source-map reconstruction was not added. The existing HTML extractor already owns these boundaries and metadata, so the reader composes its result with the native source. Readability explicitly permits missing metadata (`Readability.js`'s `_getArticleMetadata` and `parse`), which is why the merge fills only null/undefined fields. No new package, parser, selector, threshold or public option is needed.

For 2945, Readability's public constructor options and exports expose no byline matcher override; its shipped `REGEXPS.byline` includes `dateline`, and `_isValidByline` checks only the hint and text length. REJECTED a private-method/prototype patch. REJECTED switching author extraction wholesale to Defuddle: its public `author` result found the live sidebar author, but a probe lost the existing `<span rel="author">` footer author, and its metadata precedence/normalization differs. The small DOM normalization retains Readability's author behavior apart from the ambiguous dateline hint. Public regressions cover class/id substrings, case variants, French/Arabic dates, nested authors, structured-metadata precedence and genuine author names; dates within prose remain intact. The live verification ledger records exact before/after parity for all other fields.
