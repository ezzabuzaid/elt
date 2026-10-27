import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  type Crawl,
  type CrawlMemento,
  LinkReader,
  ListingReader,
  WebCrawler,
  hour,
} from './index.ts';

// Synthetic upstream sites make a block reproducible offline.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledFrame: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

// The host and path of a URL, so requests to two origins read apart.
function where(url: string) {
  const { host, pathname } = new URL(url);
  return host + pathname;
}

// A sitemap on site.test lists /a, /b and /c, and one on other.test lists /x.
// The blocked path answers with the block; every other page is an article.
function sites(
  requests: string[],
  block: { path: string; status: number; headers?: Record<string, string> },
) {
  return http.get('https://*.test/*', ({ request }) => {
    const at = where(request.url);
    requests.push(at);
    const { origin, pathname } = new URL(request.url);
    if (pathname === '/sitemap.xml')
      return HttpResponse.xml(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${(origin === 'https://site.test' ? ['/a', '/b', '/c'] : ['/x']).map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`,
      );
    if (at === block.path)
      return new HttpResponse(null, {
        status: block.status,
        headers: block.headers,
      });
    return HttpResponse.html(`<p>${pathname}</p>`);
  });
}

const starts = [
  'https://site.test/sitemap.xml',
  'https://other.test/sitemap.xml',
];

function crawler() {
  // No retries, so Got does not wait out the Retry-After itself.
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new ListingReader(),
  ]);
}

// One crawl to its end: what it handed out by kind, when it is due, and its memento.
async function crawled(crawl: Crawl) {
  const pages: string[] = [];
  const deferred: string[] = [];
  const failures: { url: string; message: string }[] = [];
  for await (const entry of crawl)
    if ('response' in entry) pages.push(where(entry.url));
    else if ('deferred' in entry) deferred.push(where(entry.deferred.url));
    else if ('error' in entry)
      failures.push({ url: where(entry.url), message: entry.error.message });
  // As JSON gives it back, so the memento is plain data.
  const memento: CrawlMemento = JSON.parse(JSON.stringify(crawl.snapshot()));
  return { pages, deferred, failures, nextDue: crawl.nextDue(), memento };
}

const options = () => ({ signal: AbortSignal.timeout(5000) });

test('a 429 with Retry-After stops requests to its origin, reports the block once and makes the crawl due when the block ends', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    sites(requests, {
      path: 'site.test/b',
      status: 429,
      headers: { 'retry-after': '120' },
    }),
  );

  const first = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(
    requests.filter((at) => !at.endsWith('/sitemap.xml')),
    ['site.test/a', 'site.test/b', 'other.test/x'],
  );
  assert.deepEqual(first.pages, ['site.test/a', 'other.test/x']);
  assert.equal(first.failures.length, 1);
  assert.equal(first.failures[0]?.url, 'site.test/b');
  assert.match(
    first.failures[0]?.message ?? '',
    /https:\/\/site\.test.*429.*1970-01-01T00:02:00\.000Z/,
  );
  assert.deepEqual(first.deferred, []);
  assert.equal(first.nextDue, 120_000);
  assert.notEqual(first.memento.crawl, null);
  assert.deepEqual(
    first.memento.crawl?.pending.map(({ url }) => where(url)).sort(),
    ['site.test/b', 'site.test/c'],
  );
});

test('a crawl resumed before its block ends requests nothing there, and one resumed after requests the rest and completes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  let blocking = true;
  using server = mockWeb(
    http.get('https://site.test/b', ({ request }) => {
      if (!blocking) return undefined;
      requests.push(where(request.url));
      return new HttpResponse(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    }),
    sites(requests, { path: '', status: 200 }),
  );
  const site = crawler();
  const first = await crawled(site.crawl(starts, null, options()));
  t.mock.timers.setTime(60_000);
  requests.length = 0;

  const early = await crawled(site.crawl(starts, first.memento, options()));
  const earlyRequests = requests.splice(0);
  t.mock.timers.setTime(120_000);
  blocking = false;
  const late = await crawled(site.crawl(starts, early.memento, options()));

  assert.deepEqual(earlyRequests, []);
  assert.deepEqual(early.failures, []);
  assert.equal(early.nextDue, 120_000);
  assert.notEqual(early.memento.crawl, null);
  assert.deepEqual(requests, ['site.test/b', 'site.test/c']);
  assert.deepEqual(late.pages, ['site.test/b', 'site.test/c']);
  assert.deepEqual(late.failures, []);
  assert.equal(late.memento.crawl, null);
});

test('three 403s in a row without Retry-After block their origin for an hour', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/sitemap.xml')
        return HttpResponse.xml(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/a', '/b', '/c', '/d'].map((path) => `<url><loc>https://site.test${path}</loc></url>`).join('')}</urlset>`,
        );
      return new HttpResponse(null, { status: 403 });
    }),
  );

  const first = await crawled(
    crawler().crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(requests, ['/sitemap.xml', '/a', '/b', '/c']);
  assert.equal(first.failures.length, 3);
  assert.match(
    first.failures[2]?.message ?? '',
    /https:\/\/site\.test.*403.*1970-01-01T01:00:00\.000Z/,
  );
  assert.equal(first.nextDue, hour);
});

test('a single 403 is a failure of its page, not a block, so the rest of its origin still downloads', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(sites(requests, { path: 'site.test/a', status: 403 }));

  const first = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(
    requests.filter((at) => !at.endsWith('/sitemap.xml')),
    ['site.test/a', 'site.test/b', 'site.test/c', 'other.test/x'],
  );
  assert.equal(first.failures.length, 1);
  assert.doesNotMatch(
    first.failures[0]?.message ?? '',
    /requests nothing there/,
  );
  assert.equal(first.memento.crawl, null);
});

test('a 429 with an HTTP-date Retry-After blocks its origin until that date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    sites(requests, {
      path: 'site.test/a',
      status: 429,
      headers: { 'retry-after': new Date(300_000).toUTCString() },
    }),
  );

  const first = await crawled(crawler().crawl(starts, null, options()));

  assert.equal(first.nextDue, 300_000);
  assert.deepEqual(
    requests.filter((at) => !at.endsWith('/sitemap.xml')),
    ['site.test/a', 'other.test/x'],
  );
});

test('a block reached through a redirect also stops requests to the origin that redirected', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    http.get('http://site.test/*', ({ request }) => {
      requests.push(request.url);
      const { pathname } = new URL(request.url);
      if (pathname === '/sitemap.xml')
        return HttpResponse.xml(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/a', '/b'].map((path) => `<url><loc>http://site.test${path}</loc></url>`).join('')}</urlset>`,
        );
      return new HttpResponse(null, {
        status: 301,
        headers: { location: `https://site.test${pathname}` },
      });
    }),
    http.get('https://site.test/*', ({ request }) => {
      requests.push(request.url);
      return new HttpResponse(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    }),
  );

  const first = await crawled(
    crawler().crawl(['http://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(requests, [
    'http://site.test/sitemap.xml',
    'http://site.test/a',
    'https://site.test/a',
  ]);
  assert.equal(first.failures.length, 1);
  assert.match(
    first.failures[0]?.message ?? '',
    /https:\/\/site\.test answered 429/,
  );
});

test('a tolerated 404 opens no breaker, so the rest of its origin still downloads', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(where(request.url));
      const { pathname } = new URL(request.url);
      if (pathname === '/')
        return HttpResponse.html(
          '<a href="/gone">Gone</a><a href="/b">B</a><a href="/after">After</a>',
        );
      if (pathname === '/gone') return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Page</p>');
    }),
  );

  const first = await crawled(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new LinkReader({ maxDepth: 1, maxPages: 100 }),
    ]).crawl(['https://site.test/'], null, options()),
  );

  assert.deepEqual(requests, [
    'site.test/',
    'site.test/gone',
    'site.test/b',
    'site.test/after',
  ]);
  assert.deepEqual(first.failures, []);
  assert.equal(first.memento.crawl, null);
});
