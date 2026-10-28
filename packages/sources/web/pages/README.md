# Web pages

`WebSource` crawls chosen websites, sitemaps and feeds and extracts records from the pages it finds into one stream. A `WebStream` configures that stream: its name and primary key, the crawler readers that navigate, the URL patterns of the pages to extract, and the `RecordExtractor` that turns each page into records. This is the shape of Airbyte's `DeclarativeStream`: a configured instance with a paginator for navigation and a record extractor for behavior. `ArticleExtractor` extracts one readable article per page.

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
  cachePath: './web-http.sqlite',
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

The example's publisher and path are caller configuration. The source contains no publisher rules. Omit `include` to extract every crawled page. An empty `include` selects no pages. This filters extraction; the crawler still reads listings and downloads the link pages it admits.

Every record of the stream carries the page's provenance: `inputUrl`, the chosen input and the partition key; `pageUrl`, the page URL as found; `listingUrl`, the listing that first supplied it; and `lastModified`, the raw sitemap hint. The stream's key is `inputUrl` followed by the `WebStream` primary key, so the same page selected through two inputs has one row per input.

A `RecordExtractor` declares the JSON Schema `properties` of its records, without the provenance columns, and `open(http)` returns one run per input crawl: the run's `accept` is the Accept header for the pages that the crawl hands back, or null for the client's default, and `read(response, signal)` returns the page's `fingerprint` and a `records()` function. The fingerprint is known before records are extracted, so an unchanged page skips extraction; it is null when other responses can change the output. An error that the extractor throws for a page is a failure of that page.

`ArticleExtractor` stores sanitized HTML (`content`), Markdown (`markdown`), readable text (`textContent`), extraction metadata, the discovered and final response URLs, the declared canonical URL, and listing provenance. The source prioritizes native Markdown through HTTP content negotiation and advertised alternatives, then falls back to HTML. Native `markdown` retains the publisher’s body after removing front matter. A readable HTML counterpart supplies normalized `content` and `textContent` and fills missing metadata; advertised alternatives reuse HTML already downloaded, while negotiated Markdown requires one additional HTML request. If that optional counterpart is unavailable, HTML and text are sanitized derivatives of the native body. For HTML-only responses, Markdown is converted from the sanitized selected article. Raw native Markdown can retain publisher boilerplate or raw HTML even when the normalized fields are clean, so later renderers must sanitize it. Its `articleUrl` is the declared canonical URL, or the final URL when the page declares none. With the primary key `articleUrl`, two URLs of one article, such as with and without a trailing slash, give one record ([ADR 0007](./docs/adr/0007-an-article-is-keyed-by-its-canonical-url.md)).

The stream's readers decide what the crawler finds. With the readers in the example, the crawler reads sitemaps, feeds and HTML archives completely, wherever they are declared, and follows same-origin links in HTML and Markdown pages within three hops and 100 admitted linked pages per input crawl. It downloads each found URL once and hands back only pages that match the stream's `include` patterns; other pages are downloaded only to follow their links. Pages handed back ask for the extractor's `accept`; `ArticleExtractor` asks for native Markdown first. An interrupted crawl resumes from its memento. A known page is requested again when the stream's revisit policy says it is due; see [ADR 0008](./docs/adr/0008-a-known-page-is-requested-again-when-its-revisit-policy-says.md) and the [crawler rules](../../../sdks/web/crawler/README.md).

The HTTP module keeps a persistent SQLite cache in the file that the host gives as `cachePath`, and it creates the directory of that file automatically with mode 0700. The host selects the location, because only the host knows where its data is kept. Each crawl opens and closes its own cache connection; crawls with the same `cachePath` reuse cached responses across runs and process restarts. Got and Keyv retain response bodies and HTTP cache policy for crawl and article requests. Every poll revalidates with `Cache-Control: no-cache`, including responses with a future freshness lifetime. Where the server supplies ETag or Last-Modified, an unchanged response can return 304 without a body; Got restores the cached response before the SDK sees it. The official `@keyv/sqlite` adapter uses Node’s built-in SQLite driver to persist cached responses, including policy updates after revalidation. Responses without validators are downloaded again, and `no-store` responses are not persisted. The cache is separate from checkpoints and can be deleted to force cold HTTP requests.

Incremental reruns revalidate the selected pages that are due, then use `diffGroupedSnapshot` to skip extraction when the extractor's fingerprint, the `listingUrl` and the `lastModified` match the last committed group. `ArticleExtractor` fingerprints every response that the extraction reads: the page, and its HTML counterpart or its advertised alternatives, each by its final URL, Content-Type and bytes. It requests those responses before the fingerprint, so an unchanged native-Markdown page is not extracted again. New or changed inputs are extracted and only new or changed records are emitted. A failed page does not stop other pages: successful pages are committed, and `Pipeline.run()` reports the failures together through `PipelineError` after the crawl. The crawler keeps failed pages, with their `listingUrl` and `lastModified`, in its memento, even if they disappear from the feed. Got's normal HTTP retries happen within a run; a URL that still fails is due again two hours later. A page that the extractor cannot read is failed back to the crawler, so it is due again too.

An interrupted crawl resumes from its saved snapshot, and the page handed out last is handed out again. Progress through listings and archives is saved at most once a second, so an interruption there repeats at most about a second of work. A completed crawl keeps only its known URLs, so the next refresh starts a new crawl and can find new URLs anywhere. `WebStream`'s `revisit` sets when a known page is due; the default, the crawler's `AdaptiveRevisit`, requests an unchanged page again after one day and then after longer intervals, up to 14 days, and a page whose sitemap `lastModified` changed at once. A page that is not due keeps its row: the crawl hands it out as deferred, and the scan keeps its group unread, so once due it is extracted again only when it changed. Failed pages are due again even after they leave every listing. A full refresh uses `AlwaysRevisit`, so it requests every known page. Feed rollover and empty extraction do not delete previously loaded records. Full refresh attempts the selected pages but replaces the collection only after a successful pass.

`Pipeline.watch({ signal })` checks again when the earliest known URL of an input is due, as its last crawl left it, using the same extraction and checkpoint path. A failed crawl leaves its input to the watch's own retries. `AlwaysRevisit` gives no interval, so a watched full refresh crawls again as soon as its crawl ends; give a watched stream a policy with an interval, such as `FixedRevisit`. One-shot `run()` does not start a watcher. The host chooses SQLite, Postgres, or another destination.

Within each input, the crawler downloads one page at a time. A shared `p-queue` gate permits at most two request starts per rolling second, including listings, redirects and retries. Got supplies its standard selective retry/backoff policy and a 30-second timeout per HTTP attempt, starting after the rate-limit wait. The caller’s abort signal bounds the whole run; cancellation and stopping consumption cancel queued and in-flight downloads. A failed listing or page is recorded and the crawl continues; validation and persistence failures stop the run. An origin that answers 429, or three 403s in a row, after Got's retries is blocked until its `Retry-After`, or for one hour without one: the crawl requests nothing more there, the run reports the block once through `PipelineError`, and the pages already loaded stay. The scan does not end, so the next run after the block continues the crawl and loads only the pages it did not reach. A watch checks again when the block ends. These limits apply per crawl, not globally across separate pipelines. The crawler follows each origin's `robots.txt` (RFC 9309) for the client's user agent: it does not request a disallowed URL, it waits out a `Crawl-delay` of up to 60 seconds between two requests to an origin, and an origin whose `robots.txt` answers 429 or 5xx, or cannot be reached, is blocked as for a 429. HTML extraction retains the SDK's limitations, including no JavaScript rendering. Each save of the state grows with the listing; backlog item 2920 records this.

## Documentation

- [ADR 0001: A page is extracted again only when its fingerprint changes](./docs/adr/0001-a-page-is-extracted-again-only-when-its-fingerprint-changes.md)
- [ADR 0002: The crawler owns the frontier](./docs/adr/0002-the-crawler-owns-the-frontier.md)
- [ADR 0003: The state has diff, crawl and retry](./docs/adr/0003-the-state-has-diff-crawl-and-retry.md)
- [ADR 0004: A failed page is tried again on the next run](./docs/adr/0004-a-failed-page-is-tried-again-on-the-next-run.md)
- [ADR 0005: An absent page is not a deletion](./docs/adr/0005-an-absent-page-is-not-a-deletion.md)
- [ADR 0006: The HTTP cache is Keyv on Node's SQLite driver](./docs/adr/0006-the-http-cache-is-keyv-on-node-sqlite.md)
- [ADR 0007: An article is keyed by its canonical URL](./docs/adr/0007-an-article-is-keyed-by-its-canonical-url.md)
- [ADR 0008: A known page is requested again when its revisit policy says](./docs/adr/0008-a-known-page-is-requested-again-when-its-revisit-policy-says.md)
