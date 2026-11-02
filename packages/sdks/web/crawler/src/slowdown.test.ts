import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { Msw } from '@zukhruf/testing/msw';
import got from 'got';
import { HttpResponse, http } from 'msw';

import {
  AdaptiveRevisit,
  AlwaysRevisit,
  CompositeRevisit,
  type Crawl,
  type CrawlMemento,
  ListingReader,
  Origins,
  type OriginsMemento,
} from './index.ts';

// Synthetic upstream sites make refusals reproducible offline.

// A sitemap that names these pages of its origin.
function sitemap(origin: string, paths: readonly string[]) {
  return HttpResponse.xml(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map((path) => `<url><loc>${origin}${path}</loc></url>`)
      .join('')}</urlset>`,
  );
}

// One read: a crawler and its origins' records, which start from the last
// read's memento. Got retries a network error only when a test names it, and
// it never retries a refusal, which is the record's.
function read(retries: number, origins: OriginsMemento | null) {
  const client = got.extend({ retry: { limit: retries } });
  const records = new Origins(client, origins);
  return {
    origins: records,
    crawler: records.crawler(
      client,
      [new ListingReader()],
      new AdaptiveRevisit(),
    ),
  };
}

// The slowdown that the records keep for site.test.
function slowdownOf(origins: Origins) {
  return origins.snapshot()['https://site.test']?.slowdown;
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

const options = () => ({ signal: AbortSignal.timeout(120_000) });

test('cancelling a crawl while it waits out a slowdown rejects at once with the signal reason', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
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
  const crawl = read(0, null).crawler.crawl(
    ['https://site.test/sitemap.xml'],
    null,
    { signal: controller.signal },
  );
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
  using server = new Msw().intercept(
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
    read(0, null).crawler.crawl(
      ['https://site.test/sitemap.xml', 'https://other.test/sitemap.xml'],
      null,
      options(),
    ),
  );

  // The delay of one second, and on site.test a slowdown of one second more.
  const [site = 0] = gaps(started.get('https://site.test') ?? []);
  const [other = Infinity] = gaps(started.get('https://other.test') ?? []);
  assert.ok(site >= 1990, `site.test pages started ${site} ms apart`);
  assert.ok(other < 1500, `other.test pages started ${other} ms apart`);
});

test('after a 429 block ends, the next read spaces its requests to that origin', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let blocking = true;
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
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
  const first = read(0, null);
  const blocked = await crawled(
    first.crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  blocking = false;
  started.length = 0;
  t.mock.timers.setTime(61_000);

  await crawled(
    read(0, first.origins.snapshot()).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      blocked,
      options(),
    ),
  );

  // The rules last 24 hours, so the next read asks only the held pages.
  assert.deepEqual(
    started.map(({ path }) => path),
    ['/a', '/b'],
  );
  const [wait = 0] = gaps(started.map(({ at }) => at));
  // The block left a slowdown of one second; the answer of /a shortened it by a tenth, on top of the delay.
  assert.ok(wait >= 1880 && wait < 2000, `/b waited ${wait} ms`);
});

test('each 5xx answer slows the next request to its origin by one second', async () => {
  const statuses = [500, 501, 503, 504, 599];
  const started = new Map<string, number[]>();
  using server = new Msw().intercept(
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
    read(0, null).crawler.crawl(
      statuses.map((status) => `https://s${status}.test/sitemap.xml`),
      null,
      options(),
    ),
  );

  for (const status of statuses) {
    const [gap = 0] = gaps(started.get(`s${status}.test`) ?? []);
    assert.ok(
      gap >= 1990 && gap < 2500,
      `after a ${status}, /b waited ${gap} ms`,
    );
  }
});

test('Got retries no refusal: a 503 is answered once, and its slowdown spaces the next requests', async () => {
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b', '/c']);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    read(1, null).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      null,
      options(),
    ),
  );

  assert.deepEqual(
    started.map(({ path }) => path),
    ['/a', '/b', '/c'],
  );
  // One second of delay and one of slowdown; /b shortened the slowdown to 900 ms.
  const [first = 0, second = 0] = gaps(started.map(({ at }) => at));
  assert.ok(first >= 1990 && first < 2100, `/b waited ${first} ms`);
  assert.ok(second >= 1880 && second < 2000, `/c waited ${second} ms`);
});

test('a page whose connection dropped and then answered 503 counts one refusal, and Got does not retry the 503', async () => {
  const requests: string[] = [];
  const attempts: ('drop' | 503)[] = ['drop', 503];
  // msw gives a network error no code, so Got would not retry it; the
  // interceptor under msw drops the connection as a short network outage does.
  const interceptor = new ClientRequestInterceptor();
  interceptor.on('request', ({ request, controller }) => {
    const { pathname } = new URL(request.url);
    requests.push(pathname);
    const attempt = pathname === '/a' ? attempts.shift() : undefined;
    if (pathname === '/robots.txt')
      controller.respondWith(new Response(null, { status: 404 }));
    else if (pathname === '/sitemap.xml')
      controller.respondWith(sitemap('https://site.test', ['/a']));
    else if (attempt === 'drop')
      controller.errorWith(
        Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
          syscall: 'read',
        }),
      );
    else if (attempt === 503)
      controller.respondWith(new Response(null, { status: 503 }));
    else controller.respondWith(HttpResponse.html('<p>A</p>'));
  });
  interceptor.apply();
  try {
    const { crawler, origins } = read(2, null);
    await crawled(
      crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    );

    assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a', '/a']);
    // The 503 is the site's refusal; the drop before it is the network's.
    assert.equal(slowdownOf(origins), 1000);
  } finally {
    interceptor.dispose();
  }
});

test('a 408 that Got retried away does not slow the origin', async () => {
  const requests: string[] = [];
  let timeouts = 1;
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a']);
      if (timeouts-- > 0) return new HttpResponse(null, { status: 408 });
      return HttpResponse.html('<p>A</p>');
    }),
  );

  const { crawler, origins } = read(1, null);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a', '/a']);
  // A refusal is a 429 or a 5xx; a request timeout is not one.
  assert.equal(slowdownOf(origins), 0);
});

test('each further refusal doubles the slowdown', async () => {
  const started: number[] = [];
  using server = new Msw().intercept(
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
    read(0, null).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      null,
      options(),
    ),
  );

  // The delay of 1 s plus 1 s, 2 s, then 4 s: a slowdown that grew by one second each time would give 4 s for the last.
  const [first = 0, second = 0, third = 0] = gaps(started);
  assert.ok(first >= 1990 && first < 2500, `/b waited ${first} ms`);
  assert.ok(second >= 2990 && second < 3500, `/c waited ${second} ms`);
  assert.ok(third >= 4990 && third < 5500, `/d waited ${third} ms`);
});

test('answers that are not refusals shorten the slowdown step by step, until it ends', async () => {
  const pages = [
    '/a',
    ...Array.from({ length: 22 }, (_, index) => `/${index + 1}`),
  ];
  const started: number[] = [];
  using server = new Msw().intercept(
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

  const { crawler, origins } = read(0, null);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  // The delay, and one second of slowdown after the refusal, a tenth shorter after each page.
  const waits = gaps(started);
  assert.equal(waits.length, 22);
  for (const [index, wait] of waits.entries()) {
    const expected = 1000 + 1000 * 0.9 ** index;
    assert.ok(
      wait >= expected - 25 && wait < expected + 45,
      `page ${index + 1} waited ${wait} ms, not about ${Math.round(expected)} ms`,
    );
  }
  // The 22nd page shortened the slowdown under 100 ms, so it ended: no wait shows that, so this reads the records.
  assert.equal(slowdownOf(origins), 0);
});

// A read of site.test whose page /a answers 503 and whose other pages
// answer, then a second read from its mementos, whose sitemap also names /new.
async function readAgain(pages: readonly string[]) {
  const started: { path: string; at: number }[] = [];
  let again = false;
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', again ? [...pages, '/new'] : pages);
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );
  // The sitemap is read in every crawl, as a host reads its lists.
  const crawler = (origins: OriginsMemento | null) => {
    const client = got.extend({ retry: { limit: 0 } });
    const records = new Origins(client, origins);
    return {
      origins: records,
      crawler: records.crawler(
        client,
        [new ListingReader()],
        new CompositeRevisit(
          [
            [
              new URLPattern('https://site.test/sitemap.xml'),
              new AlwaysRevisit(),
            ],
          ],
          new AdaptiveRevisit(),
        ),
      ),
    };
  };
  const first = crawler(null);
  const memento = await crawled(
    first.crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  started.length = 0;
  again = true;
  await crawled(
    crawler(first.origins.snapshot()).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      memento,
      options(),
    ),
  );
  return { complete: memento.crawl === null, started };
}

test('a slowdown carries over to the next read after a complete crawl', async () => {
  const { complete, started } = await readAgain(['/a']);

  assert.equal(complete, true);
  assert.deepEqual(
    started.map(({ path }) => path),
    ['/sitemap.xml', '/new'],
  );
  // The refusal left one second; the sitemap answer of the next read shortened it by a tenth.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 1880 && wait < 2000, `/new waited ${wait} ms`);
});

test('the next read starts from the shortened slowdown, not from its peak', async () => {
  const { complete, started } = await readAgain([
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
    ['/sitemap.xml', '/new'],
  );
  // One second after the refusal, a tenth shorter after each of the five pages and the next sitemap: 1000 × 0.9⁶, on top of the delay.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 1510 && wait < 1570, `/new waited ${wait} ms`);
});

test('a slowdown adds to the Crawl-delay, as Nutch adds its back-off to the server delay', async () => {
  // site.test asks for 2 s and refuses once; other.test asks for 1 s and refuses twice.
  const refusals = new Map([
    ['site.test', ['/a']],
    ['other.test', ['/a', '/b']],
  ]);
  const started = new Map<string, number[]>();
  using server = new Msw().intercept(
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
      read(0, null).crawler.crawl(
        [`https://${host}/sitemap.xml`],
        null,
        options(),
      ),
    );

  const [site = 0] = gaps(started.get('site.test') ?? []);
  const [, other = 0] = gaps(started.get('other.test') ?? []);
  // site.test: a Crawl-delay of 2 s and a slowdown of 1 s.
  assert.ok(site >= 2990 && site < 3500, `site.test /b waited ${site} ms`);
  // other.test: a Crawl-delay of 1 s and a slowdown of 2 s.
  assert.ok(other >= 2990 && other < 3500, `other.test /c waited ${other} ms`);
});

test('a robots.txt that answers 503 also slows its origin after the block', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let refusing = true;
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
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
  const first = read(0, null);
  const blocked = await crawled(
    first.crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );
  refusing = false;
  started.length = 0;
  t.mock.timers.setTime(3_600_001);

  await crawled(
    read(0, first.origins.snapshot()).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      blocked,
      options(),
    ),
  );

  assert.equal(started[0]?.path, '/robots.txt');
  assert.equal(started[1]?.path, '/sitemap.xml');
  // The refusal left one second; the new robots.txt answer shortened it by a tenth, on top of the delay.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  assert.ok(wait >= 1880 && wait < 2000, `the sitemap waited ${wait} ms`);
});

test('repeated refusals never make the slowdown longer than one minute', async () => {
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/sitemap.xml')
        return new HttpResponse(null, { status: 503 });
      return new HttpResponse(null, { status: 404 });
    }),
  );
  // An origin that a last read left at the longest slowdown, with rules it read now.
  const { crawler, origins } = read(0, {
    'https://site.test': {
      robots: { body: '', fetched: Date.now() },
      blocked: null,
      slowdown: 60_000,
    },
  });

  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  // A wait of a minute is too long for a test, so this reads the slowdown the records carry to the next read.
  assert.equal(slowdownOf(origins), 60_000);
});

test('Got retries no refusal of robots.txt: one 503 blocks and slows its origin', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 503 });
      return sitemap('https://site.test', ['/a']);
    }),
  );

  const { crawler, origins } = read(1, null);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
  );

  assert.deepEqual(requests, ['/robots.txt']);
  assert.equal(slowdownOf(origins), 1000);
  assert.notEqual(origins.snapshot()['https://site.test']?.blocked, null);
});

test('a robots.txt whose connection dropped before Got retried it does not slow its origin', async () => {
  const requests: string[] = [];
  let drops = 1;
  // msw gives a network error no code, so Got would not retry it; the
  // interceptor under msw drops the connection as a short network outage does.
  const interceptor = new ClientRequestInterceptor();
  interceptor.on('request', ({ request, controller }) => {
    const { pathname } = new URL(request.url);
    requests.push(pathname);
    if (pathname === '/robots.txt' && drops-- > 0)
      controller.errorWith(
        Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
          syscall: 'read',
        }),
      );
    else if (pathname === '/robots.txt')
      controller.respondWith(new Response(null, { status: 404 }));
    else if (pathname === '/sitemap.xml')
      controller.respondWith(sitemap('https://site.test', ['/a']));
    else controller.respondWith(HttpResponse.html('<p>A</p>'));
  });
  interceptor.apply();
  try {
    const { crawler, origins } = read(1, null);
    await crawled(
      crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    );

    assert.deepEqual(requests, [
      '/robots.txt',
      '/robots.txt',
      '/sitemap.xml',
      '/a',
    ]);
    assert.equal(slowdownOf(origins), 0);
  } finally {
    interceptor.dispose();
  }
});
