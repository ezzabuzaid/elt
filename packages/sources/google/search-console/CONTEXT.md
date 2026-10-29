# source-google-search-console

A user wants the Search Console data of their sites in a store that SQL can read: the search traffic, the sitemaps and the index status of each page. The Search Console source reads one or more properties through the Search Console API. The words that all of elt uses, for example stream, partition, checkpoint and snapshot, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Property**:
One site in Search Console: `sc-domain:<domain>` for a domain property, or the URL prefix of a URL-prefix property. The API calls it a site, and the records hold it in `siteUrl`.
_Avoid_: Site (`sites` is the stream that lists the properties), domain, account

**Grant**:
The OAuth permission that one Google account gave to the app, stored by `googleSession`. It sets which properties the source can read.
_Avoid_: Credential, login, token (a session makes its own access token from the grant)

**Report type**:
One search surface of Google: `WEB`, `IMAGE`, `VIDEO`, `NEWS`, `DISCOVER` or `GOOGLE_NEWS`. The API and the records call it `searchType`. Each report type is a separate audience, so do not add them up.
_Avoid_: Channel, search type (in prose)

**Grain**:
The dimensions that one search analytics stream asks for: the day, the day and query, the day and page, or the country and device.
_Avoid_: Granularity, level, breakdown (a breakdown is a grain other than the daily totals)

**Pacific day**:
A calendar day in Pacific Time (`America/Los_Angeles`). Search Console reports each date this way.
_Avoid_: Day (when the time zone matters), UTC day

**Settled day**:
A day before the `firstIncompleteDate` of a response. Google does not restate it. A row of a later day has `settled` false.
_Avoid_: Final day (`dataState: 'FINAL'` is an option of the API), complete day

**Re-read**:
A day that the next run reads again: the last settled day and each day after it.
_Avoid_: Lookback, overlap

**Inspection**:
One URL Inspection API request for one URL, and the index status that it gives.
_Avoid_: Crawl, check, scan (a scan is the shared work of one read)

**Discovered set**:
The URLs that the source can inspect for a property: each URL that its sitemaps list and each page in its search analytics, in the property. The set is complete when the source could read each sitemap.
_Avoid_: Universe (the name in the code), crawl, sitemap

**Due URL**:
A URL of the discovered set that was never inspected, or whose last inspection is older than `inspectionRefreshHours`.
_Avoid_: Stale URL, pending URL

**Quota reset**:
The next midnight in Pacific Time, when the daily inspection quota of a property starts again. The checkpoint keeps it as `quotaResetAt`.
_Avoid_: Cooldown, backoff (a backoff is the wait of a retry)

**Reader view**:
The view `marts.search_console_<snake_stream>` that the host makes over the raw table of each copy. Readers query it.
_Avoid_: Mart (the schema is `marts`), report
