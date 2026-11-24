# A JSON list hands back each of its pages

Before this decision, `PaginationReader` read only HTML lists. It read the HTTP `Link` header of a list, but only when the list answered HTML, because it read the rest of the list with jsdom. A JSON list did not page at all. WooCommerce's public Store API is one: `GET /wp-json/wc/store/v1/products?per_page=100&page=1` answers `application/json` with `Link: <…page=2>; rel="next"`, `X-WP-Total` and `X-WP-TotalPages`, and its body is an array of products. On 2026-11-24, 22 of the 46 Jordanian shop hosts with 20 or more product URLs in Common Crawl `CC-MAIN-2026-43` ran WooCommerce, and 10 of them gave no schema.org `Product` in their pages, so the Store API was their only structured data (backlog item 5576). Commit b8243cab, which made `PaginationReader`, was for the category pages of marketplaces and blogs; it did not consider JSON.

An HTML list links its items, so its items are the pages. A JSON list holds its items, so the list is the data. The pipeline tools that page through JSON lists all model it so. These citations are of their `main` branches on 2026-11-24:

- Airbyte's declarative CDK (airbyte-python-cdk 3527d41c): `cursor_pagination_strategy.py`, lines 129 to 154, puts `response.links` of the `requests` library in the template as `headers["link"]`, and the manifest's `"{{ headers.link.next.cursor }}"` gives the next page. `simple_retriever.py`, lines 838 to 868, runs the record selector on every response, then asks for the next page.
- dlt (84e87f8f): `HeaderLinkPaginator` (`paginators.py`, lines 665 to 714) reads `response.links.get("next")`, and its docstring's example is a JSON array with `Link: <…page=2>; rel="next"`. `client.py`, lines 271 to 291, extracts the data of every page. Its paginator detector tries the `Link` header first (`detector.py`).
- The Singer SDK (meltano/sdk fbcfe6ad): `HeaderLinkPaginator` (`pagination.py`, lines 269 to 288) reads `response.links.get("next")`, and `records_jsonpath` `$[*]` makes a top-level array the records of each page.

None of them checks the content type of the response before it reads the `Link` header. A next link in the body is a path that the user declares in all three, and only dlt also guesses one. No crawler that we checked (Crawlee, Scrapy, Heritrix, Nutch, StormCrawler) follows a `Link` header.

## Decision

1. **The reader that knows the format decides.** `PaginationReader` reads a starting URL or a list that answers JSON: `application/json`, or a format with the `+json` suffix of RFC 6839, such as JSON:API's `application/vnd.api+json` and HAL's `application/hal+json`. A JSON Feed is not a JSON list: it is a feed, which `ListingReader` reads, and it is often served as `application/json` or as `application/feed+json`, a `+json` format. Thus the reader leaves a body that feedsmith's `detectJsonFeed` finds to be a JSON Feed, as `ListingReader` finds it with the same function. The first build of this decision read a JSON Feed as a JSON list, and handed back the feed itself as a page; three tests of source-web-pages failed, because `ArticleExtractor` could not read the feed. The engine knows no format ([ADR 0001](./0001-one-engine-downloads-and-each-reader-finds-one-kind-of-url.md)), so it stays as it is.
2. **Each page of a JSON list is a page and a list.** Each page that the `Link` header declares with `rel="next"`, `prev`, `next-archive` or `prev-archive` is a page, so the crawl hands it back to the host's extractor, and a list, so the reader reads its `Link` header in turn.
3. **The starting list is a page too.** The reader finds the starting JSON list as a page, as `StartReader` finds a starting URL. Otherwise a host that did not give `StartReader` would lose the records of page 1 and get those of the other pages.
4. **Only the `Link` header is read.** RFC 8288 defines the `Link` header for every representation. A JSON body has no standard place for its next page, and no consumer needs one, so the reader reads none there.
5. **The header has one rule for HTML and JSON.** The same function reads the `Link` header of both, and keeps only the pages on the list's own origin, as HTML pagination stays on its origin. A declared page that fails is an error. The fragment of a declared URL is removed, as for every URL of the crawl: WordPress escapes the `&` of its next page as `&#038;`, so `page=2#038;page=1` is `page=2`.

## Considered Options

- **The host gives `StartReader` beside `PaginationReader` for page 1.** A host that forgot it would lose the records of page 1 without an error. This option was rejected.
- **The engine decides that a JSON list is a page.** The engine would then know a format, against ADR 0001. This option was rejected.
- **The reader also reads a next link in the body, such as `links.next` or `_links.next.href`.** No consumer needs it, and the Rule of Three adds no option for a later consumer. This option was rejected.
- **The reader of JSON lists reads the `Link` header, and each page of the list is a page.** This option was selected.

## Consequences

- A web stream with `PaginationReader` and an extractor of JSON gets the records of every page of a JSON list, such as WooCommerce's Store API.
- The crawl downloads the starting JSON list a second time to hand it back, as for `StartReader`. Got's cache makes that a revalidation when the server gives validators.
- A JSON list whose next page is only in its body does not page. Its first page is handed back.
- A JSON list hands back no URLs that its records name, because its items are its records. An extractor that needs the item pages, such as each product's `permalink`, is a separate stream over those URLs.
