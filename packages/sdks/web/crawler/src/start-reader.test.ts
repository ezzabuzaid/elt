import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  type Crawl,
  type CrawlFailure,
  type CrawledPage,
  StartReader,
  WebCrawler,
} from './index.ts';

// Synthetic upstream sites make the requests reproducible offline. They have
// no robots.txt, so the requests they record are the crawl's own downloads.
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

async function pages(crawl: Crawl) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawl)
    if (!('progress' in entry) && !('deferred' in entry)) entries.push(entry);
  return entries.map((entry) => {
    if ('error' in entry) throw entry.error;
    return { url: pathOf(entry.url), listingUrl: pathOf(entry.listingUrl) };
  });
}

// A home page whose menu links every category, as a marketplace's does.
function marketplace(requests: string[]) {
  return http.get('https://site.test/*', ({ request }) => {
    const path = pathOf(request.url);
    requests.push(path);
    if (path === '/en')
      return HttpResponse.html(
        '<nav><a href="/en/cars">Cars</a></nav><main><a href="/en/cars/motorcycles">Motorcycles</a><a href="/en/property">Property</a></main>',
      );
    if (path === '/ar')
      return HttpResponse.html('<main><a href="/ar/cars">سيارات</a></main>');
    return HttpResponse.html('<p>A category.</p>');
  });
}

test('a crawl that only reads its starting pages requests none of the pages they link', async () => {
  const requests: string[] = [];
  using server = mockWeb(marketplace(requests));

  const handed = await pages(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new StartReader(),
    ]).crawl(['https://site.test/en'], null, {
      signal: AbortSignal.timeout(5000),
    }),
  );

  assert.deepEqual(
    handed.map(({ url }) => url),
    ['/en'],
  );
  assert.deepEqual(
    requests.filter((path) => path !== '/en'),
    [],
  );
});

test('each starting page is handed back as a page of its own provenance', async () => {
  const requests: string[] = [];
  using server = mockWeb(marketplace(requests));

  const handed = await pages(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new StartReader(),
    ]).crawl(['https://site.test/en', 'https://site.test/ar'], null, {
      signal: AbortSignal.timeout(5000),
    }),
  );

  assert.deepEqual(
    handed.toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      { url: '/ar', listingUrl: '/ar' },
      { url: '/en', listingUrl: '/en' },
    ],
  );
});
