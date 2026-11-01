# Web pages

`WebSource` crawls chosen websites, sitemaps and feeds and extracts records from the pages it finds into its streams. A `WebStream` configures one stream: its name and primary key, the crawler readers that navigate, the URL patterns of the pages to extract, and the `RecordExtractor` that turns each page into records. This is the shape of Airbyte's `DeclarativeStream`: a configured instance with a paginator for navigation and a record extractor for behavior. The host gives each web stream its own inputs, and one source can give many web streams, as an Airbyte declarative source has many streams ([ADR 0010](./docs/adr/0010-a-web-source-gives-many-web-streams.md)). `ArticleExtractor` extracts one readable article per page.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
} from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

const source = new WebSource({
  streams: [
    {
      stream: new WebStream({
        name: 'articles',
        primaryKey: ['articleUrl'],
        readers: [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
          new LinkReader({ maxDepth: 3, maxPages: 100 }),
        ],
        include: [new URLPattern('https://www.anthropic.com/news/*')],
        extractor: new ArticleExtractor(),
      }),
      inputs: ['https://www.anthropic.com/'],
    },
  ],
  cachePath: './web-http.sqlite',
  userAgent: 'ExampleReader/1.0 (+https://example.com/contact)',
});
const destination = new SQLiteDestination({ path: './articles.sqlite' });
const history = new SQLiteSyncHistory();

const pipeline = new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'web',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './articles-state.sqlite',
      }),
      steps: [
        new Copy(
          (await source.discover()).get('articles'),
          destination.table('articles'),
          {
            id: 'web:articles',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
      ],
    }),
  ],
});

await pipeline.run({ signal: AbortSignal.timeout(120_000) });
```

Each web stream is its own stream of the catalog, with its own inputs as partitions, its own coverage and its own target. A marketplace, for example, gives a stream of its categories, read from its home page, and a stream of the listings of the categories that a user chose. Each input of a stream is crawled separately, and all the crawls of a read share the HTTP cache, the user agent and the record of each origin ([ADR 0014](./docs/adr/0014-the-crawls-of-a-read-share-the-record-of-each-origin.md)). A watch reads again only the streams that have a page due. A web stream without an input, or with an input that is not an http or https URL, makes the constructor throw `InputError`. The user chooses the inputs, so `failureType` gives `config` for it.

The example's publisher and path are caller configuration. The source contains no publisher rules. Omit `include` to extract every crawled page; a given `include` has at least one pattern. This filters extraction; the crawler still reads listings and downloads the link pages it admits. Give `expand` patterns when a list links home pages and the pages you want are on their websites or one link away: the crawler expands each such page one step and keeps only what matches `expand` (see [Search inside the sites a list links](../../../sdks/web/crawler/docs/recipes/search-inside-the-sites-a-list-links.md)). Omit `expand` to expand only the inputs' websites.

Every record of the stream carries the page's provenance: `inputUrl`, the chosen input and the partition key; `pageUrl`, the page URL as found; `listingUrl`, the listing that first supplied it; `lastModified`, the raw modification hint of that listing, such as a sitemap `lastmod` or an Atom `updated`; and `published`, the time that the listing says the page was published, such as an RSS `pubDate` or an Atom `published`, as a `date-time` in UTC, or null when the listing gives no date that `Date` can read ([ADR 0009](./docs/adr/0009-a-feed-gives-the-publication-time-as-provenance.md)). `published` is not the date of the page itself: `ArticleExtractor` keeps the date that the page declares, raw, in `publishedTime`, and the date that Defuddle finds in the page, the declared date or a date in the text near the title, in `inferredPublished`, as a `date-time` in UTC or null ([sdk-web-article ADR 0011](../../../sdks/web/article/docs/adr/0011-the-inferred-publication-time-is-defuddles-date-in-its-own-field.md)). A host that sorts by date can take `publishedTime`, then `published`, then `inferredPublished`. The stream's key is `inputUrl` followed by the `WebStream` primary key, so the same page selected through two inputs has one row per input.

Each web stream also gives a routes stream, named `<name>_routes`, such as `articles_routes` ([ADR 0011](./docs/adr/0011-a-web-stream-gives-its-routes-as-a-second-stream.md)). It has one row for each route that a crawl found: a listing named a URL. Its columns are `inputUrl`, `listingUrl`, `url`, `how` and `text`, and its primary key is `inputUrl`, `listingUrl` and `url`. `how` tells how the listing named the URL, such as `list-item`, `link`, `robots-sitemap`, `sitemap-entry`, `feed-item` or `redirect`. `text` is the anchor text of the link or the list item, or the title of the feed item. A record's `listingUrl` names only the first route to its page; follow the routes stream for every route. A listing that a crawl reads again completely replaces its rows: a URL that the listing no longer names loses its row. A read where a reader threw or skipped the response, such as a linked page that `LinkReader` does not admit, only adds rows. A listing that a run does not read keeps its rows. The routes stream reads only incrementally and loads into a deduplicating target (`append_dedup`), because it gives deletions. Select it in the same connection as its web stream: it reads beside the web stream, from the same crawl, and loads the routes of each checkpoint of the web stream while the crawl goes on ([ADR 0012](./docs/adr/0012-a-routes-stream-reads-beside-its-web-stream.md)). A read that does not select the web stream gives no routes. Add a copy of it to load it:

```ts
new Copy(
  (await source.discover()).get('articles_routes'),
  destination.table('articles_routes'),
  {
    id: 'web:articles_routes',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  },
);
```

Each web stream also gives a crawls stream, named `<name>_crawls`, such as `articles_crawls` ([ADR 0013](./docs/adr/0013-a-crawls-stream-tells-when-the-crawl-of-an-input-is-complete.md)). It has one row for each input, keyed by `inputUrl`. `complete` is true when the last crawl of the input reached its end, and false while an expansion budget or a blocked host leaves pages for a later run. A failed page does not keep it false: it is due again later, and a reader that needs it waits for that page. `since` is when the crawl that first gave this value ended. A reader that concludes from an absence, such as a page that no route reaches, waits until the inputs that it reads are complete. The crawls stream reads only incrementally, after its web stream, and gives a row only when `complete` changes. Load it with a copy as the routes stream above, with `append_dedup`, and read it, for example, as `SELECT inputUrl, since FROM articles_crawls WHERE complete`.

A failure that the crawl reports is a `CrawlError` from `@workspace/sdk-web-crawler`. Its `url` is the URL that failed, and its `page` is true for a page that the crawl would have handed back and false for a starting URL or a document, such as a broken sitemap. A failure of the extractor is the extractor's own error, such as an `ArticleError`, and is always a page. The run's `PipelineError` holds them in an `AggregateError` for each input.

A `RecordExtractor` declares the JSON Schema `properties` of its records, without the provenance columns, and `open(http)` returns one run per input crawl: the run's `negotiation` gives the Accept header for the pages that the crawl hands back and the `afterResponse` hook that marks a redirect that `read()` needs to know of, or is null for the client's default; `open` gets the client of the origins' records, so each extra request of the extractor passes the `robots.txt`, the delay and the block of its origin, and `read(response, signal)` returns the page's `fingerprint` and a `records()` function. The fingerprint is known before records are extracted, so an unchanged page skips extraction; it is null when other responses can change the output. An error that the extractor throws for a page is a failure of that page.

`ArticleExtractor` stores sanitized HTML (`content`), Markdown (`markdown`), readable text (`textContent`), extraction metadata, the discovered and final response URLs, the declared canonical URL, and listing provenance. The source prioritizes native Markdown through HTTP content negotiation and advertised alternatives, then falls back to HTML. Native `markdown` retains the publisher’s body after removing front matter. A readable HTML counterpart supplies normalized `content` and `textContent` and fills missing metadata; advertised alternatives reuse HTML already downloaded, while negotiated Markdown requires one additional HTML request. If that optional counterpart is unavailable, HTML and text are sanitized derivatives of the native body. For HTML-only responses, Markdown is converted from the sanitized selected article. Raw native Markdown can retain publisher boilerplate or raw HTML even when the normalized fields are clean, so later renderers must sanitize it. Its `articleUrl` is the declared canonical URL, or the final URL when the page declares none. With the primary key `articleUrl`, two URLs of one article, such as with and without a trailing slash, give one record ([ADR 0007](./docs/adr/0007-an-article-is-keyed-by-its-canonical-url.md)).

The stream's readers decide what the crawler finds. With the readers in the example, the crawler reads sitemaps, feeds and HTML archives completely, wherever they are declared, and follows same-origin links in HTML and Markdown pages within three hops and 100 admitted linked pages per input crawl. It downloads each found URL once and hands back only pages that match the stream's `include` patterns; other pages are downloaded only to follow their links. Pages handed back ask with the extractor's `negotiation`; `ArticleExtractor` asks for native Markdown first, and asks a page again as a browser asks when a redirect that `Vary` says Accept chose gives no Markdown. An interrupted crawl resumes from its memento. A known page is requested again when the stream's revisit policy says it is due; see [ADR 0008](./docs/adr/0008-a-known-page-is-requested-again-when-its-revisit-policy-says.md) and the [crawler rules](../../../sdks/web/crawler/README.md).

The HTTP module keeps a persistent SQLite cache in the file that the host gives as `cachePath`, and it creates the directory of that file automatically with mode 0700. The host selects the location, because only the host knows where its data is kept. Each crawl opens and closes its own cache connection; crawls with the same `cachePath` reuse cached responses across runs and process restarts. Got and Keyv retain response bodies and HTTP cache policy for crawl and article requests. Every poll revalidates with `Cache-Control: no-cache`, including responses with a future freshness lifetime. Where the server supplies ETag or Last-Modified, an unchanged response can return 304 without a body; Got restores the cached response before the SDK sees it. The official `@keyv/sqlite` adapter uses Node’s built-in SQLite driver to persist cached responses, including policy updates after revalidation. Responses without validators are downloaded again, and `no-store` responses are not persisted. The cache is separate from checkpoints and can be deleted to force cold HTTP requests.

Incremental reruns revalidate the selected pages that are due, then use `diffGroupedSnapshot` to skip extraction when the extractor's fingerprint, the `listingUrl`, the `lastModified` and the `published` match the last committed group. `ArticleExtractor` fingerprints every response that the extraction reads: the page, and its HTML counterpart or its advertised alternatives, each by its final URL, Content-Type and bytes. It requests those responses before the fingerprint, so an unchanged native-Markdown page is not extracted again. New or changed inputs are extracted and only new or changed records are emitted. A failed page does not stop other pages: successful pages are committed, and `Pipeline.run()` reports the failures together through `PipelineError` after the crawl. The crawler keeps failed pages, with their `listingUrl` and `lastModified`, in its memento, even if they disappear from the feed. Got's normal HTTP retries happen within a run; a URL that still fails is due again two hours later. A page that the extractor cannot read is failed back to the crawler, so it is due again too.

An interrupted crawl resumes from its saved snapshot, and the page handed out last is handed out again. The run also reads again each input that its revisit policy makes due, so its new pages enter the crawl. Progress through listings and archives is saved at most once a second, so an interruption there repeats at most about a second of work. A completed crawl keeps only its known URLs, so the next refresh starts a new crawl and can find new URLs anywhere. `WebStream`'s `revisit` sets when a known page is due; the default, the crawler's `AdaptiveRevisit`, requests an unchanged page again after one day and then after longer intervals, up to 14 days, and a page whose sitemap `lastModified` changed at once. A page that is not due keeps its row: the crawl hands it out as deferred, and the scan keeps its group unread, so once due it is extracted again only when it changed. Failed pages are due again even after they leave every listing. A full refresh uses `AlwaysRevisit`, so it requests every known page. Feed rollover and empty extraction do not delete previously loaded records. Full refresh attempts the selected pages but replaces the collection only after a successful pass. It keeps nothing of a failed pass: one page that fails after Got's retries discards the pass, and the next run starts the crawl again from its starting URLs, as Airbyte's Full Refresh | Overwrite does from one sync to the next. For a crawl that must continue after a failure or an interruption, such as a large site on a laptop that sleeps, use an incremental copy: it commits each page, the next run continues an interrupted crawl, and a failed page is requested again once it is due.

`Pipeline.watch({ signal })` checks again when the earliest known URL of an input is due, as its last crawl left it, using the same extraction and checkpoint path. A crawl that fails for a reason that is not a page's, such as a record that the schema rejects or a full disk, is retried by the watch's own back-off first, and its input is due again when its starting URLs are due as failed ones, two hours later by default, so a watch never stops reading an input. `AlwaysRevisit` gives no interval, so a watched full refresh crawls again as soon as its crawl ends; give a watched stream a policy with an interval, such as `FixedRevisit`. One-shot `run()` does not start a watcher. The host chooses SQLite, Postgres, or another destination.

Within each input, the crawler downloads one page at a time. Every crawl of a read asks one record of each origin, which the source opens with the read ([ADR 0014](./docs/adr/0014-the-crawls-of-a-read-share-the-record-of-each-origin.md)): two requests to one origin start at least one second apart, or its `Crawl-delay` apart, listings, redirect targets and the extractor's own requests included, and two web streams can crawl at once, because the record spaces the requests of both. Got retries network errors and a 408, with a 30-second timeout per HTTP attempt: Heritrix allows 20 seconds of socket silence and Nutch 10, and one attempt includes its whole body, such as a large sitemap. It also retries `EADDRNOTAVAIL`, which a socket gets when its local address goes away, as when the Mac sleeps. Got retries no refusal, a 429 or a 5xx: the record of the origin handles it, and the revisit policy makes the URL due again. The caller’s abort signal bounds the whole run; cancellation and stopping consumption cancel queued and in-flight downloads. A failed listing or page is recorded and the crawl continues; validation and persistence failures stop the run. An origin that answers 429, a 503 with `Retry-After`, or three 403s in a row is blocked until its `Retry-After`, at most one day later, or for one hour without one: no crawl of the read requests anything more there, the crawl that met it reports the block once through `PipelineError`, and the pages already loaded stay. A second input on that origin holds its URLs and fails nothing. The scan does not end, so the next run after the block continues the crawl and loads only the pages it did not reach. A watch checks again when the block ends. A crawl that the crawler's expansion budget leaves unfinished, such as one that a site with hundreds of sitemaps holds up, ends its run the same way, and the next run continues it at once (see the crawler's ADR 0005). An origin that answers 429 or 5xx also gets a slowdown: the crawler waits longer between two requests to it, from one second up to one minute more than its delay. The source keeps the `robots.txt` rules of each origin with the time it read them, its block and its slowdown in the file of the HTTP cache, in the table `origins`, after each commit, so a block and a slowdown outlive the process, and a read asks `robots.txt` again only after 24 hours (RFC 9309 §2.4). These records belong to one read; separate pipelines on separate cache files keep their own. The optional `userAgent` sets the `User-Agent` header on every request. If the host omits it, requests send no `User-Agent` header, including no Got default. The host selects a name such as `WhatIsGoingOn/0.1 (+https://github.com/ezzabuzaid/what-is-going-on)` when it wants to identify its crawler. The crawler follows each origin's `robots.txt` (RFC 9309) for the product token of that user agent, `WhatIsGoingOn`, or for `*` when no group names the token or no header is sent: it does not request an origin whose group has `Content-Signal: search=no`, it does not request a disallowed URL, it waits out a `Crawl-delay` of up to 60 seconds between two requests to an origin, it asks the `robots.txt` of the origin that a redirect leads to before it requests the target, and an origin whose `robots.txt` answers 429 or 5xx, or cannot be reached, is blocked as for a 429. HTML extraction retains the SDK's limitations, including no JavaScript rendering. Each save of the state grows with the listing; backlog item 2920 records this.

## Documentation

**Recipes**: one use case each, with a full program that you can run.

1. [Sync again the next day](./docs/recipes/sync-again-the-next-day.md)
2. [Refresh from a Sync button or a watch](./docs/recipes/refresh-from-a-sync-button-or-a-watch.md)
3. [Resume an interrupted crawl](../../../sdks/web/crawler/docs/recipes/resume-an-interrupted-crawl.md), with `@workspace/sdk-web-crawler`
4. [Check some pages every hour and the rest by change](../../../sdks/web/crawler/docs/recipes/check-some-pages-every-hour.md), with `@workspace/sdk-web-crawler`
5. [Write your own revisit policy](../../../sdks/web/crawler/docs/recipes/write-your-own-revisit-policy.md), with `@workspace/sdk-web-crawler`
6. [Crawl a website that rate-limits you](../../../sdks/web/crawler/docs/recipes/crawl-a-website-that-rate-limits-you.md), with `@workspace/sdk-web-crawler`

**Decisions**: the architecture decision records tell why the design is as it is.

- [ADR 0001: A page is extracted again only when its fingerprint changes](./docs/adr/0001-a-page-is-extracted-again-only-when-its-fingerprint-changes.md)
- [ADR 0002: The crawler owns the frontier](./docs/adr/0002-the-crawler-owns-the-frontier.md)
- [ADR 0003: The state has diff, crawl and retry](./docs/adr/0003-the-state-has-diff-crawl-and-retry.md)
- [ADR 0004: A failed page is tried again on the next run](./docs/adr/0004-a-failed-page-is-tried-again-on-the-next-run.md)
- [ADR 0005: An absent page is not a deletion](./docs/adr/0005-an-absent-page-is-not-a-deletion.md)
- [ADR 0006: The HTTP cache is Keyv on Node's SQLite driver](./docs/adr/0006-the-http-cache-is-keyv-on-node-sqlite.md)
- [ADR 0007: An article is keyed by its canonical URL](./docs/adr/0007-an-article-is-keyed-by-its-canonical-url.md)
- [ADR 0008: A known page is requested again when its revisit policy says](./docs/adr/0008-a-known-page-is-requested-again-when-its-revisit-policy-says.md)
- [ADR 0014: The crawls of a read share the record of each origin](./docs/adr/0014-the-crawls-of-a-read-share-the-record-of-each-origin.md)
