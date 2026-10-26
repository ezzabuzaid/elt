# Defuddle selects the content, and Readability gives the metadata

Readability selected both the content and the metadata of an HTML page. On real pages its selection lost introductions, linked captions, appendices and acknowledgments (backlog item 2919). Its metadata was correct, and callers depend on its field names and on its null values for missing metadata.

Thus Defuddle selects the content, and Readability gives only the metadata. `HTMLExtraction` gives Defuddle the serialized HTML through `defuddle/node`, and it gives Readability the DOM with `charThreshold: 1`, so a short page keeps its metadata. The article takes `content` from Defuddle and the metadata from Readability.

## Considered Options

- **Tune the candidate count, the character threshold and the link density of Readability.** Probes recovered the linked caption, but they still lost the introduction and the appendix.
- **`@extractus/article-extractor` 9.0.1.** It wraps the same Readability algorithm with fixed options, so it has the same losses. Probes also found subscription text and inferred publication dates.
- **Crawlee.** Its crawler needs an extraction handler, and its HTML-to-text helper does not select an article.
- **Defuddle for the content, and Readability for the metadata.** This option was selected.

## Consequences

- The metadata keeps the field names and the null values of Readability.
- Defuddle reads the HTML string with its own parser. When it got the jsdom document, its selector went beyond the 2048-character selector limit of jsdom, and Defuddle used a fallback that lost its cleanup. Defuddle marks the string input as deprecated for its next major version, so the package pins Defuddle 0.19.5.
- Each page is parsed twice: one time by jsdom and one time by Defuddle.
