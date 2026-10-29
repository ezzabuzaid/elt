# @workspace/source-google-search-console

An ELT source for Google Search Console properties. It reads each property through the `searchconsole:v1` API: the properties, the sitemaps, the search analytics and the URL inspections. The API serves `sites`, `sitemaps` and `searchAnalytics` under the original `webmasters/v3` path prefix. It serves URL inspection from `v1` on the same host.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md), and the glossary of [elt](../../../elt/CONTEXT.md) for the words of all of elt.

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import {
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  googleSession,
} from '@workspace/google-auth';
import { SearchConsoleSource } from '@workspace/source-google-search-console/search-console-source';

const url = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'google_search_console';

const source = new SearchConsoleSource({
  requester: await googleSession({
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
    directory: join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'elt',
    ),
  }),
  siteUrls: ['sc-domain:example.com', 'sc-domain:example.org'],
});
const destination = new PostgresDestination({ url, schema });
const { streams } = await source.discover();

await new Pipeline({
  history: new PostgresSyncHistory({ url }),
  connections: [
    new Connection({
      name: 'google-search-console',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url, schema }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            destination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `search_console_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `search-console:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
}).run();
```

The Google app (`apps/google/src/main.ts`) runs this program for `sc-domain:ezz.sh`. Each copy loads `google_search_console.raw_<stream>`, and readers query the reader view `marts.search_console_<snake_stream>`. See [Reader views](#reader-views).

## Options

| Option                   | Default                                                    | What it does                                                             |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `requester`              | none                                                       | The authenticated requester from `googleSession`. See [Access](#access). |
| `siteUrls`               | none                                                       | One or more distinct properties.                                         |
| `searchTypes`            | `WEB`, `IMAGE`, `VIDEO`, `NEWS`, `DISCOVER`, `GOOGLE_NEWS` | The report types of `searchAnalyticsDaily` and of URL discovery.         |
| `breakdownMonths`        | 3                                                          | The window of `searchAnalyticsCountries`, in calendar months.            |
| `inspectionRefreshHours` | 24                                                         | The age at which an inspected URL is due again.                          |
| `inspectionConcurrency`  | 16                                                         | The number of URL inspection requests in flight for one property.        |
| `streamConcurrency`      | 4                                                          | The number of streams that one read reads at once.                       |
| `pollIntervalMs`         | six hours                                                  | The time between two probes of a watch. See [Watching](#watching).       |

The report types change which rows exist. Thus they are part of the source identity, `search-console:<report types joined by +>`, and a different list binds different checkpoints. The properties are not part of the identity. Each property is a partition. See [ADR 0001](./docs/adr/0001-each-property-is-a-partition-of-one-source.md).

## Streams

| Stream                     | Extraction               | Key                                  | One record per                                         |
| -------------------------- | ------------------------ | ------------------------------------ | ------------------------------------------------------ |
| `sites`                    | Full refresh or snapshot | `[siteUrl]`                          | property that the grant can read                       |
| `sitemaps`                 | Full refresh or snapshot | `[siteUrl, path]`                    | sitemap that the property lists                        |
| `sitemapContents`          | Full refresh or snapshot | `[siteUrl, sitemapPath, type]`       | content type in a sitemap                              |
| `searchAnalyticsDaily`     | Incremental              | `[siteUrl, date, searchType]`        | Pacific day and report type                            |
| `searchAnalyticsQueries`   | Incremental              | `[siteUrl, date, query]`             | Pacific day and query, web results only                |
| `searchAnalyticsPages`     | Incremental              | `[siteUrl, date, page]`              | Pacific day and page, web results only                 |
| `searchAnalyticsCountries` | Full refresh or snapshot | `[siteUrl, country, device]`         | country and device, web results only                   |
| `urlInspection`            | Incremental (rolling)    | `[siteUrl, inspectionUrl]`           | URL that the source inspected                          |
| `urlInspectionSitemaps`    | Incremental (rolling)    | `[siteUrl, inspectionUrl, position]` | sitemap in the index status of an inspected URL        |
| `urlInspectionReferrers`   | Incremental (rolling)    | `[siteUrl, inspectionUrl, position]` | referring page in the index status of an inspected URL |

- `sites` lists the properties that the grant can read, also the properties that `siteUrls` does not select. Google also lists the properties where the grant is `siteUnverifiedUser`. The source drops them, because their history cannot be read.
- `sitemaps` holds the report of Google on each listed sitemap. Google sends the int64 counts `warnings`, `errors` and `submitted` as decimal strings. The source parses them to integers and rejects an integer that is not safe. `lastDownloaded` is null until Google reads the sitemap for the first time. The stream also holds what the source read from the sitemap file: `urlsRead`, or `readError` when the source could not read the file.
- `sitemapContents` holds the rows for each content type that each sitemap holds.
- `searchAnalyticsDaily` holds the totals of the property for each day and each report type. `searchType` is a column.
- `searchAnalyticsCountries` holds the totals of a trailing window of `breakdownMonths`, from `startDate` to `endDate`, the day of the read. The stream has no date dimension. Thus each read replaces the whole window, and the source compares it as one list. It does not resume it.
- `urlInspection` holds one row for each inspected URL. `inSitemap` and `inSearchAnalytics` tell where the source found the URL, and `inspectedAt` tells when it inspected the URL. `errorStatus` and `errorMessage` are set when Google rejected the URL.
- `urlInspectionSitemaps` and `urlInspectionReferrers` hold the arrays in the index status result.

One source reads all the properties in `siteUrls`. Each stream other than `sites` is a partitioned stream with `partitionKey: ['siteUrl']`. Each property has its own checkpoint, each row holds its property in `siteUrl`, and each key starts with `siteUrl`. Thus all properties share one table for each stream. When you add a property, the source reads all of its history, and the other properties resume. When you remove a property, the source stops reading it and keeps its rows. `sites` is not partitioned, because the grant lists the same properties for each property. See partitioned streams in [elt](../../../elt/README.md#partitioned-streams).

Each read of a snapshot stream gives the complete list. Thus an incremental copy (`append_dedup` on the key of the stream, with no `cursorField`) writes only the changed rows and deletes the rows that left the list. See snapshot streams in [elt](../../../elt/README.md#snapshot-streams). The inspection streams are rolling. See [URL inspection and quota](#url-inspection-and-quota).

A target has one writer. Thus put all properties in the list of one source. A second connection into the same tables is refused. See target ownership in [elt](../../../elt/README.md#target-ownership).

## Access

The app signs in with its own **Desktop-type** OAuth client. The client id and secret come from `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The read scope is `GOOGLE_SEARCH_CONSOLE_SCOPE`, `https://www.googleapis.com/auth/webmasters.readonly`. Search Console gives access for each property. The Google Cloud project of the client supplies the API quota. Thus the project must have `searchconsole.googleapis.com` enabled. Google bills a user credential to the project that issued its OAuth client. Thus no quota-project header is necessary.

Do this setup one time in the Cloud Console. Google has no API that makes a Desktop OAuth client.

1. Set the OAuth consent screen to External, and add the `webmasters.readonly` scope.
2. Set the publishing status to **In production**. When an External consent screen is in **Testing**, Google gives refresh tokens that expire after 7 days. Only the scopes name, email address and user profile do not cause this, and `webmasters.readonly` is not one of them.
3. Make an OAuth client ID of the type **Desktop app**, and export its id and secret.

`googleSession` from `@workspace/google-auth` then operates as follows:

- **First run.** When no stored grant has the scopes, it listens on `http://127.0.0.1:<random port>/callback`. It opens the consent link in the default macOS browser, and it waits for a maximum of five minutes. It accepts only a redirect that has the `state` of the flow. Each other request gets `400`, and the listener continues to wait.
- **Browser failures.** When the browser does not open, sign-in fails and the callback listener closes. On other platforms and in headless sessions, give `googleSession({ openBrowser })` to show the consent URL. The library does not print links or errors.
- **Later runs.** The session uses the stored grant again with no browser. The grant keeps the refresh token and each scope that Google granted, but no access token. Each session makes its own access token on its first call, for the scopes that it asked for only. A refresh can name a subset of the granted scopes (RFC 6749 §6). When Google rotates the refresh token, the session writes the new token before the request that caused the rotation returns.
- **One grant, narrow tokens.** All sessions of one account share one grant. The token of each session has only the scopes of that session. Thus an API that refuses a token with the restricted scope of a different API, for example Google Health (`403 DISALLOWED_OAUTH_SCOPES`), accepts it. A Search Console session also has no Drive or Gmail access.
- **New scopes.** When a later caller needs a scope that the grant does not have, consent runs again for all the old and new scopes. Thus no permission that Google gave before is lost.
- **Revoked or expired grants.** When Google refuses the stored refresh token, consent runs again. Causes are revoked consent, a token from Testing mode that expired, and a Workspace demand to authenticate again.

The host sets where the grants are. `googleSession` keeps them in `<directory>/google/`, and the Google app gives `${XDG_CONFIG_HOME:-~/.config}/elt`. Each grant is a JSON file that only the owner can read (`0600`). The session writes it to a temporary file and then renames it. Thus a crash keeps the previous grant. gcloud gives its own refresh token the same protection. The file is not encrypted. The file and directory names are SHA-256 hashes, not account ids. To use a different Google account, delete that directory. The next run then asks for consent.

`failureType` gives `config` for a `401`, a `403` and a grant that Google revoked (`invalid_grant`). Only the user can repair these, and a watch does not try them again. Each other failure is `system`. A `SearchConsoleQuotaError` is `system` too.

## Search analytics

### Each grain is its own stream

Google holds back rare queries for privacy. The loss increases with each dimension that a request adds. These are measurements of one live property from 2026-09-10 to 2026-09-20:

| Request                                      | Rows | Clicks | Impressions |
| -------------------------------------------- | ---- | ------ | ----------- |
| `['date']`                                   | 11   | 58     | 1986        |
| `['date','query','page','country','device']` | 749  | 37     | 1020        |

One wide request loses 36% of the clicks and 49% of the impressions. No aggregation of it can give the real totals of the property again. Thus each grain is its own stream with its own window. `searchAnalyticsDaily` holds the only correct totals. You can compare the rows of a breakdown only with other rows of the same breakdown. The query and page rows do not add up to the daily totals.

Do not average `ctr` or `position` over rows:

- The click-through rate is `sum(clicks)::float / nullif(sum(impressions), 0)`.
- The average rank is `sum(position * impressions) / nullif(sum(impressions) FILTER (WHERE position IS NOT NULL), 0)`.

The descriptions of `clicks`, `ctr` and `position` give these formulas. Each reader view shows them as column comments.

### Projection

- The API does not name the columns of a row. `keys` has one value for each requested dimension, in the same order. When a row has a different number of keys, the source skips that row. It does not fail the copy.
- `clicks`, `impressions` and `ctr` are always present, also when they are zero. For example, live Discover rows report `"clicks":0,"impressions":0,"ctr":0`. `clicks` and `impressions` are integers. A missing or fractional count fails validation.
- Each dated row has `settled`. It is false from the `firstIncompleteDate` of the response, because Google can still restate those days. The next incremental run reads the day again, and the flag becomes true when Google settles the day.
- `position` can be null. Discover and Google News report no rank on any row, also on rows with no traffic. When a missing rank loads as `0`, it tells the best possible position, which is wrong. A live run found no position on all 380 Discover and all 380 Google News daily rows.
- `date` is a calendar day in Pacific Time, not an instant (`format: 'date'`). The source finds the current day in Pacific Time with Temporal.
- The history of 16 months is calendar arithmetic. When the earlier month is shorter, the day becomes its last day: sixteen months before 31 March is 30 November. A count of 480 days moves by about one week, and history is lost with no signal.

### Incremental reads

Google changes the metrics of the last two or three days. Each response tells `firstIncompleteDate`, the first day that Google still collects. Thus the source does not guess a lookback:

- The checkpoint is `{ date: '<last settled day>', diff }`. `diff` is the snapshot of the days from that date.
- A run starts **at** the saved date, not after it. Thus the run reads the last settled day again.
- Requests use `dataState: 'ALL'`. The checkpoint moves to `firstIncompleteDate` minus one day. When the API reports no `firstIncompleteDate`, the checkpoint moves to the end date.
- The source reads 25000 rows on each page with `startRow`, until a page has fewer rows.
- The source compares each read with the previous read, and it keeps only the days from the start of the next read. A row that Google restated loads again. A row that did not change is not written again. When Google does not give a row again for a day that the run read again, the source deletes the row. When the day comes back empty, the source deletes all rows of the day. The days before the window stay as they are. See [ADR 0002](./docs/adr/0002-a-re-read-day-loses-the-rows-that-google-no-longer-returns.md).

`searchAnalyticsDaily` sends one request for each report type. The report types settle at different times. Thus the checkpoint keeps the earliest settled day of all report types.

## URL inspection and quota

URL inspection has no list endpoint. Each row costs one request for one URL. A property gets 2000 requests each day and 600 each minute. The source inspects each URL that it can find for a property:

- **Discovery.** The source finds the URLs in two places. The first is each sitemap that the property lists (`sitemaps.list`), downloaded from the site: XML URL sets, sitemap indexes, RSS 2.0 and Atom feeds, and plain-text lists, with or without gzip. The source follows sitemap indexes for a maximum of three levels. A deeper index is a `readError` of that sitemap. The second is each page in the search analytics of 16 months, for each configured report type. The source removes each `#fragment`, because Google Search indexes documents, not anchors. It merges duplicates, and it keeps only absolute `http` and `https` URLs in the property. A domain property (`sc-domain:example.com`) has its host, its subdomains and both schemes. A URL-prefix property has each URL that starts with the prefix. No Google API can find a page that is in no sitemap and that never showed in search.
- **Rolling refresh.** The checkpoint of each stream keeps the last inspection time of each URL. A run inspects the URLs that it never inspected first. Then it inspects the URLs whose last inspection is older than `inspectionRefreshHours`, the oldest first. A newer URL costs nothing. When a property has more URLs than the daily quota, the source inspects them over many days. Each URL is then inspected again about each ⌈URLs / 2000⌉ days.
- **Concurrency.** `inspectionConcurrency` requests run at once. The source starts fewer than 600 requests each minute. Thus a quota refusal can only be the daily quota. In a live run, 126 URLs took 54 seconds. One request at a time took about 6.6 seconds for each URL.
- **Quota.** When Google refuses for quota (a `429` that continues after the retries), `inspectUrls` in `@workspace/sdk-google-search-console` starts no new request. The requests in flight finish, and the source commits the inspections that succeeded. The source then sends no inspection request for that property until the next midnight in Pacific Time, when the daily Google Cloud quotas reset. It keeps that time as `quotaResetAt` in the checkpoint of each inspection stream. Thus the next run also waits. See [ADR 0003](./docs/adr/0003-an-exhausted-inspection-quota-waits-until-pacific-midnight.md).
- **Rejected URLs.** When Google answers `400` or `404` for one URL, the source loads a `urlInspection` row with `errorStatus`, `errorMessage` and null verdicts, and the run continues. Each other error, for example a `401` or a `403`, fails all URLs in the same way. Thus it fails the copy.
- **Removal.** Each inspection stream compares its rows with its snapshot under a `Coverage` policy. The policy covers the URLs that the run inspected and the URLs that left the discovered set. When a URL leaves the discovered set, the source deletes it from all three tables. When an array becomes shorter, its extra positions are deleted. A row that did not change is not written again. A URL that the run did not inspect keeps its rows. When a sitemap cannot be read, the discovered set is not complete, and no URL is deleted because it left the set.
- **Sharing.** One request serves all three inspection streams. The source keeps its inspections in memory for one read. Before it calls the API, a stream uses an inspection that is newer than the inspection that the stream loaded last. The source reads `streamConcurrency` streams at once, so the three inspection streams can run together. For each property, they plan and inspect one at a time. Thus a stream sees what the stream before it inspected, and no URL is inspected two times. Different properties do not wait for each other.
- **Sitemaps that cannot be read** do not stop inspection. The `sitemaps` stream loads the outcome of each listed sitemap (`urlsRead`, `readError`). The source still inspects the URLs that the other places show. In a live run, `https://ezz.sh/sitemap.xml` reset TLS connections, and Google itself last read it on 2025-07-20 with one error.

## Retry

`SearchConsoleApi` in `@workspace/sdk-google-search-console` makes each Search Console call. It retries rate limits and temporary server errors. When the retries end, it fails with an error. Search Console permits 1200 queries each minute for each site and user, and 40000 each minute and 30000000 each day for each project.

| Response                                                         | Retried | When the retries end                                    |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `429`                                                            | Yes     | `SearchConsoleQuotaError`, with `status` and `attempts` |
| `403` with reason `rateLimitExceeded` or `userRateLimitExceeded` | Yes     | `SearchConsoleQuotaError`                               |
| Each other `403` (scope not sufficient, API not enabled)         | No      | The original error, with no change                      |
| `408`, `500`, `502`, `503`, `504`                                | Yes     | The original error, with no change                      |
| Each other response                                              | No      | The original error, with no change                      |

The wait uses the `Retry-After` of the server, in seconds or as an HTTP date. When the server sends no `Retry-After`, the wait starts at one second and doubles with each attempt, with full jitter, to a maximum of one minute. When `Retry-After` is longer than one minute, the call fails immediately, and the pipeline does not stop to wait. A call makes a maximum of five attempts. The SDK sets this policy, and no option changes it.

The transport of google-auth-library, gaxios, has its own retry. But that retry is off by default, it does not retry `POST`, and it does not read `Retry-After`. `searchAnalytics.query` and URL inspection both use `POST`. Thus the retry is in `SearchConsoleApi`, over the `GoogleRequester` interface, which is not specific to a library.

## Watching

Search Console sends no change notifications. Thus `observe()` polls. A host that calls `Pipeline.watch()` uses it. The Google app runs one pass and stops, so no host watches Search Console now.

Each `pollIntervalMs`, the watch reads two probes. Each probe wakes only the streams of its data:

- The daily `WEB` totals of each property for the last 28 days, grouped by `date`, wake the analytics streams. They wake when `firstIncompleteDate` moved or when the clicks or impressions of a day changed. When Google restates the breakdown by query and the daily totals stay the same, this probe does not see the change.
- The list of properties and the sitemap list of each property wake `sites`, `sitemaps` and `sitemapContents` when one of them changed.

Inspections do not follow traffic. The source sets when they are due. It learns the last inspection of each URL from the checkpoints that its extractions get. It wakes only the inspection streams when the next URL becomes due, or at the quota reset at midnight in Pacific Time. When an extraction learns a due time, it wakes the watcher. Thus the watch keeps a due time that is sooner than the next poll. When no extraction moved past a due time since the last wake, because the extraction failed or did not end, the watch checks that due time again at the next poll. A due time that no extraction learned is due. Thus the watch tries a failed inspection pass again at each poll, for example the pass of a property whose permission was removed and then given again. When you select only the inspection streams, the watch never probes the analytics. An app that calls `run()` and stops has no watcher. Start it with the scheduler of the operating system (cron, launchd), and each run inspects the URLs that are due.

When the probe of a property fails, for example after its permission was revoked, the watch continues. The failure becomes part of the fingerprint of that property. When the probe starts or stops failing, the watch wakes the streams, and the extraction reports the failure or loads the data. The watch continues for the other properties.

When the watch signal aborts, the probe request and each `Retry-After` wait stop immediately. Thus a close never waits for a rate-limit delay. The cancellation shows as the `AbortError` of the signal, not as the wrapped error of the transport.

`currentAsOf` is null for each stream. The source reads the days that Google can still restate and marks each row `settled` or not. Thus the rows agree with Google each time the source reads. See [ADR 0004](./docs/adr/0004-the-rows-are-current-each-time-the-source-reads.md).

## Reader views

The Google app loads into the Postgres warehouse database. The layout of that database, its roles and privileges, the sync history and the catalog are in [elt-postgresql](../../../destinations/postgresql/README.md).

Each copy keeps a reader view of its raw table in `marts`, with the name of the source and the stream. The name of each Search Console reader view is `search_console_<snake_stream>`, for example `marts.search_console_search_analytics_daily`. The view has the columns of `google_search_console.raw_<stream>` and `loaded_at`. The comment of each column is the description of the field. The host makes the copies and the reader views. The source has no Postgres code. See [ADR 0005](./docs/adr/0005-the-host-makes-the-copies-and-the-reader-views.md).

The reader views show the rows as Google reports them, with `ctr` and `position` for each row. Do not average these values over rows. Use the formulas in [Each grain is its own stream](#each-grain-is-its-own-stream). The dates are calendar days in Pacific Time. `settled` is false for a day that Google can still restate.

## Limitations

- Google keeps search analytics for 16 months.
- Google holds back rare queries. Thus the query and page rows do not add up to the daily totals. Use `searchAnalyticsDaily` for totals.
- A request gives a maximum of 25000 rows. The source reads the next pages with `startRow`, so no row is lost. But Google keeps a maximum of 50000 rows each day for each report type of a property, and Google tells that the API "does not guarantee to return all data rows". Google drops more rows with no signal. Google documents this limit. The live property did not show it: its busiest day had 39 query rows.
- Each URL inspection is one request, and Google permits 2000 each day for a property. A large property gets its inspections over many days.
- The source inspects only the URLs that a sitemap lists or that search analytics shows.
- The source does not read a field that is added to the dated analytics streams again for the dates that it loaded. The field stays null on those dates (backlog #2458).
- The watch probe does not see a restatement that changes the breakdowns and keeps the daily totals.

## Live checks

Tests with controlled API responses cover the projection of streams, the key order, pagination, incremental checkpoints, the replacement of restated rows, the sharing of inspections, the watch probes, retry and abort, the loopback consent flow, and the reuse of grants and consent again.

On **2026-09-22**, the pipeline ran two times against a real property (`sc-domain:ezz.sh`) into SQLite, with `google-auth-library` 11.1.0 and Node.js 26.8.1:

- All seven streams of that time loaded: 4 sites, 1 sitemap, 1 sitemap content row, 7736 analytics rows from 2025-07-21 to 2026-09-22, 9 inspected URLs and 12 referrer rows.
- The API reported `firstIncompleteDate: 2026-09-21`, and the checkpoint stopped at `2026-09-20`.
- The second run extracted 135 rows, not 7736. It started at the checkpoint, and it did not read the backfill window again.
- The row count and the count of distinct keys both stayed at 7736. Thus the days that the run read again replaced their rows and did not duplicate them. `loaded_at` on 2026-09-20 to 2026-09-22 moved to the second run, and 2026-09-19 kept the value of the first run. The default `cursor_newer` guard would have skipped that replacement.

A second live run with the four grains loaded 2280 daily rows of six report types, 3525 query rows, 1508 page rows and 261 country rows. All 380 Discover and all 380 Google News daily rows had a null position. The daily totals were the same as a separate request by date only: 58 clicks and 1986 impressions for 2026-09-10 to 2026-09-20.

On **2026-09-24**, the check ran again with the loopback consent flow. The client was a Desktop-type OAuth client in the same Cloud project as the API:

- The first run found no grant and opened Google consent. It stored the grant in files that only the owner can read (`0700` directories, `0600` JSON, hashed names). Then it loaded all ten streams, and the analytics grains started at the earlier checkpoint.
- The second run used the stored grant again with no browser, and it ended in 80 seconds. It read three days again (18 daily rows of six report types) from the `2026-09-21` checkpoint.
- In each analytics table, the row count stayed equal to the count of distinct keys (2286 daily, 3571 query and 1514 page rows). Thus the days that the run read again replaced their rows.

On **2026-09-24**, a check of the daily inspection quota ran on `sc-domain:limerence.sh`. 1868 inspections succeeded after 132 earlier inspections on that day (2000 in all). Then Google answered `429` with the reason `rateLimitExceeded`, the status `RESOURCE_EXHAUSTED`, the message "Quota exceeded for sc-domain:limerence.sh." and no `Retry-After`. The error reference of Google tells `403 quotaExceeded`, but Google did not send it. The pool stopped and kept each earlier inspection. A further call reported the quota as exhausted and inspected nothing.

On **2026-09-24**, a check of partitions ran. One source with `sc-domain:ezz.sh`, `sc-domain:january.sh` and `sc-domain:limerence.sh` loaded each table in one run. Each stream had one checkpoint with one `{ partitions: [...] }` entry for each property.

On **2026-09-25**, a check of target ownership ran against `sc-domain:ezz.sh`. The `_elt_writers` table was dropped. One run made it again as `(target, writer)`, with one row for each table, and each copy id owned its row (for example `sitemaps ← {"copy":"sitemaps"}`). A second copy from a different source into `sitemaps` failed with `TargetOwnedError`, which named both writers. It extracted nothing, and the row count did not change.

On **2026-09-25**, a check of failure isolation and clear ran against `sc-domain:ezz.sh`:

- A run with `sc-domain:ezz.sh` and `sc-domain:example.com` (no permission) ran each stream. `ezz.sh` loaded and kept its checkpoint, for example 24 daily and 78 query rows. Each partitioned stream reported `example.com` with the Google message "User does not have sufficient permission for site 'sc-domain:example.com'". The run failed, and it wrote no `example.com` row or checkpoint entry. The next run with only `ezz.sh` completed.
- `watch()` over the same two properties stayed open. Its first batch loaded `ezz.sh` (18 daily rows) and reported `example.com` with the same permission message.
- A clear of the `sitemaps` copy emptied its table, its owner row and its checkpoint. `marts.search_console_sitemaps`, a view on that table, continued to work. The next run loaded the table again from the start. Postgres refuses to drop the table because of that view. Thus a clear empties SQL tables and does not drop them.

On **2026-10-12**, a check of the copies that the host makes ran against `sc-domain:ezz.sh`. Two runs of `apps/google/dist/main.js` stopped with exit code 0. The first run loaded ten `raw_<stream>` tables and made the ten `marts.search_console_<snake_stream>` views. The second run wrote and deleted nothing. When `agent_reader` read them, each view showed the same number of rows as its raw table: 2400 daily, 3746 query, 1577 page and 267 country rows, 27 inspected URLs and 25 referrer rows.

On 2026-09-24, a live load of `sc-domain:ezz.sh` into the compose warehouse filled each view. On 2026-10-15, `nx run google:test` loaded Search Console beside Google Health. See [Google Health](../health/README.md#live-checks).

Not checked live: `watch()` over a real poll interval, and a property with more than 25000 rows for one request.

## Decisions

- [ADR 0001](./docs/adr/0001-each-property-is-a-partition-of-one-source.md): each property is a partition of one source.
- [ADR 0002](./docs/adr/0002-a-re-read-day-loses-the-rows-that-google-no-longer-returns.md): a re-read day loses the rows that Google no longer returns.
- [ADR 0003](./docs/adr/0003-an-exhausted-inspection-quota-waits-until-pacific-midnight.md): an exhausted inspection quota waits until midnight in Pacific Time.
- [ADR 0004](./docs/adr/0004-the-rows-are-current-each-time-the-source-reads.md): the rows are current each time the source reads.
- [ADR 0005](./docs/adr/0005-the-host-makes-the-copies-and-the-reader-views.md): the host makes the copies and the reader views.

## Development

Run the commands from the workspace root.

```sh
npx nx run source-google-search-console:test        # builds, then runs src/*.test.ts with msw and Docker
npx nx run source-google-search-console:typecheck   # formats, lints, then type checks
npx nx run google:start                              # loads sc-domain:ezz.sh into the local warehouse
```
