import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { DiscoveryError, WebDiscovery } from './index.ts';

test('website archives discover older posts beyond the feed, following pagination without following articles or off-site links', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
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
      case '/robots.txt':
        response.writeHead(404).end();
        break;
      default:
        // Discovery reads listings, not the article bodies it returns.
        response.writeHead(500).end('Unexpected article download');
    }
  });
  const pages = await new WebDiscovery(
    got.extend({ retry: { limit: 0 } }),
  ).discover(upstream.origin, AbortSignal.timeout(5000));
  assert.deepEqual(pages, [
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
  ]);
});

test('archive failures remain attributable and cancellation stops a paginated scan', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('Stop the archive scan');
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<a href="/archive/">Archives</a>');
      } else if (request.url === '/archive/') {
        if (cancel) controller.abort(reason);
        response.writeHead(503).end('Archive unavailable');
      } else response.writeHead(404).end();
    });
    await assert.rejects(
      new WebDiscovery(got.extend({ retry: { limit: 0 } })).discover(
        upstream.origin,
        controller.signal,
      ),
      (error) =>
        cancel
          ? error === reason
          : error instanceof DiscoveryError &&
            error.url === `${upstream.origin}/archive/`,
    );
  }
});

test('dead discovered archive links do not discard history, while a dead chosen URL still fails', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end(
        '<a href="/archive/">Archive</a><a href="/archives/">Archives</a><a href="/2001/">2001</a>',
      );
    else if (request.url === '/2001/')
      response.end('<main><a href="/old-story">An older story</a></main>');
    else response.writeHead(request.url === '/archives/' ? 410 : 404).end();
  });
  const discovery = new WebDiscovery(got.extend({ retry: { limit: 0 } }));
  assert.deepEqual(
    await discovery.discover(upstream.origin, AbortSignal.timeout(5000)),
    [
      {
        url: `${upstream.origin}/old-story`,
        lastModified: null,
        listingUrl: `${upstream.origin}/2001/`,
      },
    ],
  );
  await assert.rejects(
    discovery.discover(
      `${upstream.origin}/archive/`,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DiscoveryError &&
      error.url === `${upstream.origin}/archive/`,
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
    else response.writeHead(404).end();
  });
  assert.deepEqual(
    await new WebDiscovery(got).discover(
      upstream.origin,
      AbortSignal.timeout(5000),
    ),
    [
      {
        url: `${upstream.origin}/early-report`,
        lastModified: null,
        listingUrl: `${upstream.origin}/writing`,
      },
    ],
  );
});

test('a chosen HTML archive follows HTTP pagination links and resolves redirected listings', async () => {
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
      default:
        response.writeHead(404).end();
    }
  });
  assert.deepEqual(
    await new WebDiscovery(got).discover(
      `${upstream.origin}/history`,
      AbortSignal.timeout(5000),
    ),
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
    const pages = await new WebDiscovery(got).discover(
      `${upstream.origin}/first`,
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(
      pages,
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

test('a self-linked archive and calendar indexes expose the full history', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
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
        response
          .writeHead(500)
          .end('An article must not be fetched as a calendar index');
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const pages = await new WebDiscovery(got).discover(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(
    pages.map((page) => page.url).sort(),
    [
      '/2001/02/03/second/',
      '/2001/Jan/2/first/',
      '/2001/essays/',
      '/early',
      '/recent',
    ]
      .map((path) => `${upstream.origin}${path}`)
      .sort(),
  );
});
