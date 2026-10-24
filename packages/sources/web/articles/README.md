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

The `articles` stream stores sanitized HTML, readable text, extraction metadata, the discovered and final response URLs, the declared canonical URL, and listing provenance. Its key is `(inputUrl, pageUrl)`; canonical declarations do not merge records. The same page selected through two inputs has one row per input.

Incremental reruns refetch the selected pages and emit only new or changed records. Each processed page checkpoints its progress; a new source and pipeline can resume after a failed or cancelled run. Feed rollover and empty extraction do not delete previously loaded articles. Full refresh replaces the collection only after a successful pass.

`Pipeline.watch({ signal })` polls at the required `pollIntervalMs`, using the same extraction and checkpoint path. One-shot `run()` does not start a watcher. The host chooses SQLite, Postgres, or another destination.

The source fetches articles sequentially within each input. It has no automatic HTTP retries, conditional requests, crawl-delay policy, or robots exclusion enforcement. Discovery's robots support locates sitemaps. HTML extraction retains the SDK's limitations, including no JavaScript rendering. Checkpoint work grows with the accumulated listing; large-sitemap throughput is not established by the live sample checks.

See [behavior, package decisions, and verification](docs/reference.md).
