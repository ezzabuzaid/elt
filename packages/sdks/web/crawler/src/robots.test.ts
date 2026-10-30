import assert from 'node:assert/strict';
import { test } from 'node:test';

import got from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  type Crawl,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

// Synthetic upstream sites make robots.txt answers reproducible offline.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledFrame: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

// A site whose sitemap lists /a, /private/b and /c, and whose robots.txt is the given answer.
function site(requests: string[], robots: () => Response) {
  return http.get('https://site.test/*', ({ request }) => {
    const { pathname } = new URL(request.url);
    requests.push(pathname);
    if (pathname === '/robots.txt') return robots();
    if (pathname === '/sitemap.xml')
      return HttpResponse.xml(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/a', '/private/b', '/c'].map((path) => `<url><loc>https://site.test${path}</loc></url>`).join('')}</urlset>`,
      );
    return HttpResponse.html(`<p>${pathname}</p>`);
  });
}

function crawler(headers: Record<string, string> = {}) {
  return new WebCrawler(got.extend({ retry: { limit: 0 }, headers }), [
    new ListingReader(),
  ]);
}

async function crawled(crawl: Crawl) {
  const pages: string[] = [];
  const failures: { url: string; message: string }[] = [];
  for await (const entry of crawl)
    if ('response' in entry) pages.push(new URL(entry.url).pathname);
    else if ('error' in entry)
      failures.push({
        url: new URL(entry.url).pathname,
        message: entry.error.message,
      });
  return {
    pages,
    failures,
    nextDue: crawl.nextDue(),
    memento: crawl.snapshot(),
  };
}

const starts = ['https://site.test/sitemap.xml'];
const options = () => ({ signal: AbortSignal.timeout(5000) });

test('a URL that robots.txt disallows is not requested, and the other pages are handed back', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    site(requests, () =>
      HttpResponse.text('User-agent: *\nDisallow: /private/\n'),
    ),
  );

  const result = await crawled(crawler().crawl(starts, null, options()));

  assert.equal(requests[0], '/robots.txt');
  assert.ok(!requests.includes('/private/b'));
  assert.deepEqual(result.pages, ['/a', '/c']);
  assert.deepEqual(result.failures, []);
  assert.equal(result.memento.crawl, null);
});

test('rules for another user agent do not apply, and rules for the client user agent do', async () => {
  const robots = () =>
    HttpResponse.text(
      'User-agent: OtherBot\nDisallow: /a\n\nUser-agent: ExampleBot\nDisallow: /c\n',
    );
  const requests: string[] = [];
  using server = mockWeb(site(requests, robots));

  const result = await crawled(
    crawler({ 'user-agent': 'ExampleBot/1.0' }).crawl(starts, null, options()),
  );

  assert.ok(!requests.includes('/c'));
  assert.deepEqual(result.pages, ['/a', '/private/b']);
});

test('a robots.txt that answers 404 allows every URL', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    site(requests, () => new HttpResponse(null, { status: 404 })),
  );

  const result = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(result.pages, ['/a', '/private/b', '/c']);
  assert.deepEqual(result.failures, []);
});

test('a robots.txt that answers 503 holds its origin until Retry-After, and the crawl ends unfinished', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    site(
      requests,
      () =>
        new HttpResponse(null, {
          status: 503,
          headers: { 'retry-after': '120' },
        }),
    ),
  );

  const result = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(requests, ['/robots.txt']);
  assert.deepEqual(result.pages, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]?.message ?? '', /robots\.txt.*503/);
  assert.notEqual(result.memento.crawl, null);
  assert.deepEqual(
    result.memento.crawl?.pending.map(({ url }) => new URL(url).pathname),
    ['/sitemap.xml'],
  );
  assert.equal(result.nextDue, 120_000);
});

test('a link that robots.txt disallows spends no LinkReader budget', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      if (pathname === '/robots.txt')
        return HttpResponse.text('User-agent: *\nDisallow: /private/\n');
      if (pathname === '/')
        return HttpResponse.html(
          '<a href="/private/a">A</a><a href="/b">B</a>',
        );
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  // No page links /nothing, so a linked page downloads only when LinkReader admits it.
  await crawled(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new LinkReader({ maxDepth: 1, maxPages: 1 }),
    ]).crawl(['https://site.test/'], null, {
      ...options(),
      include: [new URLPattern({ pathname: '/nothing' })],
    }),
  );

  assert.deepEqual(requests, ['/robots.txt', '/', '/b']);
});

test('a start that redirects to another origin spends no LinkReader budget on a link that robots.txt there disallows', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://a.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(`a.test${pathname}`);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return new HttpResponse(null, {
        status: 301,
        headers: { location: 'https://b.test/' },
      });
    }),
    http.get('https://b.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      requests.push(`b.test${pathname}`);
      if (pathname === '/robots.txt')
        return HttpResponse.text('User-agent: *\nDisallow: /private/\n');
      if (pathname === '/')
        return HttpResponse.html(
          '<a href="/private/a">A</a><a href="/b">B</a>',
        );
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
  );

  // No page links /nothing, so a linked page downloads only when LinkReader admits it.
  await crawled(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new LinkReader({ maxDepth: 1, maxPages: 1 }),
    ]).crawl(['https://a.test/'], null, {
      ...options(),
      include: [new URLPattern({ pathname: '/nothing' })],
    }),
  );

  assert.ok(requests.includes('b.test/b'), requests.join(' '));
  assert.ok(!requests.includes('b.test/private/a'), requests.join(' '));
});

test('a link that the crawl does not select is dropped, not held, on a website whose robots.txt answers 503', async () => {
  using server = mockWeb(
    http.get('https://list.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html(
        '<main><a href="https://flaky.test/post/2">Two</a><a href="https://flaky.test/post/3">Three</a></main>',
      );
    }),
    http.get(
      'https://flaky.test/*',
      () => new HttpResponse(null, { status: 503 }),
    ),
  );

  const result = await crawled(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new PaginationReader({ strategy: 'all' }),
    ]).crawl(['https://list.test/list'], null, {
      ...options(),
      include: [new URLPattern('https://flaky.test/post/2')],
    }),
  );

  assert.deepEqual(
    result.failures.map(({ url }) => url),
    ['/post/2'],
  );
  assert.deepEqual(
    result.memento.crawl?.pending.map(({ url }) => new URL(url).pathname),
    ['/post/2'],
  );
});

test('a link that the crawl does not select asks its website nothing, so a website whose robots.txt answers 503 fails nothing', async () => {
  const flaky: string[] = [];
  using server = mockWeb(
    http.get('https://list.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      if (pathname === '/list')
        return HttpResponse.html(
          '<main><a href="/post/1">Own</a><a href="https://flaky.test/post/2">Flaky</a></main>',
        );
      return HttpResponse.html(`<p>${pathname}</p>`);
    }),
    http.get('https://flaky.test/*', ({ request }) => {
      flaky.push(new URL(request.url).pathname);
      return new HttpResponse(null, { status: 503 });
    }),
  );

  const result = await crawled(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new PaginationReader({ strategy: 'all' }),
    ]).crawl(['https://list.test/list'], null, {
      ...options(),
      include: [new URLPattern('https://list.test/post/*')],
    }),
  );

  assert.deepEqual(result.pages, ['/post/1']);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(flaky, []);
  assert.equal(result.memento.crawl, null);
});

test('a robots.txt that answers 429 holds its origin as a 5xx does, not allowing everything as other 4xx answers do', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const requests: string[] = [];
  using server = mockWeb(
    site(
      requests,
      () =>
        new HttpResponse(null, {
          status: 429,
          headers: { 'retry-after': '60' },
        }),
    ),
  );

  const result = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(requests, ['/robots.txt']);
  assert.notEqual(result.memento.crawl, null);
  assert.equal(result.nextDue, 60_000);
});

test('Crawl-delay spaces the requests to its origin', async () => {
  const started: number[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/robots.txt')
        return HttpResponse.text('User-agent: *\nCrawl-delay: 1\n');
      started.push(performance.now());
      if (pathname === '/sitemap.xml')
        return HttpResponse.xml(
          '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://site.test/a</loc></url></urlset>',
        );
      return HttpResponse.html('<p>A</p>');
    }),
  );

  const result = await crawled(crawler().crawl(starts, null, options()));

  assert.deepEqual(result.pages, ['/a']);
  const [sitemap = 0, page = 0] = started;
  assert.equal(started.length, 2);
  // The crawler spaces its request starts; their arrival at the server jitters by a few milliseconds.
  assert.ok(
    page - sitemap >= 990,
    `requests started ${page - sitemap} ms apart`,
  );
});
