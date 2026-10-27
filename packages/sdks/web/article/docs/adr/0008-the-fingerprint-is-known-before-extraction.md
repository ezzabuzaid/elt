# The fingerprint is known before extraction

A caller that loads articles on each run must skip pages that did not change. Extraction is the step that it must skip, so the caller must know whether the article can have changed before extraction starts.

Thus `download()` and `read()` return a lazy extraction: a `fingerprint` and an `extract()` function. The fingerprint is a SHA-256 hash of each response that the extraction can read: its final URL, its Content-Type and its bytes, in a fixed order. When Got gives back a cached response after a 304, the bytes are the same, so the fingerprint is the same as for an identical 200. When the article can come from another response, the reader requests that response before it gives the fingerprint: the advertised alternatives in a format that the extraction chain prefers, or the HTML counterpart of native Markdown for a chain that prefers Markdown and also reads HTML. `extract()` uses these responses and makes no request. A failed alternative or counterpart is in the hash as a fixed marker.

## Considered Options

- **Compare the extracted article.** The caller then extracts every page on every run.
- **Hash only the response bytes.** A move to another URL or another Content-Type then shows no change.
- **Hash the final URL, the Content-Type and the bytes, and give null when another response is involved.** Each due visit then extracts a native-Markdown page again (backlog item 3121), and Markdown-first sites serve Markdown for every page.
- **Request the other responses before the fingerprint, and hash all of them.** This option was selected.

## Consequences

- The web source skips the extraction of a page whose fingerprint did not change.
- The fingerprint is never null.
- The reader requests an alternative or a counterpart before the caller knows whether to extract. Extraction requested it on every visit before, so the count of requests does not change. When a page advertises two alternatives, the reader requests both, also when the first one gives the article.
- A change in the page outside the article, such as an ad, changes the fingerprint and causes an extraction. An extractor that knows its records can give a narrower fingerprint.
- Cancellation and `ArticleError` apply also when the caller runs `extract()` later.
