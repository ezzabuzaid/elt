# A page is a partition whose records a read replaces

The web stream declared no deletions ([ADR 0005](./0005-an-absent-page-is-not-a-deletion.md)), so elt's diff forgot every vanished key with no DELETE. That rule was written for a page that a listing no longer names, but it also covered two pages that the crawl reads. A page that answers 404 or 410 kept its rows, so a product search over shops showed a product that its shop removed, and its link opened a dead page. A sitemap's page that answered 404 also failed the read on every run. A page read again with fewer records kept the rows of the records it no longer gave (elt backlog item 3235).

The established tools delete what a fetch says is gone, and they do not delete what only a listing stopped naming:

- Apache Nutch gives a 404 or 410 the status `db_gone`, and its indexer deletes the document of a gone URL with `-deleteGone`. Its orphan scoring, which removes pages that no link names, is an opt-in plugin.
- StormCrawler sends a URL to its deletion stream once it is gone, and its deletion bolts remove the document from the index.
- dlt's merge deletes the rows of a `merge_key` that a load gives again without them, and Airbyte replaces the records of a partition that a complete read gives.

## Decision

1. **Each page is a partition of its web stream.** A page that the crawl reads again replaces its records: the row of a record that it no longer gives is deleted. The web stream declares `emitsDeletes`, and its policy, `ListedPages`, deletes a key that vanished from a page that the scan listed.
2. **A gone page gives no records.** The crawler hands out a page that answers 404 or 410, or whose third visit in a row fails, as gone ([crawler ADR 0010](../../../../sdks/web/crawler/docs/adr/0010-a-gone-page-is-handed-out-as-gone.md)), and the source diffs it as a page with no records, so its rows are deleted. A gone page is no failure: it fails no read and is no row of the failures stream.
3. **A page that only left its listings keeps its rows**, as ADR 0005 says. It is still a page that the crawl knows, so the crawl hands it out as deferred until it is due, and then requests it, as Nutch keeps fetching a URL that no link names: HTTP decides. While it answers, a read replaces its records; once it answers 404 or 410, it is gone. A page that the scan does not list at all, such as one whose last visit failed and that is not due, lets its keys expire with no DELETE.
4. **A failed page keeps its records.** A failure is no answer about a page's records, as Nutch keeps the document of a URL that it will try again. At the end of each crawl, the source gives each page of `crawl.failures()`, the crawl's dead letters, to the diff as a failed group ([zukhruf snapshot-differential ADR 0010](https://github.com/JanuaryLabs/zukhruf/blob/main/packages/snapshot-differential/docs/adr/0010-a-scan-keeps-a-group-that-it-failed-to-read.md)), also when the run did not request the page because its retry was not due. So a page that answers again with fewer records, or that its third failed visit makes gone, still deletes the records it no longer gives.
5. **A redirected page is no deletion.** The crawler follows a redirect and hands the page back under the URL that it requested, so the page's records come from its target and replace its records as any read does. Nutch deletes a redirected URL because it keeps the redirect itself as a status. This source keeps no record of a redirect.

## Considered Options

- **Keep ADR 0005 for every page, and add a column that says when a crawl last saw a page.** A reader then filters on a time it must choose, and a write per unchanged page defeats the skip of ADR 0001.
- **Delete the rows of every page that a listing no longer names.** A feed that rolls over then deletes its older pages, which ADR 0005 rejected. Nutch removes such orphans only with an opt-in plugin.
- **A page is a partition: a read replaces its records, a gone page has none, and a page that left its listings is read when it is due.** This option was selected.

## Consequences

- An incremental copy of a web stream must use `append_dedup`, as elt requires of every stream that emits deletions. A full refresh replaces its target as before.
- A stream keyed by something other than the page, such as a WooCommerce product's id, deletes a product that no page of the list gives any more. A product that moves to another page of the list keeps its row.
