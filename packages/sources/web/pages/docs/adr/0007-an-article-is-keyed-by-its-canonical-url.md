# An article is keyed by its canonical URL

A site can name one article with two URLs. On ezz.sh, `rss.xml` names `/posts/ways_of_writing` and `sitemap-0.xml` names `/posts/ways_of_writing/` (backlog item 2966). Both URLs answer 200 with the same bytes, and both declare `/posts/ways_of_writing/` as the canonical URL. The articles stream was keyed by the page URL, so the destination had 152 rows for 77 articles.

Thus `ArticleExtractor` gives an `articleUrl`: the canonical URL that the page declares, or the final URL when the page declares none. A web stream of articles uses `articleUrl` as its primary key. Both URLs of one article then give one key on each crawl, and the destination keeps one row.

## Considered Options

- **Normalize the trailing slash.** RFC 3986 does not make `/a` and `/a/` equal, and they resolve relative links against different bases.
- **A content-seen test in the crawler.** The crawler drops a page whose bytes it already saw at another URL in the crawl. The key still depends on crawl order: when one URL leaves its listing, the next crawl finds only the other URL and writes a second row.
- **Keep one row for each page URL, and let readers group by `canonicalUrl`.** Each query must merge the rows, and the rows stay twice in the destination.
- **Key the article by its canonical URL.** This option was selected.

## Consequences

- One row for each article, on every crawl, also when one of its URLs leaves a listing.
- The first crawl still downloads and extracts both URLs. Later crawls skip the extraction of both while they do not change ([ADR 0001](./0001-a-page-is-extracted-again-only-when-its-fingerprint-changes.md)).
- The row holds the record of the URL that the crawl handed back last, with that URL as `pageUrl`.
- A site that declares one canonical URL for different pages gets one row for all of them.
- When an extractor gives a null fingerprint, its page is extracted on each run. When two URLs of such a page are both in the crawl, each writes the row again, because their `pageUrl` differs. `ArticleExtractor` gives no null fingerprint.
