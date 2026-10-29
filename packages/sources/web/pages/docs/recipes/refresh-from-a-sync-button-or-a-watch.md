# Recipe: Refresh from a Sync button or a watch

**Use case.** You want your copy of a website to stay current. You must select who starts each pipeline run: the user, a scheduler of the operating system, or a process that runs all the time. The source and its revisit policy do not start a pipeline run, and they use no cron.

**What you need.** A pipeline with a `WebSource`. Use `pipeline.run()` for one pipeline run. Use `pipeline.watch({ signal })` for a process that starts each pipeline run when a URL is due.

## Select how to start a pipeline run

| Trigger         | Call                                                       | When the next crawl starts                                                                                      |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A Sync button   | `pipeline.run()`                                           | When the user presses the button. A due page waits until then.                                                  |
| cron or launchd | `pipeline.run()` in a short process                        | At the time that the schedule gives, for example each hour. A page that is not due yet stays out of that crawl. |
| A watch         | `pipeline.watch({ signal })` in a process that stays alive | At `crawl.nextDue()` of each input: the earliest time when a known URL is due, or when a block ends.            |

The revisit policy only gives each URL the time when it is due. A crawl requests the URLs that are due when it starts, whoever starts it.

## The program

A blog has two posts. Post 1 changes at each visit, and post 2 never changes. The web stream uses `FixedRevisit({ every: 3_000 })`, so each URL is due three seconds after its visit. The program does one pipeline run, as a Sync button does. Then it watches for two passes, and stops the watch.

```ts title="sync-or-watch.ts"
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { FixedRevisit, ListingReader } from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

// A blog whose post 1 changes at each visit.
let edits = 0;
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  if (pathname === '/feed.json') {
    response.setHeader('content-type', 'application/feed+json');
    response.end(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Blog',
        items: [1, 2].map((n) => ({ id: `${n}`, url: `${origin}/posts/${n}` })),
      }),
    );
  } else if (pathname === '/posts/1' || pathname === '/posts/2') {
    const text =
      pathname === '/posts/1'
        ? `Post 1 has had ${++edits} edits.`
        : 'Post 2 does not change.';
    response.setHeader('content-type', 'text/html');
    response.end(
      `<title>${pathname}</title><article><p>${text} The blog keeps it for its readers.</p></article>`,
    );
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

const directory = await mkdtemp(join(tmpdir(), 'web-'));
const destination = new SQLiteDestination({
  path: join(directory, 'articles.sqlite'),
});
const source = new WebSource({
  stream: new WebStream({
    name: 'articles',
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    revisit: new FixedRevisit({ every: 3_000 }),
    extractor: new ArticleExtractor(),
  }),
  inputs: [`${origin}/feed.json`],
  cachePath: join(directory, 'web-http.sqlite'),
  userAgent: 'ExampleReader/1.0 (+https://example.com/contact)',
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

const started = performance.now();
const seconds = () => Math.round((performance.now() - started) / 1000);

// One pipeline run, as a Sync button starts it.
const [result] = await pipeline.run();
console.log(`sync button, at ${seconds()} s: ${result?.count} records`);

// A watch: it starts a pass at once, then each time a URL is due.
const stop = new AbortController();
let passes = 0;
for await (const pass of pipeline.watch({ signal: stop.signal })) {
  passes++;
  console.log(
    `watch pass ${passes}, at ${seconds()} s: ${pass.outcomes[0]?.count} records`,
  );
  if (passes === 2) stop.abort();
}
server.close();
await rm(directory, { recursive: true, force: true });
```

Output (the times change from run to run):

```
sync button, at 1 s: 2 records
watch pass 1, at 1 s: 0 records
watch pass 2, at 4 s: 1 records
```

## Why it works

`pipeline.run()` does one pass and returns. Nothing starts the next pass until you call it again.

`pipeline.watch()` asks the source when to start each pass. `WebSource` starts with one pass for all its inputs. After each crawl, it reads `crawl.nextDue()`, and it waits until the earliest due time of all its inputs. That wait is the only timer.

The first watch pass started at once, just after the pass of the Sync button. Only the feed was due, because a starting URL is always due, so the pass loaded no records. The second watch pass started when the posts were due, three seconds after their last visit. Post 1 had changed, so the pass loaded its new record. Post 2 had not changed, so the extractor did not extract its records again.

## Things to know

- **Every pass requests only the URLs that are due.** With the default `AdaptiveRevisit`, a watch does not crawl again soon after a crawl. Its first wait is one day.
- **Do not watch with `AlwaysRevisit`.** Every URL is then due at once, so the watch crawls again as soon as each crawl ends.
- **A watch also waits out a block.** After a 429, `crawl.nextDue()` gives the end of the block. See [Crawl a website that rate-limits you](../../../../../sdks/web/crawler/docs/recipes/crawl-a-website-that-rate-limits-you.md).
- **A watch needs a process that stays alive.** If the process stops, the state still has each due time. The next `run()` or `watch()` reads them.
- **A pass that a scheduler starts too early does little.** It requests only the input and the URLs that are due. The other pages are deferred pages, and their rows stay.
