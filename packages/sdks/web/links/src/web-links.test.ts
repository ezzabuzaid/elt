import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import got, { HTTPError, type Response } from 'got';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { CrawlError, type LinkedPage, WebLinks } from './index.ts';

// Synthetic upstream sites make cycles, redirects and failures reproducible offline.
function mockWeb(...handlers: Parameters<typeof setupServer>) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  return {
    [Symbol.dispose]() {
      server.close();
    },
  };
}

test('crawls links itself and preserves URL identity, provenance and Got responses', async () => {
  const requests: string[] = [];
  const responses = new Map<string, Response>();
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      requests.push(path);
      assert.equal(request.headers.get('x-crawl'), 'configured');
      if (path === '/')
        return HttpResponse.html(
          `
      <base href="/docs/">
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
  const pages = await Array.fromAsync(
    new WebLinks(client, { maxDepth: 3, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname + new URL(page.url).search),
    [
      '/',
      '/docs/one',
      '/post',
      '/post/',
      '/post?a=1&b=2',
      '/post?b=2&a=1',
      '/history',
      '/leaf',
    ],
  );
  assert.equal(requests.length, pages.length);
  assert.equal(
    pages.find((page) => page.url.endsWith('/leaf'))?.listingUrl,
    'https://site.test/docs/one',
  );
  for (const page of pages) {
    assert.equal(page.response, responses.get(page.url));
    assert.equal(page.lastModified, null);
    assert.ok(Buffer.isBuffer(page.response.body));
  }
});

test('reuses a downloaded response and deduplicates its request and redirect URLs', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/old')
        return new HttpResponse(null, {
          status: 302,
          headers: { location: '/home' },
        });
      if (path === '/home')
        return HttpResponse.html(
          '<a href="/old">Old</a><a href="/home#part">Home</a><a href="/child">Child</a>',
        );
      return HttpResponse.html('<p>Child</p>');
    }),
  );
  const response = await got('https://site.test/old');
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 3, maxPages: 100 }).crawl(
      [response, 'https://site.test/home'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(requests, ['/old', '/home', '/child']);
  assert.equal(pages[0]?.response, response);
  assert.equal(pages[0]?.url, 'https://site.test/home');
});

test('starting locations keep listing metadata when encountered again as links', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.html('<a href="/article">Article</a>');
    }),
  );
  const location = {
    url: 'https://site.test/article',
    listingUrl: 'https://site.test/map.xml',
    lastModified: '2026-10-20',
  };
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 1, maxPages: 1 }).crawl(
      ['https://site.test/', location, location],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(requests, [
    'https://site.test/',
    'https://site.test/article',
  ]);
  const article = pages.find((page) => page.url === location.url);
  assert.ok(article);
  const { response, ...metadata } = article;
  assert.deepEqual(metadata, location);
});

test('depth and page limits bound expansion while retaining discovered candidates', async () => {
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return HttpResponse.html('<a href="/a">A</a><a href="/b">B</a>');
      return HttpResponse.html(`<a href="${path}/child">Child</a>`);
    }),
  );
  for (const [limits, paths] of [
    [{ maxDepth: 0, maxPages: 100 }, ['/', '/a', '/b']],
    [{ maxDepth: 3, maxPages: 0 }, ['/', '/a', '/b']],
    [{ maxDepth: 3, maxPages: 1 }, ['/', '/a', '/b', '/a/child']],
    [{ maxDepth: 1, maxPages: 100 }, ['/', '/a', '/b', '/a/child', '/b/child']],
  ] satisfies [{ maxDepth: number; maxPages: number }, string[]][]) {
    const pages = await Array.fromAsync(
      new WebLinks(got, limits).crawl(['https://site.test/'], {
        signal: AbortSignal.timeout(5000),
      }),
    );
    assert.deepEqual(
      pages.map((page) => new URL(page.url).pathname),
      paths,
    );
  }
});

test('secondary feeds contribute one document and deduplicate ordinary candidates', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(`
      <link rel="alternate" type="application/feed+json" href="/feed">
      <link rel="sitemap" href="/map"><a href="/article">Article</a>
    `);
      if (path === '/feed')
        return HttpResponse.json({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Posts',
          items: [
            { id: '1', url: '/article' },
            { id: '2', url: '/extra' },
          ],
          next_url: '/feed/2',
        });
      if (path === '/map')
        return HttpResponse.xml(
          '<urlset><url><loc>/mapped</loc><lastmod>2026-10-20</lastmod></url></urlset>',
        );
      assert.ok(['/article', '/extra', '/mapped'].includes(path));
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 3, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname),
    ['/', '/article', '/extra', '/mapped'],
  );
  assert.equal(requests.filter((path) => path === '/article').length, 1);
  assert.equal(
    pages.find((page) => page.url.endsWith('/extra'))?.listingUrl,
    'https://site.test/feed',
  );
  assert.equal(
    pages.find((page) => page.url.endsWith('/mapped'))?.lastModified,
    '2026-10-20',
  );
  assert.ok(!requests.includes('/feed/2'));
});

test('reads Atom, RDF and gzip sitemaps from headers without following child listings', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html('<p>Home</p>', {
          headers: {
            link: [
              '</atom>; rel="alternate"; type="application/atom+xml"',
              '</rdf>; rel="alternate"; type="application/rdf+xml"',
              '</map.gz>; rel="sitemap"',
              '</index>; rel="sitemap"',
            ].join(', '),
          },
        });
      if (path === '/atom')
        return HttpResponse.xml(
          '<feed xmlns="http://www.w3.org/2005/Atom"><link rel="next" href="/next"/><entry><link href="/atom-page"/></entry></feed>',
        );
      if (path === '/rdf')
        return HttpResponse.xml(
          '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item rdf:about="https://site.test/rdf-page"><link>/rdf-page</link></item></rdf:RDF>',
        );
      if (path === '/map.gz')
        return new HttpResponse(
          new Uint8Array(
            gzipSync(
              '<urlset><url><loc>/mapped</loc><lastmod>2026-10-25</lastmod></url></urlset>',
            ),
          ),
        );
      if (path === '/index')
        return HttpResponse.xml(
          '<sitemapindex><sitemap><loc>/child-map</loc></sitemap></sitemapindex>',
        );
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 1, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname),
    ['/', '/atom-page', '/rdf-page', '/mapped'],
  );
  assert.equal(pages.at(-1)?.lastModified, '2026-10-25');
  assert.ok(!requests.includes('/next'));
  assert.ok(!requests.includes('/child-map'));
});

test('a URL declared as both a page and a feed is fetched once and serves both roles', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/feed">Feed</a><link rel="alternate" type="application/rss+xml" href="/feed">',
        );
      if (path === '/feed')
        return HttpResponse.xml(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
      return HttpResponse.html('<p>Article</p>');
    }),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 1, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(requests, ['/', '/feed', '/article']);
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname),
    requests,
  );
});

test('an invalid feed hint still remains an ordinary HTML page', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<link rel="alternate" type="application/json" href="/api"><a href="/about">About RSS</a>',
        );
      if (path === '/api') return HttpResponse.json({ user: 'someone' });
      if (path === '/about')
        return HttpResponse.html('<a href="/leaf">Leaf</a>');
      return HttpResponse.html('<a href="/too-deep">Too deep</a>');
    }),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 1, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(
    pages.map((page) => new URL(page.url).pathname),
    ['/', '/about', '/leaf'],
  );
  assert.deepEqual(requests, ['/', '/api', '/about', '/leaf']);
});

test('declared remote feeds contribute pages without expanding the remote origin', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/', () =>
      HttpResponse.html(`
      <a href="https://remote.test/wiki/Atom_(standard)">Atom</a>
      <link rel="alternate" type="application/rss+xml" href="https://remote.test/feed">
      <a href="https://remote.test/rss/blog/123">RSS</a>
    `),
    ),
    http.get('https://remote.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/feed' || path === '/rss/blog/123')
        return HttpResponse.xml(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
      assert.equal(path, '/article');
      return HttpResponse.html('<a href="/unrelated">Unrelated</a>');
    }),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 3, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(requests, ['/feed', '/rss/blog/123', '/article']);
  assert.deepEqual(
    pages.map((page) => page.url),
    ['https://site.test/', 'https://remote.test/article'],
  );
});

test('redirect targets are emitted once and off-origin redirects do not expand', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<a href="/alias">Alias</a><a href="/target">Target</a><a href="/external">External</a>',
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
      return HttpResponse.html('<p>Target</p>');
    }),
    http.get('https://remote.test/page', () =>
      HttpResponse.html('<a href="/no">Outside</a>'),
    ),
  );
  const pages = await Array.fromAsync(
    new WebLinks(got, { maxDepth: 3, maxPages: 100 }).crawl(
      ['https://site.test/'],
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.deepEqual(requests, ['/', '/alias', '/target', '/external']);
  assert.deepEqual(
    pages.map((page) => page.url),
    [
      'https://site.test/',
      'https://site.test/target',
      'https://remote.test/page',
    ],
  );
});

test('continues independent pages, reports failures with URLs and retries on a new crawl', async () => {
  let broken = true;
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
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
  const links = new WebLinks(got.extend({ retry: { limit: 0 } }), {
    maxDepth: 3,
    maxPages: 100,
  });
  const pages: LinkedPage[] = [];
  await assert.rejects(
    async () => {
      for await (const page of links.crawl(['https://site.test/'], {
        signal: AbortSignal.timeout(5000),
      }))
        pages.push(page);
    },
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      const failure = error.errors[0];
      assert.ok(failure instanceof CrawlError);
      assert.equal(failure.url, 'https://site.test/bad');
      assert.ok(failure.cause instanceof HTTPError);
      return true;
    },
  );
  assert.deepEqual(
    pages.map((page) => page.url),
    ['https://site.test/', 'https://site.test/good'],
  );
  broken = false;
  const retried = await Array.fromAsync(
    links.crawl(['https://site.test/'], { signal: AbortSignal.timeout(5000) }),
  );
  assert.deepEqual(
    retried.map((page) => new URL(page.url).pathname),
    ['/', '/bad', '/good'],
  );
  assert.equal(requests.filter((path) => path === '/bad').length, 2);
});

test('explicit feed failures and root HTTP errors remain attributable', async () => {
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return HttpResponse.html(
          '<link rel="sitemap" href="/broken"><a href="/good">Good</a>',
        );
      if (path === '/good') return HttpResponse.html('<p>Good</p>');
      return new HttpResponse(null, { status: 404 });
    }),
  );
  const links = new WebLinks(got.extend({ retry: { limit: 0 } }), {
    maxDepth: 3,
    maxPages: 100,
  });
  for (const [input, failed] of [
    ['/', '/broken'],
    ['/missing', '/missing'],
  ])
    await assert.rejects(
      Array.fromAsync(
        links.crawl([`https://site.test${input}`], {
          signal: AbortSignal.timeout(5000),
        }),
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors[0] instanceof CrawlError);
        assert.equal(error.errors[0].url, `https://site.test${failed}`);
        return true;
      },
    );
});

test('malformed listings fail with provenance while binary pages retain their bytes', async () => {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return HttpResponse.html(
          '<link rel="sitemap" href="/broken"><a href="/binary">Binary</a>',
        );
      if (path === '/broken')
        return HttpResponse.xml(
          '<urlset><url><lastmod>2026-10-25</lastmod></url></urlset>',
        );
      return new HttpResponse(bytes, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }),
  );
  const pages: LinkedPage[] = [];
  await assert.rejects(
    async () => {
      for await (const page of new WebLinks(got, {
        maxDepth: 1,
        maxPages: 100,
      }).crawl(['https://site.test/'], { signal: AbortSignal.timeout(5000) }))
        pages.push(page);
    },
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof CrawlError);
      assert.equal(error.errors[0].url, 'https://site.test/broken');
      assert.match(error.errors[0].message, /loc/);
      return true;
    },
  );
  assert.equal(pages.at(-1)?.url, 'https://site.test/binary');
  assert.deepEqual(pages.at(-1)?.response.rawBody, Buffer.from(bytes));
});

test('consumer backpressure and early break stop fetching, and calls remain isolated', async () => {
  const requests: string[] = [];
  using server = mockWeb(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return HttpResponse.html(
        path === '/' ? '<a href="/child">Child</a>' : '<p>Child</p>',
      );
    }),
  );
  const links = new WebLinks(got, { maxDepth: 3, maxPages: 100 });
  for await (const page of links.crawl(['https://site.test/'], {
    signal: AbortSignal.timeout(5000),
  })) {
    assert.equal(page.url, 'https://site.test/');
    assert.deepEqual(requests, ['/']);
    break;
  }
  assert.deepEqual(requests, ['/']);
  const [first, second] = await Promise.all([
    Array.fromAsync(
      links.crawl(['https://site.test/'], {
        signal: AbortSignal.timeout(5000),
      }),
    ),
    Array.fromAsync(
      links.crawl(['https://site.test/'], {
        signal: AbortSignal.timeout(5000),
      }),
    ),
  ]);
  assert.deepEqual(
    first.map((page) => page.url),
    second.map((page) => page.url),
  );
  assert.equal(first.length, 2);
  assert.equal(requests.filter((path) => path === '/child').length, 2);
});

test(
  'cancellation interrupts an in-flight request with the exact reason',
  { timeout: 10000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using server = mockWeb(
      http.get('https://site.test/slow', async () => {
        entered.resolve();
        // MSW's synthetic Request.signal does not mirror Node request aborts.
        await release.promise;
        return HttpResponse.html('<p>Stopped</p>');
      }),
    );
    const stop = new AbortController();
    const reason = new Error('stop this crawl');
    const links = new WebLinks(got, { maxDepth: 3, maxPages: 100 });
    const run = Array.fromAsync(
      links.crawl(['https://site.test/slow'], {
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
      }),
    );
    try {
      await entered.promise;
      stop.abort(reason);
      await assert.rejects(run, (error) => error === reason);
      await assert.rejects(
        Array.fromAsync(
          links.crawl(['https://site.test/unused'], { signal: stop.signal }),
        ),
        (error) => error === reason,
      );
    } finally {
      stop.abort(reason);
      release.resolve();
    }
  },
);

test('validates limits and starting URLs and accepts an empty crawl', async () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new WebLinks(got, { maxDepth: value, maxPages: 1 }),
      RangeError,
    );
    assert.throws(
      () => new WebLinks(got, { maxDepth: 1, maxPages: value }),
      RangeError,
    );
  }
  const links = new WebLinks(got, { maxDepth: 0, maxPages: 0 });
  assert.deepEqual(
    await Array.fromAsync(
      links.crawl([], { signal: AbortSignal.timeout(5000) }),
    ),
    [],
  );
  for (const input of ['relative', 'file:///etc/hosts', 'ftp://site.test/feed'])
    await assert.rejects(
      Array.fromAsync(
        links.crawl([input], { signal: AbortSignal.timeout(5000) }),
      ),
    );
});

test(
  'drains queues beyond the storage page size without dropping candidates',
  { timeout: 30000 },
  async () => {
    using server = mockWeb(
      http.get('https://site.test/*', ({ request }) =>
        HttpResponse.html(
          new URL(request.url).pathname === '/'
            ? Array.from(
                { length: 1100 },
                (_, i) => `<a href="/page/${i}">Page</a>`,
              ).join('')
            : '<a href="/unfollowed">Unfollowed</a>',
        ),
      ),
    );
    const pages = await Array.fromAsync(
      new WebLinks(got, { maxDepth: 0, maxPages: 0 }).crawl(
        ['https://site.test/'],
        { signal: AbortSignal.timeout(25000) },
      ),
    );
    assert.equal(pages.length, 1101);
    assert.equal(new Set(pages.map((page) => page.url)).size, 1101);
  },
);

test('queue storage stays disposable despite ambient Crawlee persistence settings', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'web-links-storage-'),
  );
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import got from ${JSON.stringify(import.meta.resolve('got'))};
    import {HttpResponse, http} from ${JSON.stringify(import.meta.resolve('msw'))};
    import {setupServer} from ${JSON.stringify(import.meta.resolve('msw/node'))};
    import {WebLinks} from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
    const server = setupServer(http.get('https://site.test/', () => HttpResponse.html('<a href="/unread">Unread</a>')));
    server.listen({onUnhandledRequest:'error'});
    try {
      for await (const page of new WebLinks(got,{maxDepth:1,maxPages:1}).crawl(['https://site.test/'],{signal:AbortSignal.timeout(5000)})) {
        assert.equal(page.url,'https://site.test/');
        break;
      }
    } finally { server.close(); }
  `,
    ],
    {
      cwd: directory.path,
      timeout: 15000,
      env: {
        ...process.env,
        TMPDIR: directory.path,
        CRAWLEE_STORAGE_DIR: directory.path,
        CRAWLEE_PERSIST_STORAGE: 'true',
        CRAWLEE_PURGE_ON_START: 'true',
      },
    },
  );
  assert.deepEqual(await readdir(directory.path), []);
});
