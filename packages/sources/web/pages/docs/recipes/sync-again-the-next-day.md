# Recipe: Sync again the next day

**Use case.** You load the posts of a blog today. Tomorrow you sync again. The second pipeline run must not download and extract every post again. It must load the posts that changed, and keep the rows of the others.

**What you need.** A `WebSource` in a pipeline with a checkpoint store. The state of the source keeps the crawl memento, so the next pipeline run knows each URL that the last crawl visited. The default revisit policy is `AdaptiveRevisit`.

## What the second pipeline run does

1. **The input is always due.** The crawl downloads the sitemap or the feed again, and its readers find the pages.
2. **A page that is not due is a deferred page.** The crawl does not request it, and its rows stay. With `AdaptiveRevisit`, a page is due one day after its first visit. The interval then grows while the page does not change, up to 14 days. It moves toward one hour while the page changes.
3. **A sitemap can make a page due at once.** When the sitemap gives a page another `lastmod`, the crawl requests the page in this crawl.
4. **A due page uses the HTTP cache.** When the server gave an ETag or a `Last-Modified` date, the client asks the server whether the page changed. When the answer is 304, or the fingerprint is the same, the extractor does not extract the records again.
5. **A page that changed goes to the extractor.** Its records replace the old records of the page.

## The program

A blog has two posts, and its sitemap gives the date when each post last changed. On day 2, post 1 has a new version and a new `lastmod`.

```ts title="sync-again.ts"
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ListingReader } from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

// A blog whose sitemap gives the date when each post last changed.
const posts = new Map([
  ['/posts/1', { lastmod: '2026-10-27', text: 'The first version of post 1.' }],
  ['/posts/2', { lastmod: '2026-10-27', text: 'Post 2 does not change.' }],
]);
let requested: string[] = [];
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  requested.push(pathname);
  const post = posts.get(pathname);
  if (pathname === '/sitemap.xml') {
    response.setHeader('content-type', 'application/xml');
    response.end(
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
        ...posts,
      ]
        .map(
          ([path, { lastmod }]) =>
            `<url><loc>${origin}${path}</loc><lastmod>${lastmod}</lastmod></url>`,
        )
        .join('')}</urlset>`,
    );
  } else if (post) {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<title>${pathname}</title><article><p>${post.text} The blog keeps it for its readers.</p></article>`,
    );
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

const directory = await mkdtemp(join(tmpdir(), 'web-'));
const articles = join(directory, 'articles.sqlite');
const destination = new SQLiteDestination({ path: articles });
const source = new WebSource({
  stream: new WebStream({
    name: 'articles',
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    extractor: new ArticleExtractor(),
  }),
  inputs: [`${origin}/sitemap.xml`],
  cachePath: join(directory, 'web-http.sqlite'),
});
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'web',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(directory, 'checkpoints.sqlite'),
      }),
      steps: (await source.discover()).streams.map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: 'web:articles',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
});

async function sync(name: string) {
  requested = [];
  const [result] = await pipeline.run();
  const database = new DatabaseSync(articles, { readOnly: true });
  const rows = database
    .prepare('SELECT pageUrl, textContent FROM articles ORDER BY pageUrl')
    .all()
    .map(
      (row) =>
        `${new URL(String(row.pageUrl)).pathname}: ${String(row.textContent).split('.')[0]}`,
    );
  database.close();
  console.log(name, { requested, loaded: result?.count, rows });
}

await sync('day 1');
posts.set('/posts/1', {
  lastmod: '2026-10-28',
  text: 'The second version of post 1.',
});
await sync('day 2');
server.close();
await rm(directory, { recursive: true, force: true });
```

Output:

```
day 1 {
  requested: [ '/robots.txt', '/sitemap.xml', '/posts/1', '/posts/2' ],
  loaded: 2,
  rows: [
    '/posts/1: The first version of post 1',
    '/posts/2: Post 2 does not change'
  ]
}
day 2 {
  requested: [ '/robots.txt', '/sitemap.xml', '/posts/1' ],
  loaded: 1,
  rows: [
    '/posts/1: The second version of post 1',
    '/posts/2: Post 2 does not change'
  ]
}
```

## Why it works

On day 2, the crawl knew both posts from the crawl memento in the state. Post 1 had a new `lastmod`, so it was due at once, and the extractor read its new version. Post 2 was not due, so the crawl did not request it. It was a deferred page, and its row stayed.

## Things to know

- **The source never deletes a row.** A page that a listing no longer names can still exist, so its rows stay. See [ADR 0005](../adr/0005-an-absent-page-is-not-a-deletion.md). Each row has `loaded_at`, the time when elt last wrote it. A page that did not change is not written again, so `loaded_at` does not show when a crawl last saw the page.
- **An interrupted pipeline run continues.** The state keeps the crawl snapshot. The next pipeline run continues the same crawl, and it hands back the page that was in progress again. See [Resume an interrupted crawl](../../../../../sdks/web/crawler/docs/recipes/resume-an-interrupted-crawl.md).
- **A failed page keeps its rows.** The revisit policy makes it due again two hours later.
- **The state is in the checkpoint store.** If you delete the checkpoint store, the next pipeline run requests every page again, and each revisit interval starts again from one day.
- **A full refresh requests every page.** With `syncMode: 'full_refresh'`, the source uses `AlwaysRevisit`.
- **To change when pages are due, give `revisit` to the web stream.** See the policies in the [crawler README](../../../../../sdks/web/crawler/README.md#revisits) and [Check some pages every hour and the rest by change](../../../../../sdks/web/crawler/docs/recipes/check-some-pages-every-hour.md).
- **The source does not sync by itself.** Your host starts each pipeline run. See [Refresh from a Sync button or a watch](./refresh-from-a-sync-button-or-a-watch.md).
