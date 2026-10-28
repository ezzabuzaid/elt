# Recipe: Check some pages every hour and the rest by change

**Use case.** A website has a news section and a guides section. A news page must be at most one hour old in your copy. A guide changes seldom, and you do not know when. Each crawl must request each news page that is one hour old, and only the guides that probably changed.

**What you need.** `CompositeRevisit`. It gives each URL the revisit policy of the first `URLPattern` that matches the URL, or a fallback policy. Here, `FixedRevisit` for `/news/*` and `AdaptiveRevisit` for all other URLs.

## The steps

1. Make a route for each part of the website that needs its own policy: `[new URLPattern({ pathname: '/news/*' }), new FixedRevisit({ every: hour })]`.
2. Give the routes and a fallback to `new CompositeRevisit(routes, fallback)`.
3. Give the composite policy to `new WebCrawler(http, readers, policy)`. With `@workspace/source-web-pages`, give it to `new WebStream({ revisit })`.
4. Start the next crawl at `crawl.nextDue()`, or when your host decides.

## The program

A sitemap names two news pages and one guide. One crawl reads all of them. The program then shows when each URL is due again.

```ts title="check-news-every-hour.ts"
import { once } from 'node:events';
import { createServer } from 'node:http';

import got from 'got';

import {
  AdaptiveRevisit,
  CompositeRevisit,
  FixedRevisit,
  ListingReader,
  WebCrawler,
  hour,
} from '@workspace/sdk-web-crawler';

// A website whose sitemap names two news pages and one guide.
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  if (pathname === '/sitemap.xml') {
    response.setHeader('content-type', 'application/xml');
    response.end(
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
        '/news/1',
        '/news/2',
        '/guides/setup',
      ]
        .map((path) => `<url><loc>${origin}${path}</loc></url>`)
        .join('')}</urlset>`,
    );
  } else if (pathname.startsWith('/news/') || pathname.startsWith('/guides/')) {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${pathname}</title>`);
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

const crawler = new WebCrawler(
  got.extend({ timeout: { request: 30_000 } }),
  [new ListingReader()],
  new CompositeRevisit(
    [
      [
        new URLPattern({ pathname: '/news/*' }),
        new FixedRevisit({ every: hour }),
      ],
    ],
    new AdaptiveRevisit(),
  ),
);
const crawl = crawler.crawl([`${origin}/sitemap.xml`], null, {
  signal: AbortSignal.timeout(60_000),
});
for await (const entry of crawl) if ('error' in entry) throw entry.error;

const at = Date.now();
const { urls } = crawl.snapshot();
console.log(
  Object.fromEntries(
    Object.entries(urls).map(([url, { due }]) => [
      new URL(url).pathname,
      due === null ? 'never' : `due in ${Math.round((due - at) / hour)} h`,
    ]),
  ),
);
const next = crawl.nextDue();
if (next !== null)
  console.log(`next crawl in ${Math.round((next - at) / hour)} h`);
server.close();
```

Output:

```
{
  '/sitemap.xml': 'due in 24 h',
  '/news/1': 'due in 1 h',
  '/news/2': 'due in 1 h',
  '/guides/setup': 'due in 24 h'
}
next crawl in 1 h
```

## Why it works

After each visit, the crawler asks the revisit policy when the URL is due again, and it keeps the answer in the crawl memento. `CompositeRevisit` sends the question to the policy of the matching route. `FixedRevisit({ every: hour })` always answers "one hour after this visit". `AdaptiveRevisit` answers "one day" after a first visit, and changes the interval after each later visit: longer while the page does not change, shorter when it changes.

A crawl requests only the known URLs that are due when the crawl starts. Thus a crawl one hour later requests the sitemap, because a starting URL is always due, and the two news pages. It does not request the guide.

## Things to know

- **The first matching route wins.** Put the narrow patterns before the wide ones.
- **Each route keeps its own history.** If a URL moves to another route, for example after you change a pattern, its new policy starts with no history.
- **A policy does not start a crawl.** It only gives each URL the time when it is due. Your host starts the crawl: from a button, from cron or launchd, or from `Pipeline.watch()` of elt, which wakes at `crawl.nextDue()`.
- **Two rules apply under every policy.** A sitemap that gives a page another `lastmod` makes the page due at once. A feed is due again within half of the time that its items cover, so that no item rolls off before the next crawl.
- **Starting URLs are always due.** A route for a starting URL has no effect on when it is requested.
