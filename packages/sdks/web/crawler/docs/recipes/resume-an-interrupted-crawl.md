# Recipe: Resume an interrupted crawl

**Use case.** A crawl of a large website stops before it ends: the process stops, or the machine goes to sleep. The next crawl must continue from the page where the last one stopped. It must not start again from the first page.

**What you need.** A place to keep the crawl memento, such as a file. The crawler does not save anything. You save `crawl.snapshot()`, and you give it back to the next `crawler.crawl(...)`.

## The steps

1. Read the last crawl memento, or use `null` for the first crawl.
2. Give it to `crawler.crawl(starts, memento, options)`.
3. Save `crawl.snapshot()` each time that you finish a page.
4. When the crawl ends, save `crawl.snapshot()` again. Its `crawl` part is then `null`, because the crawl is complete.

## The program

A blog has a feed that names five posts. The first crawl stops while it reads post 3, before it saves. The second crawl starts from the saved crawl memento.

```ts title="resume-a-crawl.ts"
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import got from 'got';

import { ListingReader, WebCrawler } from '@workspace/sdk-web-crawler';

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

const file = join(await mkdtemp(join(tmpdir(), 'crawl-')), 'crawl.json');
const crawler = new WebCrawler(got.extend({ timeout: { request: 30_000 } }), [
  new ListingReader(),
]);

async function crawlUntil(name: string, stopAt: string | null) {
  const memento = await readFile(file, 'utf8').then(JSON.parse, () => null);
  const crawl = crawler.crawl([`${origin}/feed.json`], memento, {
    signal: AbortSignal.timeout(60_000),
  });
  const pages: string[] = [];
  for await (const entry of crawl) {
    if (!('response' in entry)) continue;
    const page = new URL(entry.url).pathname;
    if (page === stopAt) {
      console.log(name, { pages, stoppedAt: page });
      return; // The process stops here, before it saves this page.
    }
    pages.push(page);
    await writeFile(file, JSON.stringify(crawl.snapshot()));
  }
  await writeFile(file, JSON.stringify(crawl.snapshot()));
  console.log(name, { pages, complete: crawl.snapshot().crawl === null });
}

await crawlUntil('first crawl', '/posts/3');
await crawlUntil('second crawl', null);
server.close();
```

Output:

```
first crawl { pages: [ '/posts/1', '/posts/2' ], stoppedAt: '/posts/3' }
second crawl {
  pages: [ '/posts/2', '/posts/3', '/posts/4', '/posts/5' ],
  complete: true
}
```

## Why it works

The crawl memento is plain data. Its `crawl` part is the crawl snapshot: the frontier, the URLs that the crawl knows, and the pages that it handed back. A new `crawler.crawl(...)` with that crawl memento continues the same crawl. The second crawl does not hand back post 1 again.

The crawl counts the page that it handed out last as unfinished until you ask for the next entry. When you save after post 2, post 2 is still unfinished in that crawl memento. Thus the second crawl hands back post 2 again. A crawl hands back each page at least once, never zero times. Make the work for a page safe to do two times, for example an upsert by a key.

## Things to know

- **Save often.** The crawler cannot save for you, because it does not know where you keep data. Each save is one `JSON.stringify` of the crawl memento.
- **The crawl memento grows with the website.** It keeps every URL that a crawl visited, with the time when it is due again.
- **A complete crawl starts a new crawl.** When `crawl` is `null`, the next `crawler.crawl(...)` starts from the starting URLs again. It requests only the URLs that are due. See [Check some pages every hour and the rest by change](./check-some-pages-every-hour.md).
- **To start again from nothing, delete the crawl memento.** The next crawl then requests every page.
- **The revisit policy keeps its history in the crawl memento too.** If you delete the crawl memento, each URL goes back to its first visit.
- **`WebSource` of `@workspace/source-web-pages` does these steps for you.** It keeps the crawl memento in its state, in the checkpoint store of elt.
