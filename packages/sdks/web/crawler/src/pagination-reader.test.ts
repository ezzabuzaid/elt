import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  ArchiveReader,
  type CrawlFailure,
  type CrawledPage,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

function pagination() {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new PaginationReader(),
  ]);
}

// Progress entries only mark URLs read for the readers; these tests assert pages and failures.
async function crawl(
  crawler: WebCrawler,
  start: string,
  signal: AbortSignal,
  include?: URLPattern[],
) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawler.run([start], { signal, include }))
    if (!('progress' in entry)) entries.push(entry);
  return entries;
}

function location(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  const { url, listingUrl, lastModified } = entry;
  return { url, lastModified, listingUrl };
}

test('a failing page of the pagination is handed out as a failure, and the pages listed before it are kept', async () => {
  // A declared next page that is gone is a failure too, unlike a listed page.
  for (const status of [500, 404]) {
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/category')
        response.end(
          '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
        );
      else if (request.url === '/category?page=2')
        response.writeHead(status).end();
      else response.end('<p>An item.</p>');
    });

    const entries = await crawl(
      pagination(),
      `${upstream.origin}/category`,
      AbortSignal.timeout(5000),
    );

    assert.deepEqual(
      entries.flatMap((entry) =>
        'error' in entry ? [{ url: entry.url, page: entry.page }] : [],
      ),
      [{ url: `${upstream.origin}/category?page=2`, page: false }],
      String(status),
    );
    assert.deepEqual(
      entries.filter((entry) => !('error' in entry)).map(location),
      [
        {
          url: `${upstream.origin}/item/1`,
          lastModified: null,
          listingUrl: `${upstream.origin}/category`,
        },
      ],
    );
  }
});

test('a listed page that is gone is skipped, not a failure', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<main><a href="/item/1">One</a><a href="/item/sold">Sold</a><a href="/item/removed">Removed</a></main>',
      );
    else if (request.url === '/item/sold') response.writeHead(404).end();
    else if (request.url === '/item/removed') response.writeHead(410).end();
    else response.end('<p>An item.</p>');
  });

  const entries = await crawl(
    pagination(),
    `${upstream.origin}/category`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(entries.map(location), [
    {
      url: `${upstream.origin}/item/1`,
      lastModified: null,
      listingUrl: `${upstream.origin}/category`,
    },
  ]);
  assert.ok(requests.includes('/item/sold'), requests.join(' '));
  assert.ok(requests.includes('/item/removed'), requests.join(' '));
});

test('a /sitemap.xml guess answered by a soft 404 page is not read as a list', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end('<main><a href="/news/1">News</a></main>');
    else if (request.url === '/robots.txt') response.writeHead(404).end();
    // The site's page template, answered with 200 for a missing sitemap.
    else if (request.url === '/sitemap.xml')
      response.end(
        '<main><h1>Page not found</h1><a href="/offers">Offers</a></main>',
      );
    else response.end('<p>A page.</p>');
  });

  const pages = await crawl(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new ListingReader(),
      new PaginationReader(),
    ]),
    `${upstream.origin}/`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/news/1`],
  );
  assert.ok(requests.includes('/sitemap.xml'), requests.join(' '));
  assert.ok(!requests.includes('/offers'), requests.join(' '));
});

test('an archive that ArchiveReader finds and that fits on one page hands back the posts it lists, whatever the order of the readers', async () => {
  // In the second order, PaginationReader finds /2024/ as a page before ArchiveReader finds it as a list.
  for (const readers of [
    [new ArchiveReader(), new PaginationReader()],
    [new PaginationReader(), new ArchiveReader()],
  ]) {
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/') response.end('<a href="/2024/">2024</a>');
      // A year archive without pagination.
      else if (request.url === '/2024/')
        response.end(
          '<main><a href="/posts/a">A</a><a href="/posts/b">B</a></main>',
        );
      else response.end('<p>A post.</p>');
    });

    const pages = await crawl(
      new WebCrawler(got.extend({ retry: { limit: 0 } }), readers),
      `${upstream.origin}/`,
      AbortSignal.timeout(5000),
      [new URLPattern({ pathname: '/posts/*' })],
    );

    assert.deepEqual(
      pages.map(location),
      ['/posts/a', '/posts/b'].map((path) => ({
        url: `${upstream.origin}${path}`,
        lastModified: null,
        listingUrl: `${upstream.origin}/2024/`,
      })),
      readers.map((reader) => reader.constructor.name).join(', '),
    );
  }
});

test('an archive that a later page of a list declares is no hop, so link limits count from the list', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
      );
    else if (request.url === '/category?page=2')
      response.end(
        '<head><link rel="archives" href="/2024/"></head><main><a href="/item/2">Two</a></main>',
      );
    // Only LinkReader reads links in navigation, and only on pages within its depth.
    else if (request.url === '/2024/')
      response.end(
        '<nav><a href="/about">About</a></nav><main><a href="/posts/a">A</a></main>',
      );
    else response.end('<p>A page.</p>');
  });

  const pages = await crawl(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new PaginationReader(),
      new ArchiveReader(),
      new LinkReader({ maxDepth: 0, maxPages: 100 }),
    ]),
    `${upstream.origin}/category`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(
    pages
      .map(location)
      .map((page) => page.url)
      .toSorted(),
    ['/about', '/item/1', '/item/2', '/posts/a'].map(
      (path) => `${upstream.origin}${path}`,
    ),
  );
});

test('pagination on a listed page is not followed, and neither are its other links', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<main><a href="/item/1">One</a><a href="/item/2">Two</a></main>',
      );
    else if (request.url === '/item/1') {
      // A listed page with pagination of its own, such as related ads or comments.
      response.setHeader('link', '</item/1/comments?page=2>; rel="next"');
      response.end(
        '<head><link rel="next" href="/related?page=2"></head><main><a rel="next" href="/item/1/photos/2">More photos</a><a href="/item/3">A related item</a></main>',
      );
    } else if (request.url === '/item/2') response.end('<p>An item.</p>');
    else response.end('<main><a href="/item/9">Another item</a></main>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/item/1`, `${upstream.origin}/item/2`],
  );
  assert.deepEqual(requests.toSorted(), ['/category', '/item/1', '/item/2']);
});

test('a crawl stopped inside the pagination and resumed from its snapshot reads the rest of the chain', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
      );
    else if (request.url === '/category?page=2')
      response.end(
        '<head><link rel="next" href="/category?page=3"></head><main><a href="/item/2">Two</a></main>',
      );
    else if (request.url === '/category?page=3')
      response.end('<main><a href="/item/3">Three</a></main>');
    else response.end('<p>An item.</p>');
  });
  const crawler = pagination();
  const first = crawler.run([`${upstream.origin}/category`], {
    signal: AbortSignal.timeout(5000),
  });
  for await (const entry of first) if (!('progress' in entry)) break;
  const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
  requests.length = 0;

  const resumed: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawler.resume(snapshot, {
    signal: AbortSignal.timeout(5000),
  }))
    if (!('progress' in entry)) resumed.push(entry);

  assert.deepEqual(
    resumed
      .map(location)
      .map((page) => page.url)
      .toSorted(),
    ['/item/1', '/item/2', '/item/3'].map(
      (path) => `${upstream.origin}${path}`,
    ),
  );
  assert.ok(!requests.includes('/category'), requests.join(' '));
});

test('the pagination of a starting page is read to its end, both ways, from link elements, anchors and HTTP Link headers', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    switch (request.url) {
      case '/category/2':
        response.end(
          '<head><link rel="prev" href="/category/1"></head><main><a href="/b">B</a><a rel="next" href="/category/3">Next</a></main>',
        );
        break;
      case '/category/1':
        response.end('<main><a href="/a">A</a></main>');
        break;
      case '/category/3':
        response.setHeader('link', '</category/4>; rel="next"');
        response.end('<main><a href="/c">C</a></main>');
        break;
      case '/category/4':
        response.end(
          '<main><a href="/d">D</a><a rel="prev" href="/category/3">Previous</a></main>',
        );
        break;
      default:
        response.end('<p>An item.</p>');
    }
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category/2`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      ['/a', '/category/1'],
      ['/b', '/category/2'],
      ['/c', '/category/3'],
      ['/d', '/category/4'],
    ].map(([path, listing]) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}${listing}`,
    })),
  );
});

test('a starting page without pagination hands back the pages it lists outside navigation', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<nav><a href="/about">About</a></nav><main><a href="/item/1">One</a><a href="/item/2">Two</a></main><footer><a href="/contact">Contact</a></footer>',
      );
    else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category`,
    AbortSignal.timeout(5000),
  );

  assert.deepEqual(
    pages.map(location),
    ['/item/1', '/item/2'].map((path) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}/category`,
    })),
  );
});
