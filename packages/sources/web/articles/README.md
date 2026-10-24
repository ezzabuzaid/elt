# Web articles

`WebSource` ingests readable articles from chosen websites, sitemaps, and feeds. It composes the generic web discovery and article SDKs with the existing ELT engine.

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

The example's publisher and path are caller configuration. The source contains no publisher rules. Omit `include` to fetch every discovered candidate, or supply absolute [URLPattern](https://nodejs.org/api/url.html#class-urlpattern) strings. An empty `include` selects no pages. This filters article requests, not the listings discovery must read.

The `articles` stream stores sanitized HTML (`content`), Markdown (`markdown`), readable text (`textContent`), extraction metadata, the discovered and final response URLs, the declared canonical URL, and listing provenance. The source prioritizes native Markdown through HTTP content negotiation and advertised alternatives, then falls back to HTML. Native `markdown` retains the publisher’s body after removing front matter. A readable HTML counterpart supplies normalized `content` and `textContent` and fills missing metadata; advertised alternatives reuse HTML already downloaded, while negotiated Markdown requires one additional HTML request. If that optional counterpart is unavailable, HTML and text are sanitized derivatives of the native body. For HTML-only responses, Markdown is converted from the sanitized selected article. Raw native Markdown can retain publisher boilerplate or raw HTML even when the normalized fields are clean, so later renderers must sanitize it. Its key is `(inputUrl, pageUrl)`; canonical declarations do not merge records. The same page selected through two inputs has one row per input.

Discovery follows advertised HTML archives, calendar indexes and pagination as well as sitemaps and feeds. It collects candidate links without downloading their article bodies. HTML archive links stay within each resolved listing's origin; the source's `include` patterns decide which candidates to fetch. Hidden or unadvertised archives are not guaranteed to be found. See the [discovery rules](../../../sdks/web/discovery/README.md).

Incremental reruns refetch the selected pages and emit only new or changed records. A failed article does not stop other articles: successful pages are committed, and `Pipeline.run()` reports the failures together through `PipelineError` after the scan. Failed URLs and their listing metadata remain in the checkpoint for the next run, even if they disappear from the feed. Got's normal HTTP retries happen within a run; a URL that still fails is attempted again on a later run.

An interrupted scan resumes after its saved cursor and also retries earlier failed URLs. A completed scan clears that cursor, including when some articles failed, so the next refresh can find new URLs and edits anywhere in the listing. Feed rollover and empty extraction do not delete previously loaded articles. Full refresh attempts the selected articles but replaces the collection only after a successful pass.

`Pipeline.watch({ signal })` polls at the required `pollIntervalMs`, using the same extraction and checkpoint path. One-shot `run()` does not start a watcher. The host chooses SQLite, Postgres, or another destination.

Within each input, `pMapIterable` processes up to four articles concurrently and bounds prefetched results. Results and checkpoints remain in URL order. A shared `p-queue` gate permits at most two request starts per rolling second, including discovery, redirects and retries. Got supplies its standard selective retry/backoff policy and a 30-second timeout per HTTP attempt, starting after the rate-limit wait. The caller’s abort signal bounds the whole run; cancellation and stopping consumption cancel queued and in-flight downloads. Listing, validation and persistence failures remain failures of the scan, outside article retry handling. These limits apply per input scan, not globally across separate pipelines. There are no conditional requests, crawl-delay policy, or robots exclusion enforcement. Discovery's robots support locates sitemaps. HTML extraction retains the SDK's limitations, including no JavaScript rendering. Checkpoint work grows with the accumulated listing; large-sitemap throughput is not established by the live sample checks.

See [behavior, package decisions, and verification](docs/reference.md).
