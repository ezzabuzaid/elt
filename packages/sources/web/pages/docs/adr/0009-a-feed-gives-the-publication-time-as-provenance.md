# A feed gives the publication time as provenance

Many posts have no date in their own page. OpenAI, Apple Machine Learning Research and Sakana AI give the date only in the `pubDate` of their RSS items (backlog item 3257). The codec read the link of each item and ignored its dates, so the record had no date, and a host could not sort the posts or put them in a time window.

Thus the listing gives each page a publication time, and the source adds it to the record as the provenance column `published`, next to `listingUrl` and `lastModified`. An RSS `pubDate` (RFC 822), an Atom `published` and a JSON Feed `date_published` (RFC 3339) are publication times. `ListingReader` reads them with `Date` and gives them in ISO 8601 UTC, so the column is a `date-time` that the destinations store as a timestamp. A value that `Date` cannot read gives null. An Atom `updated` and a JSON Feed `date_modified` are modification times, so they go into `lastModified`, raw, as a sitemap `lastmod` does.

## Considered Options

- **Put the feed date into `lastModified`.** A modification is not a publication. A post that its publisher edits gets a new `updated`, and a revisit policy reads `lastModified` to request the page again. One column cannot be both.
- **Fill `publishedTime` of `ArticleExtractor` from the feed when the page has no date.** `publishedTime` is the metadata that the page gives, raw. With the feed date in it, a reader cannot know where the date came from, and every other extractor would need the same fallback.
- **Keep the raw text of the date.** An RFC 822 date does not sort as text, and each host would parse it again.
- **A provenance column that the listing gives, parsed by `Date`.** This option was selected.

## Consequences

- A host can sort and window the posts by `published` when the page gives no `publishedTime`.
- An Atom entry with only `updated` has a `lastModified` and no `published`.
- The fingerprint of a page includes `published`, so a new date in the feed writes the record again ([ADR 0001](./0001-a-page-is-extracted-again-only-when-its-fingerprint-changes.md)).
- `Date` is lenient: V8 reads some text that is not RFC 822 or RFC 3339, such as `not a date 2026`, as a date.
- An RDF item gives no `published`: the RDF feeds give only `dc:date`, which does not say if it is a publication or a modification.
