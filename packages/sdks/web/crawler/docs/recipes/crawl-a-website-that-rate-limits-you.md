# Recipe: Crawl a website that rate-limits you

**Use case.** A website answers `429 Too Many Requests` in the middle of a crawl. The crawl must stop all requests to that website for the time that the website asks for. It must not lose the pages that it did not reach. A later crawl must continue from where the block started.

**What you need.** A crawl and its crawl memento, and the origins' records and their memento. The crawler handles the 429. You save `crawl.snapshot()` and `origins.snapshot()`, and you start the next crawl at `crawl.nextDue()`.

## What happens, step by step

1. **Got does not try the request again.** A refusal, a 429 or a 5xx, belongs to the origin's record, not to Got. The crawl gives each request its own retry options, which keep Got's retries of network errors and of a 408, and remove the refusals.
2. **The record blocks the origin.** The record of the origin, for example `https://shop.example`, opens a circuit breaker. The block ends at the `Retry-After` time, at most one day later, or one hour later when the answer gives none. A 503 with `Retry-After` blocks the origin in the same way.
3. **The crawl holds the URLs of the origin.** The URL and each later URL of the origin stay in the frontier, and the crawl sends no request for them. Every other crawl that shares the record holds them too. The crawl continues on all other origins.
4. **The crawl ends unfinished.** When only held URLs remain, the crawl ends. `crawl.snapshot().crawl` is not `null`, and it keeps the held URLs. `origins.snapshot()` keeps the block.
5. **The next read continues, slowly.** `crawl.nextDue()` gives the time when the first block ends. A read that starts after that time requests the held URLs. The refusal gave the origin a slowdown of one second, so the crawl waits that much more than the origin's delay between its requests. Each answer that is not a refusal shortens the slowdown by a tenth.

## The program

A blog has a feed that names three posts. Post 2 answers 429 with `Retry-After: 2` one time, then it answers normally. Each crawl is a read of its own, as each run of a host is: its origins' records start from the memento of the last read.

```ts title="rate-limited-crawl.ts"
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

import got from 'got';

import {
  AdaptiveRevisit,
  ListingReader,
  Origins,
} from '@workspace/sdk-web-crawler';

// A blog whose post 2 answers 429 one time.
let refusals = 0;
const started: number[] = [];
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  started.push(performance.now());
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
  } else if (pathname === '/posts/2' && refusals < 1) {
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

const http = got.extend({ timeout: { request: 30_000 } });
let memento: unknown = null;
let records: unknown = null;
for (const name of ['first read', 'second read']) {
  const origins = new Origins(http, records);
  const crawl = origins
    .crawler(http, [new ListingReader()], new AdaptiveRevisit())
    .crawl([`${origin}/feed.json`], memento, {
      signal: AbortSignal.timeout(60_000),
    });
  started.length = 0;
  const pages: string[] = [];
  for await (const entry of crawl) {
    if ('error' in entry) console.log(name, entry.error.message);
    else if ('response' in entry) pages.push(new URL(entry.url).pathname);
  }
  memento = crawl.snapshot();
  records = origins.snapshot();
  const complete = crawl.snapshot().crawl === null;
  const gaps = started
    .slice(1)
    .map((at, index) => Math.round(at - (started[index] ?? at)));
  console.log(name, { pages, complete, refusals, gaps });
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
first read Crawl could not read http://127.0.0.1:63102/posts/2: http://127.0.0.1:63102 answered 429, so the crawl requests nothing there until 2026-11-01T06:53:21.214Z
first read {
  pages: [ '/posts/1' ],
  complete: false,
  refusals: 1,
  gaps: [ 997, 1000, 999 ]
}
the block ends in 2 s
second read {
  pages: [ '/posts/2', '/posts/3' ],
  complete: true,
  refusals: 1,
  gaps: [ 1902 ]
}
```

## Why it works

The first read asked `robots.txt`, the feed, post 1 and post 2, one second apart. The record of the origin met one 429 for post 2, so it blocked the origin until the `Retry-After` time. Got did not try again. Post 3 has the same origin, so the crawl held it without a request. The crawl ended unfinished, and its crawl snapshot kept posts 2 and 3. The second read started after the block ended, so it requested them. Its origins' records came from the first read's memento, so the second read did not read `robots.txt` again: the rules last 24 hours (RFC 9309 §2.4). The refusal left a slowdown of one second, so the second read waited the origin's delay of one second and the slowdown, a tenth less after each answer.

The block is data in the origins' memento, not a timer. A process that starts again before the block ends reads the block and still sends no request to the origin. A timer would be lost when the process stops.

## Things to know

- **In the read where it starts, a block lasts until that read ends**, even when its end time comes first. Apache Nutch also clears the queue of a blocked website for the round.
- **Every crawl of one read shares the block.** One `Origins` serves all the crawls of a read, as Heritrix keeps one record for each host. A second list on the same website sends it no request while the block lasts.
- **Three 403 answers in a row also block the origin.** A single 403 is a failure of that page only, because one page can be for members only.
- **A 503 with `Retry-After` blocks the origin** (RFC 9110 §10.2.3). A 503 without one is a failure of the page, and it slows the origin.
- **A `robots.txt` that the crawl cannot read also blocks the origin**: a 429, a 5xx or a network error.
- **A reader can accept a status for a URL.** A 429 that the reader accepts does not block the origin.
- **A `Retry-After` longer than one day ends after one day**, as StormCrawler caps the `Retry-After` it honors.
- **Every origin has a delay.** Two requests to one origin start at least one second apart, or its `Crawl-delay` apart, as StormCrawler's `fetcher.server.delay`. A slowdown adds to the delay, as Nutch adds its back-off to the server delay.
- **The slowdown carries over.** The origins' memento keeps it, so tomorrow's crawl of a website that refused today starts slowly.
- **The crawler starts no crawl.** Your host starts the next crawl at `crawl.nextDue()`. `Pipeline.watch()` of elt does this. A host that only has a Sync button starts the next crawl when the user presses it.
