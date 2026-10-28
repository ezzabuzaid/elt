# Recipe: Crawl a website that rate-limits you

**Use case.** A website answers `429 Too Many Requests` in the middle of a crawl. The crawl must stop all requests to that website for the time that the website asks for. It must not lose the pages that it did not reach. A later crawl must continue from where the block started.

**What you need.** Nothing more than a crawl and its crawl memento. Got and the crawler handle the 429. You save `crawl.snapshot()`, and you start the next crawl at `crawl.nextDue()`.

## What happens, step by step

1. **Got tries the request again.** Got tries a GET request again a maximum of two times. It waits for the `Retry-After` time when that time is not longer than the request timeout. Without `Retry-After`, it waits approximately 1 second, then 2 seconds.
2. **The crawler blocks the origin.** When the answer is still 429, the crawler opens a circuit breaker for the origin, for example `https://shop.example`. The block ends at the `Retry-After` time, or one hour later when the answer gives none.
3. **The crawl holds the URLs of the origin.** The URL and each later URL of the origin stay in the frontier, and the crawl sends no request for them. The crawl continues on all other origins.
4. **The crawl ends unfinished.** When only held URLs remain, the crawl ends. `crawl.snapshot().crawl` is not `null`, and it keeps the held URLs and the block.
5. **The next crawl continues.** `crawl.nextDue()` gives the time when the first block ends. A crawl that starts after that time requests the held URLs.

## The program

A blog has a feed that names three posts. Post 2 answers 429 with `Retry-After: 2` three times, then it answers normally.

```ts title="rate-limited-crawl.ts"
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

import got from 'got';

import { ListingReader, WebCrawler } from '@workspace/sdk-web-crawler';

// A blog whose post 2 answers 429 three times.
let refusals = 0;
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  if (pathname === '/feed.json') {
    response.setHeader('content-type', 'application/feed+json');
    response.end(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Blog',
        items: [1, 2, 3].map((n) => ({
          id: `${n}`,
          url: `${origin}/posts/${n}`,
        })),
      }),
    );
  } else if (pathname === '/posts/2' && refusals < 3) {
    refusals++;
    response.writeHead(429, { 'retry-after': '2' }).end();
  } else if (pathname.startsWith('/posts/')) {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${pathname}</title>`);
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

const crawler = new WebCrawler(got.extend({ timeout: { request: 30_000 } }), [
  new ListingReader(),
]);
let memento: unknown = null;
for (const name of ['first crawl', 'second crawl']) {
  const crawl = crawler.crawl([`${origin}/feed.json`], memento, {
    signal: AbortSignal.timeout(60_000),
  });
  const pages: string[] = [];
  for await (const entry of crawl) {
    if ('error' in entry) console.log(name, entry.error.message);
    else if ('response' in entry) pages.push(new URL(entry.url).pathname);
  }
  memento = crawl.snapshot();
  const complete = crawl.snapshot().crawl === null;
  console.log(name, { pages, complete, refusals });
  const next = crawl.nextDue();
  if (complete || next === null) break;
  const wait = next - Date.now();
  console.log(`the block ends in ${Math.round(wait / 1000)} s`);
  await setTimeout(Math.max(0, wait));
}
server.close();
```

Output (the port and the times change from run to run):

```
first crawl Crawl could not read http://127.0.0.1:50109/posts/2: http://127.0.0.1:50109 answered 429, so the crawl requests nothing there until 2026-10-28T09:03:37.988Z
first crawl { pages: [ '/posts/1' ], complete: false, refusals: 3 }
the block ends in 2 s
second crawl { pages: [ '/posts/2', '/posts/3' ], complete: true, refusals: 3 }
```

## Why it works

Got sent the request for post 2 three times: the first try and two more. Each answer was 429, so the crawler blocked the origin until the `Retry-After` time of the last answer. Post 3 has the same origin, so the crawl held it without a request. The crawl ended unfinished, and its crawl snapshot kept posts 2 and 3. The second crawl started after the block ended, so it requested them.

The block is data in the crawl memento, not a timer. A process that starts again before the block ends reads the block and still sends no request to the origin. A timer would be lost when the process stops.

## Things to know

- **In the crawl where it starts, a block lasts until that crawl ends**, even when its end time comes first. Apache Nutch also clears the queue of a blocked website for the round.
- **Three 403 answers in a row also block the origin.** A single 403 is a failure of that page only, because one page can be for members only.
- **A `robots.txt` that the crawl cannot read also blocks the origin**: a 429, a 5xx or a network error.
- **A reader can accept a status for a URL.** A 429 that the reader accepts does not block the origin.
- **Got waits inside the request.** While Got waits for a `Retry-After` of up to the request timeout, the crawl does nothing else. A `Retry-After` that is longer than the request timeout skips Got's retries and goes straight to the block.
- **Set a request timeout.** Without one, Got waits for any `Retry-After`, also one of an hour, before the crawler can block the origin.
- **After the block, the crawl continues at the full rate.** The crawler does not slow down after a 429. Backlog item 3170 records this.
- **The crawler starts no crawl.** Your host starts the next crawl at `crawl.nextDue()`. `Pipeline.watch()` of elt does this. A host that only has a Sync button starts the next crawl when the user presses it.
