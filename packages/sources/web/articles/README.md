# Web articles

`WebSource` ingests readable articles from chosen websites, sitemaps, and feeds. It composes the generic web crawler and article SDKs with the existing ELT engine.

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { WebSource } from '@workspace/source-web-articles/web-source';

const source = new WebSource({
  inputs: ['https://www.anthropic.com/'],
  include: ['https://www.anthropic.com/news/*'],
  pollIntervalMs: 3_600_000,
});
const destination = new SQLiteDestination({ path: './articles.sqlite' });
const history = new SQLiteSyncHistory();
await history.install([destination]);

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

The example's publisher and path are caller configuration. The source contains no publisher rules. Omit `include` to extract every crawled page, or supply absolute [URLPattern](https://nodejs.org/api/url.html#class-urlpattern) strings. An empty `include` selects no articles. This filters article extraction; the crawler still reads listings and downloads the link pages it admits.

The `articles` stream stores sanitized HTML (`content`), Markdown (`markdown`), readable text (`textContent`), extraction metadata, the discovered and final response URLs, the declared canonical URL, and listing provenance. The source prioritizes native Markdown through HTTP content negotiation and advertised alternatives, then falls back to HTML. Native `markdown` retains the publisher’s body after removing front matter. A readable HTML counterpart supplies normalized `content` and `textContent` and fills missing metadata; advertised alternatives reuse HTML already downloaded, while negotiated Markdown requires one additional HTML request. If that optional counterpart is unavailable, HTML and text are sanitized derivatives of the native body. For HTML-only responses, Markdown is converted from the sanitized selected article. Raw native Markdown can retain publisher boilerplate or raw HTML even when the normalized fields are clean, so later renderers must sanitize it. Its key is `(inputUrl, pageUrl)`; canonical declarations do not merge records. The same page selected through two inputs has one row per input.

The crawler reads sitemaps, feeds and HTML archives completely, wherever they are declared, and follows same-origin links in HTML and Markdown pages within three hops and 100 admitted linked pages per input crawl. It downloads each found URL once and hands back only pages that match the source's `include` patterns; other pages are downloaded only to follow their links. Pages handed back ask for native Markdown first. An interrupted crawl resumes from its snapshot; failed pages return in the next crawl. See the [crawler rules](../../../sdks/web/crawler/README.md).

The HTTP module owns a persistent SQLite cache at `.cache/web-http.sqlite` under the working directory and creates its directory automatically. Each input scan opens and closes its own cache connection; scans in the same working directory reuse cached responses across runs and process restarts. Got and Keyv retain response bodies and HTTP cache policy for crawl and article requests. Every poll revalidates with `Cache-Control: no-cache`, including responses with a future freshness lifetime. Where the server supplies ETag or Last-Modified, an unchanged response can return 304 without a body; Got restores the cached response before the SDK sees it. The official `@keyv/sqlite` adapter uses Node’s built-in SQLite driver to persist cached responses, including policy updates after revalidation. Responses without validators are downloaded again, and `no-store` responses are not persisted. The cache is separate from checkpoints and can be deleted to force cold HTTP requests.

Incremental reruns revalidate the selected pages, then use `diffGroupedSnapshot` to skip extraction when response bytes, final URL, Content-Type and listing metadata match the last committed group. New or changed inputs are extracted and only new or changed records are emitted. Representations whose additional responses cannot be fingerprinted remain eligible for extraction. A failed article does not stop other articles: successful pages are committed, and `Pipeline.run()` reports the failures together through `PipelineError` after the scan. Failed URLs and their listing metadata remain in the checkpoint for the next run, even if they disappear from the feed. Got's normal HTTP retries happen within a run; a URL that still fails is attempted again on a later run.

An interrupted crawl resumes from its saved snapshot, and the page handed out last is handed out again. A completed crawl saves no snapshot, so the next refresh starts a new crawl and can find new URLs and edits anywhere. Failed pages return in that next crawl, even after they leave every listing. Feed rollover and empty extraction do not delete previously loaded articles. Full refresh attempts the selected articles but replaces the collection only after a successful pass.

`Pipeline.watch({ signal })` polls at the required `pollIntervalMs`, using the same extraction and checkpoint path. One-shot `run()` does not start a watcher. The host chooses SQLite, Postgres, or another destination.

Within each input, the crawler downloads one page at a time. A shared `p-queue` gate permits at most two request starts per rolling second, including listings, redirects and retries. Got supplies its standard selective retry/backoff policy and a 30-second timeout per HTTP attempt, starting after the rate-limit wait. The caller’s abort signal bounds the whole run; cancellation and stopping consumption cancel queued and in-flight downloads. A failed listing or page is recorded and the crawl continues; validation and persistence failures remain failures of the scan. These limits apply per input scan, not globally across separate pipelines. There is no crawl-delay policy or robots exclusion enforcement. The crawler's robots support locates sitemaps. HTML extraction retains the SDK's limitations, including no JavaScript rendering. Checkpoint work grows with the accumulated listing; large-sitemap throughput is not established by the live sample checks.

See [behavior, package decisions, and verification](docs/reference.md).
