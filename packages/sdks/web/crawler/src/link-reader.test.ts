import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  ArchiveReader,
  type Crawl,
  type CrawlFailure,
  type CrawledPage,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

// Synthetic upstream sites make link graphs reproducible offline.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

function pathOf(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  return new URL(entry.url).pathname;
}

// Progress entries only mark URLs read for the readers; these tests assert pages and failures.
async function results(crawl: Crawl) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawl)
    if (!('progress' in entry)) entries.push(entry);
  return entries;
}

test('depth and page limits bound which pages contribute links, while every found page is handed back', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html('<a href="/a">A</a><a href="/b">B</a>');
      return HttpResponse.html(`<a href="${path}/child">Child</a>`);
    }),
  );
  for (const [limits, paths] of [
    [{ maxDepth: 0, maxPages: 100 }, ['/a', '/b']],
    [{ maxDepth: 3, maxPages: 0 }, ['/a', '/b']],
    [{ maxDepth: 3, maxPages: 1 }, ['/a', '/b', '/a/child']],
    [{ maxDepth: 1, maxPages: 100 }, ['/a', '/b', '/a/child', '/b/child']],
  ] satisfies [{ maxDepth: number; maxPages: number }, string[]][]) {
    requests.length = 0;
    const pages = await results(
      new WebCrawler(got, [new LinkReader(limits)]).run(
        ['https://site.test/'],
        {
          signal: AbortSignal.timeout(5000),
        },
      ),
    );
    assert.deepEqual(pages.map(pathOf), paths, JSON.stringify(limits));
    assert.deepEqual(requests, ['/', ...paths], JSON.stringify(limits));
  }
});

test('invalid link limits fail on construction', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new LinkReader({ maxDepth: value, maxPages: 1 }),
      RangeError,
    );
    assert.throws(
      () => new LinkReader({ maxDepth: 1, maxPages: value }),
      RangeError,
    );
  }
});

test('Markdown pages contribute their links on the starting origin', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const markdown = (body: string) =>
        new HttpResponse(body, {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        });
      if (path === '/')
        return markdown(
          '# Docs\n\n[Guide](/guide.md) and [Elsewhere](https://other.test/x)\n',
        );
      if (path === '/guide.md')
        return markdown('See [the deeper page](deeper.md).\n');
      return markdown('# Deeper\n');
    }),
  );
  const pages = await results(
    new WebCrawler(got, [new LinkReader({ maxDepth: 2, maxPages: 100 })]).run(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(pages.map(pathOf), ['/guide.md', '/deeper.md']);
  assert.deepEqual(requests, ['/', '/guide.md', '/deeper.md']);
});

test('feed-only starts do not turn their articles into new link roots', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    if (request.url === '/feed')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/unrelated">More</a>');
  });
  const pages = await results(
    new WebCrawler(got, [
      new ListingReader(),
      new ArchiveReader(),
      new PaginationReader(),
      new LinkReader({ maxDepth: 3, maxPages: 100 }),
    ]).run([`${upstream.origin}/feed`], { signal: AbortSignal.timeout(5000) }),
  );
  assert.deepEqual(pages.map(pathOf), ['/article']);
  assert.deepEqual(requests, ['/feed', '/article']);
});

test('archive pages contribute their links, and declarations with non-HTTP URLs are ignored', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/archive/">Archive</a>');
    else if (request.url === '/archive/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="sitemap" href="ftp://example.test/map"><a href="/article">Article</a>',
        );
    else if (request.url === '/article')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<p>An article.</p>');
    else response.writeHead(404).end();
  });
  const pages = await results(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new ListingReader(),
      new ArchiveReader(),
      new PaginationReader(),
      new LinkReader({ maxDepth: 3, maxPages: 100 }),
    ]).run([upstream.origin], { signal: AbortSignal.timeout(5000) }),
  );
  assert.deepEqual(pages.map(pathOf), ['/archive/', '/article']);
});
