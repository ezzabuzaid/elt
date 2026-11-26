import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Msw } from '@zukhruf/testing/msw';
import got from 'got';
import { type HttpHandler, HttpResponse, http } from 'msw';

import {
  AlwaysRevisit,
  type Crawl,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  type SavedCrawl,
  applySnapshot,
  hour,
} from './index.ts';
import { InstantClock } from './instant-clock.ts';

// Got retries no failure, so each visit is one answer.
const noRetries = got.extend({ retry: { limit: 0 } });

// A synthetic shop with no robots.txt, so the requests it gets are the crawl's.
function shop(...handlers: HttpHandler[]) {
  return new Msw().intercept(
    http.get('*/robots.txt', () => new HttpResponse(null, { status: 404 })),
    ...handlers,
  );
}

// One crawl to its end: the paths it handed out as gone and as failures, and
// what its host keeps after it, from what it kept before.
async function crawled(crawl: Crawl, before: SavedCrawl | null = null) {
  const gone: string[] = [];
  const failed: string[] = [];
  for await (const entry of crawl)
    if ('gone' in entry) gone.push(new URL(entry.gone.url).pathname);
    else if ('error' in entry) failed.push(new URL(entry.url).pathname);
  return {
    gone: gone.toSorted(),
    failed,
    failures: crawl.failures().map((url) => new URL(url).pathname),
    kept: applySnapshot(before, crawl.snapshot()),
  };
}

test('a page that the crawl would hand back and that answers 404 or 410 is handed out as gone, whether its finding tolerated the status or not, and is no failure', async (t) => {
  await using server = shop(
    http.get('https://shop.test/sitemap.xml', () =>
      HttpResponse.xml(
        '<urlset><url><loc>https://shop.test/p/1</loc></url></urlset>',
      ),
    ),
    // A sitemap's page tolerates no failure; a list's item tolerates 404 and 410.
    http.get(
      'https://shop.test/p/1',
      () => new HttpResponse(null, { status: 410 }),
    ),
    http.get('https://shop.test/list', () =>
      HttpResponse.html('<main><a href="/p/2">Two</a></main>'),
    ),
    http.get(
      'https://shop.test/p/2',
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
  const crawler = new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new ListingReader(), new PaginationReader()],
    new AlwaysRevisit(),
  );

  const result = await crawled(
    crawler.crawl(
      ['https://shop.test/sitemap.xml', 'https://shop.test/list'],
      null,
      { signal: t.signal },
    ),
  );

  assert.deepEqual(
    { gone: result.gone, failed: result.failed, failures: result.failures },
    { gone: ['/p/1', '/p/2'], failed: [], failures: [] },
  );
});

test("a page's third failed visit in a row is gone: the two visits before are failures, and the third hands it out as gone and takes it out of the failures", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = shop(
    http.get('https://shop.test/sitemap.xml', () =>
      HttpResponse.xml(
        '<urlset><url><loc>https://shop.test/p/1</loc></url></urlset>',
      ),
    ),
    http.get(
      'https://shop.test/p/1',
      () => new HttpResponse(null, { status: 503 }),
    ),
  );
  const crawler = new Origins(noRetries, null, new InstantClock(Date)).crawler(
    noRetries,
    [new ListingReader()],
    new AlwaysRevisit(),
  );
  const visits = [];
  let kept: SavedCrawl | null = null;
  for (const time of [0, 3 * hour, 6 * hour]) {
    t.mock.timers.setTime(time);
    const visit = await crawled(
      crawler.crawl(['https://shop.test/sitemap.xml'], kept, {
        signal: t.signal,
      }),
      kept,
    );
    kept = visit.kept;
    visits.push({
      gone: visit.gone,
      failed: visit.failed,
      failures: visit.failures,
    });
  }

  assert.deepEqual(visits, [
    { gone: [], failed: ['/p/1'], failures: ['/p/1'] },
    { gone: [], failed: ['/p/1'], failures: ['/p/1'] },
    { gone: ['/p/1'], failed: [], failures: [] },
  ]);
});

test('a gone page that answers again in a later crawl is handed back as a page', async (t) => {
  let status = 404;
  await using server = shop(
    http.get('https://shop.test/sitemap.xml', () =>
      HttpResponse.xml(
        '<urlset><url><loc>https://shop.test/p/1</loc></url></urlset>',
      ),
    ),
    http.get('https://shop.test/p/1', () =>
      status === 200
        ? HttpResponse.html('<p>Back.</p>')
        : new HttpResponse(null, { status }),
    ),
  );
  const crawler = new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new ListingReader()],
    new AlwaysRevisit(),
  );
  const gone = await crawled(
    crawler.crawl(['https://shop.test/sitemap.xml'], null, {
      signal: t.signal,
    }),
  );
  status = 200;

  const handed: string[] = [];
  for await (const entry of crawler.crawl(
    ['https://shop.test/sitemap.xml'],
    gone.kept,
    { signal: t.signal },
  ))
    if ('response' in entry) handed.push(new URL(entry.url).pathname);

  assert.deepEqual(
    { gone: gone.gone, handed },
    { gone: ['/p/1'], handed: ['/p/1'] },
  );
});

test('a URL that answers 404 and that the crawl would not hand back is not handed out as gone', async (t) => {
  await using server = shop(
    http.get('https://shop.test/', () =>
      HttpResponse.html('<a href="/p/1">One</a><a href="/about">About</a>'),
    ),
    http.get(
      'https://shop.test/*',
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
  const crawler = new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new LinkReader({ maxDepth: 1, maxPages: 100 })],
    new AlwaysRevisit(),
  );

  const result = await crawled(
    crawler.crawl(['https://shop.test/'], null, {
      signal: t.signal,
      include: [new URLPattern({ pathname: '/p/*' })],
    }),
  );

  assert.deepEqual(result.gone, ['/p/1']);
});

test("a gone page whose finding tolerates its status is read by the readers, and its gone entry carries that read's routes, so a routes stream learns that it names nothing", async (t) => {
  await using server = shop(
    http.get('https://shop.test/', () =>
      HttpResponse.html('<a href="/p/1">One</a>'),
    ),
    // A shop's 404 page, with a link of its own.
    http.get(
      'https://shop.test/p/1',
      () =>
        new HttpResponse('<a href="/p/2">Two</a>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  const crawler = new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new LinkReader({ maxDepth: 2, maxPages: 100 })],
    new AlwaysRevisit(),
  );

  const routes = [];
  for await (const entry of crawler.crawl(['https://shop.test/'], null, {
    signal: t.signal,
  }))
    if ('gone' in entry) routes.push(...entry.routes);

  assert.deepEqual(routes, [
    // LinkReader read the 404 page and named nothing in it.
    { listingUrl: 'https://shop.test/p/1', readers: [[]], redirect: null },
  ]);
});
