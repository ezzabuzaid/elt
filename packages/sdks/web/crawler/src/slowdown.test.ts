import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { type TimerId, createClock } from '@sinonjs/fake-timers';
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

// The clock of the reads, which the test moves: waits of seconds take no real
// time, and the clock moves by the length of each wait, also on a busy
// machine. A real timer waits whole milliseconds and at least one, so a wait
// here lasts its length rounded up; a fake timer shorter than a millisecond
// would end at once, and the crawl would wait for the rest again and again.
function clock(now: number) {
  const fake = createClock(now);
  const timers = new Map<object, TimerId>();
  return {
    fake,
    Date: fake.Date,
    performance: fake.performance,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = {};
      timers.set(
        timer,
        fake.setTimeout(() => {
          timers.delete(timer);
          callback();
        }, Math.ceil(ms)),
      );
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      if (!(timer instanceof Object)) return;
      fake.clearTimeout(timers.get(timer));
      timers.delete(timer);
    },
  };
}

type Clock = ReturnType<typeof clock>;

// One read: a crawler and its origins' records, which start from the last
// read's memento. Got retries a network error only when a test names it, and
// it never retries a refusal, which is the record's.
function read(retries: number, origins: OriginsMemento | null, time: Clock) {
  const client = got.extend({ retry: { limit: retries } });
  const records = new Origins(client, origins, time);
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

// Whether the promise settled in one turn of the event loop; a rejection throws.
function settled(promise: Promise<unknown>) {
  return Promise.race([promise.then(() => true), setImmediate(false)]);
}

// One crawl to its end, and its memento as JSON gives it back. The crawl waits
// only on its clock, so a pending timer is the wait of the crawl, which ends
// at once with the clock moved by its length.
async function crawled(crawl: Crawl, time: Clock) {
  const consumed = (async () => {
    for await (const entry of crawl) void entry;
  })();
  while (!(await settled(consumed)))
    if (time.fake.countTimers() > 0) time.fake.next();
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
  const time = clock(0);
  const controller = new AbortController();
  const reason = new Error('The user stopped the crawl');
  const crawl = read(0, null, time).crawler.crawl(
    ['https://site.test/sitemap.xml'],
    null,
    { signal: controller.signal },
  );
  let refusedAt: number | undefined;
  const consumed = (async () => {
    for await (const entry of crawl)
      if ('error' in entry) refusedAt = time.performance.now();
  })();

  await assert.rejects(
    async () => {
      // Each wait ends at once until /a is refused; the user stops the wait after it.
      while (!(await settled(consumed)))
        if (time.fake.countTimers() === 0) continue;
        else if (refusedAt === undefined) time.fake.next();
        else controller.abort(reason);
    },
    (error) => error === reason,
  );

  // No time passed on the clock after the refusal, and the wait's timer stopped.
  assert.equal(time.performance.now(), refusedAt);
  assert.equal(time.fake.countTimers(), 0);
  assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a']);
});

test('a refusal slows the requests to its own origin and not to another origin', async () => {
  const time = clock(0);
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
      started.set(origin, [
        ...(started.get(origin) ?? []),
        time.performance.now(),
      ]);
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    read(0, null, time).crawler.crawl(
      ['https://site.test/sitemap.xml', 'https://other.test/sitemap.xml'],
      null,
      options(),
    ),
    time,
  );

  // The delay of one second, and on site.test a slowdown of one second more.
  assert.deepEqual(gaps(started.get('https://site.test') ?? []), [2000]);
  assert.deepEqual(gaps(started.get('https://other.test') ?? []), [1000]);
});

test('after a 429 block ends, the next read spaces its requests to that origin', async () => {
  const time = clock(0);
  let blocking = true;
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: time.performance.now() });
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
  const first = read(0, null, time);
  const blocked = await crawled(
    first.crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );
  blocking = false;
  started.length = 0;
  time.fake.tick(61_000);

  await crawled(
    read(0, first.origins.snapshot(), time).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      blocked,
      options(),
    ),
    time,
  );

  // The rules last 24 hours, so the next read asks only the held pages.
  assert.deepEqual(
    started.map(({ path }) => path),
    ['/a', '/b'],
  );
  // The block left a slowdown of one second; the answer of /a shortened it by a tenth, on top of the delay.
  assert.deepEqual(gaps(started.map(({ at }) => at)), [1900]);
});

test('each 5xx answer slows the next request to its origin by one second', async () => {
  const time = clock(0);
  const statuses = [500, 501, 503, 504, 599];
  const started = new Map<string, number[]>();
  using server = new Msw().intercept(
    http.get('https://:host/*', ({ request }) => {
      const { host, origin, pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml') return sitemap(origin, ['/a', '/b']);
      started.set(host, [...(started.get(host) ?? []), time.performance.now()]);
      if (pathname === '/a')
        return new HttpResponse(null, {
          status: Number.parseInt(host.slice(1)),
        });
      return HttpResponse.html('<p>B</p>');
    }),
  );

  await crawled(
    read(0, null, time).crawler.crawl(
      statuses.map((status) => `https://s${status}.test/sitemap.xml`),
      null,
      options(),
    ),
    time,
  );

  for (const status of statuses)
    assert.deepEqual(
      gaps(started.get(`s${status}.test`) ?? []),
      [2000],
      `after a ${status}`,
    );
});

test('Got retries no refusal: a 503 is answered once, and its slowdown spaces the next requests', async () => {
  const time = clock(0);
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b', '/c']);
      started.push({ path: pathname, at: time.performance.now() });
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    read(1, null, time).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      null,
      options(),
    ),
    time,
  );

  assert.deepEqual(
    started.map(({ path }) => path),
    ['/a', '/b', '/c'],
  );
  // One second of delay and one of slowdown; /b shortened the slowdown to 900 ms.
  assert.deepEqual(gaps(started.map(({ at }) => at)), [2000, 1900]);
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
    const time = clock(0);
    const { crawler, origins } = read(2, null, time);
    await crawled(
      crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
      time,
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

  const time = clock(0);
  const { crawler, origins } = read(1, null, time);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );

  assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a', '/a']);
  // A refusal is a 429 or a 5xx; a request timeout is not one.
  assert.equal(slowdownOf(origins), 0);
});

test('each further refusal doubles the slowdown', async () => {
  const time = clock(0);
  const started: number[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a', '/b', '/c', '/d']);
      started.push(time.performance.now());
      if (pathname === '/d') return HttpResponse.html('<p>D</p>');
      return new HttpResponse(null, { status: 503 });
    }),
  );

  await crawled(
    read(0, null, time).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      null,
      options(),
    ),
    time,
  );

  // The delay of 1 s plus 1 s, 2 s, then 4 s: a slowdown that grew by one second each time would give 4 s for the last.
  assert.deepEqual(gaps(started), [2000, 3000, 5000]);
});

test('answers that are not refusals shorten the slowdown step by step, until it ends', async () => {
  const time = clock(0);
  const pages = [
    '/a',
    ...Array.from({ length: 24 }, (_, index) => `/${index + 1}`),
  ];
  const started: number[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', pages);
      started.push(time.performance.now());
      if (pathname === '/a') return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  const { crawler, origins } = read(0, null, time);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );

  // The delay, and one second of slowdown after the refusal, a tenth shorter
  // after each page. The 22nd page shortens it under 100 ms, so it ends, and
  // the 23rd and 24th wait the delay alone. A timer waits whole milliseconds,
  // so each wait is within one millisecond of its length.
  const waits = gaps(started);
  assert.equal(waits.length, 24);
  for (const [index, wait] of waits.entries()) {
    const expected = 1000 + (index < 22 ? 1000 * 0.9 ** index : 0);
    assert.ok(
      Math.abs(wait - expected) < 1,
      `page ${index + 1} waited ${wait} ms, not ${expected} ms`,
    );
  }
  assert.equal(slowdownOf(origins), 0);
});

// A read of site.test whose page /a answers 503 and whose other pages
// answer, then a second read from its mementos, whose sitemap also names /new.
async function readAgain(pages: readonly string[]) {
  const time = clock(0);
  const started: { path: string; at: number }[] = [];
  let again = false;
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: time.performance.now() });
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
    const records = new Origins(client, origins, time);
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
    time,
  );
  started.length = 0;
  again = true;
  await crawled(
    crawler(first.origins.snapshot()).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      memento,
      options(),
    ),
    time,
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
  assert.deepEqual(gaps(started.map(({ at }) => at)), [1900]);
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
  // One second after the refusal, a tenth shorter after each of the five pages and the next sitemap: 1000 × 0.9⁶, on top of the delay, within the millisecond of a timer.
  const [wait = 0] = gaps(started.map(({ at }) => at));
  const expected = 1000 + 1000 * 0.9 ** 6;
  assert.ok(
    Math.abs(wait - expected) < 1,
    `/new waited ${wait} ms, not ${expected} ms`,
  );
});

test('a slowdown adds to the Crawl-delay, as Nutch adds its back-off to the server delay', async () => {
  const time = clock(0);
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
      started.set(host, [...(started.get(host) ?? []), time.performance.now()]);
      if (refusals.get(host)?.includes(pathname))
        return new HttpResponse(null, { status: 503 });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  for (const host of refusals.keys())
    await crawled(
      read(0, null, time).crawler.crawl(
        [`https://${host}/sitemap.xml`],
        null,
        options(),
      ),
      time,
    );

  // site.test: a Crawl-delay of 2 s and a slowdown of 1 s.
  assert.deepEqual(gaps(started.get('site.test') ?? []), [3000]);
  // other.test: a Crawl-delay of 1 s and a slowdown of 1 s, then of 2 s.
  assert.deepEqual(gaps(started.get('other.test') ?? []), [2000, 3000]);
});

test('a robots.txt that answers 503 also slows its origin after the block', async () => {
  const time = clock(0);
  let refusing = true;
  const started: { path: string; at: number }[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      started.push({ path: pathname, at: time.performance.now() });
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: refusing ? 503 : 404 });
      if (pathname === '/sitemap.xml')
        return sitemap('https://site.test', ['/a']);
      return HttpResponse.html('<p>A</p>');
    }),
  );
  const first = read(0, null, time);
  const blocked = await crawled(
    first.crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );
  refusing = false;
  started.length = 0;
  time.fake.tick(3_600_001);

  await crawled(
    read(0, first.origins.snapshot(), time).crawler.crawl(
      ['https://site.test/sitemap.xml'],
      blocked,
      options(),
    ),
    time,
  );

  assert.equal(started[0]?.path, '/robots.txt');
  assert.equal(started[1]?.path, '/sitemap.xml');
  // The refusal left one second; the new robots.txt answer shortened it by a tenth, on top of the delay.
  const [wait] = gaps(started.map(({ at }) => at));
  assert.equal(wait, 1900);
});

test('repeated refusals never make the slowdown longer than one minute', async () => {
  const time = clock(0);
  const started: number[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      started.push(time.performance.now());
      return new HttpResponse(null, { status: 503 });
    }),
  );
  // An origin that a last read left at the longest slowdown, with rules it read now.
  const { crawler, origins } = read(
    0,
    {
      'https://site.test': {
        robots: { body: '', fetched: time.Date.now() },
        blocked: null,
        slowdown: 60_000,
      },
    },
    time,
  );

  await crawled(
    crawler.crawl(
      ['https://site.test/a.xml', 'https://site.test/b.xml'],
      null,
      options(),
    ),
    time,
  );

  // Both lists refuse; after the first, the second waits the delay and one minute, not two.
  assert.deepEqual(gaps(started), [61_000]);
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

  const time = clock(0);
  const { crawler, origins } = read(1, null, time);
  await crawled(
    crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
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
    const time = clock(0);
    const { crawler, origins } = read(1, null, time);
    await crawled(
      crawler.crawl(['https://site.test/sitemap.xml'], null, options()),
      time,
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
