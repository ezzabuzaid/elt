import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  AdaptiveRevisit,
  AlwaysRevisit,
  ChangeRateRevisit,
  CompositeRevisit,
  type Crawl,
  type CrawlRequest,
  FixedRevisit,
  HintRevisit,
  LinkReader,
  ListingReader,
  type RevisitPolicy,
  WebCrawler,
  day,
  hour,
} from './index.ts';

// Synthetic upstream sites make page bodies and failures reproducible offline.
// They have no robots.txt, so the requests they record are the crawl's pages.
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
  return new URL(url).pathname;
}

// One crawl to its end: what it handed out by kind, and its memento as JSON gives it back.
async function crawled(crawl: Crawl) {
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
    memento: JSON.parse(JSON.stringify(crawl.snapshot())),
  };
}

function siteCrawler(revisit?: RevisitPolicy<unknown>) {
  return new WebCrawler(
    got,
    [new LinkReader({ maxDepth: 1, maxPages: 100 })],
    revisit,
  );
}

const options = () => ({ signal: AbortSignal.timeout(5000) });

const request: CrawlRequest = {
  url: 'https://site.test/a',
  listingUrl: 'https://site.test/',
  lastModified: null,
  hops: 1,
  start: false,
  page: true,
  list: false,
};

test('a page that is not due is not requested and comes out as deferred after the pages, and it is requested again once due', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler();

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, options()),
  );
  t.mock.timers.setTime(hour);
  requests.length = 0;
  const early = await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
  );
  t.mock.timers.setTime(day);
  requests.length = 0;
  const due = await crawled(
    crawler.crawl(['https://site.test/'], early.memento, options()),
  );

  assert.deepEqual(first.pages, [{ path: '/a', change: 'unknown' }]);
  assert.deepEqual(early.pages, []);
  assert.deepEqual(early.deferred, ['/a']);
  assert.equal(early.memento.crawl, null);
  assert.deepEqual(due.pages, [{ path: '/a', change: 'unmodified' }]);
  assert.deepEqual(due.deferred, []);
  assert.deepEqual(requests, ['/', '/a']);
});

test('a caller that keeps no memento gets every page on every crawl', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return HttpResponse.html('<a href="/a">A</a>');
    }),
  );
  const crawler = siteCrawler();

  await crawled(crawler.crawl(['https://site.test/'], null, options()));
  const again = await crawled(
    crawler.crawl(['https://site.test/'], null, options()),
  );

  assert.deepEqual(again.pages, [{ path: '/a', change: 'unknown' }]);
  assert.deepEqual(requests, ['/', '/a', '/', '/a']);
});

test('a page whose body changed is handed back as modified', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let body = '<p>First</p>';
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html(body),
    ),
  );
  const crawler = siteCrawler(new FixedRevisit({ every: hour }));

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, options()),
  );
  body = '<p>Second</p>';
  t.mock.timers.setTime(hour);
  const changed = await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
  );

  assert.deepEqual(changed.pages, [{ path: '/a', change: 'modified' }]);
});

test('a visit is timed at the start of its crawl, so a page due one interval later is due in the crawl that starts then', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  using server = mockWeb(
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
    crawler.crawl(['https://site.test/'], null, options()),
  );
  t.mock.timers.setTime(hour);
  const next = await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
  );

  assert.deepEqual(next.pages, [{ path: '/a', change: 'unmodified' }]);
});

test('a failed page is due again two hours later even when nothing lists it, and is not deferred before then', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let listed = true;
  let broken = true;
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      if (pathOf(request.url) === '/')
        return HttpResponse.html(listed ? '<a href="/a">A</a>' : '<p>Home</p>');
      return broken
        ? new HttpResponse(null, { status: 400 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler();

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, options()),
  );
  t.mock.timers.setTime(hour);
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
  );
  listed = false;
  broken = false;
  t.mock.timers.setTime(2 * hour);
  requests.length = 0;
  const retried = await crawled(
    crawler.crawl(['https://site.test/'], waiting.memento, options()),
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
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      if (pathOf(request.url) === '/')
        return HttpResponse.html('<a href="/a">A</a>');
      return gone
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.html('<p>A</p>');
    }),
  );
  const crawler = siteCrawler();

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, options()),
  );
  t.mock.timers.setTime(hour);
  requests.length = 0;
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
  );
  const waitingRequests = requests.splice(0);
  gone = false;
  t.mock.timers.setTime(day);
  const back = await crawled(
    crawler.crawl(['https://site.test/'], waiting.memento, options()),
  );

  assert.deepEqual(waitingRequests, ['/']);
  assert.deepEqual(waiting.deferred, []);
  assert.deepEqual(back.pages, [{ path: '/a', change: 'unknown' }]);
});

test('a listing that gives a page another lastModified makes it due at once, and the page carries the new hint', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let lastModified = '2026-10-01';
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/sitemap.xml'
        ? HttpResponse.xml(
            `<urlset><url><loc>https://site.test/a</loc><lastmod>${lastModified}</lastmod></url></urlset>`,
          )
        : HttpResponse.html('<p>A</p>'),
    ),
  );
  const crawler = new WebCrawler(got, [new ListingReader()]);
  const hinted = async (memento: unknown) => {
    const hints: (string | null)[] = [];
    const crawl = crawler.crawl(
      ['https://site.test/sitemap.xml'],
      memento,
      options(),
    );
    for await (const entry of crawl)
      if ('response' in entry) hints.push(entry.lastModified);
    return { hints, memento: JSON.parse(JSON.stringify(crawl.snapshot())) };
  };

  const first = await hinted(null);
  t.mock.timers.setTime(hour);
  const same = await hinted(first.memento);
  lastModified = '2026-10-02';
  const changed = await hinted(same.memento);

  assert.deepEqual(first.hints, ['2026-10-01']);
  assert.deepEqual(same.hints, []);
  assert.deepEqual(changed.hints, ['2026-10-02']);
});

test('a known page that is due and that no listing names goes after the pages this crawl lists', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let items = ['/a'];
  const requests: string[] = [];
  using server = mockWeb(
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
  const crawler = new WebCrawler(
    got,
    [new ListingReader()],
    new AlwaysRevisit(),
  );

  const first = await crawled(
    crawler.crawl(['https://site.test/feed.json'], null, options()),
  );
  items = ['/b'];
  t.mock.timers.setTime(1);
  requests.length = 0;
  await crawled(
    crawler.crawl(['https://site.test/feed.json'], first.memento, options()),
  );

  assert.deepEqual(requests, ['/feed.json', '/b', '/a']);
});

test('fail makes a handed-back page due as a failed one: it is not deferred, and its next download has no body to compare', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : HttpResponse.html('<p>A</p>'),
    ),
  );
  const crawler = siteCrawler();
  const crawl = crawler.crawl(['https://site.test/'], null, options());
  for await (const entry of crawl)
    if ('response' in entry) crawl.fail(entry.url);
  const memento = JSON.parse(JSON.stringify(crawl.snapshot()));

  t.mock.timers.setTime(hour);
  const waiting = await crawled(
    crawler.crawl(['https://site.test/'], memento, options()),
  );
  t.mock.timers.setTime(2 * hour);
  const retried = await crawled(
    crawler.crawl(['https://site.test/'], waiting.memento, options()),
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
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(pathOf(request.url));
      return pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a><a href="/b">B</a>')
        : HttpResponse.html('<p>Page</p>');
    }),
  );
  const crawler = new WebCrawler(got, [
    new LinkReader({ maxDepth: 1, maxPages: 1 }),
  ]);
  // No page is handed back, so a linked page downloads only when LinkReader admits it.
  const linksOnly = () => ({ ...options(), include: [] });

  const first = await crawled(
    crawler.crawl(['https://site.test/'], null, linksOnly()),
  );
  const firstRequests = requests.splice(0);
  t.mock.timers.setTime(hour);
  await crawled(
    crawler.crawl(['https://site.test/'], first.memento, linksOnly()),
  );

  assert.deepEqual(firstRequests, ['/', '/a']);
  assert.deepEqual(requests, ['/', '/b']);
});

test('AlwaysRevisit makes every visited URL due in the next crawl, failed and gone ones too', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
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
    crawler.crawl(['https://site.test/'], null, options()),
  );
  t.mock.timers.setTime(1);
  requests.length = 0;
  await crawled(
    crawler.crawl(['https://site.test/'], first.memento, options()),
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
  assert.equal(feedFailure.due, 0);
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
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) =>
      pathOf(request.url) === '/'
        ? HttpResponse.html('<a href="/a">A</a>')
        : new HttpResponse(null, { status: 400 }),
    ),
  );
  const crawl = siteCrawler().crawl(['https://site.test/'], null, options());
  const before = crawl.nextDue();

  await crawled(crawl);

  assert.equal(before, null);
  // The start is due a day later; /a failed, so it is due two hours later.
  assert.equal(crawl.nextDue(), 2 * hour);
});

test('a feed is due again within half the time its items cover, whatever the policy, so it rolls no item off unseen', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let dated = true;
  using server = mockWeb(
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
  const crawler = new WebCrawler(got, [new ListingReader()]);

  const crawl = crawler.crawl(['https://site.test/feed.xml'], null, options());
  await crawled(crawl);
  dated = false;
  const undated = crawler.crawl(
    ['https://site.test/feed.xml'],
    null,
    options(),
  );
  await crawled(undated);

  // The items cover four hours, so the feed is due within two; its pages a day later.
  assert.equal(crawl.nextDue(), 2 * hour);
  assert.equal(undated.nextDue(), day);
});
