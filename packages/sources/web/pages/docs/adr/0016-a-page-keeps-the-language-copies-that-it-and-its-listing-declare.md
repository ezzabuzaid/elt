# A page keeps the language copies that it and its listing declare

A site publishes one page in several languages, such as `aws.amazon.com/training/startups/` and its German copy `aws.amazon.com/de/training/startups/`. A host that lists programs, such as the startup-credits app of Context Compiler, must count such a page once, and should send one copy, not every copy, to a model. On 2026-11-02, 215 of 1,058 pages of one of its crawls were copies, and they got 47 of its 136 offer calls (backlog item 3408).

Sites declare their copies in three ways, and Google's "Localized versions" guide treats the three as equal: a `<link rel="alternate" hreflang>` element in the head of the page, a `Link` header of the response (RFC 8288), and an `<xhtml:link rel="alternate" hreflang>` element in the page's `<url>` of a sitemap. Google groups the copies that point to each other into one cluster, and ignores a one-way declaration. Translated copies are not duplicates: each copy stays its own URL with its own canonical URL. The open-source crawlers group nothing: Crawlee drops a sitemap's alternates, Scrapy follows them without their language, and Heritrix, Nutch and StormCrawler read them as plain links. Data pipelines such as CCNet filter pages by language instead.

Thus elt keeps each declaration as data, where its declarer is, and leaves the grouping to the host, as Google groups in its index and not in its crawler:

- The page's own declarations, from its head and its `Link` header, are `Article.localizedVersions` in `sdk-web-article`, and the `localizedVersions` column of `ArticleExtractor`. The `Link` header also gives `canonicalUrl` when the head declares none.
- A sitemap's declarations are listing provenance, as `lastModified` is: `codec-sitemap` reads them, the crawler carries them on each page it hands back, and WebSource gives them in the provenance column `listedVersions`.
- Each copy is `{ language, url }`, the language in lower case and the URL resolved, in the order declared. A record holds this list because an elt array can hold objects of scalar fields.
- An article stays keyed by its canonical URL (ADR 0007), so each copy is its own row.

## Considered Options

- **Group the copies in elt.** Only a reader that holds every page of a site can check that two copies point to each other, and a host decides which copy stands for the group.
- **Keep one copy, filtered by language.** A program that a site publishes in one other language only would be lost.
- **One merged column.** WebSource would write into a column that the extractor owns, and an extractor without copies, such as OpenSooq's, has no such column.
- **Both declarations, where each declarer is.** This option was selected.

## Consequences

- A host reads both columns and joins their lists: `SELECT articleUrl, localizedVersions, listedVersions FROM <stream>`.
- The tests `an HTML page's localized versions are the language copies that its head and its Link header declare, itself included, resolved, without fragments and without repeats` (sdk-web-article), `a sitemap's xhtml:link language copies of a page are the page's localized versions, resolved, HTTP only and in lower case, and a feed's item has none` (sdk-web-crawler) and `an article's row keeps the language copies that the page declares, as localizedVersions, and those that its listing declares, as listedVersions, which a listing that declares other copies rewrites while the page stays the same` (this package) prove this rule.
