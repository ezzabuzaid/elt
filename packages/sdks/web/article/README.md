# Web article

A caller has a web page and wants its article: the readable body and its metadata, without the navigation, ads and other parts of the site around it. This is main content extraction, also known as boilerplate removal, the job of the Reader View in Firefox. `WebArticle` downloads a page, or reads a response that the caller downloaded, and returns the article. The SDK has no rules for a publisher.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

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

The publisher and the URL selection in the example belong to the caller.

## Read a page

- `new WebArticle(extractions, got)` takes the extraction chain and a Got client. An empty chain is not valid. Use `got.extend(...)` for timeouts, retries and request hooks.
- `fetch(url, signal)` downloads a page and returns its article, or null when the page has no article.
- `download(url, signal)` and `read(response, signal)` return a lazy extraction: a `fingerprint` and an `extract()` function. The reader requests every response that the extraction needs before it gives the fingerprint, and the fingerprint covers all of them. `extract()` makes no request. Compare the fingerprint with your committed state before you extract ([ADR 0008](./docs/adr/0008-the-fingerprint-is-known-before-extraction.md)).
- `negotiation` tells how to request a page that you download yourself and give to `read()`. Send its `accept` as the Accept header, and add its `beforeRedirect` to the `beforeRedirect` hooks of the request. Without the hook, `read()` cannot see an Accept redirect.

Got owns HTTP: redirects, decompression, retries, deadlines, cancellation and the HTTP cache. When Got revalidates a cached response and gets a 304, it gives back the cached body, so the page reads as an identical 200.

## The extraction chain

The order of the extractions sets the Accept header: each media type gets a lower `q` value than the one before it. `WebArticle` gives each representation to the extractions in order, and the first article ends the chain. When no extraction finds an article, the result is null.

With Markdown first, the reader asks for `text/markdown` before HTML.

- When the server returns HTML, Feedscout finds the advertised alternatives in the HTTP Link header and in the HTML, with relative URLs and HTML base URLs. The reader follows each alternative one time. When an alternative fails, is empty or has another format, the original HTML stays.
- When the server returns native Markdown, the HTML counterpart gives the normalized fields and the missing metadata ([ADR 0005](./docs/adr/0005-native-markdown-is-kept-verbatim-and-an-html-counterpart-gives-the-normalized-fields.md)).
- A 406, or native Markdown that cannot be read or has no article, causes one request that accepts only HTML.
- When a redirect whose `Vary` header names `Accept` gives no Markdown, the reader asks the original URL again with the HTML media types, as a browser asks. It reads that answer in the usual way, so the advertised alternatives stay preferred ([ADR 0012](./docs/adr/0012-an-accept-redirect-that-gives-no-markdown-is-asked-again-as-a-browser-asks.md)).

The reader does not guess `.md` paths, and it uses no browser and no model.

`Extraction` is the contract for a format. A subclass declares `mediaTypes` and implements `extract(page, signal)`, which returns an `Article` or null. An `ArticlePage` holds the final `url`, the unparsed `body` (`string | Uint8Array`) and the `contentType` header. `WebArticle` gives the downloaded bytes as a Uint8Array. The contract imports no parser and no converter.

## HTML extraction

`HTMLExtraction` reads `text/html` and `application/xhtml+xml`. For each page it does these steps:

1. jsdom decodes the bytes by their charset and builds a new DOM. Every attempt starts from the original bytes.
2. The navigation landmarks `nav` and `[role="navigation"]` are removed.
3. Defuddle selects the content ([ADR 0001](./docs/adr/0001-defuddle-selects-the-content-and-readability-gives-the-metadata.md)). Its cleanup follows the markup of the page ([ADR 0002](./docs/adr/0002-defuddle-cleanup-is-off-inside-declared-article-boundaries.md)).
4. The `dateline` hints are removed ([ADR 0007](./docs/adr/0007-the-dateline-hint-is-removed-before-readability-reads-the-page.md)), a JSON-LD `@context` array becomes its schema.org IRI ([ADR 0009](./docs/adr/0009-a-json-ld-context-array-is-given-to-readability-as-its-schema-org-iri.md)), and Readability reads the metadata.
5. html-minifier-next collapses whitespace and removes comments. It keeps the spaces between inline words and the exact content of `pre`. Markup that its parser cannot read, but that browsers recover from, such as an apostrophe inside a single-quoted attribute, it keeps as text (`continueOnParseError`), and the sanitizer then parses it as HTML.
6. DOMPurify sanitizes the HTML with its default policy, and it removes `footer` elements. Readability reads the metadata first, so an author in a footer stays.
7. The acceptance check rejects a page of links only ([ADR 0003](./docs/adr/0003-a-page-of-links-only-is-not-an-article.md)).
8. html-to-text gives the text, with paragraph breaks, data tables and no wrapping. node-html-markdown gives the Markdown from the same sanitized HTML ([ADR 0004](./docs/adr/0004-markdown-is-converted-from-the-sanitized-html.md)).

Each call owns its DOM and closes it, so one reader can read pages concurrently. A subclass can replace the protected `select(dom, signal)` step, which returns an `ArticleSelection` or null.

## Markdown extraction

`MarkdownExtraction` reads `text/markdown`. It also reads a `.md` or `.markdown` file that is served as `text/plain` or without a content type.

- Marked renders the Markdown to HTML, DOMPurify sanitizes it, and html-to-text gives the text.
- Front matter gives `title`, `author`, `date` and `description` as strings ([ADR 0006](./docs/adr/0006-front-matter-is-data-read-as-yaml-1-2.md)). When the front matter has no title or description, the first H1 and the first paragraph give them. Other metadata is null.
- `markdown` is the native body without its front matter.
- `MarkdownExtraction` makes no requests and does not select an article.

## The article

The exported `Article` type is the contract for every extraction. `HTMLExtraction` keeps the field names of Mozilla Readability and its null values for missing metadata.

| Field                                | Meaning                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                                | Final HTTP response URL, including its query                                                                                                                |
| `canonicalUrl`                       | Resolved HTTP(S) HTML canonical declaration, without a fragment; null when absent or invalid                                                                |
| `content`                            | Extracted HTML with insignificant whitespace normalized, then sanitized                                                                                     |
| `markdown`                           | Markdown converted from that same sanitized HTML, including links and pipe tables                                                                           |
| `textContent`, `length`              | Text with paragraph breaks and formatted data tables; its JavaScript string length                                                                          |
| `title`, `byline`, `publishedTime`   | Readability's title, author text and raw publication metadata                                                                                               |
| `inferredPublished`                  | Defuddle's date, ISO 8601 UTC or null; it can be a guess ([ADR 0011](./docs/adr/0011-the-inferred-publication-time-is-defuddles-date-in-its-own-field.md))  |
| `excerpt`, `siteName`, `lang`, `dir` | Readability's description, publisher, language and text direction                                                                                           |
| `list`                               | The page lists other pages of its origin, such as a category or an archive ([ADR 0010](./docs/adr/0010-a-page-that-lists-pages-is-labeled-not-rejected.md)) |

For native Markdown, `markdown` is the body of the publisher. It can hold navigation, footer text or raw HTML even when `content` and `textContent` are clean, so sanitize it before you render it. Relative URLs resolve against the representation that gives the content.

`publishedTime` is only the date that the page declares. A date that the page shows only as text near its title goes into `inferredPublished`, which is a guess. The SDK does not infer a date from URL paths, HTTP timestamps or sitemap hints. An article is the result of heuristics: it does not prove that every part of the page was captured.

## When something fails

- A failed download or extraction rejects with an `ArticleError`. Its `url` is the failed URL, and its `cause` is the original error.
- Cancellation rejects with the reason of the signal, also when you call `extract()` later.
- A raw 304 without a cached response from Got fails.
- A failed advertised alternative or a failed HTML counterpart does not fail the page: the article that the reader already has stays.

## What the SDK does not do

- It does not run JavaScript, and it does not read pages that need a login.
- It does not crawl, schedule or keep checkpoints. `@workspace/sdk-web-crawler` and `@workspace/source-web-pages` do that.
- It buffers each download and parses synchronously, so cancellation does not stop a parse that has started.

## Package ownership

| Package                          | Responsibility                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Got 16.1.0                       | HTTP, redirects, decompression, selective retries, deadlines and cancellation      |
| jsdom 30.1.3                     | Charset decoding, HTML base/link resolution, canonical declaration and DOM queries |
| Defuddle 0.19.5, `defuddle/node` | Content selection with introductions, captions and appendices; the inferred date   |
| Mozilla Readability 0.6.0        | Metadata with the existing publication-date and missing-value contract             |
| html-minifier-next 9.0.1         | Stable whitespace/comment normalization while preserving preformatted content      |
| DOMPurify 3.4.17                 | Final HTML sanitization using its native policy                                    |
| html-to-text 10.0.1              | Paragraph boundaries, text conversion and data-table formatting                    |
| node-html-markdown 2.0.0         | Markdown conversion through its public `NodeHtmlMarkdown.translate` API            |
| Marked 18.1.1                    | Native Markdown parsing, including GFM tables and fenced code                      |
| gray-matter 4.0.3, YAML 2.9.0    | Front-matter splitting and YAML 1.2 metadata without date coercion                 |
| Feedscout 2.2.1                  | Advertised alternate representations in HTTP Link headers and HTML                 |
| `@zukhruf/testing/http`          | Disposable real HTTP fixtures for public black-box tests                           |

## Documentation

- [ADR 0001: Defuddle selects the content, and Readability gives the metadata](./docs/adr/0001-defuddle-selects-the-content-and-readability-gives-the-metadata.md)
- [ADR 0002: Defuddle's cleanup is off inside declared article boundaries](./docs/adr/0002-defuddle-cleanup-is-off-inside-declared-article-boundaries.md)
- [ADR 0003: A page of links only is not an article](./docs/adr/0003-a-page-of-links-only-is-not-an-article.md)
- [ADR 0004: Markdown is converted from the sanitized HTML](./docs/adr/0004-markdown-is-converted-from-the-sanitized-html.md)
- [ADR 0005: Native Markdown is kept verbatim, and an HTML counterpart gives the normalized fields](./docs/adr/0005-native-markdown-is-kept-verbatim-and-an-html-counterpart-gives-the-normalized-fields.md)
- [ADR 0006: Front matter is data, read as YAML 1.2](./docs/adr/0006-front-matter-is-data-read-as-yaml-1-2.md)
- [ADR 0007: The dateline hint is removed before Readability reads the page](./docs/adr/0007-the-dateline-hint-is-removed-before-readability-reads-the-page.md)
- [ADR 0008: The fingerprint is known before extraction](./docs/adr/0008-the-fingerprint-is-known-before-extraction.md)
- [ADR 0009: A JSON-LD context array is given to Readability as its schema.org IRI](./docs/adr/0009-a-json-ld-context-array-is-given-to-readability-as-its-schema-org-iri.md)
- [ADR 0010: A page that lists pages is labeled, not rejected](./docs/adr/0010-a-page-that-lists-pages-is-labeled-not-rejected.md)
- [ADR 0011: The inferred publication time is Defuddle's date, in its own field](./docs/adr/0011-the-inferred-publication-time-is-defuddles-date-in-its-own-field.md)
