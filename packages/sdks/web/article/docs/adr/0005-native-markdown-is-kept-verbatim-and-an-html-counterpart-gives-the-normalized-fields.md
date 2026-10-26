# Native Markdown is kept verbatim, and an HTML counterpart gives the normalized fields

Some publishers serve native Markdown. On blog.cloudflare.com, the native Markdown of an article also holds the site navigation, the footer and serialized JSON-LD, and it has no author or publication date (backlog item 2941). The HTML of the same page has article markup and that metadata.

Thus `markdown` keeps the native body exactly, without its front matter. When the extraction chain prefers Markdown and also has an HTML extraction, the HTML counterpart gives the normalized fields, and it fills each metadata field that the native article left null. The URL and the metadata of the native article take precedence. For an advertised alternative, the HTML counterpart is the response that the reader already has. For negotiated Markdown, the reader requests the final URL again, with an Accept header for HTML only.

## Considered Options

- **Find the article boundaries in the native Markdown.** Defuddle and Readability, given HTML rendered from that Markdown, kept the navigation and the JSON-LD as prose. Marked gives tokens, not article boundaries.
- **Write the native Markdown again from cleaned HTML.** The `markdown` field then no longer holds the source of the publisher.
- **Keep the native Markdown, and take the normalized fields from the HTML counterpart.** This option was selected.

## Consequences

- `markdown` can hold navigation, footer text or raw HTML. A consumer that renders it must sanitize it.
- Negotiated Markdown costs one more request.
- When the HTML counterpart fails or has no article, the native article stays, with its normalized fields rendered from the native body.
- An article from native Markdown has a null fingerprint ([ADR 0008](./0008-the-fingerprint-is-known-before-extraction.md)).
