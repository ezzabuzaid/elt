# Recipe: Follow a list to other websites

**Use case.** A page lists programs, products or posts that live on other websites, for example a GitHub list of startup programs that links the program page of each company. The crawl must hand back the pages on those other websites. It must not hand back the other pages of the list's own website, such as its license or its commits.

**What you need.** `PaginationReader` with the strategy `'all'`, and one URL pattern in `include` that selects every website except the list's own. A URL pattern has no "not", but a part of a pattern can be a regular expression group, and a negative lookahead in that group excludes one host name.

## What happens, step by step

1. **The crawl reads the starting page as a list.** `PaginationReader` reads each starting page as a list and finds the links outside its navigation.
2. **The list finds the links on all websites.** With the strategy `'all'`, the list finds its links on every origin, as Crawlee's enqueue strategy `all`. With the default strategy `'same-origin'`, it finds only the links on its own origin.
3. **`include` selects the pages.** The crawl hands back a page only when a pattern in `include` matches its URL. The pattern `{ hostname: '((?!list\\.example$).*)' }` matches every host name except `list.example`, so the crawl does not download the license.
4. **Pagination stays on the list's website.** The strategy changes only the pages that the list hands back. A `rel="next"` link or a page number on another origin is not pagination.

A link that `include` does not select costs its website nothing: the crawl sends it no request, not even for its `robots.txt`, so a website that is down gives no failure.

## The program

The list on `list.example` links its license and the program page on `company.example`. Both websites run on this computer, so the program resolves every host name to 127.0.0.1.

```ts title="follow-a-list.ts"
import { lookup } from 'node:dns';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import got from 'got';

import { PaginationReader, WebCrawler } from '@workspace/sdk-web-crawler';

// A list of startup programs, as a GitHub list, that links its own license and
// one company's program page on another website.
const list = createServer((request, response) => {
  if (request.url === '/robots.txt') return response.writeHead(404).end();
  response.setHeader('content-type', 'text/html');
  response.end(
    request.url === '/programs'
      ? `<main>
          <a href="${listOrigin}/LICENSE">License</a>
          <a href="${companyOrigin}/startups">Company credits</a>
        </main>`
      : '<p>The license of the list.</p>',
  );
});
const company = createServer((request, response) => {
  if (request.url === '/robots.txt') return response.writeHead(404).end();
  response.setHeader('content-type', 'text/html');
  response.end('<p>Up to $100,000 in credits.</p>');
});
async function listen(server: Server, hostname: string) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No port');
  return `http://${hostname}:${address.port}`;
}
const listOrigin = await listen(list, 'list.example');
const companyOrigin = await listen(company, 'company.example');

// Both websites run on this computer: every host name resolves to 127.0.0.1.
const http = got.extend({
  dnsLookup: (_hostname, options, callback) =>
    lookup('127.0.0.1', options, callback),
});

const crawler = new WebCrawler(http, [
  new PaginationReader({ strategy: 'all' }),
]);
const crawl = crawler.crawl([`${listOrigin}/programs`], null, {
  signal: AbortSignal.timeout(10_000),
  // Every website except the list's own.
  include: [new URLPattern({ hostname: '((?!list\\.example$).*)' })],
});
for await (const entry of crawl)
  if ('response' in entry) console.log(entry.url, 'from', entry.listingUrl);

list.close();
company.close();
```

## The output

The port numbers change on each run.

```text
http://company.example:58709/startups from http://list.example:58708/programs
```

The crawl handed back the program page on `company.example`, with the list as its listing. It did not hand back the license, because the pattern does not match `list.example`.
