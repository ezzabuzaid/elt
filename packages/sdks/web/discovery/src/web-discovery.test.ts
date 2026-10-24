import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import { type HttpHandler, http } from 'msw';
import { setupServer } from 'msw/node';

import { DiscoveryError, WebDiscovery } from './index.ts';

// Public sites cannot reliably produce each failure or cancellation stage.
// Only HTTP is controlled; the SDK and its parsers run for real.
function site(...handlers: HttpHandler[]) {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: 'error' });
  return { [Symbol.dispose]: () => server.close() };
}

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
      default:
        response.writeHead(404).end();
    }
  });
  assert.deepEqual(
    (
      await new WebDiscovery().discover(
        upstream.origin,
        AbortSignal.timeout(5000),
      )
    ).toSorted((a, b) => a.url.localeCompare(b.url)),
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
      default:
        response.writeHead(404).end();
    }
  });
  for (const input of ['/', '/headers'])
    assert.deepEqual(
      (
        await new WebDiscovery().discover(
          `${upstream.origin}${input}`,
          AbortSignal.timeout(5000),
        )
      ).toSorted((a, b) => a.url.localeCompare(b.url)),
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
    );
  for (const input of ['/api', '/explicit'])
    await assert.rejects(
      new WebDiscovery().discover(
        `${upstream.origin}${input}`,
        AbortSignal.timeout(5000),
      ),
      (error: unknown) =>
        error instanceof DiscoveryError &&
        error.url === `${upstream.origin}/api`,
    );
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
      default:
        response.writeHead(404).end();
    }
  });
  assert.deepEqual(
    await new WebDiscovery().discover(
      upstream.origin,
      AbortSignal.timeout(5000),
    ),
    [
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
    ],
  );
  assert.deepEqual(
    await new WebDiscovery().discover(
      `${upstream.origin}/empty-only`,
      AbortSignal.timeout(5000),
    ),
    [],
  );
  assert.deepEqual(
    await new WebDiscovery().discover(
      `${upstream.origin}/false-only`,
      AbortSignal.timeout(5000),
    ),
    [
      {
        url: `${upstream.origin}/fallback-story`,
        lastModified: null,
        listingUrl: `${upstream.origin}/sitemap.xml`,
      },
    ],
  );
});

test('failures name the upstream and never return partial discovery', async () => {
  const index = 'https://publisher.example/index.xml';
  const broken = 'https://publisher.example/broken.xml';
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
    );
    await assert.rejects(
      new WebDiscovery().discover(index, AbortSignal.timeout(5000)),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryError);
        assert.equal(error.url, failure.url);
        assert.ok(error.cause);
        return true;
      },
    );
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
      new WebDiscovery().discover(index, controller.signal),
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
      // A guessed location must not satisfy the advertised listing claim.
      http.get(`${origin}/sitemap.xml`, () => new Response('<urlset/>')),
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
    );
    assert.deepEqual(
      await new WebDiscovery().discover(
        `${origin}/`,
        AbortSignal.timeout(5000),
      ),
      [
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
      ],
    );
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
    );
    assert.deepEqual(
      await new WebDiscovery().discover(
        'https://feeds.example/start',
        AbortSignal.timeout(5000),
      ),
      [
        {
          url: 'https://feeds.example/paper',
          lastModified: null,
          listingUrl: 'https://feeds.example/archive/feed',
        },
      ],
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
    );
    assert.deepEqual(
      await new WebDiscovery().discover(
        'https://start.example/blog',
        AbortSignal.timeout(5000),
      ),
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
    );
    const result = new WebDiscovery().discover(
      'https://bare.example/',
      AbortSignal.timeout(5000),
    );
    if (mapExists)
      assert.deepEqual(await result, [
        {
          url: 'https://bare.example/page',
          lastModified: null,
          listingUrl: 'https://bare.example/sitemap.xml',
        },
      ]);
    else
      await assert.rejects(
        result,
        (error: unknown) =>
          error instanceof DiscoveryError &&
          error.url === 'https://bare.example/sitemap.xml',
      );
  }
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
  );
  assert.deepEqual(
    await new WebDiscovery().discover(
      'https://maps.example/index.xml',
      AbortSignal.timeout(5000),
    ),
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
