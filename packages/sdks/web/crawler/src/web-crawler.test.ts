import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Msw } from '@zukhruf/testing/msw';
import got, { HTTPError, type Response } from 'got';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';

import {
  AdaptiveRevisit,
  ArchiveReader,
  type Crawl,
  CrawlError,
  type CrawlFailure,
  type CrawlOptions,
  type CrawledPage,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  Reader,
} from './index.ts';

// Got retries no network error, so a test's failure is its first answer.
const noRetries = got.extend({ retry: { limit: 0 } });

// Synthetic upstream sites make cycles, redirects and failures reproducible offline.

// A site without robots.txt, answered before the handlers that record requests,
// for tests whose readers do not read robots.txt themselves.
const noRobots = http.get(
  '*/robots.txt',
  () => new HttpResponse(null, { status: 404 }),
);

function pathOf(url: string) {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

function pageOf(entry: CrawledPage | CrawlFailure): CrawledPage {
  if ('error' in entry) throw entry.error;
  return entry;
}

// Progress entries only mark URLs read for the readers; these tests assert pages and failures.
async function results(crawl: Crawl) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawl)
    if (!('progress' in entry) && !('deferred' in entry)) entries.push(entry);
  return entries;
}

test('crawls links itself and preserves URL identity, provenance and Got responses', async () => {
  const requests: string[] = [];
  const responses = new Map<string, Response>();
  using server = new Msw().intercept(
    noRobots,
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      assert.equal(request.headers.get('x-crawl'), 'configured');
      if (path === '/')
        return HttpResponse.html(
          `
      <base href="/docs/">
      <link rel="next" href="/next">
      <a href="one#first">One</a><a href="one#second">Duplicate</a>
      <nav><a href="/post">Post</a></nav><footer><a href="/post/">Post slash</a></footer>
      <a href="/post?a=1&b=2">Query</a><a href="/post?b=2&a=1">Other query</a>
      <a href="https://outside.test/no">Outside</a>
      <a href="mailto:test@example.test">Mail</a><a href="http://[">Invalid</a>
    `,
          { headers: { link: '</history>; rel="archives"' } },
        );
      if (path === '/docs/one')
        return HttpResponse.html(
          '<a href="/leaf">Leaf</a><a href="/">Cycle</a>',
        );
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const client = got.extend({
    headers: { 'x-crawl': 'configured' },
    hooks: {
      afterResponse: [
        (response) => {
          responses.set(response.url, response);
          return response;
        },
      ],
    },
  });
  const pages = (
    await results(
      new Origins(client, null, globalThis)
        .crawler(
          client,
          [new LinkReader({ maxDepth: 3, maxPages: 100 })],
          new AdaptiveRevisit(),
        )
        .crawl(['https://site.test/'], null, {
          signal: AbortSignal.timeout(120_000),
        }),
    )
  ).map(pageOf);
  // /docs/one links the starting page, so the start is a page too and comes back last; link elements and Link headers belong to ArchiveReader.
  assert.deepEqual(
    pages.map((page) => pathOf(page.url)),
    [
      '/docs/one',
      '/post',
      '/post/',
      '/post?a=1&b=2',
      '/post?b=2&a=1',
      '/leaf',
      '/',
    ],
  );
  assert.deepEqual(requests, ['/', ...pages.map((page) => pathOf(page.url))]);
  assert.equal(
    pages.find((page) => page.url.endsWith('/leaf'))?.listingUrl,
    'https://site.test/docs/one',
  );
  assert.equal(pages[0]?.listingUrl, 'https://site.test/');
  for (const page of pages) {
    assert.equal(page.response, responses.get(page.url));
    assert.equal(page.lastModified, null);
    assert.ok(page.response.body instanceof Uint8Array);
  }
});

test('each found URL is requested once for each role it adds, and a redirect is a request of its own, so a target that two URLs reach downloads once', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    noRobots,
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/alias">Alias</a><a href="/target">Target</a><a href="/#part">Home</a><a href="/external">External</a>',
        );
      if (path === '/alias')
        return new HttpResponse(null, {
          status: 302,
          headers: { location: '/target' },
        });
      if (path === '/external')
        return new HttpResponse(null, {
          status: 302,
          headers: { location: 'https://remote.test/page' },
        });
      return HttpResponse.html('<a href="/alias">Alias</a><p>Target</p>');
    }),
    http.get('https://remote.test/page', () =>
      HttpResponse.html('<a href="/no">Outside</a>'),
    ),
  );
  const pages = (
    await results(
      new Origins(got, null, globalThis)
        .crawler(
          got,
          [new LinkReader({ maxDepth: 3, maxPages: 100 })],
          new AdaptiveRevisit(),
        )
        .crawl(['https://site.test/'], null, {
          signal: AbortSignal.timeout(120_000),
        }),
    )
  ).map(pageOf);
  // The alias's redirect names /target, which the start also links, so
  // /target downloads once. / links itself as /#part, so the start is
  // requested again as a page. The redirect of /external is a request of
  // remote.test's own, which hands back its page.
  assert.deepEqual(requests, ['/', '/alias', '/target', '/', '/external']);
  assert.deepEqual(
    pages.map((page) => [page.url, page.response.url]),
    [
      ['https://site.test/target', 'https://site.test/target'],
      ['https://site.test/', 'https://site.test/'],
      ['https://remote.test/page', 'https://remote.test/page'],
    ],
  );
});

test('failures are handed out with their URL while independent pages continue, and a new crawl retries', async () => {
  let broken = true;
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/bad">Bad</a><a href="/missing">Missing</a><a href="/gone">Gone</a><a href="/good">Good</a>',
        );
      if (path === '/bad' && broken)
        return new HttpResponse(null, { status: 503 });
      if (path === '/missing') return new HttpResponse(null, { status: 404 });
      if (path === '/gone') return new HttpResponse(null, { status: 410 });
      return HttpResponse.html('<p>Good</p>');
    }),
  );
  const crawler = new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new LinkReader({ maxDepth: 3, maxPages: 100 })],
    new AdaptiveRevisit(),
  );
  const entries = await results(
    crawler.crawl(['https://site.test/'], null, {
      signal: AbortSignal.timeout(120_000),
    }),
  );
  assert.equal(entries.length, 2);
  const [failure, good] = entries;
  assert.ok(failure && 'error' in failure);
  assert.equal(failure.url, 'https://site.test/bad');
  assert.equal(failure.listingUrl, 'https://site.test/');
  assert.ok(failure.error instanceof CrawlError);
  assert.equal(failure.error.url, 'https://site.test/bad');
  assert.ok(failure.error.cause instanceof HTTPError);
  assert.equal(good && pageOf(good).url, 'https://site.test/good');
  broken = false;
  const retried = (
    await results(
      crawler.crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
    )
  ).map(pageOf);
  assert.deepEqual(
    retried.map((page) => pathOf(page.url)),
    ['/bad', '/good'],
  );
  assert.equal(requests.filter((path) => path === '/bad').length, 2);
});

test('a failed starting URL is handed out as a failure', async () => {
  using server = new Msw().intercept(
    noRobots,
    http.get(
      'https://site.test/missing',
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
  const entries = await results(
    new Origins(noRetries, null, globalThis)
      .crawler(
        noRetries,
        [new LinkReader({ maxDepth: 3, maxPages: 100 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/missing'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.equal(entries.length, 1);
  const [failure] = entries;
  assert.ok(failure && 'error' in failure);
  assert.equal(failure.error.url, 'https://site.test/missing');
});

test('consumer backpressure and early break stop fetching, and crawls remain isolated', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    noRobots,
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      return HttpResponse.html(
        path === '/'
          ? '<a href="/child">Child</a><a href="/second">Second</a>'
          : '<p>Child</p>',
      );
    }),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new LinkReader({ maxDepth: 3, maxPages: 100 })],
    new AdaptiveRevisit(),
  );
  for await (const entry of crawler.crawl(['https://site.test/'], null, {
    signal: AbortSignal.timeout(120_000),
  })) {
    if ('progress' in entry || 'deferred' in entry) continue;
    assert.equal(pageOf(entry).url, 'https://site.test/child');
    assert.deepEqual(requests, ['/', '/child']);
    break;
  }
  assert.deepEqual(requests, ['/', '/child']);
  const [first, second] = await Promise.all([
    results(
      crawler.crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
    ),
    results(
      crawler.crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
    ),
  ]);
  assert.deepEqual(
    first.map((entry) => pageOf(entry).url),
    ['https://site.test/child', 'https://site.test/second'],
  );
  assert.deepEqual(
    second.map((entry) => pageOf(entry).url),
    ['https://site.test/child', 'https://site.test/second'],
  );
  assert.equal(requests.filter((path) => path === '/child').length, 3);
});

test(
  'cancellation interrupts an in-flight request with the exact reason',
  { timeout: 10000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using server = new Msw().intercept(
      noRobots,
      http.get('https://site.test/slow', async () => {
        entered.resolve();
        // MSW's synthetic Request.signal does not mirror Node request aborts.
        await release.promise;
        return HttpResponse.html('<p>Stopped</p>');
      }),
    );
    const stop = new AbortController();
    const reason = new Error('stop this crawl');
    const crawler = new Origins(got, null, globalThis).crawler(
      got,
      [new LinkReader({ maxDepth: 3, maxPages: 100 })],
      new AdaptiveRevisit(),
    );
    const run = Array.fromAsync(
      crawler.crawl(['https://site.test/slow'], null, {
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)]),
      }),
    );
    try {
      await entered.promise;
      stop.abort(reason);
      await assert.rejects(run, (error) => error === reason);
      await assert.rejects(
        Array.fromAsync(
          crawler.crawl(['https://site.test/unused'], null, {
            signal: stop.signal,
          }),
        ),
        (error) => error === reason,
      );
    } finally {
      stop.abort(reason);
      release.resolve();
    }
  },
);

test('validates readers and starting URLs and accepts an empty crawl', async () => {
  assert.throws(
    () =>
      new Origins(got, null, globalThis).crawler(
        got,
        [],
        new AdaptiveRevisit(),
      ),
    TypeError,
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new LinkReader({ maxDepth: 0, maxPages: 0 })],
    new AdaptiveRevisit(),
  );
  assert.deepEqual(
    await Array.fromAsync(
      crawler.crawl([], null, { signal: AbortSignal.timeout(120_000) }),
    ),
    [],
  );
  for (const input of ['relative', 'file:///etc/hosts', 'ftp://site.test/feed'])
    assert.throws(() =>
      crawler.crawl([input], null, { signal: AbortSignal.timeout(120_000) }),
    );
});

test('include hands back only matching pages and never requests non-matching pages beyond the link limits', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    noRobots,
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/x1">X1</a><a href="/x2">X2</a><a href="/keep/1">Keep</a>',
        );
      return HttpResponse.html(`<a href="${path}/child">Child</a>`);
    }),
  );
  const pages = (
    await results(
      new Origins(got, null, globalThis)
        .crawler(
          got,
          [new LinkReader({ maxDepth: 1, maxPages: 1 })],
          new AdaptiveRevisit(),
        )
        .crawl(['https://site.test/'], null, {
          signal: AbortSignal.timeout(120_000),
          include: [new URLPattern({ pathname: '/keep/*' })],
        }),
    )
  ).map(pageOf);
  assert.deepEqual(
    pages.map((page) => pathOf(page.url)),
    ['/keep/1'],
  );
  // /x1 is admitted (one page) and read for links; /x2 and every child are past the limits.
  assert.deepEqual(requests, ['/', '/x1', '/keep/1']);
});

test('Got hooks see options.context.page only for handed-back pages that no reader reads as a document', async () => {
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      if (path === '/')
        return HttpResponse.html(
          '<link rel="alternate" type="application/rss+xml" href="/keep/feed"><a href="/keep/feed">Feed</a><a href="/keep/page">Keep</a><a href="/skip">Skip</a>',
        );
      if (path === '/keep/feed')
        return HttpResponse.xml(
          '<rss><channel><item><link>/keep/listed</link></item></channel></rss>',
        );
      if (path === '/robots.txt' || path === '/sitemap.xml')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const seen = new Map<string, unknown>();
  const client = got.extend({
    hooks: {
      beforeRequest: [
        (options) => {
          seen.set(pathOf(String(options.url)), options.context.page);
        },
      ],
    },
  });
  const pages = (
    await results(
      new Origins(client, null, globalThis)
        .crawler(
          client,
          [new ListingReader(), new LinkReader({ maxDepth: 1, maxPages: 100 })],
          new AdaptiveRevisit(),
        )
        .crawl(['https://site.test/'], null, {
          signal: AbortSignal.timeout(120_000),
          include: [new URLPattern({ pathname: '/keep/*' })],
        }),
    )
  ).map(pageOf);
  assert.deepEqual(pages.map((page) => pathOf(page.url)).toSorted(), [
    '/keep/feed',
    '/keep/listed',
    '/keep/page',
  ]);
  // /keep/feed is also a listing: a reader needs its own representation, so the caller's hook leaves it alone.
  assert.deepEqual(Object.fromEntries(seen), {
    '/': false,
    '/robots.txt': false,
    '/keep/feed': false,
    '/keep/page': true,
    '/keep/listed': true,
    '/skip': false,
  });
});

test('a snapshot resumes the crawl without repeating finished work and hands out the last entry again', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    noRobots,
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a>',
        );
      if (path === '/p3') return HttpResponse.html('<a href="/deep">Deep</a>');
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const crawler = new Origins(got, null, globalThis).crawler(
    got,
    [new LinkReader({ maxDepth: 3, maxPages: 100 })],
    new AdaptiveRevisit(),
  );
  const first = crawler.crawl(['https://site.test/'], null, {
    signal: AbortSignal.timeout(120_000),
  });
  const handed: string[] = [];
  for await (const entry of first) {
    if ('progress' in entry || 'deferred' in entry) continue;
    handed.push(pathOf(pageOf(entry).url));
    if (handed.length === 2) break;
  }
  assert.deepEqual(handed, ['/p1', '/p2']);
  const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
  requests.length = 0;
  const resumed = (
    await results(
      crawler.crawl(['https://site.test/'], snapshot, {
        signal: AbortSignal.timeout(120_000),
      }),
    )
  ).map(pageOf);
  assert.deepEqual(
    resumed.map((page) => pathOf(page.url)),
    ['/p2', '/p3', '/deep'],
  );
  // The starting page is not due, so it is not read again; /deep proves that
  // the memento kept its origin as a starting page's.
  assert.deepEqual(requests, ['/p2', '/p3', '/deep']);
});

test('a failure is marked as a page only for a page include matches, not for a starting URL or a declared listing', async () => {
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      if (path === '/')
        return HttpResponse.html(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/keep/bad">Bad</a>',
        );
      if (path === '/feed.xml' || path === '/keep/bad')
        return new HttpResponse(null, { status: 503 });
      return new HttpResponse(null, { status: 404 });
    }),
  );
  const entries = await results(
    new Origins(noRetries, null, globalThis)
      .crawler(
        noRetries,
        [new ListingReader(), new LinkReader({ maxDepth: 1, maxPages: 100 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/', 'https://site.test/missing'], null, {
        signal: AbortSignal.timeout(120_000),
        include: [new URLPattern({ pathname: '/keep/*' })],
      }),
  );
  const failures = entries.map((entry) => {
    assert.ok('error' in entry);
    assert.ok(entry.error instanceof CrawlError);
    return [pathOf(entry.url), entry.error.page];
  });
  assert.deepEqual(Object.fromEntries(failures), {
    '/missing': false,
    '/feed.xml': false,
    '/keep/bad': true,
  });
  assert.equal(failures.length, 3);
});

function progressSite(requests: string[]) {
  return new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/hub">Hub</a>',
        );
      if (path === '/feed.xml')
        return HttpResponse.xml(
          '<rss><channel><item><link>/keep/1</link></item><item><link>/keep/2</link></item></channel></rss>',
        );
      if (path === '/hub')
        return HttpResponse.html(
          '<a href="/keep/3">3</a><a href="/keep/bad">Bad</a>',
        );
      if (path === '/keep/bad') return new HttpResponse(null, { status: 503 });
      if (path.startsWith('/keep/')) return HttpResponse.html('<p>Page</p>');
      return new HttpResponse(null, { status: 404 });
    }),
  );
}

function progressCrawler(origins: Origins) {
  return origins.crawler(
    noRetries,
    [new ListingReader(), new LinkReader({ maxDepth: 1, maxPages: 100 })],
    new AdaptiveRevisit(),
  );
}

test('every downloaded URL that is not handed back as a page or failure is handed out once as progress', async () => {
  const requests: string[] = [];
  using server = progressSite(requests);
  const entries = await Array.fromAsync(
    progressCrawler(new Origins(noRetries, null, globalThis)).crawl(
      ['https://site.test/'],
      null,
      {
        signal: AbortSignal.timeout(120_000),
        include: [new URLPattern({ pathname: '/keep/*' })],
      },
    ),
  );
  const progress = entries.flatMap((entry) =>
    'progress' in entry ? [pathOf(entry.progress)] : [],
  );
  const handed = entries.flatMap((entry) =>
    'progress' in entry || 'deferred' in entry ? [] : [pathOf(entry.url)],
  );
  // The starting page, the feed, robots.txt's tolerated 404 and a page read only for its links.
  assert.deepEqual(progress, ['/', '/feed.xml', '/robots.txt', '/hub']);
  // The crawl reads the origin's rules before its first request; that one
  // download is also robots.txt's progress entry.
  assert.equal(requests[0], '/robots.txt');
  assert.deepEqual(handed.toSorted(), [
    '/keep/1',
    '/keep/2',
    '/keep/3',
    '/keep/bad',
  ]);
  assert.deepEqual(requests.toSorted(), [...progress, ...handed].toSorted());
});

test('a snapshot taken at a progress entry resumes without downloading the documents read before it', async () => {
  const requests: string[] = [];
  using server = progressSite(requests);
  const options: CrawlOptions = {
    signal: AbortSignal.timeout(120_000),
    include: [new URLPattern({ pathname: '/keep/*' })],
  };
  const origins = new Origins(noRetries, null, globalThis);
  const first = progressCrawler(origins).crawl(
    ['https://site.test/'],
    null,
    options,
  );
  for await (const entry of first)
    if ('progress' in entry && pathOf(entry.progress) === '/robots.txt') break;
  assert.deepEqual(requests, ['/robots.txt', '/', '/feed.xml']);
  const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
  requests.length = 0;
  // The resumed crawl is a read of its own, whose origins' records start from the last read's.
  const resumed = await results(
    progressCrawler(
      new Origins(noRetries, origins.snapshot(), globalThis),
    ).crawl(['https://site.test/'], snapshot, options),
  );
  // The starting page is not due, so it is not read again. The progress
  // entry's own URL is unfinished until the next entry is requested, so it is
  // read once more; the origin's rules last 24 hours (RFC 9309 §2.4), so the
  // resumed crawl does not read them again for its pages.
  assert.equal(requests[0], '/robots.txt');
  assert.ok(!requests.includes('/'), requests.join(' '));
  assert.ok(!requests.includes('/feed.xml'), requests.join(' '));
  assert.deepEqual(requests.toSorted(), [
    '/hub',
    '/keep/1',
    '/keep/2',
    '/keep/3',
    '/keep/bad',
    '/robots.txt',
  ]);
  assert.deepEqual(resumed.map((entry) => pathOf(entry.url)).toSorted(), [
    '/keep/1',
    '/keep/2',
    '/keep/3',
    '/keep/bad',
  ]);
});

test('a page labeled Latin-1 in its Content-Type is handed back, and every reader reads it by that charset', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/') return HttpResponse.html('<a href="/latin">Latin</a>');
      if (path === '/latin')
        return new HttpResponse(
          Buffer.from(
            // Only ArchiveReader reads <link rel="archives">, and only LinkReader reads anchors.
            '<link rel="alternate" type="application/rss+xml" href="/flux-café.xml"><link rel="archives" href="/archives/café/"><a href="/café">Café</a>',
            'latin1',
          ),
          { headers: { 'content-type': 'text/html; charset=iso-8859-1' } },
        );
      if (path === '/flux-caf%C3%A9.xml')
        return HttpResponse.xml(
          '<rss version="2.0"><channel><title>Journal</title><link>https://site.test/</link><description>Updates</description></channel></rss>',
        );
      if (path === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const entries = await results(
    new Origins(got, null, globalThis)
      .crawler(
        got,
        [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
          new LinkReader({ maxDepth: 2, maxPages: 10 }),
        ],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.deepEqual(
    entries.filter((entry) => 'error' in entry),
    [],
  );
  const pages = entries.map((entry) => pathOf(entry.url));
  // Decoded as Latin-1, the byte E9 is é; any other decoding would request a different path.
  assert.ok(
    pages.includes('/latin') && pages.includes('/caf%C3%A9'),
    pages.join(' '),
  );
  assert.ok(requests.includes('/flux-caf%C3%A9.xml'), requests.join(' '));
  assert.ok(requests.includes('/archives/caf%C3%A9/'), requests.join(' '));
});

test('a page labeled only by its <meta charset> is read by that charset', async () => {
  const requests: string[] = [];
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      requests.push(path);
      if (path === '/') return HttpResponse.html('<a href="/meta">Meta</a>');
      if (path === '/meta')
        return new HttpResponse(
          Buffer.from(
            '<meta charset="windows-1252"><a href="/café">Café</a>',
            'latin1',
          ),
          { headers: { 'content-type': 'text/html' } },
        );
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  await results(
    new Origins(got, null, globalThis)
      .crawler(
        got,
        [new LinkReader({ maxDepth: 2, maxPages: 10 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.ok(requests.includes('/caf%C3%A9'), requests.join(' '));
});

test('an unlabeled page is read as UTF-8, and one that is not valid UTF-8 is still handed back with its links followed', async () => {
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/legacy">Legacy</a><a href="/modern">Modern</a>',
        );
      if (path === '/modern')
        return new HttpResponse(Buffer.from('<a href="/café">Café</a>'), {
          headers: { 'content-type': 'text/html' },
        });
      if (path === '/legacy')
        return new HttpResponse(
          Buffer.from('<p>Café</p><a href="/next">Next</a>', 'latin1'),
          { headers: { 'content-type': 'text/html' } },
        );
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const entries = await results(
    new Origins(got, null, globalThis)
      .crawler(
        got,
        [new LinkReader({ maxDepth: 2, maxPages: 10 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.deepEqual(
    entries.map((entry) =>
      'error' in entry ? `failure ${pathOf(entry.url)}` : pathOf(entry.url),
    ),
    ['/legacy', '/modern', '/next', '/caf%C3%A9'],
  );
});

test('a reader that throws on a response does not stop the readers after it or drop the page', async () => {
  // A reader that cannot read anything, placed before the built-in readers.
  class BrokenReader extends Reader<never, null> {
    readonly notes = z.never();
    readonly states = z.null();
    open() {
      return null;
    }
    wants() {
      return false;
    }
    read(): never {
      throw new Error('The reader broke');
    }
  }
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      if (path === '/') return HttpResponse.html('<a href="/page">Page</a>');
      if (path === '/page')
        return HttpResponse.html('<a href="/next">Next</a>');
      return HttpResponse.html('<p>Leaf</p>');
    }),
  );
  const entries = await results(
    new Origins(got, null, globalThis)
      .crawler(
        got,
        [new BrokenReader(), new LinkReader({ maxDepth: 2, maxPages: 10 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.deepEqual(
    entries.flatMap((entry) => ('error' in entry ? [] : [pathOf(entry.url)])),
    ['/page', '/next'],
  );
  assert.deepEqual(
    entries.flatMap((entry) =>
      'error' in entry
        ? [
            [
              pathOf(entry.error.url),
              entry.error.page,
              String(entry.error.cause),
            ],
          ]
        : [],
    ),
    [
      ['/', false, 'Error: The reader broke'],
      ['/page', false, 'Error: The reader broke'],
      ['/next', false, 'Error: The reader broke'],
    ],
  );
});

test('a declared listing that one reader cannot read keeps what the other readers find in it', async () => {
  using server = new Msw().intercept(
    http.get('https://site.test/*', ({ request }) => {
      const path = pathOf(request.url);
      if (path === '/')
        return HttpResponse.html('<link rel="sitemap" href="/map">');
      if (path === '/map')
        return HttpResponse.html('<a href="/found">Found</a>');
      if (path === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Leaf</p>');
    }),
  );
  const entries = await results(
    new Origins(got, null, globalThis)
      .crawler(
        got,
        [new ListingReader(), new LinkReader({ maxDepth: 2, maxPages: 10 })],
        new AdaptiveRevisit(),
      )
      .crawl(['https://site.test/'], null, {
        signal: AbortSignal.timeout(120_000),
      }),
  );
  assert.deepEqual(
    entries.map((entry) =>
      'error' in entry
        ? `failure ${pathOf(entry.error.url)}`
        : pathOf(entry.url),
    ),
    ['failure /map', '/found'],
  );
});
