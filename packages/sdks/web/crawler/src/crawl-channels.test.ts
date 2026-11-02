import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Msw } from '@zukhruf/testing/msw';
import got from 'got';
import { HttpResponse, http } from 'msw';

import {
  AdaptiveRevisit,
  CrawlEnded,
  CrawlHandedOff,
  CrawlRequested,
  CrawlStarted,
  ListingReader,
  OriginBlocked,
  Origins,
  crawlChannels,
} from './index.ts';

// Synthetic upstream sites make what a crawl publishes reproducible offline.

// What the crawl channels publish while the returned object is in scope;
// tests of one file run one at a time.
function listen() {
  const heard: unknown[] = [];
  const hear = (message: unknown) => heard.push(message);
  const channels = Object.values(crawlChannels);
  for (const channel of channels) channel.subscribe(hear);
  return {
    heard,
    [Symbol.dispose]() {
      for (const channel of channels) channel.unsubscribe(hear);
    },
  };
}

// A site whose robots.txt names its sitemap, which lists /a and /b.
const site = (page: (path: string) => Response | undefined = () => undefined) =>
  http.get('https://site.test/*', ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/robots.txt')
      return HttpResponse.text(
        'User-agent: *\nSitemap: https://site.test/sitemap.xml\n',
      );
    if (pathname === '/sitemap.xml')
      return HttpResponse.xml(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/a', '/b'].map((path) => `<url><loc>https://site.test${path}</loc></url>`).join('')}</urlset>`,
      );
    return page(pathname) ?? HttpResponse.html(`<p>${pathname}</p>`);
  });

function crawler() {
  const http = got.extend({ retry: { limit: 0 } });
  return new Origins(http, null).crawler(
    http,
    [new ListingReader()],
    new AdaptiveRevisit(),
  );
}

const options = () => ({ signal: AbortSignal.timeout(120_000) });

test('a crawl publishes its start, each URL it requested with its lane, roles and listing, and its end', async () => {
  using server = new Msw().intercept(site());
  using listened = listen();

  for await (const _ of crawler().crawl(
    ['https://site.test/'],
    null,
    options(),
  ));

  const [started] = listened.heard;
  assert.ok(started instanceof CrawlStarted);
  assert.deepEqual(started.starts, ['https://site.test/']);
  assert.equal(started.resumed, false);
  assert.deepEqual(
    listened.heard.flatMap((message) =>
      message instanceof CrawlRequested
        ? [
            [
              new URL(message.url).pathname,
              message.lane,
              message.document,
              message.page,
              new URL(message.listingUrl).pathname,
              message.served,
              'status' in message.outcome ? message.outcome.status : null,
            ],
          ]
        : [],
    ),
    [
      ['/', 'listing', true, false, '/', 'network', 200],
      ['/robots.txt', 'listing', true, false, '/', 'origin record', 200],
      ['/sitemap.xml', 'listing', true, false, '/robots.txt', 'network', 200],
      ['/a', 'page', false, true, '/sitemap.xml', 'network', 200],
      ['/b', 'page', false, true, '/sitemap.xml', 'network', 200],
    ],
  );
  const ended = listened.heard.at(-1);
  assert.ok(ended instanceof CrawlEnded);
  assert.equal(ended.complete, true);
});

test("a request publishes how long the crawl waited for its origin's delay", async () => {
  using server = new Msw().intercept(site());
  using listened = listen();

  for await (const _ of crawler().crawl(
    ['https://site.test/'],
    null,
    options(),
  ));

  const waits = listened.heard.flatMap((message) =>
    message instanceof CrawlRequested && message.served === 'network'
      ? [message.waited]
      : [],
  );
  // Each request waits out the origin's one-second delay from the start of
  // the request before it, the first one from the origin record's robots.txt
  // request; what that request took comes off the wait.
  assert.equal(waits.length, 4);
  assert.ok(
    waits.every((waited) => waited > 500 && waited < 1100),
    waits.join(' '),
  );
});

test("a crawl publishes its consumer's time with each entry as the entry's hand-off", async () => {
  using server = new Msw().intercept(site());
  using listened = listen();

  for await (const entry of crawler().crawl(
    ['https://site.test/'],
    null,
    options(),
  ))
    if ('response' in entry && entry.url === 'https://site.test/a')
      await sleep(200);

  const handOffs = listened.heard.flatMap((message) =>
    message instanceof CrawlHandedOff && message.kind === 'page'
      ? [[new URL(message.url).pathname, message.duration] as const]
      : [],
  );
  assert.deepEqual(
    handOffs.map(([path]) => path),
    ['/a', '/b'],
  );
  assert.ok((handOffs[0]?.[1] ?? 0) >= 190, String(handOffs[0]?.[1]));
  assert.ok((handOffs[1]?.[1] ?? Infinity) < 100, String(handOffs[1]?.[1]));
});

test('an origin that answers 429 publishes its block until its Retry-After', async () => {
  using server = new Msw().intercept(
    site((path) =>
      path === '/a'
        ? new HttpResponse(null, {
            status: 429,
            headers: { 'retry-after': '120' },
          })
        : undefined,
    ),
  );
  using listened = listen();
  const before = Date.now();

  for await (const _ of crawler().crawl(
    ['https://site.test/'],
    null,
    options(),
  ));

  const blocks = listened.heard.filter(
    (message) => message instanceof OriginBlocked,
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.origin, 'https://site.test');
  assert.ok((blocks[0]?.until ?? 0) >= before + 119_000);
});

test('a request that gets no answer publishes its error', async () => {
  using server = new Msw().intercept(
    site((path) => (path === '/b' ? HttpResponse.error() : undefined)),
  );
  using listened = listen();

  for await (const _ of crawler().crawl(
    ['https://site.test/'],
    null,
    options(),
  ));

  const failed = listened.heard.flatMap((message) =>
    message instanceof CrawlRequested && 'error' in message.outcome
      ? [new URL(message.url).pathname]
      : [],
  );
  assert.deepEqual(failed, ['/b']);
});
