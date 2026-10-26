# The fingerprint is known before extraction

A caller that loads articles on each run must skip pages that did not change. Extraction is the step that it must skip, so the caller must know whether the article can have changed before extraction starts.

Thus `download()` and `read()` return a lazy extraction: a `fingerprint` and an `extract()` function. The fingerprint is a SHA-256 hash of the final URL, the Content-Type and the response bytes. When Got gives back a cached response after a 304, the bytes are the same, so the fingerprint is the same as for an identical 200. When the article can come from another response, the fingerprint is null: the page names an advertised alternative in a format that the extraction chain prefers, or it is native Markdown for a chain that prefers Markdown and also reads HTML.

## Considered Options

- **Compare the extracted article.** The caller then extracts every page on every run.
- **Hash only the response bytes.** A move to another URL or another Content-Type then shows no change.
- **Hash the final URL, the Content-Type and the bytes, and give null when another response is involved.** This option was selected.

## Consequences

- The web source skips the extraction of a page whose fingerprint did not change.
- A page with a null fingerprint is always extracted.
- A change in the page outside the article, such as an ad, changes the fingerprint and causes an extraction. An extractor that knows its records can give a narrower fingerprint.
- Cancellation and `ArticleError` apply also when the caller runs `extract()` later.
