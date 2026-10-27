import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  ArchiveReader,
  type CrawlFailure,
  type CrawledPage,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

function listings() {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new ListingReader(),
    new ArchiveReader(),
    new PaginationReader(),
  ]);
}

// Progress entries only mark URLs read for the readers; these tests assert pages and failures.
async function crawl(crawler: WebCrawler, start: string, signal: AbortSignal) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawler.crawl([start], null, { signal }))
    if (!('progress' in entry) && !('deferred' in entry)) entries.push(entry);
  return entries;
}

function location(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  const { url, listingUrl, lastModified } = entry;
  return { url, lastModified, listingUrl };
}

test('website archives discover older posts beyond the feed, following pagination without following articles or off-site links', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    switch (request.url) {
      case '/':
        response.end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/archive/">Archives</a>',
        );
        break;
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          '<rss><channel><item><link>/recent</link></item></channel></rss>',
        );
        break;
      case '/archive/':
        response.end(
          '<base href="/history/"><main><a href="/recent">Recent report</a><a href="/old">Older report</a><a rel="next" href="second">Next</a><a href="https://external.example/story">External reference</a><a href="mailto:editor@example.com">Email</a></main><nav><a href="/about">About</a></nav>',
        );
        break;
      case '/history/second':
        response.end(
          '<main><a href="/old#again">Older report</a><a href="/oldest">First report</a><a rel="prev" href="/archive/">Previous</a></main>',
        );
        break;
      case '/recent':
      case '/old':
      case '/oldest':
        // An article's own links are not listings.
        response.end('<main><a href="/unrelated">Unrelated</a></main>');
        break;
      case '/robots.txt':
        response.writeHead(404).end();
        break;
      default:
        response.writeHead(500).end('Unexpected download');
    }
  });
  assert.deepEqual(
    (await crawl(listings(), upstream.origin, AbortSignal.timeout(5000))).map(
      location,
    ),
    [
      // The starting page is a list, and an archive it links is one of its pages too.
      {
        url: `${upstream.origin}/archive/`,
        lastModified: null,
        listingUrl: `${upstream.origin}/`,
      },
      {
        url: `${upstream.origin}/recent`,
        lastModified: null,
        listingUrl: `${upstream.origin}/feed.xml`,
      },
      {
        url: `${upstream.origin}/old`,
        lastModified: null,
        listingUrl: `${upstream.origin}/archive/`,
      },
      {
        url: `${upstream.origin}/oldest`,
        lastModified: null,
        listingUrl: `${upstream.origin}/history/second`,
      },
    ],
  );
  for (const path of ['/recent', '/old', '/oldest'])
    assert.equal(requests.filter((url) => url === path).length, 1, path);
  assert.ok(!requests.includes('/unrelated'));
  assert.ok(!requests.includes('/about'));
});

test('archive failures remain attributable, archives do not suppress the sitemap guess, and cancellation stops a paginated scan', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('Stop the archive scan');
    const requests: unknown[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      requests.push(request.url);
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<a href="/archive/">Archives</a>');
      } else if (request.url === '/archive/') {
        if (cancel) controller.abort(reason);
        response.writeHead(503).end('Archive unavailable');
      } else response.writeHead(404).end();
    });
    const result = crawl(listings(), upstream.origin, controller.signal);
    if (cancel) await assert.rejects(result, (error) => error === reason);
    else {
      assert.deepEqual(
        (await result).map((entry) =>
          'error' in entry ? entry.error.url : entry.url,
        ),
        [`${upstream.origin}/archive/`],
      );
      // The guess happens despite the archive, and its 404 is an ordinary answer.
      assert.ok(requests.includes('/sitemap.xml'));
    }
  }
});

test('dead discovered archive links do not discard history, while a dead starting URL still fails', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end(
        '<a href="/archive/">Archive</a><a href="/archives/">Archives</a><a href="/2001/">2001</a>',
      );
    else if (request.url === '/2001/')
      response.end('<main><a href="/old-story">An older story</a></main>');
    else if (request.url === '/old-story') response.end('<p>A story.</p>');
    else response.writeHead(request.url === '/archives/' ? 410 : 404).end();
  });
  // A missing /sitemap.xml guess is an ordinary answer.
  assert.deepEqual(
    (await crawl(listings(), upstream.origin, AbortSignal.timeout(5000))).map(
      (entry) => ('error' in entry ? entry.error.url : location(entry)),
    ),
    [
      // The starting page lists its archives; the dead ones are skipped as pages too.
      {
        url: `${upstream.origin}/2001/`,
        lastModified: null,
        listingUrl: `${upstream.origin}/`,
      },
      {
        url: `${upstream.origin}/old-story`,
        lastModified: null,
        listingUrl: `${upstream.origin}/2001/`,
      },
    ],
  );
  assert.deepEqual(
    (
      await crawl(
        listings(),
        `${upstream.origin}/archive/`,
        AbortSignal.timeout(5000),
      )
    ).map((entry) => ('error' in entry ? entry.error.url : entry.url)),
    [`${upstream.origin}/archive/`],
  );
});

test('advertised content indexes work without archive-shaped URLs', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/') response.end('<a href="/writing">All Content</a>');
    else if (request.url === '/writing')
      response.end(
        '<main><a href="/writing">Content Index</a><a href="/early-report">An early report</a></main>',
      );
    else if (request.url === '/early-report') response.end('<p>A report.</p>');
    else response.writeHead(404).end();
  });
  assert.deepEqual(
    (await crawl(listings(), upstream.origin, AbortSignal.timeout(5000))).map(
      (entry) => ('error' in entry ? entry.error.url : location(entry)),
    ),
    [
      // The starting page is a list, and the content index it links is one of its pages too.
      {
        url: `${upstream.origin}/writing`,
        lastModified: null,
        listingUrl: `${upstream.origin}/`,
      },
      {
        url: `${upstream.origin}/early-report`,
        lastModified: null,
        listingUrl: `${upstream.origin}/writing`,
      },
    ],
  );
});

test('a starting HTML archive follows HTTP pagination links and resolves redirected listings', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    switch (request.url) {
      case '/history':
        response.writeHead(302, { location: '/archive/' }).end();
        break;
      case '/archive/':
        response.setHeader('link', '<page-2>; rel="next"');
        response.end('<main><a href="/first">First article</a></main>');
        break;
      case '/archive/page-2':
        response.setHeader('link', '</archive/>; rel="prev"');
        response.end('<main><a href="/second">Second article</a></main>');
        break;
      case '/first':
      case '/second':
        response.end('<p>An article.</p>');
        break;
      default:
        response.writeHead(404).end();
    }
  });
  assert.deepEqual(
    (
      await crawl(
        listings(),
        `${upstream.origin}/history`,
        AbortSignal.timeout(5000),
      )
    ).map(location),
    [
      {
        url: `${upstream.origin}/first`,
        lastModified: null,
        listingUrl: `${upstream.origin}/archive/`,
      },
      {
        url: `${upstream.origin}/second`,
        lastModified: null,
        listingUrl: `${upstream.origin}/archive/page-2`,
      },
    ],
  );
});

test('a self-linked archive and calendar indexes expose the full history', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    switch (request.url) {
      case '/':
        response.end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/">Archives</a><main><a href="/early">An early article</a><a href="/2001/">2001</a><a href="/2001/essays/">An essay</a></main>',
        );
        break;
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          '<rss><channel><item><link>/recent</link></item></channel></rss>',
        );
        break;
      case '/2001/':
        response.end(
          '<main><a href="/2001/Jan/">January</a><a href="/2001/02/">February</a></main>',
        );
        break;
      case '/2001/Jan/':
        response.end(
          '<main><a href="/2001/Jan/2/first/">First article</a></main>',
        );
        break;
      case '/2001/02/':
        response.end(
          '<main><a href="/2001/02/03/second/">Second article</a><a href="/2001/">2001</a></main>',
        );
        break;
      case '/2001/essays/':
        // Read as a calendar index, the essay would list this page.
        response.end('<main><a href="/listed-by-essay">Listed</a></main>');
        break;
      case '/early':
      case '/recent':
      case '/2001/Jan/2/first/':
      case '/2001/02/03/second/':
        response.end('<p>An article.</p>');
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const pages = await crawl(
    listings(),
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(
    pages.map((page) => location(page).url).sort(),
    [
      // The starting page links itself, so it is a page too.
      '/',
      // Lists hand back the archives they link as pages too.
      '/2001/',
      '/2001/02/',
      '/2001/Jan/',
      '/2001/02/03/second/',
      '/2001/Jan/2/first/',
      '/2001/essays/',
      '/early',
      '/recent',
    ]
      .map((path) => `${upstream.origin}${path}`)
      .sort(),
  );
  assert.ok(!requests.includes('/listed-by-essay'));
});

test('archives found on a crawled page are followed, and keep that page as provenance', async () => {
  for (const historyStatus of [200, 503]) {
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.url === '/')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<a href="/article">Article</a>');
      else if (request.url === '/article')
        response
          .writeHead(200, {
            'content-type': 'text/html',
            link: '</history>; rel="archives"',
          })
          .end('<p>An article.</p>');
      else if (request.url === '/history')
        response
          .writeHead(historyStatus, { 'content-type': 'text/html' })
          .end(
            '<link rel="alternate" type="application/rss+xml" href="/broken-feed"><main><a href="/listed">Listed</a></main>',
          );
      else if (request.url === '/listed')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<p>Listed.</p>');
      else response.writeHead(request.url === '/broken-feed' ? 503 : 404).end();
    });
    const entries = await crawl(
      new WebCrawler(got.extend({ retry: { limit: 0 } }), [
        new ListingReader(),
        new ArchiveReader(),
        new PaginationReader(),
        new LinkReader({ maxDepth: 3, maxPages: 100 }),
      ]),
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    const failures = entries.flatMap((entry) =>
      'error' in entry
        ? [{ url: entry.url, listingUrl: entry.listingUrl }]
        : [],
    );
    if (historyStatus === 200) {
      assert.deepEqual(failures, [
        {
          url: `${upstream.origin}/broken-feed`,
          listingUrl: `${upstream.origin}/history`,
        },
      ]);
      assert.ok(
        entries.some(
          (entry) =>
            !('error' in entry) &&
            entry.url === `${upstream.origin}/listed` &&
            entry.listingUrl === `${upstream.origin}/history`,
        ),
      );
    } else
      assert.deepEqual(failures, [
        {
          url: `${upstream.origin}/history`,
          listingUrl: `${upstream.origin}/article`,
        },
      ]);
  }
});

test('an archive that returns a feed is not read as a listing', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/archive/">Archives</a>');
    else if (request.url === '/archive/')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end('<rss><channel><item><link>/item</link></item></channel></rss>');
    else response.writeHead(404).end();
  });
  const entries = await crawl(
    listings(),
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(!requests.includes('/item'));
  assert.ok(entries.every((entry) => !entry.url.endsWith('/item')));
});

// The shape of a classifieds category page: many links outside `include` before the listings.
test('links nobody downloads do not use up turns, so listings are not starved behind them', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    const page = /^\/m\?page=(\d+)$/.exec(request.url);
    if (request.url === '/m')
      response.end(
        `<link rel="next" href="/m?page=2"><main>${Array.from({ length: 40 }, (_, index) => `<a href="/tag/${index + 1}">Tag</a>`).join('')}<a href="/search/1">1</a><a href="/search/2">2</a><a href="/search/3">3</a></main>`,
      );
    else if (page)
      response.end(
        Number(page[1]) < 10
          ? `<link rel="next" href="/m?page=${Number(page[1]) + 1}">`
          : '<p>Last page</p>',
      );
    else response.end('<p>A listing.</p>');
  });
  for await (const entry of new WebCrawler(got, [
    new ArchiveReader(),
    new PaginationReader(),
  ]).crawl([`${upstream.origin}/m`], null, {
    signal: AbortSignal.timeout(5000),
    include: [new URLPattern({ pathname: '/search/*' })],
  }))
    assert.ok(!('error' in entry));
  // Without the fix, the 40 skipped tags use 40 page turns, so ten archive pages download first.
  assert.ok(
    ['/search/1', '/search/2', '/search/3'].every(
      (listing) => requests.indexOf(listing) < requests.indexOf('/m?page=3'),
    ),
    requests.join(' '),
  );
  assert.equal(requests.filter((url) => url.startsWith('/tag/')).length, 0);
});

test('new feed pages are handed back before a long archive chain finishes, and the chain still completes', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    const archive = /^\/archive\/(\d+)$/.exec(request.url);
    if (request.url === '/')
      response.end(
        '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
      );
    else if (request.url === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel>${Array.from({ length: 6 }, (_, index) => `<item><link>/new/${index + 1}</link></item>`).join('')}</channel></rss>`,
      );
    } else if (request.url.startsWith('/new/'))
      response.end(
        '<main><p>A new article.</p></main><a href="/archive/1">Older posts</a>',
      );
    else if (archive) {
      const number = Number(archive[1]);
      response.end(
        `<main><a href="/old/${number}">An old article</a></main>${number < 20 ? `<a rel="next" href="/archive/${number + 1}">Next</a>` : ''}`,
      );
    } else response.writeHead(404).end();
  });
  const handed: string[] = [];
  for await (const entry of listings().crawl([upstream.origin], null, {
    signal: AbortSignal.timeout(5000),
    include: [new URLPattern({ pathname: '/new/*' })],
  }))
    if (!('progress' in entry) && !('deferred' in entry))
      handed.push(location(entry).url);
  assert.deepEqual(
    handed,
    Array.from(
      { length: 6 },
      (_, index) => `${upstream.origin}/new/${index + 1}`,
    ),
  );
  const archives = Array.from(
    { length: 20 },
    (_, index) => `/archive/${index + 1}`,
  );
  assert.deepEqual(
    requests.filter((url) => url.startsWith('/archive/')),
    archives,
  );
  // Before, archives went strictly first: the whole chain ran between /new/1 and /new/2.
  assert.ok(
    requests.lastIndexOf('/new/6') < requests.indexOf('/archive/20'),
    requests.join(' '),
  );
});

test('archive backfill keeps progressing while many listed pages wait', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    const archive = /^\/archive\/(\d+)$/.exec(request.url);
    if (request.url === '/')
      response.end(
        '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/archive/1">Archives</a>',
      );
    else if (request.url === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel>${Array.from({ length: 30 }, (_, index) => `<item><link>/new/${index + 1}</link></item>`).join('')}</channel></rss>`,
      );
    } else if (request.url.startsWith('/new/'))
      response.end('<p>A new article.</p>');
    else if (archive) {
      const number = Number(archive[1]);
      response.end(
        number < 30
          ? `<a rel="next" href="/archive/${number + 1}">Next</a>`
          : '<p>The first archive page.</p>',
      );
    } else response.writeHead(404).end();
  });
  const handed: string[] = [];
  for await (const entry of listings().crawl([upstream.origin], null, {
    signal: AbortSignal.timeout(5000),
    include: [new URLPattern({ pathname: '/new/*' })],
  }))
    if (!('progress' in entry) && !('deferred' in entry))
      handed.push(location(entry).url);
  assert.equal(handed.length, 30);
  const waiting = requests.slice(0, requests.lastIndexOf('/new/30'));
  // Pages weigh 4 and backfill 1: one archive page in every five downloads,
  // plus /archive/1, which the starting page also lists as a page.
  assert.equal(
    waiting.filter((url) => url.startsWith('/archive/')).length,
    8,
    requests.join(' '),
  );
  assert.deepEqual(
    requests.filter((url) => url.startsWith('/archive/')),
    Array.from({ length: 30 }, (_, index) => `/archive/${index + 1}`),
  );
});

test('a URL found as an archive and then listed as a page downloads in the page lane', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end(
        // The years sit in navigation, so the starting page, a list, does not list them as pages.
        `<link rel="alternate" type="application/rss+xml" href="/feed.xml"><nav>${Array.from({ length: 20 }, (_, index) => `<a href="/${2001 + index}/">${2001 + index}</a>`).join('')}</nav>`,
      );
    else if (request.url === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        '<rss><channel><item><link>/2020/</link></item></channel></rss>',
      );
    } else if (/^\/\d{4}\/$/.test(request.url)) response.end('<p>A year.</p>');
    else response.writeHead(404).end();
  });
  const handed: string[] = [];
  for await (const entry of listings().crawl([upstream.origin], null, {
    signal: AbortSignal.timeout(5000),
  }))
    if (!('progress' in entry) && !('deferred' in entry))
      handed.push(location(entry).url);
  assert.deepEqual(handed, [`${upstream.origin}/2020/`]);
  // As backfill, /2020/ would wait behind the nineteen years found before it.
  assert.deepEqual(requests.slice(0, 5), [
    '/',
    '/feed.xml',
    '/robots.txt',
    '/2020/',
    '/2001/',
  ]);
  assert.equal(requests.filter((url) => url === '/2020/').length, 1);
});
