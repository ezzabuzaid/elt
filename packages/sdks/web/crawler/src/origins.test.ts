import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { type TimerId, createClock } from '@sinonjs/fake-timers';
import { Msw } from '@zukhruf/testing/msw';
import got from 'got';
import { HttpResponse, http } from 'msw';

import {
  AdaptiveRevisit,
  type Crawl,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  day,
  hour,
} from './index.ts';

// Synthetic upstream sites: each origin's record decides what the crawl asks them.

// Got retries no network error, so a test's failure is its first answer.
const noRetries = got.extend({ retry: { limit: 0 } });

const options = () => ({ signal: AbortSignal.timeout(120_000) });

// A sitemap that names these URLs.
function sitemap(urls: readonly string[]) {
  return HttpResponse.xml(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`,
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

// Whether the promise settled in one turn of the event loop; a rejection throws.
function settled(promise: Promise<unknown>) {
  return Promise.race([promise.then(() => true), setImmediate(false)]);
}

// One crawl to its end: its pages and its failures. The crawl waits only on
// its clock, so a pending timer is the wait of the crawl, which ends at once
// with the clock moved by its length.
async function crawled(crawl: Crawl, time: Clock) {
  const pages: string[] = [];
  const failures: string[] = [];
  const consumed = (async () => {
    for await (const entry of crawl)
      if ('response' in entry) pages.push(entry.url);
      else if ('error' in entry) failures.push(entry.error.message);
  })();
  while (!(await settled(consumed)))
    if (time.fake.countTimers() > 0) time.fake.next();
  return { pages, failures };
}

test('a redirect to another origin whose robots.txt disallows the target is not requested', async () => {
  const time = clock(0);
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://*.test/*', ({ request }) => {
      requests.push(request.url);
      const { host, pathname } = new URL(request.url);
      if (host === 'site.test' && pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (host === 'site.test' && pathname === '/sitemap.xml')
        return sitemap(['https://site.test/moved']);
      if (host === 'site.test')
        return new HttpResponse(null, {
          status: 301,
          headers: { location: 'https://private.test/secret' },
        });
      if (pathname === '/robots.txt')
        return HttpResponse.text('User-agent: *\nDisallow: /secret\n');
      return HttpResponse.html('<p>Secret</p>');
    }),
  );

  const { pages, failures } = await crawled(
    new Origins(noRetries, null, time)
      .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
      .crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );

  assert.deepEqual(requests, [
    'https://site.test/robots.txt',
    'https://site.test/sitemap.xml',
    'https://site.test/moved',
    'https://private.test/robots.txt',
  ]);
  assert.deepEqual(pages, []);
  assert.deepEqual(failures, []);
});

test('a redirect target waits the delay of its own origin, not of the origin that redirected', async () => {
  const time = clock(0);
  const started = new Map<string, number>();
  using server = new Msw().intercept(
    http.get('https://*.test/*', ({ request }) => {
      started.set(request.url, time.performance.now());
      const { host, pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap(['https://site.test/away', 'https://site.test/here']);
      if (host === 'site.test' && pathname === '/away')
        return new HttpResponse(null, {
          status: 301,
          headers: { location: 'https://other.test/away' },
        });
      if (host === 'site.test' && pathname === '/here')
        return new HttpResponse(null, {
          status: 301,
          headers: { location: 'https://site.test/there' },
        });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  const { pages } = await crawled(
    new Origins(noRetries, null, time)
      .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
      .crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );

  const at = (url: string) => started.get(url) ?? Number.NaN;
  assert.deepEqual(pages.toSorted(), [
    'https://other.test/away',
    'https://site.test/there',
  ]);
  // other.test was never asked, so its first request waits only for its robots.txt.
  assert.equal(
    at('https://other.test/away') - at('https://other.test/robots.txt'),
    1000,
  );
  // A redirect within site.test is a request of site.test, one delay after the last one.
  assert.equal(
    at('https://site.test/there') - at('https://site.test/here'),
    1000,
  );
});

test('without a Crawl-delay, two requests to one origin start one second apart', async () => {
  const time = clock(0);
  const started: number[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap(['https://site.test/a', 'https://site.test/b']);
      started.push(time.performance.now());
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  await crawled(
    new Origins(noRetries, null, time)
      .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
      .crawl(['https://site.test/sitemap.xml'], null, options()),
    time,
  );

  const [a = 0, b = 0] = started;
  assert.equal(b - a, 1000);
});

test('the rules of robots.txt are read again 24 hours after they were read, and not before', async () => {
  const time = clock(10 * day);
  const robots: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt') {
        robots.push(pathname);
        return HttpResponse.text('User-agent: *\nAllow: /\n');
      }
      return sitemap([]);
    }),
  );
  // The last read read the rules at fetched; this read starts at 10 days.
  const read = (fetched: number) =>
    crawled(
      new Origins(
        noRetries,
        {
          'https://site.test': {
            robots: { body: 'User-agent: *\nAllow: /\n', fetched },
            blocked: null,
            slowdown: 0,
          },
        },
        time,
      )
        .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
        .crawl(['https://site.test/sitemap.xml'], null, options()),
      time,
    );

  await read(10 * day - 23 * hour);
  assert.deepEqual(robots, []);
  await read(10 * day - 24 * hour);
  assert.deepEqual(robots, ['/robots.txt']);
});

test('a 503 with Retry-After holds its origin until then, as a 429 does', async () => {
  const time = clock(0);
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml')
        return sitemap(['https://site.test/a', 'https://site.test/b']);
      return new HttpResponse(null, {
        status: 503,
        headers: { 'retry-after': '600' },
      });
    }),
  );
  const crawl = new Origins(noRetries, null, time)
    .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
    .crawl(['https://site.test/sitemap.xml'], null, options());

  const { failures } = await crawled(crawl, time);

  assert.deepEqual(requests, ['/robots.txt', '/sitemap.xml', '/a']);
  assert.equal(failures.length, 1);
  // /a answered 2 s in, after the delays of the sitemap and of /a.
  assert.match(failures[0] ?? '', /answered 503.*1970-01-01T00:10:02\.000Z/);
  assert.equal(crawl.nextDue(), 602_000);
  assert.deepEqual(
    crawl
      .snapshot()
      .crawl?.pending.map(({ url }) => url)
      .toSorted(),
    ['https://site.test/a', 'https://site.test/b'],
  );
});

test('two crawls of one read share the expansion budget of each origin', async () => {
  const time = clock(0);
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://*.test/*', ({ request }) => {
      requests.push(request.url);
      const { host, pathname } = new URL(request.url);
      if (host === 'list-a.test' || host === 'list-b.test') {
        if (pathname === '/robots.txt')
          return new HttpResponse(null, { status: 404 });
        return HttpResponse.html(
          '<main><a href="https://company.test/">Company</a></main>',
        );
      }
      if (pathname === '/robots.txt')
        return HttpResponse.text(
          Array.from(
            { length: 10 },
            (_, index) => `Sitemap: https://company.test/${index}.xml`,
          ).join('\n'),
        );
      if (pathname.endsWith('.xml')) return sitemap([]);
      return HttpResponse.html('<p>Company</p>');
    }),
  );
  // Two inputs of one source, each its own crawl, in one read.
  const origins = new Origins(noRetries, null, time);
  const programs = () =>
    origins.crawler(
      noRetries,
      [
        new PaginationReader({ strategy: 'all' }),
        new ListingReader(),
        new LinkReader({ maxDepth: 0, maxPages: 0 }),
      ],
      new AdaptiveRevisit(),
    );
  const crawlOptions = {
    ...options(),
    include: [new URLPattern('https://company.test/*')] as const,
    expand: [new URLPattern({ pathname: '*startup*' })] as const,
  };
  const sitemaps = () =>
    requests.filter((url) => /^https:\/\/company\.test\/\d+\.xml$/.test(url));

  const first = programs().crawl(
    ['https://list-a.test/programs'],
    null,
    crawlOptions,
  );
  await crawled(first, time);
  const firstSitemaps = sitemaps().length;
  requests.length = 0;
  const second = programs().crawl(
    ['https://list-b.test/programs'],
    null,
    crawlOptions,
  );
  await crawled(second, time);

  // The first crawl spent the budget of 8: robots.txt and 7 sitemaps.
  assert.equal(firstSitemaps, 7);
  assert.notEqual(first.snapshot().crawl, null);
  // The second crawl downloads no document of company.test in this read: it holds them for the next.
  assert.deepEqual(sitemaps(), []);
  assert.ok(
    !requests.includes('https://company.test/robots.txt'),
    requests.join('\n'),
  );
  assert.notEqual(second.snapshot().crawl, null);
});

test('a redirect whose target stays is scheduled as unchanged, and one whose target moves as changed', async () => {
  const time = clock(0);
  let target = '/b';
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/sitemap.xml') return sitemap(['https://site.test/a']);
      if (pathname === '/a')
        return new HttpResponse(null, {
          status: 302,
          headers: { location: target },
        });
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );
  // Each run is a read of its own; AdaptiveRevisit makes an unchanged URL
  // due 1.5 times later than its last interval, and a changed one halfway to
  // an hour.
  let memento: unknown = null;
  const run = async () => {
    const crawl = new Origins(noRetries, null, time)
      .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
      .crawl(['https://site.test/sitemap.xml'], memento, options());
    await crawled(crawl, time);
    const snapshot = crawl.snapshot();
    memento = snapshot;
    return snapshot.urls['https://site.test/a']?.due;
  };

  // The first visit has nothing to compare: one day.
  assert.equal(await run(), day);
  time.fake.setSystemTime(day);
  // The same target: unchanged, so 1.5 days after this visit.
  assert.equal(await run(), day + 1.5 * day);
  time.fake.setSystemTime(2.5 * day);
  target = '/c';
  // Another target: changed, so halfway from 1.5 days to an hour.
  assert.equal(await run(), 2.5 * day + (1.5 * day + hour) / 2);
});
