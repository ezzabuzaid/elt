# Recipe: Search inside the sites a list links

**Use case.** A list links the home page of each company, but the page you want is elsewhere: in the menu of the home page, in the sitemap of the website, or on another website that the home page links. For example, a GitHub list of startup programs links `vercel.com/`, and the program page is `vercel.com/startups`.

**What you need.** `PaginationReader` with the strategy `'all'`, `ListingReader`, `LinkReader`, an `include` pattern that selects the websites of the list's pages, and `expand` patterns that select the pages you want.

## What happens, step by step

1. **The list hands back the home page.** `PaginationReader` reads the starting page as a list and hands back the home page of the company. The home page is on an origin that no starting URL names, so the crawl expands it one step.
2. **`LinkReader` finds the links of the home page on every origin.** The crawl keeps only the links that match `expand`, here `/startups` and the program on `cloud.example`. It does not keep `/pricing`.
3. **`ListingReader` reads the `robots.txt` of the home page's origin.** The crawl reads each sitemap that `robots.txt` declares, and keeps only the entries that match `expand`, here `/startup-program/`. It does not keep `/blog/launch`.
4. **The expansion is one step.** The crawl does not expand the pages that the expansion found. It does not follow their links, and it does not read the `robots.txt` sitemaps of `cloud.example`.
5. **`include` selects the pages to hand back.** The pattern `{ hostname: '((?!list\\.example$).*)' }` matches every host name except `list.example`.
6. **Each read gives its routes.** A route is "listing L named URL U". The page and progress entries carry `routes`: each URL in the crawl's scope that the response named, with how and with its text. The crawl gives a route also for a URL that it already knows. Follow the routes from the home page to find each program page that the home page leads to.

A sitemap entry or a feed item on another website is not expanded. Only a page that a list hands back is. Without `expand`, the crawl hands back the home page and expands nothing on its website.

## The program

The list on `list.example` links the home page of `company.example`. The three websites run on this computer, so the program resolves every host name to 127.0.0.1.

```ts title="search-inside.ts"
import { lookup } from 'node:dns';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import got from 'got';

import {
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from '@workspace/sdk-web-crawler';

// A list of startup programs, as a GitHub list, that links the home page of
// one company.
const list = createServer((request, response) => {
  if (request.url !== '/programs') return response.writeHead(404).end();
  response.setHeader('content-type', 'text/html');
  response.end(`<main><a href="${companyOrigin}/">Company</a></main>`);
});
// The company's home page links its program in the menu, and its program for
// cloud customers on another website. Its sitemap names another program page.
const company = createServer((request, response) => {
  if (request.url === '/robots.txt')
    return response.end(`Sitemap: ${companyOrigin}/sitemap.xml`);
  if (request.url === '/sitemap.xml') {
    response.setHeader('content-type', 'application/xml');
    return response.end(
      `<urlset><url><loc>${companyOrigin}/startup-program/</loc></url><url><loc>${companyOrigin}/blog/launch</loc></url></urlset>`,
    );
  }
  response.setHeader('content-type', 'text/html');
  response.end(
    request.url === '/'
      ? `<nav>
          <a href="/startups">Startups</a>
          <a href="/pricing">Pricing</a>
          <a href="${cloudOrigin}/start-ups">Cloud for start-ups</a>
        </nav>`
      : '<p>A page of the company.</p>',
  );
});
const cloud = createServer((request, response) => {
  if (request.url === '/robots.txt') return response.writeHead(404).end();
  response.setHeader('content-type', 'text/html');
  response.end('<p>Cloud credits for start-ups.</p>');
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
const cloudOrigin = await listen(cloud, 'cloud.example');

// The three websites run on this computer: every host name resolves to 127.0.0.1.
const http = got.extend({
  dnsLookup: (_hostname, options, callback) =>
    lookup('127.0.0.1', options, callback),
});

const crawler = new WebCrawler(http, [
  new PaginationReader({ strategy: 'all' }),
  new ListingReader(),
  new LinkReader({ maxDepth: 0, maxPages: 0 }),
]);
const crawl = crawler.crawl([`${listOrigin}/programs`], null, {
  signal: AbortSignal.timeout(10_000),
  // Every website except the list's own.
  include: [new URLPattern({ hostname: '((?!list\\.example$).*)' })],
  // From the company's home page, keep only the program pages.
  expand: [
    new URLPattern({ pathname: '*startup*' }),
    new URLPattern({ pathname: '*start-up*' }),
  ],
});
const routes: string[] = [];
for await (const entry of crawl) {
  if ('response' in entry) console.log(entry.url, 'from', entry.listingUrl);
  // Each read gives every URL that its response named, with how and its text.
  if ('routes' in entry)
    for (const { listingUrl, routes: named } of entry.routes)
      for (const { url, how, text } of named)
        routes.push(
          `${listingUrl} ${how} ${url}${text === null ? '' : ` "${text}"`}`,
        );
}
console.log(routes.join('\n'));

list.close();
company.close();
cloud.close();
```

## The output

The port numbers change on each run.

```text
http://company.example:55384/ from http://list.example:55383/programs
http://company.example:55384/startup-program/ from http://company.example:55384/sitemap.xml
http://company.example:55384/startups from http://company.example:55384/
http://cloud.example:55385/start-ups from http://company.example:55384/
http://list.example:55383/programs list-item http://company.example:55384/ "Company"
http://list.example:55383/programs robots http://list.example:55383/robots.txt
http://list.example:55383/robots.txt sitemap-guess http://list.example:55383/sitemap.xml
http://company.example:55384/ robots http://company.example:55384/robots.txt
http://company.example:55384/ link http://company.example:55384/startups "Startups"
http://company.example:55384/ link http://cloud.example:55385/start-ups "Cloud for start-ups"
http://company.example:55384/robots.txt robots-sitemap http://company.example:55384/sitemap.xml
http://company.example:55384/sitemap.xml sitemap-entry http://company.example:55384/startup-program/
```

The crawl handed back the home page with the list as its listing, the two program pages of `company.example`, and the program page on `cloud.example`. It did not hand back `/pricing` or `/blog/launch`, because no `expand` pattern matches them.

`/startup-program/` has the sitemap as its `listingUrl`, but the routes connect it to the list: the list names the home page, the home page names its `robots.txt`, the `robots.txt` names the sitemap, and the sitemap names `/startup-program/`. `/pricing` and `/blog/launch` have no route, because the crawl does not keep them.
