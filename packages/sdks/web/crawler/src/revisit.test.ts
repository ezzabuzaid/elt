import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Msw } from '@zukhruf/testing/msw';
import got from 'got';
import { type HttpHandler, HttpResponse, http } from 'msw';

import {
  AdaptiveRevisit,
  AlwaysRevisit,
  ChangeRateRevisit,
  CompositeRevisit,
  type Crawl,
  type CrawlOptions,
  type CrawlRequest,
  FixedRevisit,
  HintRevisit,
  LinkReader,
  ListingReader,
  OnceRevisit,
  Origins,
  type Outcome,
  type RevisitPolicy,
  type SavedCrawl,
  applySnapshot,
  day,
  hour,
} from './index.ts';
import { InstantClock } from './instant-clock.ts';

// Synthetic upstream sites make page bodies and failures reproducible offline.
// They have no robots.txt, so the requests they record are the crawl's pages.
function mockWeb(...handlers: HttpHandler[]) {
  return new Msw().intercept(
    http.get('*/robots.txt', () => new HttpResponse(null, { status: 404 })),
    ...handlers,
  );
}

function pathOf(url: string) {
  return new URL(url).pathname;
}

// One crawl to its end: what it handed out by kind, whether it is complete,
// and what its host keeps after it, from what it kept before.
async function crawled(crawl: Crawl, before: SavedCrawl | null = null) {
  const pages: { path: string; change: string }[] = [];
  const deferred: string[] = [];
  const failed: string[] = [];
  for await (const entry of crawl)
    if ('response' in entry)
      pages.push({ path: pathOf(entry.url), change: entry.change });
    else if ('deferred' in entry) deferred.push(pathOf(entry.deferred.url));
    else if ('error' in entry) failed.push(pathOf(entry.url));
  return {
    pages,
    deferred,
    failed,
    complete: crawl.complete,
    kept: applySnapshot(before, crawl.snapshot()),
  };
}

// A starting page that is read in every crawl, as a host reads its lists,
// so the pages that it links are found again; every other URL follows the
// policy under test.
function everyCrawl(start: string, revisit: RevisitPolicy<unknown>) {
  return new CompositeRevisit(
    [[new URLPattern(start), new AlwaysRevisit()]],
    revisit,
  );
}

function siteCrawler(revisit: RevisitPolicy<unknown>) {
  return new Origins(got, null, globalThis).crawler(
    got,
    [new LinkReader({ maxDepth: 1, maxPages: 100 })],
    everyCrawl('https://site.test/', revisit),
  );
}

const request: CrawlRequest = {
  url: 'https://site.test/a',
  listingUrl: 'https://site.test/',
  lastModified: null,
  published: null,
  localizedVersions: [],
  hops: 1,
  start: false,
  page: true,
  list: false,
  expand: null,
  startingOrigin: true,
};

test('a page that is not due is not requested and comes out as deferred after the pages, and it is requested again once due', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new AdaptiveRevisit());

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  t.mock.timers.setTime(hour);
  requests.length = 0;
  const early = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );
  t.mock.timers.setTime(day);
  requests.length = 0;
  const due = await crawled(
    crawler.crawl(['https://site.test/'], early.kept, { signal: t.signal }),
    early.kept,
  );

  assert.deepEqual(first.pages, [{ path: '/a', change: 'unknown' }]);
  assert.deepEqual(early.pages, []);
  assert.deepEqual(early.deferred, ['/a']);
  assert.equal(early.complete, true);
  assert.deepEqual(due.pages, [{ path: '/a', change: 'unmodified' }]);
  assert.deepEqual(due.deferred, []);
  assert.deepEqual(requests, ['/', '/a']);
});

test('a caller that keeps no memento gets every page on every crawl', async (t) => {
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return HttpResponse.html('<a href="/a">A</a>');
    }),
  );
  const crawler = siteCrawler(new AdaptiveRevisit());

  await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  const again = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );

  assert.deepEqual(again.pages, [{ path: '/a', change: 'unknown' }]);
  assert.deepEqual(requests, ['/', '/a', '/', '/a']);
});

test('a page whose body changed is handed back as modified', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let body = '<p>First</p>';
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html(body),
    ),
  );
  const crawler = siteCrawler(new FixedRevisit({ every: hour }));

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  body = '<p>Second</p>';
  t.mock.timers.setTime(hour);
  const changed = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );

  assert.deepEqual(changed.pages, [{ path: '/a', change: 'modified' }]);
});

test('a visit is timed at the start of its crawl, so a page due one interval later is due in the crawl that starts then', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      // The download of /a ends a minute after its crawl started.
      t.mock.timers.setTime(Date.now() + 60_000);
      return HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new FixedRevisit({ every: hour }));

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  t.mock.timers.setTime(hour);
  const next = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );

  assert.deepEqual(next.pages, [{ path: '/a', change: 'unmodified' }]);
});

test('a failed page is due again two hours later even when nothing lists it, and is not deferred before then', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let listed = true;
  let broken = true;
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      if (pathOf(request.url) === '/')
        return HttpResponse.html(listed ? '<a href="/a">A</a>' : '<p>Home</p>');
      return broken
        ? new HttpResponse(null, { status: 400 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new AdaptiveRevisit());

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  t.mock.timers.setTime(hour);
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );
  listed = false;
  broken = false;
  t.mock.timers.setTime(2 * hour);
  requests.length = 0;
  const retried = await crawled(
    crawler.crawl(['https://site.test/'], waiting.kept, {
      signal: t.signal,
    }),
    waiting.kept,
  );

  assert.deepEqual(first.failed, ['/a']);
  assert.deepEqual(waiting.failed, []);
  assert.deepEqual(waiting.deferred, []);
  assert.deepEqual(retried.pages, [{ path: '/a', change: 'unknown' }]);
  assert.deepEqual(requests, ['/', '/a']);
});

test('a gone page waits a day, is not deferred meanwhile, and is handed back once it returns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let gone = true;
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      return gone
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new AdaptiveRevisit());

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  t.mock.timers.setTime(hour);
  requests.length = 0;
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );
  const waitingRequests = requests.splice(0);
  gone = false;
  t.mock.timers.setTime(day);
  const back = await crawled(
    crawler.crawl(['https://site.test/'], waiting.kept, {
      signal: t.signal,
    }),
    waiting.kept,
  );

  assert.deepEqual(waitingRequests, ['/']);
  assert.deepEqual(waiting.deferred, []);
  assert.deepEqual(back.pages, [{ path: '/a', change: 'unknown' }]);
});

test('a page that fails three visits in a row is gone: it waits a day, then half again as long at each gone visit, and a visit that succeeds starts the count again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let broken = true;
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      return broken
        ? new HttpResponse(null, { status: 400 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = new Origins(got, null, new InstantClock(Date)).crawler(
    got,
    [new LinkReader({ maxDepth: 1, maxPages: 100 })],
    everyCrawl('https://site.test/', new FixedRevisit({ every: 30 * day })),
  );
  let kept: SavedCrawl | null = null;
  const waits: number[] = [];
  const visit = async () => {
    const at = Date.now();
    const crawl = crawler.crawl(['https://site.test/'], kept, {
      signal: t.signal,
    });
    ({ kept } = await crawled(crawl, kept));
    const next = crawl.nextDue();
    assert.ok(next !== null);
    waits.push((next - at) / hour);
    t.mock.timers.setTime(Math.ceil(next));
  };

  for (let failure = 0; failure < 4; failure++) await visit();
  broken = false;
  await visit();
  broken = true;
  await visit();

  assert.deepEqual(waits, [2, 2, 24, 36, 30 * 24, 2]);
});

test('a gone page waits half again as long at each gone visit, up to ninety days', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : new HttpResponse(null, { status: 410 }),
    ),
  );
  const crawler = new Origins(got, null, new InstantClock(Date)).crawler(
    got,
    [new LinkReader({ maxDepth: 1, maxPages: 100 })],
    everyCrawl('https://site.test/', new FixedRevisit({ every: day })),
  );
  let kept: SavedCrawl | null = null;
  const waits: number[] = [];

  for (let visit = 0; visit < 14; visit++) {
    const at = Date.now();
    const crawl = crawler.crawl(['https://site.test/'], kept, {
      signal: t.signal,
    });
    ({ kept } = await crawled(crawl, kept));
    const next = crawl.nextDue();
    assert.ok(next !== null);
    waits.push((next - at) / day);
    t.mock.timers.setTime(Math.ceil(next));
  }

  assert.deepEqual(
    waits,
    [
      1, 1.5, 2.25, 3.375, 5.0625, 7.59375, 11.390625, 17.0859375, 25.62890625,
      38.443359375, 57.6650390625, 86.49755859375, 90, 90,
    ],
  );
});

test('a page that failed keeps the body digest of its last download, so the download after the failure compares with it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let broken = false;
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      return broken
        ? new HttpResponse(null, { status: 400 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new FixedRevisit({ every: hour }));

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  broken = true;
  t.mock.timers.setTime(hour);
  const failed = await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );
  broken = false;
  t.mock.timers.setTime(3 * hour);
  const back = await crawled(
    crawler.crawl(['https://site.test/'], failed.kept, { signal: t.signal }),
    failed.kept,
  );

  assert.deepEqual(failed.failed, ['/a']);
  assert.deepEqual(back.pages, [{ path: '/a', change: 'unmodified' }]);
});

test('a page that answers 304 is unmodified: no failure, it is deferred, it is due by its policy, and its next download compares with the body before', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let status = 200;
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      return status === 304
        ? new HttpResponse(null, { status: 304 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new FixedRevisit({ every: hour }));

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  status = 304;
  t.mock.timers.setTime(hour);
  const crawl = crawler.crawl(['https://site.test/'], first.kept, {
    signal: t.signal,
  });
  const unmodified = await crawled(crawl, first.kept);
  const due = crawl.nextDue();
  status = 200;
  t.mock.timers.setTime(2 * hour);
  const next = await crawled(
    crawler.crawl(['https://site.test/'], unmodified.kept, {
      signal: t.signal,
    }),
    unmodified.kept,
  );

  assert.deepEqual(unmodified.failed, []);
  assert.deepEqual(unmodified.pages, []);
  assert.deepEqual(unmodified.deferred, ['/a']);
  assert.deepEqual(crawl.failures(), []);
  assert.equal(due, 2 * hour);
  assert.deepEqual(next.pages, [{ path: '/a', change: 'unmodified' }]);
});

test('a listing that gives a page another lastModified makes it due at once, and the page carries the new hint', async (t) => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  let lastModified = '2026-10-01';
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/sitemap.xml'
        ? HttpResponse.xml(
            `<urlset><url><loc>https://site.test/a</loc><lastmod>${lastModified}</lastmod></url></urlset>`,
          )
        : HttpResponse.html('<p>A</p>'),
    ),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new ListingReader()],
    everyCrawl('https://site.test/sitemap.xml', new AdaptiveRevisit()),
  );
  const hinted = async (before: SavedCrawl | null) => {
    const hints: (string | null)[] = [];
    const crawl = crawler.crawl(['https://site.test/sitemap.xml'], before, {
      signal: t.signal,
    });
    for await (const entry of crawl)
      if ('response' in entry) hints.push(entry.lastModified);
    return { hints, kept: applySnapshot(before, crawl.snapshot()) };
  };

  const first = await hinted(null);
  t.mock.timers.setTime(now + hour);
  const same = await hinted(first.kept);
  lastModified = '2026-10-02';
  const changed = await hinted(same.kept);

  assert.deepEqual(first.hints, ['2026-10-01']);
  assert.deepEqual(same.hints, []);
  assert.deepEqual(changed.hints, ['2026-10-02']);
});

test('a known page that is due and that no listing names goes after the pages this crawl lists', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let items = ['/a'];
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return pathOf(request.url) === '/feed.json'
        ? HttpResponse.json({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Feed',
            items: items.map((path) => ({
              id: path,
              url: `https://site.test${path}`,
            })),
          })
        : HttpResponse.html('<p>Page</p>');
    }),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new ListingReader()],
    new AlwaysRevisit(),
  );

  const first = await crawled(
    crawler.crawl(['https://site.test/feed.json'], null, { signal: t.signal }),
  );
  items = ['/b'];
  t.mock.timers.setTime(1);
  requests.length = 0;
  await crawled(
    crawler.crawl(['https://site.test/feed.json'], first.kept, {
      signal: t.signal,
    }),
    first.kept,
  );

  assert.deepEqual(requests, ['/feed.json', '/b', '/a']);
});

test('fail makes a handed-back page due as a failed one: it is not deferred, and its next download has no body to compare', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html('<p>A</p>'),
    ),
  );
  const crawler = siteCrawler(new AdaptiveRevisit());
  const crawl = crawler.crawl(['https://site.test/'], null, {
    signal: t.signal,
  });
  for await (const entry of crawl)
    if ('response' in entry) crawl.fail(entry.url);
  const kept = applySnapshot(null, crawl.snapshot());

  t.mock.timers.setTime(hour);
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], kept, { signal: t.signal }),
    kept,
  );
  t.mock.timers.setTime(2 * hour);
  const retried = await crawled(
    crawler.crawl(['https://site.test/'], waiting.kept, {
      signal: t.signal,
    }),
    waiting.kept,
  );

  assert.deepEqual(waiting.pages, []);
  assert.deepEqual(waiting.deferred, []);
  assert.deepEqual(retried.pages, [{ path: '/a', change: 'unknown' }]);
  assert.throws(
    () => crawl.fail('https://site.test/never'),
    /did not hand back/,
  );
});

test('a linked page that is not due spends no LinkReader budget, so the budget reaches a page the last crawl could not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a><a href="/b">B</a>')
        : HttpResponse.html('<p>Page</p>');
    }),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new LinkReader({ maxDepth: 1, maxPages: 1 })],
    everyCrawl('https://site.test/', new AdaptiveRevisit()),
  );
  // No page is handed back, as no page links /nothing, so a linked page downloads only when LinkReader admits it.
  const linksOnly = (): CrawlOptions => ({
    ...{ signal: t.signal },
    include: [new URLPattern({ pathname: '/nothing' })],
  });

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, linksOnly()),
  );
  const firstRequests = requests.splice(0);
  t.mock.timers.setTime(hour);
  await crawled(
    crawler.crawl(['https://site.test/'], first.kept, linksOnly()),
    first.kept,
  );

  assert.deepEqual(firstRequests, ['/', '/a']);
  assert.deepEqual(requests, ['/', '/b']);
});

test('AlwaysRevisit makes every visited URL due in the next crawl, failed and gone ones too', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/a">A</a><a href="/gone">G</a><a href="/broken">B</a>',
        );
      if (path === '/gone') return new HttpResponse(null, { status: 404 });
      if (path === '/broken') return new HttpResponse(null, { status: 400 });
      return HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler(new AlwaysRevisit());

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, { signal: t.signal }),
  );
  t.mock.timers.setTime(1);
  requests.length = 0;
  await crawled(
    crawler.crawl(['https://site.test/'], first.kept, { signal: t.signal }),
    first.kept,
  );

  assert.deepEqual(requests.sort(), ['/', '/a', '/broken', '/gone']);
});

test('AdaptiveRevisit starts at one day, grows by half while unchanged up to fourteen days, and moves halfway to one hour when changed', () => {
  const policy = new AdaptiveRevisit();
  const visit = (
    outcome: 'unknown' | 'modified' | 'unmodified',
    history: { interval: number } | null,
  ) => policy.schedule({ request, outcome, headers: null, at: 0 }, history);

  const first = visit('unknown', null);
  const unchanged = visit('unmodified', first.history);
  const longest = visit('unmodified', { interval: 13 * day });
  const changed = visit('modified', { interval: day });

  assert.deepEqual(first, { due: day, history: { interval: day } });
  assert.equal(unchanged.due, 1.5 * day);
  assert.equal(longest.due, 14 * day);
  assert.equal(changed.due, (day + hour) / 2);
});

test('HintRevisit makes a URL due when its response stops being fresh, between one hour and fourteen days, and a day later when it declares nothing', () => {
  const policy = new HintRevisit();
  const due = (headers: Record<string, string> | null) =>
    policy.schedule(
      {
        request,
        outcome: 'unknown',
        headers: headers === null ? null : new Headers(headers),
        at: 0,
      },
      null,
    ).due;
  // A response with no Date header is as old as its arrival, now.
  // The response ages while the policy reads it, so compare whole seconds.
  assert.equal(
    Math.round((due({ 'cache-control': 'max-age=7200' }) ?? 0) / 1000),
    7200,
  );
  assert.equal(due({ 'cache-control': 'max-age=60' }), hour);
  assert.equal(due({ 'cache-control': 'max-age=31536000' }), 14 * day);
  assert.equal(due({}), day);
  assert.equal(due(null), day);
});

test('ChangeRateRevisit waits the estimated time between changes: the longest for a URL that never changed, shorter the more visits found a change', () => {
  const policy = new ChangeRateRevisit();
  const visits = (outcomes: ('modified' | 'unmodified')[]) => {
    let schedule = policy.schedule(
      { request, outcome: 'unknown', headers: null, at: 0 },
      null,
    );
    let at = 0;
    for (const outcome of outcomes) {
      at += day;
      schedule = policy.schedule(
        { request, outcome, headers: null, at },
        schedule.history,
      );
    }
    return (schedule.due ?? 0) - at;
  };

  const first = policy.schedule(
    { request, outcome: 'unknown', headers: null, at: 0 },
    null,
  );
  const never = visits(['unmodified', 'unmodified', 'unmodified']);
  const sometimes = visits([
    'modified',
    'unmodified',
    'unmodified',
    'unmodified',
  ]);
  const always = visits(['modified', 'modified', 'modified', 'modified']);

  assert.equal(first.due, day);
  assert.equal(never, 14 * day);
  // One change in four daily visits: -log(3.5 / 4.5) changes a day, about four days apart.
  assert.equal(Math.round(sometimes), Math.round(day / -Math.log(3.5 / 4.5)));
  // Every visit found a change: -log(0.5 / 4.5) changes a day, about half a day apart.
  assert.equal(Math.round(always), Math.round(day / -Math.log(0.5 / 4.5)));
});

test('CompositeRevisit routes a URL to the first matching policy or the fallback, each with its own failure rule, and starts a URL whose route changed with no history', () => {
  const policy = new CompositeRevisit(
    [[new URLPattern('https://site.test/feed*'), new AlwaysRevisit()]],
    new AdaptiveRevisit(),
  );
  const feed = { ...request, url: 'https://site.test/feed.xml' };
  const visit = (
    on: CrawlRequest,
    outcome: 'unknown' | 'failed',
    history: Parameters<typeof policy.schedule>[1],
  ) => policy.schedule({ request: on, outcome, headers: null, at: 0 }, history);

  const article = visit(request, 'unknown', null);
  const feedFailure = visit(feed, 'failed', null);
  const moved = visit(feed, 'unknown', article.history);

  assert.deepEqual(article, {
    due: day,
    history: { route: 1, history: { interval: day } },
  });
  assert.equal(feedFailure.due, 2 * hour);
  assert.deepEqual(moved.history, { route: 0, history: null });
  assert.equal(
    policy.due(
      request,
      { due: day, history: article.history, lastModified: null },
      hour,
    ),
    false,
  );
});

test('nextDue gives when the next crawl has a known URL due, starting URLs included, and null before any visit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : new HttpResponse(null, { status: 400 }),
    ),
  );
  const crawl = new Origins(got, null, globalThis)
    .crawler(
      got,
      [new LinkReader({ maxDepth: 1, maxPages: 100 })],
      new AdaptiveRevisit(),
    )
    .crawl(['https://site.test/'], null, { signal: t.signal });
  const before = crawl.nextDue();

  await crawled(crawl);

  assert.equal(before, null);
  // The start is due a day later; /a failed, so it is due two hours later.
  assert.equal(crawl.nextDue(), 2 * hour);
});

test('a feed is due again within half the time its items cover, whatever the policy, so it rolls no item off unseen', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let dated = true;
  await using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/feed.xml'
        ? HttpResponse.xml(
            `<rss version="2.0"><channel><title>Feed</title>${[10, 8, 6]
              .map(
                (hours) =>
                  `<item><link>https://site.test/${hours}</link>${dated ? `<pubDate>${new Date(Date.UTC(2026, 9, 26, hours)).toUTCString()}</pubDate>` : ''}</item>`,
              )
              .join('')}</channel></rss>`,
          )
        : HttpResponse.html('<p>Page</p>'),
    ),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new ListingReader()],
    new AdaptiveRevisit(),
  );

  const crawl = crawler.crawl(['https://site.test/feed.xml'], null, {
    signal: t.signal,
  });
  await crawled(crawl);
  dated = false;
  const undated = crawler.crawl(['https://site.test/feed.xml'], null, {
    signal: t.signal,
  });
  await crawled(undated);

  // The items cover four hours, so the feed is due within two; its pages a day later.
  assert.equal(crawl.nextDue(), 2 * hour);
  assert.equal(undated.nextDue(), day);
});

test('a listing makes a page due only by a lastModified that is a later time than the one it gave at the last visit, and not after the crawl starts', () => {
  const policy = new OnceRevisit();
  const loaded = policy.schedule(
    { request, outcome: 'unknown', headers: null, at: 0 },
    null,
  );
  const at = Date.parse('2026-11-01T00:00:00Z');
  const due = (listed: string, before: string | null) =>
    policy.due(
      { ...request, lastModified: listed },
      { ...loaded, lastModified: before },
      at,
    );

  assert.deepEqual(
    {
      sameTimeOtherFormat: due('2026-10-01T00:00:00Z', '2026-10-01'),
      older: due('2026-09-30', '2026-10-01'),
      later: due('2026-10-02', '2026-10-01'),
      laterFeedDate: due('Fri, 02 Oct 2026 08:00:00 GMT', '2026-10-01'),
      firstHint: due('2026-10-01', null),
      afterTheCrawlStarts: due('2099-01-01', '2026-10-01'),
      notATime: due('yesterday', '2026-10-01'),
    },
    {
      sameTimeOtherFormat: false,
      older: false,
      later: true,
      laterFeedDate: true,
      firstHint: true,
      afterTheCrawlStarts: false,
      notATime: false,
    },
  );
});

test('OnceRevisit never makes a page that loaded due again, and asks a failed or gone page again as every interval policy does', () => {
  const policy = new OnceRevisit();
  const visit = (outcome: Outcome) =>
    policy.schedule({ request, outcome, headers: null, at: 0 }, null);

  const loaded = visit('unknown');

  assert.deepEqual(loaded, { due: null, history: null });
  assert.deepEqual(visit('modified'), { due: null, history: null });
  assert.equal(visit('failed').due, 2 * hour);
  assert.equal(visit({ gone: 1 }).due, day);
  assert.equal(
    policy.due(request, { ...loaded, lastModified: null }, 365 * day),
    false,
  );
  assert.equal(
    policy.due(
      { ...request, lastModified: '2026-10-30' },
      { ...loaded, lastModified: '2026-10-01' },
      Date.parse('2026-11-01T00:00:00Z'),
    ),
    true,
  );
});
