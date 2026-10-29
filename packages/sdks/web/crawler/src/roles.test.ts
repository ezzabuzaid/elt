import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  ArchiveReader,
  type Crawl,
  type CrawlFailure,
  type CrawlMemento,
  type CrawledPage,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

// Synthetic upstream sites make the order of findings reproducible offline.
// They have no robots.txt, so the requests they record are the crawl's pages and listings.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(
    http.get('*/robots.txt', () => new HttpResponse(null, { status: 404 })),
    ...handlers,
  );
  server.listen({ onUnhandledFrame: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

function pathOf(url: string) {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

function location(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  const { url, listingUrl, lastModified } = entry;
  return { url: pathOf(url), listingUrl: pathOf(listingUrl), lastModified };
}

async function pages(crawl: Crawl) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawl)
    if (!('progress' in entry) && !('deferred' in entry)) entries.push(entry);
  return entries.map(location);
}

// A blog whose feed names /2026/ as an item, and whose post links /2026/ as an archive.
function blog(requests: string[]) {
  return http.get('https://site.test/*', ({ request }) => {
    const path = pathOf(request.url);
    requests.push(path);
    if (path === '/')
      return HttpResponse.html(
        '<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>',
      );
    if (path === '/feed.xml')
      return new HttpResponse(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>https://site.test/</link><description>Posts</description>
        <item><title>2026</title><link>https://site.test/2026/</link></item>
        <item><title>A</title><link>https://site.test/post/a</link></item>
        </channel></rss>`,
        { headers: { 'content-type': 'application/rss+xml' } },
      );
    if (path === '/2026/')
      return HttpResponse.html(
        '<main><a href="/2026/first-post">First post</a></main>',
      );
    if (path === '/post/a')
      return HttpResponse.html('<p>A post.</p><a href="/2026/">2026</a>');
    if (path === '/2026/first-post') return HttpResponse.html('<p>First.</p>');
    return new HttpResponse(null, { status: 404 });
  });
}

function blogCrawler() {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new ListingReader(),
    new ArchiveReader(),
    new PaginationReader(),
  ]);
}

test('a starting page that its sitemap lists as a page is handed back once, with the sitemap provenance', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/') return HttpResponse.html('<p>Home</p>');
      if (path === '/sitemap.xml')
        return HttpResponse.xml(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://site.test/</loc><lastmod>2026-10-01</lastmod></url>
          <url><loc>https://site.test/about</loc></url>
          </urlset>`,
        );
      if (path === '/about') return HttpResponse.html('<p>About</p>');
      return new HttpResponse(null, { status: 404 });
    }),
  );

  const handed = await pages(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new ListingReader(),
    ]).crawl(['https://site.test/'], null, {
      signal: AbortSignal.timeout(5000),
    }),
  );

  assert.deepEqual(handed, [
    { url: '/', listingUrl: '/sitemap.xml', lastModified: '2026-10-01' },
    { url: '/about', listingUrl: '/sitemap.xml', lastModified: null },
  ]);
  assert.deepEqual(
    requests.filter((path) => path === '/'),
    ['/', '/'],
  );
});

test('a feed item that is also an archive is read as a list, and handed back as a page once', async () => {
  const requests: string[] = [];
  using server = mockWeb(blog(requests));

  const handed = await pages(
    blogCrawler().crawl(['https://site.test/'], null, {
      signal: AbortSignal.timeout(5000),
    }),
  );

  assert.deepEqual(handed, [
    { url: '/2026/', listingUrl: '/feed.xml', lastModified: null },
    { url: '/post/a', listingUrl: '/feed.xml', lastModified: null },
    { url: '/2026/first-post', listingUrl: '/2026/', lastModified: null },
  ]);
  assert.deepEqual(
    requests.filter((path) => path === '/2026/'),
    ['/2026/', '/2026/'],
  );
});

test('a crawl resumed from a snapshot does not hand back a page again when it reads that page for another role', async () => {
  const requests: string[] = [];
  using server = mockWeb(blog(requests));
  const crawler = blogCrawler();
  const signal = AbortSignal.timeout(5000);
  const first = crawler.crawl(['https://site.test/'], null, { signal });
  const before: string[] = [];
  let snapshot;
  for await (const entry of first) {
    // The entry after /2026/'s hand-back: /2026/ is finished, so the snapshot keeps it as handed back.
    if (before.includes('/2026/')) {
      snapshot = first.snapshot();
      break;
    }
    if ('url' in entry && !('error' in entry)) before.push(pathOf(entry.url));
  }
  assert.deepEqual(before, ['/2026/']);

  const resumed = await pages(crawler.crawl([], snapshot, { signal }));

  assert.deepEqual(
    resumed.map(({ url }) => url),
    ['/post/a', '/2026/first-post'],
  );
});

test('a URL downloaded again for a role it adds is not admitted again, so it spends no reader budget twice', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html('<a href="/x">X</a><a href="/b">B</a>');
      if (path === '/b')
        return HttpResponse.html('<link rel="archives" href="/x"><p>B</p>');
      return HttpResponse.html('<p>X</p>');
    }),
  );
  const crawl = new WebCrawler(got, [
    new LinkReader({ maxDepth: 1, maxPages: 100 }),
    new ArchiveReader(),
  ]).crawl(['https://site.test/'], null, {
    signal: AbortSignal.timeout(5000),
  });
  let last: CrawlMemento | undefined;
  for await (const entry of crawl)
    if (!('deferred' in entry)) last = crawl.snapshot();

  // /x is downloaded again as an archive list, but LinkReader admitted only /x and /b.
  assert.deepEqual(requests, ['/', '/x', '/b', '/x']);
  assert.deepEqual(last?.crawl?.states[0], {
    origins: ['https://site.test'],
    followed: 2,
  });
});
