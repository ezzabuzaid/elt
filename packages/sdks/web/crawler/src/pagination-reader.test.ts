import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  AdaptiveRevisit,
  ArchiveReader,
  type CrawlFailure,
  type CrawledPage,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  type WebCrawler,
} from './index.ts';

// Got retries no network error, so a test's failure is its first answer.
const noRetries = got.extend({ retry: { limit: 0 } });

function pagination() {
  return new Origins(noRetries, null, globalThis).crawler(
    noRetries,
    [new PaginationReader()],
    new AdaptiveRevisit(),
  );
}

// Progress entries only mark URLs read for the readers; these tests assert pages and failures.
async function crawl(
  crawler: WebCrawler,
  start: string,
  signal: AbortSignal,
  include?: readonly [URLPattern, ...URLPattern[]],
) {
  const entries: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawler.crawl([start], null, { signal, include }))
    if (!('progress' in entry) && !('deferred' in entry) && !('gone' in entry))
      entries.push(entry);
  return entries;
}

function location(entry: CrawledPage | CrawlFailure) {
  if ('error' in entry) throw entry.error;
  const { url, listingUrl, lastModified } = entry;
  return { url, lastModified, listingUrl };
}

test('a failing page of the pagination is handed out as a failure, and the pages listed before it are kept', async (t) => {
  // A declared next page that is gone is a failure too, unlike a listed page.
  for (const status of [500, 404]) {
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/category')
        response.end(
          '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
        );
      else if (request.url === '/category?page=2')
        response.writeHead(status).end();
      else response.end('<p>An item.</p>');
    });

    const entries = await crawl(
      pagination(),
      `${upstream.origin}/category`,
      t.signal,
    );

    assert.deepEqual(
      entries.flatMap((entry) =>
        'error' in entry ? [{ url: entry.url, page: entry.error.page }] : [],
      ),
      [{ url: `${upstream.origin}/category?page=2`, page: false }],
      String(status),
    );
    assert.deepEqual(
      entries.filter((entry) => !('error' in entry)).map(location),
      [
        {
          url: `${upstream.origin}/item/1`,
          lastModified: null,
          listingUrl: `${upstream.origin}/category`,
        },
      ],
    );
  }
});

test('a declared next page of a JSON list that fails is handed out as a failure, and the pages handed back before it are kept', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/products?page=2') response.writeHead(500).end();
    else
      response
        .writeHead(200, {
          'content-type': 'application/json; charset=UTF-8',
          link: `<http://${request.headers.host}/products?page=2>; rel="next"`,
        })
        .end('[{"id":1}]');
  });

  const entries = await crawl(
    pagination(),
    `${upstream.origin}/products?page=1`,
    t.signal,
  );

  assert.deepEqual(
    entries.flatMap((entry) =>
      'error' in entry ? [{ url: entry.url, page: entry.error.page }] : [],
    ),
    // A page of a JSON list holds its records, so a failed one is a failed page.
    [{ url: `${upstream.origin}/products?page=2`, page: true }],
  );
  assert.deepEqual(
    entries.filter((entry) => !('error' in entry)).map(location),
    [
      {
        url: `${upstream.origin}/products?page=1`,
        lastModified: null,
        listingUrl: `${upstream.origin}/products?page=1`,
      },
    ],
  );
});

test('a JSON list is read to its end through the pages its Link header declares, and each of its pages is handed back once, the first included', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    const page = Number(
      new URL(request.url ?? '/', upstream.origin).searchParams.get('page'),
    );
    const list = `${upstream.origin}/wp-json/wc/store/v1/products?per_page=2`;
    // The header of WooCommerce's Store API as a live store gave it on
    // 2026-11-24: one header names the previous and the next page, and
    // WordPress escapes their & as &#038;, so the rest lands in the fragment.
    const links = [
      ...(page > 1
        ? [`<${list}&page=${page - 1}#038;page=${page}>; rel="prev"`]
        : []),
      ...(page < 3
        ? [`<${list}&page=${page + 1}#038;page=${page}>; rel="next"`]
        : []),
    ];
    response
      .writeHead(200, {
        'content-type': 'application/json; charset=UTF-8',
        ...(links.length > 0 ? { link: links.join(', ') } : {}),
      })
      .end(JSON.stringify([{ id: page * 2 - 1 }, { id: page * 2 }]));
  });
  const page = (n: number) =>
    `${upstream.origin}/wp-json/wc/store/v1/products?per_page=2&page=${n}`;

  const pages = await crawl(pagination(), page(1), t.signal);

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [1, 2, 3].map((n) => ({
      url: page(n),
      lastModified: null,
      listingUrl: page(Math.max(n - 1, 1)),
    })),
  );
});

test('a JSON list follows no next page on another origin', async (t) => {
  await using elsewhere = await new HttpServer().start((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end('[{"id":2}]');
  });
  await using upstream = await new HttpServer().start((_request, response) => {
    response
      .writeHead(200, {
        'content-type': 'application/json',
        link: `<${elsewhere.origin}/products?page=2>; rel="next"`,
      })
      .end('[{"id":1}]');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/products?page=1`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/products?page=1`],
  );
});

test('a JSON Feed served as application/json is a feed, not a JSON list, so the crawl hands back its items and not the feed', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.json')
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Blog',
          items: [{ id: '1', url: `${upstream.origin}/posts/1` }],
        }),
      );
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<p>A post.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [new ListingReader(), new PaginationReader()],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/feed.json`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/posts/1`],
  );
});

test("a list served as a JSON format of the +json suffix, such as JSON:API's, is a JSON list", async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/vnd.api+json',
      ...(request.url === '/articles?page=1'
        ? { link: '</articles?page=2>; rel="next"' }
        : {}),
    });
    response.end('{"data":[]}');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/articles?page=1`,
    t.signal,
  );

  assert.deepEqual(
    pages
      .map(location)
      .map((page) => page.url)
      .toSorted(),
    [
      `${upstream.origin}/articles?page=1`,
      `${upstream.origin}/articles?page=2`,
    ],
  );
});

test('a listed page that is gone is handed out as gone, not as a failure', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<main><a href="/item/1">One</a><a href="/item/sold">Sold</a><a href="/item/removed">Removed</a></main>',
      );
    else if (request.url === '/item/sold') response.writeHead(404).end();
    else if (request.url === '/item/removed') response.writeHead(410).end();
    else response.end('<p>An item.</p>');
  });

  const crawl = pagination().crawl([`${upstream.origin}/category`], null, {
    signal: t.signal,
  });
  const entries: (CrawledPage | CrawlFailure)[] = [];
  const gone: string[] = [];
  for await (const entry of crawl)
    if ('gone' in entry) gone.push(entry.gone.url);
    else if (!('progress' in entry) && !('deferred' in entry))
      entries.push(entry);

  assert.deepEqual(entries.map(location), [
    {
      url: `${upstream.origin}/item/1`,
      lastModified: null,
      listingUrl: `${upstream.origin}/category`,
    },
  ]);
  assert.deepEqual(gone.toSorted(), [
    `${upstream.origin}/item/removed`,
    `${upstream.origin}/item/sold`,
  ]);
  assert.ok(requests.includes('/item/sold'), requests.join(' '));
  assert.ok(requests.includes('/item/removed'), requests.join(' '));
});

test('a /sitemap.xml guess answered by a soft 404 page is not read as a list', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end('<main><a href="/news/1">News</a></main>');
    else if (request.url === '/robots.txt') response.writeHead(404).end();
    // The site's page template, answered with 200 for a missing sitemap.
    else if (request.url === '/sitemap.xml')
      response.end(
        '<main><h1>Page not found</h1><a href="/offers">Offers</a></main>',
      );
    else response.end('<p>A page.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [new ListingReader(), new PaginationReader()],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/news/1`],
  );
  assert.ok(requests.includes('/sitemap.xml'), requests.join(' '));
  assert.ok(!requests.includes('/offers'), requests.join(' '));
});

test('an archive that ArchiveReader finds and that fits on one page hands back the posts it lists, whatever the order of the readers', async (t) => {
  // In the second order, PaginationReader finds /2024/ as a page before ArchiveReader finds it as a list.
  for (const readers of [
    [new ArchiveReader(), new PaginationReader()],
    [new PaginationReader(), new ArchiveReader()],
  ]) {
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/') response.end('<a href="/2024/">2024</a>');
      // A year archive without pagination.
      else if (request.url === '/2024/')
        response.end(
          '<main><a href="/posts/a">A</a><a href="/posts/b">B</a></main>',
        );
      else response.end('<p>A post.</p>');
    });

    const pages = await crawl(
      new Origins(noRetries, null, globalThis).crawler(
        noRetries,
        readers,
        new AdaptiveRevisit(),
      ),
      `${upstream.origin}/`,
      t.signal,
      [new URLPattern({ pathname: '/posts/*' })],
    );

    assert.deepEqual(
      pages.map(location),
      ['/posts/a', '/posts/b'].map((path) => ({
        url: `${upstream.origin}${path}`,
        lastModified: null,
        listingUrl: `${upstream.origin}/2024/`,
      })),
      readers.map((reader) => reader.constructor.name).join(', '),
    );
  }
});

test('an archive that a later page of a list declares is no hop, so link limits count from the list', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
      );
    else if (request.url === '/category?page=2')
      response.end(
        '<head><link rel="archives" href="/2024/"></head><main><a href="/item/2">Two</a></main>',
      );
    // Only LinkReader reads links in navigation, and only on pages within its depth.
    else if (request.url === '/2024/')
      response.end(
        '<nav><a href="/about">About</a></nav><main><a href="/posts/a">A</a></main>',
      );
    else response.end('<p>A page.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [
        new PaginationReader(),
        new ArchiveReader(),
        new LinkReader({ maxDepth: 0, maxPages: 100 }),
      ],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/category`,
    t.signal,
  );

  assert.deepEqual(
    pages
      .map(location)
      .map((page) => page.url)
      .toSorted(),
    ['/about', '/item/1', '/item/2', '/posts/a'].map(
      (path) => `${upstream.origin}${path}`,
    ),
  );
});

test('pagination on a listed page is not followed, and neither are its other links', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<main><a href="/item/1">One</a><a href="/item/2">Two</a></main>',
      );
    else if (request.url === '/item/1') {
      // A listed page with pagination of its own, such as related ads or comments.
      response.setHeader('link', '</item/1/comments?page=2>; rel="next"');
      response.end(
        '<head><link rel="next" href="/related?page=2"></head><main><a rel="next" href="/item/1/photos/2">More photos</a><a href="/item/3">A related item</a></main>',
      );
    } else if (request.url === '/item/2') response.end('<p>An item.</p>');
    else if (request.url === '/robots.txt') response.writeHead(404).end();
    else response.end('<main><a href="/item/9">Another item</a></main>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/item/1`, `${upstream.origin}/item/2`],
  );
  assert.deepEqual(requests.toSorted(), [
    '/category',
    '/item/1',
    '/item/2',
    '/robots.txt',
  ]);
});

test('a crawl stopped inside the pagination and resumed from its snapshot reads the rest of the chain', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<head><link rel="next" href="/category?page=2"></head><main><a href="/item/1">One</a></main>',
      );
    else if (request.url === '/category?page=2')
      response.end(
        '<head><link rel="next" href="/category?page=3"></head><main><a href="/item/2">Two</a></main>',
      );
    else if (request.url === '/category?page=3')
      response.end('<main><a href="/item/3">Three</a></main>');
    else response.end('<p>An item.</p>');
  });
  const crawler = pagination();
  const first = crawler.crawl([`${upstream.origin}/category`], null, {
    signal: t.signal,
  });
  for await (const entry of first) if (!('progress' in entry)) break;
  const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
  requests.length = 0;

  const resumed: (CrawledPage | CrawlFailure)[] = [];
  for await (const entry of crawler.crawl([], snapshot, {
    signal: t.signal,
  }))
    if (!('progress' in entry) && !('deferred' in entry) && !('gone' in entry))
      resumed.push(entry);

  assert.deepEqual(
    resumed
      .map(location)
      .map((page) => page.url)
      .toSorted(),
    ['/item/1', '/item/2', '/item/3'].map(
      (path) => `${upstream.origin}${path}`,
    ),
  );
  assert.ok(!requests.includes('/category'), requests.join(' '));
});

test('the pagination of a starting page is read to its end, both ways, from link elements, anchors and HTTP Link headers', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    switch (request.url) {
      case '/category/2':
        response.end(
          '<head><link rel="prev" href="/category/1"></head><main><a href="/b">B</a><a rel="next" href="/category/3">Next</a></main>',
        );
        break;
      case '/category/1':
        response.end('<main><a href="/a">A</a></main>');
        break;
      case '/category/3':
        response.setHeader('link', '</category/4>; rel="next"');
        response.end('<main><a href="/c">C</a></main>');
        break;
      case '/category/4':
        response.end(
          '<main><a href="/d">D</a><a rel="prev" href="/category/3">Previous</a></main>',
        );
        break;
      default:
        response.end('<p>An item.</p>');
    }
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category/2`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      ['/a', '/category/1'],
      ['/b', '/category/2'],
      ['/c', '/category/3'],
      ['/d', '/category/4'],
    ].map(([path, listing]) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}${listing}`,
    })),
  );
});

test('undeclared pagination by page number is read to its last page, and a linked page that is gone is no failure', async (t) => {
  // The CMS forms: WordPress, Ghost and Hugo /page/N/, Django and Drupal ?page=N, WordPress ?paged=N.
  for (const at of [
    (page: number) => (page === 1 ? '/tag/x/' : `/tag/x/page/${page}/`),
    (page: number) => (page === 1 ? '/tag/x' : `/tag/x?page=${page}`),
    (page: number) => (page === 1 ? '/tag/x' : `/tag/x?paged=${page}`),
  ]) {
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('content-type', 'text/html');
      switch (request.url) {
        // As on Fortune: numbered links in navigation, and a page 0 that answers 404.
        case at(1):
          response.end(
            `<main><a href="/item/1">One</a></main><nav><a href="${at(0)}">0</a><a href="${at(2)}">2</a></nav>`,
          );
          break;
        // As on Ars Technica: a "Load more" link in the content.
        case at(2):
          response.end(
            `<main><a href="/item/2">Two</a><a href="${at(3)}">Load more</a></main>`,
          );
          break;
        case at(3):
          response.end(
            `<main><a href="/item/3">Three</a><a href="${at(2)}">Previous</a></main>`,
          );
          break;
        case at(0):
          response.writeHead(404).end();
          break;
        default:
          response.end('<p>An item.</p>');
      }
    });

    const pages = await crawl(
      pagination(),
      `${upstream.origin}${at(1)}`,
      t.signal,
    );

    assert.deepEqual(
      pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
      [1, 2, 3].map((page) => ({
        url: `${upstream.origin}/item/${page}`,
        lastModified: null,
        listingUrl: `${upstream.origin}${at(page)}`,
      })),
      at(2),
    );
  }
});

test('a year, a filter, the pages of another list and the list without its slash are pages, not pagination', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (request.url === '/tag/x/')
      response.end(
        '<main><a href="/item/1">One</a><a href="/tag/x/2022">2022</a><a href="/tag/x/?sort=new">Newest</a><a href="/tag/other/page/2/">More on other</a><a href="/tag/x">All of x</a></main>',
      );
    else if (request.url === '/tag/x/2022')
      response.end('<main><a href="/item/from-year">Year</a></main>');
    else if (request.url === '/tag/x/?sort=new')
      response.end('<main><a href="/item/from-filter">Filter</a></main>');
    else if (request.url === '/tag/other/page/2/')
      response.end('<main><a href="/item/from-other">Other</a></main>');
    else if (request.url === '/tag/x')
      response.end('<main><a href="/item/from-self">Self</a></main>');
    else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/tag/x/`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      '/item/1',
      '/tag/other/page/2/',
      '/tag/x',
      '/tag/x/?sort=new',
      '/tag/x/2022',
    ].map((path) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}/tag/x/`,
    })),
  );
  for (const path of [
    '/item/from-year',
    '/item/from-filter',
    '/item/from-other',
    '/item/from-self',
  ])
    assert.ok(!requests.includes(path), requests.join(' '));
});

test('a list that links itself and its first page is downloaded once when the URL patterns do not select it', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    // As on Fortune: each page links its own number outside navigation.
    if (request.url === '/tag/x/')
      response.end(
        '<main><a href="/item/1">One</a><a href="/tag/x/">1</a><a href="/tag/x/page/2/">2</a></main>',
      );
    else if (request.url === '/tag/x/page/2/')
      response.end(
        '<main><a href="/item/2">Two</a><a href="/tag/x/">1</a><a href="/tag/x/page/2/">2</a></main>',
      );
    else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/tag/x/`,
    t.signal,
    [new URLPattern({ pathname: '/item/*' })],
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/item/1`, `${upstream.origin}/item/2`],
  );
  assert.deepEqual(
    requests.filter((path) => path.startsWith('/tag/')),
    ['/tag/x/', '/tag/x/page/2/'],
  );
});

test('a declared pagination form is followed in place of the page-number rule', async (t) => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    // jekyll-paginate names its pages /page2/; a /page/N/ link is then no pagination.
    if (request.url === '/tag/x/')
      response.end(
        '<main><a href="/item/1">One</a></main><nav><a href="/tag/x/page2/">2</a><a href="/tag/x/page/9/">9</a></nav>',
      );
    else if (request.url === '/tag/x/page2/')
      response.end('<main><a href="/item/2">Two</a></main>');
    else if (request.url === '/tag/x/page/9/')
      response.end('<main><a href="/item/from-rule">Nine</a></main>');
    else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [
        new PaginationReader({
          pagination: [new URLPattern({ pathname: '/tag/:tag/page:n/' })],
        }),
      ],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/tag/x/`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [
      ['/item/1', '/tag/x/'],
      ['/item/2', '/tag/x/page2/'],
    ].map(([path, listing]) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}${listing}`,
    })),
  );
  assert.ok(!requests.includes('/item/from-rule'), requests.join(' '));
});

test('a list hands back only the pages on its own origin by default, also when the URL patterns match another origin', async (t) => {
  const other: string[] = [];
  await using elsewhere = await new HttpServer().start((request, response) => {
    other.push(request.url ?? '');
    response.end();
  });
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/blog/')
      response.end(
        `<main><a href="/blog/own">Own</a><a href="${elsewhere.origin}/post/1">Elsewhere</a></main>`,
      );
    else response.end('<p>A post.</p>');
  });

  // As OpenSooq's pattern, which names a path on any host.
  const pages = await crawl(
    pagination(),
    `${upstream.origin}/blog/`,
    t.signal,
    [new URLPattern({ pathname: '/:section/:slug' })],
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/blog/own`],
  );
  assert.deepEqual(other, []);
});

test('a list with the strategy all hands back the pages on other origins that the URL patterns select, and requests no other page', async (t) => {
  const sister: string[] = [];
  const other: string[] = [];
  // As deepmind.google/blog, whose cards link posts on blog.google.
  await using blog = await new HttpServer().start((request, response) => {
    sister.push(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    response.end('<p>A post.</p>');
  });
  await using elsewhere = await new HttpServer().start((request, response) => {
    other.push(request.url ?? '');
    response.end();
  });
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/blog/')
      response.end(
        `<main><a href="/blog/own">Own</a><a href="${blog.origin}/post/1">Sister</a><a href="${elsewhere.origin}/post/2">Elsewhere</a></main>`,
      );
    else response.end('<p>A post.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [new PaginationReader({ strategy: 'all' })],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/blog/`,
    t.signal,
    [
      new URLPattern(`${upstream.origin}/blog/*`),
      new URLPattern(`${blog.origin}/post/*`),
    ],
  );

  assert.deepEqual(
    pages.map(location).toSorted((a, b) => a.url.localeCompare(b.url)),
    [`${blog.origin}/post/1`, `${upstream.origin}/blog/own`]
      .toSorted()
      .map((url) => ({
        url,
        lastModified: null,
        listingUrl: `${upstream.origin}/blog/`,
      })),
  );
  assert.ok(sister.includes('/post/1'), sister.join(' '));
  assert.deepEqual(other, []);
});

test('a reader takes the strategy same-origin or all and no origins, and no list of URL patterns is empty', (t) => {
  // The type checker proves this test: each line it expects an error on must not compile.
  new PaginationReader({ strategy: 'same-origin' });
  new PaginationReader({ strategy: 'all' });
  // @ts-expect-error -- the strategies are 'same-origin' and 'all'
  new PaginationReader({ strategy: 'any' });
  // @ts-expect-error -- a list hands back other origins through the strategy 'all' and the crawl's URL patterns
  new PaginationReader({ origins: ['https://blog.google'] });
  // @ts-expect-error -- an empty list of pagination forms would turn the page-number rule off and declare none
  new PaginationReader({ pagination: [] });
  pagination().crawl([], null, {
    signal: t.signal,
    // @ts-expect-error -- an empty list of URL patterns would hand back no page
    include: [],
  });
});

test('a list with the strategy all follows no pagination to another origin', async (t) => {
  await using elsewhere = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/tag/x/page/2/')
      response.end('<main><a href="/item/2">Two</a></main>');
    else if (request.url === '/tag/x/page/3/')
      response.end('<main><a href="/item/3">Three</a></main>');
    else response.end('<p>An item.</p>');
  });
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/tag/x/') {
      response.setHeader(
        'link',
        `<${elsewhere.origin}/tag/x/page/2/>; rel="next"`,
      );
      response.end(
        `<link rel="next" href="${elsewhere.origin}/tag/x/page/3/"><main><a href="/item/1">One</a></main>`,
      );
    } else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [new PaginationReader({ strategy: 'all' })],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/tag/x/`,
    t.signal,
    [
      new URLPattern(`${upstream.origin}/item/*`),
      new URLPattern(`${elsewhere.origin}/item/*`),
    ],
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/item/1`],
  );
});

test('a list whose stylesheet jsdom cannot parse writes nothing to the console', async (t) => {
  // A stray closing brace; jsdom reports it as "Could not parse CSS stylesheet".
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<html><head><style>.a{color:red}}</style></head><body><main><a href="/item/1">One</a></main></body></html>',
      );
    else response.end('<p>An item.</p>');
  });
  const errors = t.mock.method(console, 'error', () => {});

  const pages = await crawl(
    new Origins(noRetries, null, globalThis).crawler(
      noRetries,
      [new ArchiveReader(), new PaginationReader()],
      new AdaptiveRevisit(),
    ),
    `${upstream.origin}/category`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location).map((page) => page.url),
    [`${upstream.origin}/item/1`],
  );
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: [message] }) => message),
    [],
  );
});

test('a starting page without pagination hands back the pages it lists outside navigation', async (t) => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/category')
      response.end(
        '<nav><a href="/about">About</a></nav><main><a href="/item/1">One</a><a href="/item/2">Two</a></main><footer><a href="/contact">Contact</a></footer>',
      );
    else response.end('<p>An item.</p>');
  });

  const pages = await crawl(
    pagination(),
    `${upstream.origin}/category`,
    t.signal,
  );

  assert.deepEqual(
    pages.map(location),
    ['/item/1', '/item/2'].map((path) => ({
      url: `${upstream.origin}${path}`,
      lastModified: null,
      listingUrl: `${upstream.origin}/category`,
    })),
  );
});
