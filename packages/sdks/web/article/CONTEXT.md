# Web article

A caller has a web page and wants its article: the readable body and its metadata, without the navigation, ads and other parts of the site around it. `WebArticle` downloads the page, or reads a response that the caller downloaded, and gives each representation to its extractions in order. The first extraction that finds an article ends the chain.

## Language

**Page**:
One response as an extraction reads it: the final URL, the body bytes and the Content-Type header (`ArticlePage`).
_Avoid_: Document (a DOM document is one step of HTML extraction), response (a page can come from a response that the caller downloaded)

**Article**:
The readable content and metadata that an extraction returns for one page (`Article`).
_Avoid_: Post, story, result

**Extraction**:
One way to read one family of media types into an article: `HTMLExtraction` or `MarkdownExtraction`.
_Avoid_: Parser, scraper, extractor (the web source uses extractor for its `RecordExtractor`)

**Extraction chain**:
The ordered extractions of a `WebArticle`. Their order sets the Accept header and the preferred representation.
_Avoid_: Pipeline (an elt pipeline loads data), fallback list

**Representation**:
One format of the same page, such as HTML or Markdown.
_Avoid_: Version, variant, copy

**Native Markdown**:
Markdown that the publisher serves for a page.
_Avoid_: Converted Markdown (the HTML extraction converts its own Markdown from HTML)

**Negotiated Markdown**:
Native Markdown that the server returns because the Accept header prefers `text/markdown`.
_Avoid_: Requested Markdown

**Advertised alternative**:
A representation that a page names with `rel="alternate"` in an HTTP Link header or an HTML link element.
_Avoid_: Guessed URL (the SDK does not guess `.md` paths)

**HTML counterpart**:
The HTML representation of a page whose native Markdown was read. It gives the normalized fields and the missing metadata.
_Avoid_: Companion, fallback (a fallback is the HTML-only request after unusable negotiated Markdown)

**Selection**:
The part of an HTML page that Defuddle takes as the article body.
_Avoid_: Extraction (an extraction does more than select), parse

**Normalized fields**:
`content`, `textContent` and `length`: the sanitized HTML of the selection, its text and the length of the text.
_Avoid_: Clean fields

**Metadata**:
`title`, `byline`, `publishedTime`, `excerpt`, `siteName`, `lang`, `dir` and `canonicalUrl`. A missing value is null; the SDK does not infer one.
_Avoid_: Provenance (the web source adds provenance columns)

**Inferred publication time**:
The publication date that Defuddle finds in an HTML page, in ISO 8601 UTC (`inferredPublished`): the declared date or, when the page declares none, a date in the text near the title. It is not metadata, because it can be a guess.
_Avoid_: Published time (`publishedTime` is only the declared date), feed date (the web source's `published` comes from the listing)

**Fingerprint**:
A hash of the response bytes, the final URL and the Content-Type, known before extraction. It is null when another response can change the article.
_Avoid_: ETag (an ETag is an HTTP validator), version

**Acceptance check**:
The rule that an HTML article must keep prose after the links outside `article`, `[role="article"]` and `table` are removed.
_Avoid_: Readerable check (Readability's `isProbablyReaderable` is not used)

**List**:
A page that lists other pages, such as a category, a tag page, an archive or a blog index. Its article has `list` set to true. The page declares a schema.org `CollectionPage`, or its content is cards: two or more top-level `article` elements that link other pages and hold more than half of its words. When the page declares no type, more than a third of the article's words can also be links to two or more pages of its origin.
_Avoid_: Listing (the web source uses listing for the response that first named a page), index, hub
