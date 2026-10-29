# A page is extracted again only when its fingerprint changes

A web page gives no reliable sign that it changed. The `lastmod` of a sitemap and the dates of a feed are optional, and many sites do not update them. The source must emit only new and changed records, and it must not extract a page again when its records cannot have changed.

Thus each page is one group of the `diffGroupedSnapshot` of elt. The key of the group is the page URL. Its fingerprint is a hash of the fingerprint from the extractor, the `listingUrl`, the `lastModified` and the `published` of the page. When this fingerprint is the same as the committed one, the source does not extract the page and emits nothing for it. When the extractor gives a null fingerprint, the source always extracts the page. A full refresh always extracts.

## Considered Options

- **Skip a page when its `lastmod` or its feed date did not change.** These hints are optional, so a page can change while its hint stays the same. The source then loses the change.
- **Extract every page on every run, and let the destination remove the duplicates.** Every run then extracts every page and emits records that did not change.
- **Compare a fingerprint for each page.** This option was selected.

## Consequences

- A run on pages that did not change emits no records.
- Every run still downloads or revalidates each page. The HTTP cache makes an unchanged response a 304 when the server sends validators ([ADR 0006](./0006-the-http-cache-is-keyv-on-node-sqlite.md)).
- The extractor decides what a change is. `ArticleExtractor` uses the response bytes, the final URL and the Content-Type. The OpenSooq extractor uses the JSON-LD object of the listing and the page URL, so a new ad on the page is not a change.
- A new listing, a new `lastModified` or a new `published` extracts the page again, because its provenance changes too.
