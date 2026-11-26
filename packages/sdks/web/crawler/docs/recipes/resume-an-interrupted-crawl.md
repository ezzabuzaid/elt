# Recipe: Resume an interrupted crawl

**Use case.** A crawl of a large website stops before it ends: the process stops, or the machine goes to sleep. The next crawl must continue from the page where the last one stopped. It must not start again from the first page.

**What you need.** A place to keep what the crawl gives at each snapshot: its memento, and one record for each URL that it knows, such as a table keyed by URL. The crawler does not save anything. Each `crawl.snapshot()` gives the memento and the URL records that changed since the last snapshot; you apply them, and you give the memento and every record back to the next `crawler.crawl(...)`.

## The steps

1. Read the last memento and every URL record, or use `null` for the first crawl.
2. Give them to `crawler.crawl(starts, { memento, urls }, options)`, with `urls` a `Map` from each URL to its record.
3. Each time that you finish a page, save `crawl.snapshot()`: replace the memento, delete each URL of `urls.remove`, and write each record of `urls.put` under its URL, in one transaction.
4. When the crawl ends, save `crawl.snapshot()` again. `crawl.complete` is then `true`.

## The program

A blog has a feed that names five posts. The first crawl stops while it reads post 3, before it saves. The second crawl starts from the saved memento and records, which a SQLite file keeps in two tables.

```ts title="resume-a-crawl.ts"
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TemporaryFiles } from '@zukhruf/fs';
import got from 'got';

import {
  AdaptiveRevisit,
  type CrawlSnapshot,
  ListingReader,
  Origins,
  type SavedCrawl,
} from '@eltjs/sdk-web-crawler';

// A blog with a feed that names five posts.
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  if (pathname === '/feed.json') {
    response.setHeader('content-type', 'application/feed+json');
    response.end(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Blog',
        items: [1, 2, 3, 4, 5].map((n) => ({
          id: `${n}`,
          url: `${origin}/posts/${n}`,
        })),
      }),
    );
  } else if (pathname.startsWith('/posts/')) {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${pathname}</title>`);
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

await using folder = await new TemporaryFiles().directory('crawl-');
using database = new DatabaseSync(join(folder.path, 'crawl.sqlite'));
database.exec(`
  CREATE TABLE memento (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL) STRICT;
  CREATE TABLE urls (url TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT, WITHOUT ROWID;
`);

// The memento and every URL record, as the last save left them.
function saved(): SavedCrawl | null {
  const memento = database.prepare('SELECT value FROM memento').get();
  if (memento === undefined) return null;
  const urls = database.prepare('SELECT url, record FROM urls').all();
  return {
    memento: JSON.parse(String(memento.value)),
    urls: new Map(
      urls.map(({ url, record }) => [String(url), JSON.parse(String(record))]),
    ),
  };
}

// One save: the memento, and only the URL records that changed.
function save({ memento, urls }: CrawlSnapshot) {
  database.exec('BEGIN');
  database
    .prepare(
      'INSERT INTO memento (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value',
    )
    .run(JSON.stringify(memento));
  for (const url of urls.remove)
    database.prepare('DELETE FROM urls WHERE url = ?').run(url);
  for (const [url, record] of urls.put)
    database
      .prepare(
        'INSERT INTO urls (url, record) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET record = excluded.record',
      )
      .run(url, JSON.stringify(record));
  database.exec('COMMIT');
  return urls.put.size + urls.remove.size;
}

const http = got.extend({ timeout: { request: 30_000 } });
// Each process is a read of its own, with its own records of the origins.
const crawler = () =>
  new Origins(http, null, globalThis).crawler(
    http,
    [new ListingReader()],
    new AdaptiveRevisit(),
  );

async function crawlUntil(name: string, stopAt: string | null) {
  const crawl = crawler().crawl([`${origin}/feed.json`], saved(), {
    signal: AbortSignal.timeout(60_000),
  });
  const pages: string[] = [];
  const written: number[] = [];
  for await (const entry of crawl) {
    if (!('response' in entry)) continue;
    const page = new URL(entry.url).pathname;
    if (page === stopAt) {
      console.log(name, { pages, written, stoppedAt: page });
      return; // The process stops here, before it saves this page.
    }
    pages.push(page);
    written.push(save(crawl.snapshot()));
  }
  written.push(save(crawl.snapshot()));
  console.log(name, { pages, written, complete: crawl.complete });
}

await crawlUntil('first crawl', '/posts/3');
await crawlUntil('second crawl', null);
server.close();
```

Output:

```
first crawl {
  pages: [ '/posts/1', '/posts/2' ],
  written: [ 6, 1 ],
  stoppedAt: '/posts/3'
}
second crawl {
  pages: [ '/posts/2', '/posts/3', '/posts/4', '/posts/5' ],
  written: [ 0, 1, 1, 1, 1 ],
  complete: true
}
```

## Why it works

The memento and the URL records are plain data. The memento is small: the reader states and the starting origins of an unfinished crawl, and the starting pages. Each URL record holds what the last visit of the URL got, its place in the frontier, or both, as Nutch keeps a `CrawlDatum` for each URL ([ADR 0011](../adr/0011-a-snapshot-gives-the-url-records-that-changed.md)). A new `crawler.crawl(...)` with the memento and the records continues the same crawl. The second crawl does not hand back post 1 again.

`written` counts the records of each save. The first save writes the feed and the five posts that it names, which wait in the frontier. Each later save writes one record: the page handed out before, now visited. The first save of the second crawl writes nothing, since nothing changed yet. A save does not write the records that it wrote before, so a save of a large website costs what changed, not the size of the website.

The crawl counts the page that it handed out last as unfinished until you ask for the next entry. When you save after post 2, post 2 still waits in the frontier. Thus the second crawl hands back post 2 again. A crawl hands back each page at least once, never zero times. Make the work for a page safe to do two times, for example an upsert by a key.

## Things to know

- **Save every snapshot, in order.** A snapshot gives only what changed since the last one, so a snapshot that you do not save loses those changes. Apply the removes and the puts of one snapshot together with its memento, in one transaction.
- **Give back every record.** The crawl reads the records in the order found, whatever order your store gives them in.
- **A complete crawl starts a new crawl.** When `crawl.complete` is `true`, the next `crawler.crawl(...)` starts from the starting URLs again. It requests only the URLs that are due. See [Check some pages every hour and the rest by change](./check-some-pages-every-hour.md).
- **To start again from nothing, delete the memento and the records.** The next crawl then requests every page.
- **The revisit policy keeps its history in the URL records.** If you delete them, each URL goes back to its first visit.
- **The records of the origins are not in the memento.** `Origins.snapshot()` keeps the blocks, the slowdowns and the `robots.txt` rules of the origins. Give it to `new Origins(http, memento, globalThis)` of the next read so that a block outlives the process; here each process starts with no records, so it reads `robots.txt` again.
- **`WebSource` of `@eltjs/source-web-pages` does these steps for you.** It keeps the memento in its state and the URL records in the `crawl` space of the checkpoint's keyed entries, in the checkpoint store of elt.
