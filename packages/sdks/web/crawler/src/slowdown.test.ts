import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  type Crawl,
  type CrawlMemento,
  ListingReader,
  WebCrawler,
} from './index.ts';

// Synthetic upstream sites make refusals reproducible offline.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledFrame: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

// A sitemap that names these pages of its origin.
function sitemap(origin: string, paths: readonly string[]) {
  return HttpResponse.xml(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map((path) => `<url><loc>${origin}${path}</loc></url>`)
      .join('')}</urlset>`,
  );
}

// No retries unless a test names them, so Got neither hides a refusal nor waits out a Retry-After.
function crawler(retries = 0) {
  return new WebCrawler(got.extend({ retry: { limit: retries } }), [
    new ListingReader(),
  ]);
}

// One crawl to its end, and its memento as JSON gives it back.
async function crawled(crawl: Crawl) {
  for await (const entry of crawl) void entry;
  const memento: CrawlMemento = JSON.parse(JSON.stringify(crawl.snapshot()));
  return memento;
}

// The gaps between request starts, in milliseconds, as the server saw them.
function gaps(started: readonly number[]) {
  return started.slice(1).map((at, index) => at - (started[index] ?? at));
}

const options = () => ({ signal: AbortSignal.timeout(15_000) });

test('cancelling a crawl while it waits out a slowdown rejects at once with the signal reason', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b']);
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      if (pathname === '/b') return HttpResponse.html('<p>B</p>');
      return new HttpResponse(null, { status: 404 });
    }),
  );
  const controller = new AbortController();
  const reason = new Error('The user stopped the crawl');
  const crawl = crawler().crawl(['https://site.test/sitemap.xml'], null, {
    signal: controller.signal,
  });
  let abortedAt = 0;

  await assert.rejects(
    async () => {
      for await (const entry of crawl)
        if ('error' in entry)
          setTimeout(() => {
            abortedAt = performance.now();
            controller.abort(reason);
          }, 200);
    },
    (error) => error === reason,
  );

  const stoppedAfter = performance.now() - abortedAt;
  assert.ok(
    stoppedAfter < 250,
    `the crawl stopped ${stoppedAfter} ms after the abort`,
  );
  assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a']);
});

test('a refusal slows the requests to its own origin and not to another origin', async () => {
  const started = new Map<string, number[]>();
  using server = mockWeb(
    http.get('https://:host/*', ({ request }) => {
      const { origin, pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap(
          origin,
          origin === 'https://site.test' ? ['/a', '/b'] : ['/x', '/y'],
        );
      started.set(origin, [...(started.get(origin) ?? []), performance.now()]);
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    crawler().crawl(
      ['https://site.test/sitemap.xml', 'https://other.test/sitemap.xml'],
      null,
      options(),
    ),
  );

  const [site = 0] = gaps(started.get('https://site.test') ?? []);
  const [other = Infinity] = gaps(started.get('https://other.test') ?? []);
  assert.ok(site >= 990, `site.test pages started ${site} ms apart`);
  assert.ok(other < 500, `other.test pages started ${other} ms apart`);
});

test('after a 429 block ends, the next crawl spaces its requests to that origin', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let blocking = true;
  const started: { path: string; at: number }[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b']);
      if (pathname === '/a' && blocking)
        return new HttpResponse(null, {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );
  const crawl = crawler();
  const blocked = await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  blocking = false;
  started.length = 0;
  t.mock.timers.setTime(61_000);

  await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], blocked, options()),
  );

  assert.deepEqual(
    started.map(({ path }) => path),
    ['/robots.txt', '/a', '/b'],
  );
  const [first = 0, second = 0] = gaps(started.map(({ at }) => at));
  // The block left a slowdown of one second; each answer since, robots.txt first, shortened it by a tenth.
  assert.ok(first >= 880 && first < 1000, `/a waited ${first} ms`);
  assert.ok(second >= 790 && second < 900, `/b waited ${second} ms`);
});

test('each 5xx answer slows the next request to its origin by one second', async () => {
  const statuses = [500, 501, 503, 504, 599];
  const started = new Map<string, number[]>();
  using server = mockWeb(
    http.get('https://:host/*', ({ request }) => {
      const { host, origin, pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml') return sitemap(origin, ['/a', '/b']);
      started.set(host, [...(started.get(host) ?? []), performance.now()]);
      if (pathname === '/a')
        return new HttpResponse(null, {
          status: Number.parseInt(host.slice(1)),
        });
      return HttpResponse.html('<p>B</p>');
    }),
  );

  await crawled(
    crawler().crawl(
      statuses.map((status) => `https://s${status}.test/sitemap.xml`),
      null,
      options(),
    ),
  );

  for (const status of statuses) {
    const [gap = 0] = gaps(started.get(`s${status}.test`) ?? []);
    assert.ok(
      gap >= 990 && gap < 1500,
      `after a ${status}, /b waited ${gap} ms`,
    );
  }
});

test('a 503 that Got retried away still slows the origin', async () => {
  let refusals = 1;
  const started: { path: string; at: number }[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b', '/c']);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/a' && refusals-- > 0)
        return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    crawler(1).crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(
    started.map(({ path }) => path),
    ['/a', '/a', '/b', '/c'],
  );
  // Got's own wait before its retry covers the first second; /b shortened the slowdown to 900 ms.
  const [, , last = 0] = gaps(started.map(({ at }) => at));
  assert.ok(last >= 880 && last < 1000, `/c waited ${last} ms`);
});

test('each further refusal doubles the wait', async () => {
  const started: number[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b', '/c', '/d']);
      started.push(performance.now());
      if (pathname === '/d') return HttpResponse.html('<p>D</p>');
      return new HttpResponse(null, { status: 503 });
    }),
  );

  await crawled(
    crawler().crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  // 1 s, 2 s, then 4 s: a wait that grew by one second each time would give 3 s for the last.
  const [first = 0, second = 0, third = 0] = gaps(started);
  assert.ok(first >= 990 && first < 1500, `/b waited ${first} ms`);
  assert.ok(second >= 1990 && second < 2500, `/c waited ${second} ms`);
  assert.ok(third >= 3990 && third < 4500, `/d waited ${third} ms`);
});

test('answers that are not refusals shorten the wait step by step, until the slowdown ends', async () => {
  const pages = [
    '/a',
    ...Array.from({ length: 22 }, (_, index) => `/${index + 1}`),
  ];
  const started: number[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', pages);
      started.push(performance.now());
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  const memento = await crawled(
    crawler().crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  // One second after the refusal, then a tenth shorter after each page.
  const waits = gaps(started);
  assert.equal(waits.length, 22);
  for (const [index, wait] of waits.entries()) {
    const expected = 1000 * 0.9 ** index;
    assert.ok(
      wait >= expected - 25 && wait < expected + 45,
      `page ${index + 1} waited ${wait} ms, not about ${Math.round(expected)} ms`,
    );
  }
  // The 22nd page shortened the slowdown under 100 ms, so it ended: no wait shows that, so this reads the memento.
  assert.deepEqual(memento.slowdowns, {});
});

// A crawl of site.test whose page /a answers 503 and whose other pages answer, then a second crawl from its memento.
async function crawlAgain(pages: readonly string[]) {
  const started: { path: string; at: number }[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', pages);
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );
  const crawl = crawler();
  const first = await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  started.length = 0;
  await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], first, options()),
  );
  return { complete: first.crawl === null, started };
}

test('a slowdown carries over to the next crawl after a complete crawl', async () => {
  const { complete, started } = await crawlAgain(['/a']);

  assert.equal(complete, true);
  assert.deepEqual(
    started.map(({ path }) => path),
    ['/robots.txt', '/sitemap.xml'],
  );
  // The refusal left one second; the robots.txt answer of the next crawl shortened it by a tenth.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 880 && wait < 1000, `the sitemap waited ${wait} ms`);
});

test('the next crawl starts from the shortened slowdown, not from its peak', async () => {
  const { complete, started } = await crawlAgain([
    '/a',
    '/1',
    '/2',
    '/3',
    '/4',
    '/5',
  ]);

  assert.equal(complete, true);
  assert.deepEqual(
    started.map(({ path }) => path),
    ['/robots.txt', '/sitemap.xml'],
  );
  // One second after the refusal, a tenth shorter after each of the five pages and the next robots.txt: 1000 × 0.9⁶.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 510 && wait < 570, `the sitemap waited ${wait} ms`);
});

test('beside a Crawl-delay, the longer wait wins and the two do not add up', async () => {
  // site.test asks for 2 s and refuses once; other.test asks for 1 s and refuses twice.
  const refusals = new Map([
    ['site.test', ['/a']],
    ['other.test', ['/a', '/b']],
  ]);
  const started = new Map<string, number[]>();
  using server = mockWeb(
    http.get('https://:host/*', ({ request }) => {
      const { host, origin, pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return HttpResponse.text(
          `User-agent: *\nCrawl-delay: ${host === 'site.test' ? 2 : 1}\n`,
        );
      if (pathname === '/sitemap.xml')
        return sitemap(
          origin,
          host === 'site.test' ? ['/a', '/b'] : ['/a', '/b', '/c'],
        );
      started.set(host, [...(started.get(host) ?? []), performance.now()]);
      if (refusals.get(host)?.includes(pathname))
        return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  for (const host of refusals.keys())
    await crawled(
      crawler().crawl([`https://${host}/sitemap.xml`], null, options()),
    );

  const [site = 0] = gaps(started.get('site.test') ?? []);
  const [, other = 0] = gaps(started.get('other.test') ?? []);
  // site.test: a slowdown of 1 s under a Crawl-delay of 2 s.
  assert.ok(site >= 1990 && site < 2500, `site.test /b waited ${site} ms`);
  // other.test: a slowdown of 2 s over a Crawl-delay of 1 s.
  assert.ok(other >= 1990 && other < 2500, `other.test /c waited ${other} ms`);
});

test('a robots.txt that answers 503 also slows its origin after the block', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let refusing = true;
  const started: { path: string; at: number }[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: refusing ? 503 : 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a']);
      return HttpResponse.html('<p>A</p>');
    }),
  );
  const crawl = crawler();
  const blocked = await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  refusing = false;
  started.length = 0;
  t.mock.timers.setTime(3_600_001);

  await crawled(
    crawl.crawl(['https://site.test/sitemap.xml'], blocked, options()),
  );

  assert.equal(started[0]?.path, '/robots.txt');
  assert.equal(started[1]?.path, '/sitemap.xml');
  // The refusal left one second; the new robots.txt answer shortened it by a tenth.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 880 && wait < 1000, `the sitemap waited ${wait} ms`);
});

test('repeated refusals never make the wait longer than one minute', async () => {
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a']);
      return new HttpResponse(null, { status: 503 });
    }),
  );
  // Seven retries 1 ms apart give eight refusals at once, past the minute after the seventh.
  const crawler = new WebCrawler(
    got.extend({
      retry: {
        limit: 7,
        calculateDelay: ({ computedValue }) => (computedValue === 0 ? 0 : 1),
      },
    }),
    [new ListingReader()],
  );

  const memento = await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  // A wait of a minute is too long for a test, so this reads the slowdown the memento carries to the next crawl.
  assert.deepEqual(memento.slowdowns, { 'https://site.test': 60_000 });
});

test('a robots.txt 503 that Got retried away still slows its origin', async () => {
  let refusals = 1;
  const started: { path: string; at: number }[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: refusals-- > 0 ? 503 : 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a']);
      return HttpResponse.html('<p>A</p>');
    }),
  );

  await crawled(
    crawler(1).crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(
    started.map(({ path }) => path),
    ['/robots.txt', '/robots.txt', '/sitemap.xml', '/a'],
  );
  // Got's own wait before its retry covers the first second; the sitemap shortened the slowdown to 900 ms.
  const [, , last = 0] = gaps(started.map(({ at }) => at));
  assert.ok(last >= 880 && last < 1000, `/a waited ${last} ms`);
});
