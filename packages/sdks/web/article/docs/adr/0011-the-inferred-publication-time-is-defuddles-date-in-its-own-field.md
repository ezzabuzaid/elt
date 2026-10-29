# The inferred publication time is Defuddle's date, in its own field

Some pages show their date only as text near the title. research.google/blog puts `<p>October 27, 2026</p>` in a block after the `h1`, and ai.meta.com/blog puts `<span>July 9, 2026</span>` there. These pages declare no JSON-LD `datePublished`, no `article:published_time` and no `<time>`, and the two labs publish no feed. Thus `publishedTime` was null, the feed date of the web source was null, and a host could not sort or window the posts (backlog item 3262).

`publishedTime` is the date that the page declares, raw, as Readability reads it. ADR 0009 rejected Defuddle's `published` for that field, because Defuddle guesses a date from the text when the page declares none. A guess must not look like a declared date.

Thus `HTMLExtraction` gives Defuddle's `published` in a different field, `inferredPublished`. `Date` reads it, and the field holds it in ISO 8601 UTC, or null when `Date` cannot read it. `publishedTime` does not change.

Defuddle 0.19.5 (`DefuddleMetadata.getPublished`) finds the date in this order:

1. The JSON-LD `datePublished`, the `publishDate` and `article:published_time` meta tags, an `abbr[itemprop="datePublished"]`, and a `<time>` that is not in a link to another page of the site.
2. When the page declares none, a date such as `October 27, 2026` or `27 October 2026` in the three elements after the `h1`, then in `p` and `time` elements in the three elements before it. This date gets 00:00 UTC.

On the retained pages, `inferredPublished` is `2026-10-27T00:00:00.000Z` for the Google Research post and `2026-07-09T00:00:00.000Z` for the Meta AI post. `publishedTime` is null for both.

## Considered Options

- **Fill `publishedTime` from Defuddle when Readability gives none.** A reader then cannot know if the date is declared or guessed. ADR 0009 rejected this.
- **Write a rule that reads dates from the text.** htmldate (`find_date` with `extensive_search`), which trafilatura uses for its metadata, reads the declared metadata first and then searches the text for date patterns. Defuddle already does this near the title, and the retained pages get the correct date from it.
- **Give only the guess, null when the page declares a date.** The SDK must then repeat the declared rules of Defuddle to know which step gave the date.
- **Give Defuddle's date, parsed, in its own field.** This option was selected.

## Consequences

- A host can choose the declared date (`publishedTime`), then the feed date (`published` of the web source), then `inferredPublished`, and then its own fallback.
- When the page declares a date, `inferredPublished` is that date in UTC. Defuddle and Readability can read different declarations, such as a `<time>` that Readability does not read.
- The text rule knows only English month names. Other languages and numeric dates, such as `27/10/2026`, give null.
- A date in the text near the title can be a date that is not the publication date, such as an event date.
- `MarkdownExtraction` gives null. For native Markdown with an HTML counterpart, the counterpart gives `inferredPublished`.
