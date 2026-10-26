import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { type HttpHandler, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import {
  ArchiveReader,
  CrawlError,
  type CrawlFailure,
  type CrawledPage,
  LinkReader,
  ListingReader,
  WebCrawler,
} from './index.ts';

// Public sites cannot reliably produce each failure or cancellation stage.
// Only HTTP is controlled; the crawler and its parsers run for real.
function site(...handlers: HttpHandler[]) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  return { [Symbol.dispose]: () => server.close() };
}

function listings() {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new ListingReader(),
    new ArchiveReader(),
  ]);
}

function allReaders(limits: { maxDepth: number; maxPages: number }) {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new ListingReader(),
    new ArchiveReader(),
    new LinkReader(limits),
  ]);
}

function crawl(crawler: WebCrawler, start: string) {
  return Array.fromAsync(
    crawler.run([start], { signal: AbortSignal.timeout(5000) }),
  );
}

function location(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  const { url, listingUrl, lastModified } = entry;
  return { url, lastModified, listingUrl };
}

function failures(entries: readonly (CrawledPage | CrawlFailure)[]) {
  return entries.flatMap((entry) => ('error' in entry ? [entry] : []));
}

function pages(entries: readonly (CrawledPage | CrawlFailure)[]) {
  return entries.flatMap((entry) =>
    'error' in entry ? [] : [location(entry)],
  );
}

function pathOf(url: string) {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

const article = '<html><body><p>An article.</p></body></html>';

test('HTML sitemap declarations discover older pages when robots is absent', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    switch (request.url) {
      case '/':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><head><base href="/exports/"><link rel="sitemap" href="index.xml"><link rel="alternate" type="application/rss+xml" href="feed.xml"></head></html>',
        );
        break;
      case '/exports/feed.xml':
        response.end(
          '<rss><channel><item><link>/recent</link></item></channel></rss>',
        );
        break;
      case '/exports/index.xml':
        response.end(
          '<sitemapindex><sitemap><loc>archive.xml</loc></sitemap></sitemapindex>',
        );
        break;
      case '/exports/archive.xml':
        response.end(
          '<urlset><url><loc>/older</loc><lastmod>2026-10-20</lastmod></url></urlset>',
        );
        break;
      case '/recent':
      case '/older':
        response.setHeader('content-type', 'text/html');
        response.end(article);
        break;
      default:
        response.writeHead(404).end();
    }
  });
  assert.deepEqual(
    (await crawl(listings(), upstream.origin))
      .map(location)
      .toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      {
        url: `${upstream.origin}/older`,
        lastModified: '2026-10-20',
        listingUrl: `${upstream.origin}/exports/archive.xml`,
      },
      {
        url: `${upstream.origin}/recent`,
        lastModified: null,
        listingUrl: `${upstream.origin}/exports/feed.xml`,
      },
    ],
  );
});

test('JSON alternates are validated without hiding explicit listing errors', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    switch (request.url) {
      case '/':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="alternate" type="application/json" href="/api"><link rel="alternate" type="application/json" href="/feed.json"></head></html>',
        );
        break;
      case '/headers':
        response.setHeader('content-type', 'text/html');
        response.setHeader(
          'link',
          '</rss.xml>; rel="alternate"; type="application/rss+xml", </api>; rel="alternate"; type="application/json", </feed.json>; rel="alternate"; type="application/json"',
        );
        response.end('<html/>');
        break;
      case '/api':
        response.setHeader('content-type', 'application/json');
        response.end(
          '{"id":78933,"title":{"rendered":"Home"},"content":{"rendered":"<p>Home</p>"}}',
        );
        break;
      case '/feed.json':
        response.setHeader('content-type', 'application/json');
        response.end(
          '{"version":"https://jsonfeed.org/version/1.1","title":"Journal","items":[{"id":"1","url":"/json-story"}]}',
        );
        break;
      case '/rss.xml':
        response.end(
          '<rss><channel><item><link>/rss-story</link></item></channel></rss>',
        );
        break;
      case '/explicit':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><head><link rel="alternate" type="application/feed+json" href="/api"></head></html>',
        );
        break;
      case '/json-story':
      case '/rss-story':
        response.setHeader('content-type', 'text/html');
        response.end(article);
        break;
      default:
        response.writeHead(404).end();
    }
  });
  for (const input of ['/', '/headers'])
    assert.deepEqual(
      (await crawl(listings(), `${upstream.origin}${input}`))
        .map(location)
        .toSorted((a, b) => a.url.localeCompare(b.url)),
      [
        {
          url: `${upstream.origin}/json-story`,
          lastModified: null,
          listingUrl: `${upstream.origin}/feed.json`,
        },
        {
          url: `${upstream.origin}/rss-story`,
          lastModified: null,
          listingUrl: `${upstream.origin}/rss.xml`,
        },
      ],
      input,
    );
  for (const input of ['/api', '/explicit']) {
    const entries = await crawl(listings(), `${upstream.origin}${input}`);
    assert.deepEqual(pages(entries), [], input);
    assert.deepEqual(
      failures(entries).map((failure) => [failure.url, failure.error.url]),
      [[`${upstream.origin}/api`, `${upstream.origin}/api`]],
      input,
    );
  }
});

test('labeled feed anchors discover pages without accepting ordinary navigation', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    switch (request.url) {
      case '/':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><head><base href="/exports/"></head><body><a href="updates">Subscribe via <span>RSS</span></a><a href="attribute" title="feed"></a><a href="guide" aria-label="RSS">Guide</a><a href="missing">RSS help</a><a href="feedback">Feedback</a><a href="/rss">Formats</a></body></html>',
        );
        break;
      case '/empty-only':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><body><a href="/exports/empty" title="feed"></a></body></html>',
        );
        break;
      case '/false-only':
        response.setHeader('content-type', 'text/html');
        response.end(
          '<html><body><a href="/exports/guide">RSS help</a></body></html>',
        );
        break;
      case '/exports/updates':
        response.writeHead(302, { location: '/feeds/current' }).end();
        break;
      case '/feeds/current':
        response.end('<feed><entry><link href="/story"/></entry></feed>');
        break;
      case '/exports/empty':
        response.end(
          '<rss version="2.0"><channel><title>Journal</title><link>https://example.org/</link><description>Updates</description></channel></rss>',
        );
        break;
      case '/exports/attribute':
        response.end(
          '<rss><channel><item><link>/attribute-story</link></item></channel></rss>',
        );
        break;
      case '/sitemap.xml':
        response.end('<urlset><url><loc>/fallback-story</loc></url></urlset>');
        break;
      case '/exports/guide':
      case '/exports/feedback':
      case '/rss':
        response.setHeader('content-type', 'text/html');
        response.end('<html>Ordinary page</html>');
        break;
      case '/story':
      case '/attribute-story':
      case '/fallback-story':
        response.setHeader('content-type', 'text/html');
        response.end(article);
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const fallback = {
    url: `${upstream.origin}/fallback-story`,
    lastModified: null,
    listingUrl: `${upstream.origin}/sitemap.xml`,
  };
  // A valid possible feed, even an empty one, is a listing, so robots.txt makes no /sitemap.xml guess.
  assert.deepEqual((await crawl(listings(), upstream.origin)).map(location), [
    {
      url: `${upstream.origin}/story`,
      lastModified: null,
      listingUrl: `${upstream.origin}/feeds/current`,
    },
    {
      url: `${upstream.origin}/attribute-story`,
      lastModified: null,
      listingUrl: `${upstream.origin}/exports/attribute`,
    },
  ]);
  assert.deepEqual(
    (await crawl(listings(), `${upstream.origin}/empty-only`)).map(location),
    [],
  );
  assert.deepEqual(
    (await crawl(listings(), `${upstream.origin}/false-only`)).map(location),
    [fallback],
  );
});

test('failures name the upstream while the rest of the listing still arrives', async () => {
  const index = 'https://publisher.example/index.xml';
  const broken = 'https://publisher.example/broken.xml';
  const story = {
    url: 'https://publisher.example/story',
    lastModified: null,
    listingUrl: 'https://publisher.example/good.xml',
  };
  for (const failure of [
    { url: index, reply: () => new Response('unavailable', { status: 503 }) },
    { url: index, reply: () => Response.error() },
    { url: broken, reply: () => new Response('unavailable', { status: 503 }) },
    { url: broken, reply: () => new Response('<urlset><url>') },
    { url: broken, reply: () => new Response('<urlset><url/></urlset>') },
    {
      url: broken,
      reply: () =>
        new Response('<html>Login</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
    {
      url: broken,
      reply: () =>
        new Response('{"version":"https://jsonfeed.org/version/1.1","items":['),
    },
    {
      url: broken,
      reply: () =>
        new Response(
          '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item><link>https://publisher.example/partial</link></item>',
        ),
    },
  ]) {
    using upstream = site(
      http.get(failure.url, failure.reply),
      http.get(
        index,
        () =>
          new Response(
            `<sitemapindex><sitemap><loc>https://publisher.example/good.xml</loc></sitemap><sitemap><loc>${broken}</loc></sitemap></sitemapindex>`,
          ),
      ),
      http.get(
        'https://publisher.example/good.xml',
        () =>
          new Response(
            '<urlset><url><loc>https://publisher.example/story</loc></url></urlset>',
          ),
      ),
      http.get(story.url, () => HttpResponse.html(article)),
    );
    const entries = await crawl(listings(), index);
    const [error, ...others] = failures(entries);
    assert.equal(others.length, 0);
    assert.equal(error?.url, failure.url);
    assert.ok(error.error instanceof CrawlError);
    assert.equal(error.error.url, failure.url);
    assert.ok(error.error.cause);
    assert.deepEqual(pages(entries), failure.url === index ? [] : [story]);
  }
});

test('cancellation stops requests and preserves the caller reason', async () => {
  const index = 'https://cancel.example/index.xml';
  const child = 'https://cancel.example/child.xml';
  for (const stage of ['before', 'input', 'child']) {
    const controller = new AbortController();
    const reason = new Error('caller stopped discovery');
    const requests: string[] = [];
    using upstream = site(
      http.get(index, ({ request }) => {
        requests.push(request.url);
        if (stage === 'input') controller.abort(reason);
        return new Response(
          `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`,
        );
      }),
      http.get(child, ({ request }) => {
        requests.push(request.url);
        if (stage === 'child') controller.abort(reason);
        return new Response('<urlset/>');
      }),
    );
    if (stage === 'before') controller.abort(reason);
    await assert.rejects(
      Array.fromAsync(listings().run([index], { signal: controller.signal })),
      (error: unknown) => error === reason,
    );
    assert.deepEqual(
      requests,
      stage === 'before' ? [] : stage === 'input' ? [index] : [index, child],
    );
  }
});

test('arbitrary sites retain every candidate path, URL identity and raw hints', async () => {
  for (const origin of ['https://biology.example', 'https://city.example']) {
    const listingUrl = `${origin}/maps/current.xml`;
    const requests: string[] = [];
    using upstream = site(
      http.get(
        `${origin}/`,
        () =>
          new Response('<html><body>Journal</body></html>', {
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.get(
        `${origin}/robots.txt`,
        () =>
          new Response(`User-Agent: *\nAllow: /\n  sItEmAp: ${listingUrl}\n`),
      ),
      // A guessed location must not stand in for the advertised listing.
      http.get(`${origin}/sitemap.xml`, ({ request }) => {
        requests.push(request.url);
        return new Response('<urlset/>');
      }),
      http.get(
        listingUrl,
        () =>
          new Response(`<urlset>
        <url><loc>${origin}/news/category</loc><lastmod>2026-10-20</lastmod></url>
        <url><loc>${origin}/papers?id=1</loc><lastmod>2026-10-20T16:04:01.000Z</lastmod></url>
        <url><loc>${origin}/papers?id=2</loc></url>
        <url><loc>${origin}/papers/</loc><lastmod> </lastmod></url>
        <url><loc>${origin}/papers</loc></url>
        <url><loc>https://archive.example/elsewhere</loc></url>
      </urlset>`),
      ),
      http.get(`${origin}/news/category`, () => HttpResponse.html(article)),
      http.get(`${origin}/papers`, () => HttpResponse.html(article)),
      http.get(`${origin}/papers/`, () => HttpResponse.html(article)),
      http.get('https://archive.example/elsewhere', () =>
        HttpResponse.html(article),
      ),
    );
    assert.deepEqual((await crawl(listings(), `${origin}/`)).map(location), [
      {
        url: `${origin}/news/category`,
        lastModified: '2026-10-20',
        listingUrl,
      },
      {
        url: `${origin}/papers?id=1`,
        lastModified: '2026-10-20T16:04:01.000Z',
        listingUrl,
      },
      { url: `${origin}/papers?id=2`, lastModified: null, listingUrl },
      { url: `${origin}/papers/`, lastModified: null, listingUrl },
      { url: `${origin}/papers`, lastModified: null, listingUrl },
      {
        url: 'https://archive.example/elsewhere',
        lastModified: null,
        listingUrl,
      },
    ]);
    assert.deepEqual(requests, []);
  }
});

test('direct listings support sitemap, text, RSS, Atom, RDF and JSON Feed with provenance', async () => {
  for (const document of [
    '<urlset><url><loc>https://feeds.example/paper</loc></url></urlset>',
    'https://feeds.example/paper\n',
    '<rss version="2.0"><channel><item><link>../paper</link><pubDate>Tue, 20 Oct 2026 00:00:00 GMT</pubDate></item><item><title>No link</title></item></channel></rss>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="../paper"/><link rel="self" href="/entry.xml"/><published>2026-10-20</published></entry></feed>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://feeds.example/"><title>Science</title><link>https://feeds.example/</link></channel><item rdf:about="https://feeds.example/paper"><title>Paper</title><link>../paper</link></item></rdf:RDF>',
    '{"version":"https://jsonfeed.org/version/1.1","title":"Science","items":[{"id":"1","url":"../paper","date_published":"2026-10-20T00:00:00Z"},{"id":"2","content_text":"No URL"}]}',
  ]) {
    using upstream = site(
      http.get('https://feeds.example/start', () =>
        Response.redirect('https://feeds.example/archive/feed'),
      ),
      http.get(
        'https://feeds.example/archive/feed',
        () => new Response(document),
      ),
      http.get('https://feeds.example/paper', () => HttpResponse.html(article)),
    );
    assert.deepEqual(
      (await crawl(listings(), 'https://feeds.example/start')).map(location),
      [
        {
          url: 'https://feeds.example/paper',
          lastModified: null,
          listingUrl: 'https://feeds.example/archive/feed',
        },
      ],
      document,
    );
  }
});

test('autodiscovery follows HTML base and HTTP feed links despite absent robots, then probes a sitemap', async () => {
  for (const status of [404, 410]) {
    using upstream = site(
      http.get('https://start.example/blog', () =>
        Response.redirect('https://journal.example/blog/'),
      ),
      http.get(
        'https://journal.example/blog/',
        () =>
          new Response(
            '<html><head><base href="/exports/"><link rel="alternate" type="application/rss+xml" href="latest.xml"></head><body><a href="/feedback">Feedback</a><a href="/rss">Formats</a><a href="/rss/help">Help</a><a href="/guide" aria-label="RSS">Guide</a></body></html>',
            {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                link: '<header.atom>; rel="alternate"; type="application/atom+xml"',
              },
            },
          ),
      ),
      ...['feedback', 'rss', 'rss/help', 'guide'].map((path) =>
        http.get(
          `https://journal.example/${path}`,
          () =>
            new Response('<html>Ordinary page</html>', {
              headers: { 'content-type': 'text/html' },
            }),
        ),
      ),
      http.get(
        'https://journal.example/robots.txt',
        () => new Response('absent', { status }),
      ),
      http.get(
        'https://journal.example/exports/latest.xml',
        () =>
          new Response(
            '<rss><channel><item><link>/from-html</link></item></channel></rss>',
          ),
      ),
      http.get(
        'https://journal.example/blog/header.atom',
        () =>
          new Response(
            '<feed><entry><link href="/from-header"/></entry></feed>',
          ),
      ),
      http.get('https://journal.example/from-html', () =>
        HttpResponse.html(article),
      ),
      http.get('https://journal.example/from-header', () =>
        HttpResponse.html(article),
      ),
    );
    assert.deepEqual(
      (await crawl(listings(), 'https://start.example/blog')).map(location),
      [
        {
          url: 'https://journal.example/from-html',
          lastModified: null,
          listingUrl: 'https://journal.example/exports/latest.xml',
        },
        {
          url: 'https://journal.example/from-header',
          lastModified: null,
          listingUrl: 'https://journal.example/blog/header.atom',
        },
      ],
    );
  }
  for (const mapExists of [true, false]) {
    using upstream = site(
      http.get(
        'https://bare.example/',
        () =>
          new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
      ),
      http.get(
        'https://bare.example/robots.txt',
        () => new Response('User-agent: *\nAllow: /'),
      ),
      http.get('https://bare.example/sitemap.xml', () =>
        mapExists
          ? new Response(
              '<urlset><url><loc>https://bare.example/page</loc></url></urlset>',
            )
          : new Response('absent', { status: 404 }),
      ),
      http.get('https://bare.example/page', () => HttpResponse.html(article)),
    );
    const entries = await crawl(listings(), 'https://bare.example/');
    if (mapExists)
      assert.deepEqual(entries.map(location), [
        {
          url: 'https://bare.example/page',
          lastModified: null,
          listingUrl: 'https://bare.example/sitemap.xml',
        },
      ]);
    // A missing guess is an ordinary answer, so a site with nothing to list yields an empty crawl.
    else assert.deepEqual(entries, []);
  }
});

test('an unreadable /sitemap.xml guess, such as a soft 404 page, is ignored', async () => {
  using server = site(
    http.get('https://soft.example/', () => HttpResponse.html('<p>Home</p>')),
    http.get(
      'https://soft.example/robots.txt',
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get('https://soft.example/sitemap.xml', () =>
      HttpResponse.html('<p>Page not found</p>'),
    ),
  );
  assert.deepEqual(await crawl(listings(), 'https://soft.example/'), []);
});

test('traversal follows nested gzip maps, deduplicates candidates and terminates cycles', async () => {
  let indexReads = 0;
  let mapReads = 0;
  using upstream = site(
    http.get('https://maps.example/index.xml', () => {
      // Make a repeated cycle fail promptly rather than leaving a hung test.
      if (++indexReads > 1) return new Response('repeat', { status: 503 });
      return new Response(
        '<sitemapindex><sitemap><loc>/first.xml</loc></sitemap><sitemap><loc>/compressed.xml.gz</loc></sitemap><sitemap><loc>/index.xml#again</loc></sitemap><sitemap><loc>/compressed.xml.gz</loc></sitemap></sitemapindex>',
      );
    }),
    http.get(
      'https://maps.example/first.xml',
      () =>
        new Response(
          '<urlset><url><loc>https://maps.example/page#one</loc><lastmod>2026-10-20</lastmod></url></urlset>',
        ),
    ),
    http.get('https://maps.example/compressed.xml.gz', () => {
      if (++mapReads > 1) return new Response('repeat', { status: 503 });
      return new Response(
        new Uint8Array(
          gzipSync(
            '<urlset><url><loc>https://maps.example/page#two</loc><lastmod>2026-10-21</lastmod></url><url><loc>https://maps.example/page?edition=2</loc></url></urlset>',
          ),
        ),
      );
    }),
    http.get('https://maps.example/page', () => HttpResponse.html(article)),
  );
  assert.deepEqual(
    (await crawl(listings(), 'https://maps.example/index.xml')).map(location),
    [
      {
        url: 'https://maps.example/page',
        lastModified: '2026-10-20',
        listingUrl: 'https://maps.example/first.xml',
      },
      {
        url: 'https://maps.example/page?edition=2',
        lastModified: null,
        listingUrl: 'https://maps.example/compressed.xml.gz',
      },
    ],
  );
});

test('JSON Feed and Atom pagination, including Atom links in RSS, retain older entries and stop cycles', async () => {
  for (const format of ['json', 'atom', 'rss']) {
    await using upstream = await new HttpServer().start((request, response) => {
      const first = request.url === '/first';
      const page = first ? '/recent' : '/older';
      const next = first ? '/second' : '/first';
      response.setHeader(
        'content-type',
        format === 'json' ? 'application/feed+json' : 'application/xml',
      );
      if (format === 'json')
        response.end(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Journal',
            next_url: next,
            items: [{ id: page, url: page }],
          }),
        );
      else if (format === 'atom')
        response.end(
          `<feed xmlns="http://www.w3.org/2005/Atom"><link rel="prev-archive" href="${next}"/><entry><link href="${page}"/></entry></feed>`,
        );
      else
        response.end(
          `<rss xmlns:atom="http://www.w3.org/2005/Atom"><channel><atom:link rel="next" href="${next}"/><item><link>${page}</link></item></channel></rss>`,
        );
    });
    assert.deepEqual(
      (await crawl(listings(), `${upstream.origin}/first`)).map(location),
      [
        {
          url: `${upstream.origin}/recent`,
          lastModified: null,
          listingUrl: `${upstream.origin}/first`,
        },
        {
          url: `${upstream.origin}/older`,
          lastModified: null,
          listingUrl: `${upstream.origin}/second`,
        },
      ],
      format,
    );
  }
});

test('feeds declared on crawled pages are read completely, and each page is downloaded once', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url;
    assert.ok(path);
    requests.push(path);
    const feed = (body: object, headers: Record<string, string> = {}) =>
      response
        .writeHead(200, { 'content-type': 'application/feed+json', ...headers })
        .end(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Feed',
            ...body,
          }),
        );
    if (path === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/feed+json" href="/feed/1"><a href="/known">Known</a>',
        );
    else if (path.startsWith('/feed/')) {
      const n = Number(path.at(-1));
      feed({
        items: [{ id: String(n), url: n === 1 ? '/known' : `/article/${n}` }],
        ...(n < 3 ? { next_url: `/feed/${n + 1}` } : {}),
      });
    } else if (path === '/known')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<a href="/hidden">Hidden</a><link rel="alternate" type="application/feed+json" href="/extra/1">',
        );
    else if (path === '/extra/1')
      feed(
        {
          items: [
            { id: 'new', url: '/extra-article' },
            { id: 'known', url: '/known' },
          ],
          next_url: '/extra/2',
        },
        { link: '</header-next>; rel="next"' },
      );
    else if (path === '/extra/2')
      feed({ items: [{ id: 'older', url: '/extra-older' }] });
    else if (path === '/header-next')
      feed({ items: [{ id: 'header', url: '/header-article' }] });
    else if (
      [
        '/article/2',
        '/article/3',
        '/hidden',
        '/extra-article',
        '/extra-older',
        '/header-article',
      ].includes(path)
    )
      response.writeHead(200, { 'content-type': 'text/html' }).end(article);
    else response.writeHead(404).end();
  });
  const entries = await crawl(
    allReaders({ maxDepth: 3, maxPages: 100 }),
    upstream.origin,
  );
  assert.deepEqual(
    entries.map((entry) => pathOf(location(entry).url)).toSorted(),
    [
      '/article/2',
      '/article/3',
      '/extra-article',
      '/extra-older',
      '/header-article',
      '/hidden',
      '/known',
    ],
  );
  assert.equal(requests.filter((path) => path === '/known').length, 1);
  for (const path of ['/feed/3', '/extra/2', '/header-next'])
    assert.ok(requests.includes(path), path);
  assert.equal(
    pages(entries).find((page) => page.url.endsWith('/extra-article'))
      ?.listingUrl,
    `${upstream.origin}/extra/1`,
  );
});

test('feeds and sitemaps a starting page declares are read completely, and a listing replaces a link provenance', async () => {
  const requests: string[] = [];
  using server = site(
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
      if (path === '/feed/2')
        return HttpResponse.json({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Posts',
          items: [{ id: '3', url: '/older' }],
        });
      if (path === '/map')
        return HttpResponse.xml(
          '<urlset><url><loc>/mapped</loc><lastmod>2026-10-20</lastmod></url></urlset>',
        );
      if (path === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      assert.ok(['/article', '/extra', '/mapped', '/older'].includes(path));
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const found = (
    await crawl(
      allReaders({ maxDepth: 3, maxPages: 100 }),
      'https://site.test/',
    )
  ).map(location);
  assert.deepEqual(
    found.map((page) => new URL(page.url).pathname),
    ['/article', '/extra', '/mapped', '/older'],
  );
  assert.equal(requests.filter((path) => path === '/article').length, 1);
  // The anchor found /article first; the feed's provenance replaces the link's.
  assert.equal(found[0]?.listingUrl, 'https://site.test/feed');
  assert.equal(found[1]?.listingUrl, 'https://site.test/feed');
  assert.equal(found[2]?.lastModified, '2026-10-20');
  assert.equal(found[3]?.listingUrl, 'https://site.test/feed/2');
});

test('reads Atom, RDF and gzip sitemaps declared in headers, following their pagination and child listings', async () => {
  using server = site(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
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
      if (path === '/next')
        return HttpResponse.xml(
          '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/next-page"/></entry></feed>',
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
      if (path === '/child-map')
        return HttpResponse.xml(
          '<urlset><url><loc>/child-page</loc></url></urlset>',
        );
      if (path === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Page</p>');
    }),
  );
  const found = (
    await crawl(
      allReaders({ maxDepth: 1, maxPages: 100 }),
      'https://site.test/',
    )
  ).map(location);
  assert.deepEqual(found.map((page) => new URL(page.url).pathname).toSorted(), [
    '/atom-page',
    '/child-page',
    '/mapped',
    '/next-page',
    '/rdf-page',
  ]);
  assert.equal(
    found.find((page) => page.url.endsWith('/mapped'))?.lastModified,
    '2026-10-25',
  );
});

test('a URL declared as both a page and a feed is fetched once and serves both roles', async () => {
  const requests: string[] = [];
  using server = site(
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
      if (path === '/robots.txt')
        return new HttpResponse(null, { status: 404 });
      return HttpResponse.html('<p>Article</p>');
    }),
  );
  const found = (
    await crawl(
      allReaders({ maxDepth: 1, maxPages: 100 }),
      'https://site.test/',
    )
  ).map(location);
  assert.deepEqual(requests, ['/', '/feed', '/robots.txt', '/article']);
  assert.deepEqual(
    found.map((page) => new URL(page.url).pathname),
    ['/feed', '/article'],
  );
});

test('an invalid feed hint still remains an ordinary linked page', async () => {
  const requests: string[] = [];
  using server = site(
    http.get('https://site.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/')
        return HttpResponse.html(
          '<link rel="alternate" type="application/json" href="/api"><a href="/about">About RSS</a>',
        );
      if (path === '/api') return HttpResponse.json({ user: 'someone' });
      if (path === '/robots.txt' || path === '/sitemap.xml')
        return new HttpResponse(null, { status: 404 });
      if (path === '/about')
        return HttpResponse.html('<a href="/leaf">Leaf</a>');
      return HttpResponse.html('<a href="/too-deep">Too deep</a>');
    }),
  );
  const found = (
    await crawl(
      allReaders({ maxDepth: 1, maxPages: 100 }),
      'https://site.test/',
    )
  ).map(location);
  // /about is one hop away: /leaf is two hops away, past maxDepth, so its links are not read.
  assert.deepEqual(
    found.map((page) => new URL(page.url).pathname),
    ['/about', '/leaf'],
  );
  assert.ok(!requests.includes('/too-deep'));
});

test('declared remote feeds contribute pages without expanding the remote origin', async () => {
  const requests: string[] = [];
  using server = site(
    http.get('https://site.test/', () =>
      HttpResponse.html(`
      <a href="https://remote.test/wiki/Atom_(standard)">Atom</a>
      <link rel="alternate" type="application/rss+xml" href="https://remote.test/feed">
      <a href="https://remote.test/rss/blog/123">RSS</a>
    `),
    ),
    http.get(
      'https://site.test/robots.txt',
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get('https://remote.test/*', ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/feed' || path === '/rss/blog/123')
        return HttpResponse.xml(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
      if (path === '/wiki/Atom_(standard)')
        return HttpResponse.html('<p>An encyclopedia page.</p>');
      assert.equal(path, '/article');
      return HttpResponse.html('<a href="/unrelated">Unrelated</a>');
    }),
  );
  const found = (
    await crawl(
      allReaders({ maxDepth: 3, maxPages: 100 }),
      'https://site.test/',
    )
  ).map(location);
  // A starting page's labeled anchors are possible feeds on any origin; Feedscout rejects the wiki page.
  assert.deepEqual(requests, [
    '/feed',
    '/wiki/Atom_(standard)',
    '/rss/blog/123',
    '/article',
  ]);
  assert.deepEqual(
    found.map((page) => page.url),
    ['https://remote.test/article'],
  );
});

test('cross-origin feeds on crawled pages need a declaration or a feed-path hint', async () => {
  const remoteRequests: string[] = [];
  await using remote = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    remoteRequests.push(request.url);
    if (request.url === '/feed' || request.url === '/rss/blog/123')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/published</link></item></channel></rss>',
        );
    else if (request.url === '/published')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/unrelated">Unrelated</a>');
    else response.writeHead(503).end();
  });
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/article">Article</a>');
    else if (request.url === '/article')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<a href="${remote.origin}/wiki/Atom_(standard)">Atom</a><link rel="alternate" type="application/rss+xml" href="${remote.origin}/feed"><a href="${remote.origin}/rss/blog/123">RSS</a>`,
        );
    else response.writeHead(404).end();
  });
  const entries = await crawl(
    allReaders({ maxDepth: 3, maxPages: 1 }),
    upstream.origin,
  );
  // /published is on a remote origin, so its links are not followed.
  assert.deepEqual(remoteRequests, ['/feed', '/rss/blog/123', '/published']);
  assert.deepEqual(pages(entries), [
    {
      url: `${upstream.origin}/article`,
      lastModified: null,
      listingUrl: `${upstream.origin}/`,
    },
    {
      url: `${remote.origin}/published`,
      lastModified: null,
      listingUrl: `${remote.origin}/feed`,
    },
  ]);
  assert.deepEqual(failures(entries), []);
});

test('a feed on a crawled page keeps the caller reason on cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/article">Article</a>');
    else if (request.url === '/article')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/rss+xml" href="/slow-feed">',
        );
    else if (request.url === '/slow-feed') {
      entered.resolve();
      response.on('close', () => closed.resolve());
    } else response.writeHead(404).end();
  });
  const stop = new AbortController(),
    reason = new Error('stop feed');
  const result = Array.fromAsync(
    allReaders({ maxDepth: 3, maxPages: 100 }).run([upstream.origin], {
      signal: stop.signal,
    }),
  );
  try {
    await entered.promise;
    stop.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    await closed.promise;
  } finally {
    stop.abort(reason);
  }
});

test('declared sitemap failures and malformed listings are handed out with their URL while pages continue', async () => {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  for (const listing of ['missing', 'malformed']) {
    const requests: string[] = [];
    using server = site(
      http.get('https://site.test/*', ({ request }) => {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path === '/')
          return HttpResponse.html(
            '<link rel="sitemap" href="/broken"><a href="/binary">Binary</a>',
          );
        if (path === '/broken')
          return listing === 'missing'
            ? new HttpResponse(null, { status: 404 })
            : HttpResponse.xml(
                '<urlset><url><lastmod>2026-10-25</lastmod></url></urlset>',
              );
        if (path === '/robots.txt')
          return new HttpResponse(null, { status: 404 });
        return new HttpResponse(bytes, {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }),
    );
    const entries = await crawl(
      allReaders({ maxDepth: 1, maxPages: 100 }),
      'https://site.test/',
    );
    const [failure, ...others] = failures(entries);
    assert.equal(others.length, 0);
    assert.equal(failure?.url, 'https://site.test/broken');
    assert.equal(failure.listingUrl, 'https://site.test/');
    if (listing === 'malformed') assert.match(failure.error.message, /loc/);
    const binary = entries.find(
      (entry): entry is CrawledPage => !('error' in entry),
    );
    assert.equal(binary?.url, 'https://site.test/binary');
    assert.deepEqual(binary.response.rawBody, Buffer.from(bytes));
    // A declared sitemap, even a failing one, means no /sitemap.xml guess.
    assert.ok(!requests.includes('/sitemap.xml'));
  }
});
