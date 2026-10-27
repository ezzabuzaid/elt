# @workspace/source-google-search-console

An ELT source for Google Search Console properties. It reads each property through the `searchconsole:v1` API: the properties, the sitemaps, the search analytics and the URL inspections.

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
    clientId,
    clientSecret,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
    directory: join(homedir(), '.config', 'elt'),
  }),
  siteUrls: ['sc-domain:example.com'],
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
          new Copy(stream, destination.table(stream.name), {
            id: `search-console:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

One source reads all the properties in `siteUrls`.

| Stream                     | One record per                                         |
| -------------------------- | ------------------------------------------------------ |
| `sites`                    | property that the grant can read                       |
| `sitemaps`                 | sitemap that the property lists                        |
| `sitemapContents`          | content type in a sitemap                              |
| `searchAnalyticsDaily`     | day and report type                                    |
| `searchAnalyticsQueries`   | day and query, web results only                        |
| `searchAnalyticsPages`     | day and page, web results only                         |
| `searchAnalyticsCountries` | country and device, over the last `breakdownMonths`    |
| `urlInspection`            | URL that the source inspected                          |
| `urlInspectionSitemaps`    | sitemap in the index status of an inspected URL        |
| `urlInspectionReferrers`   | referring page in the index status of an inspected URL |

Every stream other than `sites` is partitioned by `siteUrl`.

## Access

`googleSession` signs in with a Desktop-type OAuth client and the `webmasters.readonly` scope. The client's Google Cloud project must have `searchconsole.googleapis.com` enabled. A `401` or a `403` fails the copy as a `config` failure. A quota limit that stays after the retries fails with `SearchConsoleQuotaError`.

## Limitations

- Google keeps search analytics for 16 months.
- Google holds back rare queries. Thus the query and page rows do not add up to the daily totals. Use `searchAnalyticsDaily` for totals.
- Google keeps at most 50,000 rows each day for each report type of a property. Google drops more rows and gives no signal.
- Each URL inspection is one request, and Google permits 2,000 each day for a property. A large property gets its inspections over many days.
- The source inspects only URLs that a sitemap lists or that search analytics shows.

See [docs/reference.md](../../../../docs/reference.md#google-search-console).
