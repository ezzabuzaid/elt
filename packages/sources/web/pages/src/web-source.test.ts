import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import type { Response } from 'got';

import {
  Connection,
  Copy,
  CopyProgress,
  Pipeline,
  PipelineError,
  passChannels,
} from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import {
  ArticleError,
  HTMLExtraction,
  WebArticle,
} from '@eltjs/sdk-web-article';
import {
  AlwaysRevisit,
  ArchiveReader,
  CompositeRevisit,
  CrawlError,
  FixedRevisit,
  LinkReader,
  ListingReader,
  OnceRevisit,
  PaginationReader,
  StartReader,
  day,
  hour,
} from '@eltjs/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebClient } from './http/web-http.ts';
import { RecordExtractor } from './record-extractor.ts';
import { type WebInput, WebSource, webInput } from './web-source.ts';
import { WebStream } from './web-stream.ts';

test('native articles persist clean text and refresh independently changing HTML metadata', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let date = '2026-10-24';
  const markdown =
    '# Field report\n\nRead the [findings](/findings).\n\nSubscribe for updates.';
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.xml') {
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end('<rss><channel><item><link>/report</link></item></channel></rss>');
    } else if (request.headers.accept?.startsWith('text/markdown')) {
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end(markdown);
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<html><head><meta name="author" content="Lina"><meta property="article:published_time" content="${date}"></head><body><article><p>Read the <a href="/findings">findings</a>.</p></article><footer>Subscribe for updates.</footer></body></html>`,
        );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 1);
  const article = database.connection
    .prepare(
      'SELECT markdown, textContent, byline, publishedTime FROM articles',
    )
    .get();
  assert.ok(article);
  assert.equal(article.markdown, markdown);
  assert.equal(
    article.textContent,
    `Read the findings [${upstream.origin}/findings].`,
  );
  assert.equal(article.byline, 'Lina');
  assert.equal(article.publishedTime, '2026-10-24');
  assert.equal((await ingestion.run())[0]?.count, 0);
  date = '2026-10-25';
  assert.equal((await ingestion.run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT publishedTime FROM articles').get()
      ?.publishedTime,
    '2026-10-25',
  );
});

test('archive articles persist Markdown and an unchanged rerun writes no records', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/') response.end('<a href="/archive/">Archive</a>');
    else if (request.url === '/archive/')
      response.end('<main><a href="/older">Older field report</a></main>');
    else if (request.url === '/older')
      response.end(
        '<article><p>These observations confirm the <a href="/results">published results</a>.</p></article>',
      );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [{ stream: articles(), inputs: [upstream.origin] }],
  });
  const ingestion = await pipeline(source, database.path, checkpoints.path);
  assert.equal((await ingestion.run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT markdown FROM articles').get()
      ?.markdown,
    `These observations confirm the [published results](${upstream.origin}/results).`,
  );
  assert.equal((await ingestion.run())[0]?.count, 0);
});

test('the pipeline prefers native Markdown, keeps HTML fallback and writes nothing on an unchanged rerun', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.xml') {
      assert(!request.headers.accept?.includes('text/markdown'));
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/native</link></item><item><link>/html</link></item></channel></rss>',
        );
    } else if (
      request.url === '/native' &&
      request.headers.accept?.startsWith('text/markdown')
    ) {
      response
        .writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        .end('# Native report\n\n**Publisher Markdown** stays intact.');
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><title>HTML report</title></head><body><article><p>The HTML-only report remains available.</p></article></body></html>',
        );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 2);
  assert.deepEqual(
    database.connection
      .prepare('SELECT title, markdown FROM articles ORDER BY title')
      .all()
      .map(({ title, markdown }) => ({ title, markdown })),
    [
      {
        title: 'HTML report',
        markdown: 'The HTML-only report remains available.',
      },
      {
        title: 'Native report',
        markdown: '# Native report\n\n**Publisher Markdown** stays intact.',
      },
    ],
  );
  assert.equal((await ingestion.run())[0]?.count, 0);
});

test('a page whose Markdown request a site redirects to an HTML app shell, saying Vary: Accept, is stored as the page a browser gets, under its own URL', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // linear.app on 2026-10-30, trimmed: a Markdown request is sent to
  // /index.md, which answers every request with the app's loading shell.
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end('<rss><channel><item><link>/</link></item></channel></rss>');
    else if (
      request.url === '/' &&
      request.headers.accept?.startsWith('text/markdown')
    )
      response.writeHead(307, { location: '/index.md', vary: 'Accept' }).end();
    else if (request.url === '/')
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          link: '</index.md>; rel="alternate"; type="text/markdown"',
        })
        .end(
          '<!doctype html><html lang="en"><head><title>Linear – The system for product development</title></head><body><main><h1>The product development system for teams and agents</h1><p>Purpose-built for planning and building products. Designed for the AI era.</p></main></body></html>',
        );
    else if (request.url === '/index.md')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linear</title></head><body><div id="root"></div><div id="loading"><div id="loading-content">Loading…</div></div></body></html>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT articleUrl, title FROM articles')
      .all()
      .map(({ articleUrl, title }) => ({ articleUrl, title })),
    [
      {
        articleUrl: `${upstream.origin}/`,
        title: 'Linear – The system for product development',
      },
    ],
  );
});

test('a page asked again as a browser after a failed Markdown redirect is extracted again when that page changes and its shell does not', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let tagline = 'Purpose-built for planning and building products.';
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end('<rss><channel><item><link>/</link></item></channel></rss>');
    else if (
      request.url === '/' &&
      request.headers.accept?.startsWith('text/markdown')
    )
      response.writeHead(307, { location: '/index.md', vary: 'Accept' }).end();
    else if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><html lang="en"><head><title>Linear – The system for product development</title></head><body><main><h1>The product development system for teams and agents</h1><p>${tagline}</p></main></body></html>`,
        );
    else if (request.url === '/index.md')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linear</title></head><body><div id="root"></div><div id="loading"><div id="loading-content">Loading…</div></div></body></html>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  await ingestion.run();

  tagline = 'Designed for the AI era.';
  const [second] = await ingestion.run();

  assert.equal(second?.count, 1);
  assert.match(
    String(
      database.connection.prepare('SELECT markdown FROM articles').get()
        ?.markdown,
    ),
    /Designed for the AI era/,
  );
});

test('an article that a feed and a sitemap list with and without a trailing slash is stored once, and an unchanged rerun writes nothing', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // Like ezz.sh live on 2026-10-26: rss.xml and sitemap-0.xml name the two forms, both answer 200 and declare one canonical URL.
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/robots.txt')
      response.end(`Sitemap: ${upstream.origin}/sitemap.xml`);
    else if (request.url === '/sitemap.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset><url><loc>${upstream.origin}/posts/ways-of-writing/</loc></url></urlset>`,
        );
    else if (request.url === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/posts/ways-of-writing</link></item></channel></rss>',
        );
    else if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        );
    else if (request.url?.startsWith('/posts/ways-of-writing'))
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<title>Ways of writing</title><link rel="canonical" href="/posts/ways-of-writing/"><article><h1>Ways of writing</h1><p>Writing every day keeps the ideas moving.</p></article>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: articles(), inputs: [upstream.origin] }],
    }),
    database.path,
    checkpoints.path,
  );
  await ingestion.run();

  assert.deepEqual(
    requests.filter((url) => url.startsWith('/posts/')).toSorted(),
    ['/posts/ways-of-writing', '/posts/ways-of-writing/'],
  );
  assert.deepEqual(
    {
      ...database.connection
        .prepare('SELECT count(*) AS rows FROM articles')
        .get(),
    },
    { rows: 1 },
  );
  assert.deepEqual(
    database.connection
      .prepare('SELECT articleUrl, title FROM articles')
      .all()
      .map((row) => ({ ...row })),
    [
      {
        articleUrl: `${upstream.origin}/posts/ways-of-writing/`,
        title: 'Ways of writing',
      },
    ],
  );
  assert.equal((await ingestion.run())[0]?.count, 0);
});

async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  const history = new SQLiteSyncHistory();
  return new Pipeline({
    clock: globalThis,
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: `web:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('temporary listing and article failures recover in the run after their Retry-After', async (t) => {
  // A block ends by the clock; the test moves Date past each Retry-After.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const retried = requests.includes(url.pathname);
    requests.push(url.pathname);
    if (!retried) {
      response
        .writeHead(url.pathname === '/feed.xml' ? 503 : 429, {
          'retry-after': '1',
        })
        .end();
    } else if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/article</link></item></channel></rss>`,
      );
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>The recovered article contains the complete published observations.</p></article>',
      );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  // Got retries no refusal: each one holds the origin until its Retry-After,
  // and the next run after it asks again.
  await assert.rejects(ingestion.run(), PipelineError);
  t.mock.timers.setTime(Date.now() + 2000);
  await assert.rejects(ingestion.run(), PipelineError);
  t.mock.timers.setTime(Date.now() + 2000);
  assert.equal((await ingestion.run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT textContent FROM articles').get()
      ?.textContent,
    'The recovered article contains the complete published observations.',
  );
  // Every crawl reads the feed again, as AlwaysRevisit makes it due.
  assert.deepEqual(requests, [
    '/feed.xml',
    '/feed.xml',
    '/article',
    '/feed.xml',
    '/article',
  ]);
});

test('a site that refuses the first connection, as during a short network drop, is stored within one run', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/article</link></item></channel></rss>`,
      );
    } else if (url.pathname === '/article') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>The article read after the network came back contains the complete published observations.</p></article>',
      );
    } else response.writeHead(404).end();
  });
  // The network drops: the site's port refuses connections, and it is back
  // after the first refusal, before Got's retry delay of at least a second.
  upstream.server.close();
  const reopen = () => {
    unsubscribe('http.client.request.error', reopen);
    upstream.server.listen(Number(new URL(upstream.origin).port), '127.0.0.1');
  };
  subscribe('http.client.request.error', reopen);
  try {
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
        ],
      }),
      database.path,
      checkpoints.path,
    );

    assert.equal((await ingestion.run())[0]?.count, 1);
    assert.equal(
      database.connection.prepare('SELECT textContent FROM articles').get()
        ?.textContent,
      'The article read after the network came back contains the complete published observations.',
    );
  } finally {
    unsubscribe('http.client.request.error', reopen);
  }
});

test('a page whose read fails with EADDRNOTAVAIL, as when the Mac sleeps, is tried again and stored within one run', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/article</link></item></channel></rss>`,
      );
    } else if (url.pathname === '/article') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>The article read after the Mac woke up contains the complete published observations.</p></article>',
      );
    } else response.writeHead(404).end();
  });
  // Only the kernel raises EADDRNOTAVAIL, when the Mac's address goes away
  // during sleep, so an interceptor at Node's HTTP transport raises it for the
  // first article request. Every other request reaches the site.
  const interceptor = new ClientRequestInterceptor();
  let dropped = false;
  interceptor.on('request', ({ request, controller }) => {
    if (dropped || new URL(request.url).pathname !== '/article') return;
    dropped = true;
    controller.errorWith(
      Object.assign(new Error('read EADDRNOTAVAIL'), {
        code: 'EADDRNOTAVAIL',
        syscall: 'read',
      }),
    );
  });
  interceptor.apply();
  try {
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
        ],
      }),
      database.path,
      checkpoints.path,
    );

    assert.equal((await ingestion.run())[0]?.count, 1);
    assert.equal(
      database.connection.prepare('SELECT textContent FROM articles').get()
        ?.textContent,
      'The article read after the Mac woke up contains the complete published observations.',
    );
    assert(dropped);
  } finally {
    interceptor.dispose();
  }
});

test('failed articles do not block later articles or later refreshes', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: string[] = [];
  let failing = true;
  let added = false;
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel>${(added ? ['c', 'b', 'a', 'aa'] : ['c', 'b', 'a']).map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
      );
    } else if (url.pathname === '/b' && failing) {
      response.writeHead(404).end();
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article><p>Research article ${url.pathname} contains the complete published observations.</p></article>`,
      );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [{ stream: articles(), inputs: [`${upstream.origin}/feed.xml`] }],
  };
  const first = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );
  await assert.rejects(first.run(), (error) => {
    assert(error instanceof PipelineError);
    assert.equal(error.results[0]?.count, 2);
    assert.equal(error.results[0]?.failures.length, 1);
    assert.match(error.message, /\/b/);
    return true;
  });
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => row.pageUrl),
    [`${upstream.origin}/a`, `${upstream.origin}/c`],
  );
  // Feed order: the article after the failure still downloads, and a 404 is not retried within the run.
  assert.deepEqual(requests, ['/feed.xml', '/c', '/b', '/a']);
  added = true;
  const refresh = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );
  await assert.rejects(refresh.run(), (error) => {
    assert(error instanceof PipelineError);
    assert.equal(
      error.results[0]?.count,
      1,
      'a failed URL must not starve new URLs',
    );
    return true;
  });
  failing = false;
  requests.length = 0;
  const resumed = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );
  assert.equal((await resumed.run())[0]?.count, 1);
  // The listing is read first, then its pages in feed order; the earlier failure is one of them.
  assert.deepEqual(requests, ['/feed.xml', '/c', '/b', '/a', '/aa']);
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => row.pageUrl),
    ['a', 'aa', 'b', 'c'].map((name) => `${upstream.origin}/${name}`),
  );
});

test(
  'failed URLs survive feed rollover and cancellation during a later retry',
  { timeout: 60_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    let phase = 0;
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.json') {
        response.setHeader('content-type', 'application/feed+json');
        response.end(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Observations',
            items: (phase === 0
              ? ['a', 'b', 'c', 'd']
              : phase === 1
                ? []
                : ['c', 'd', 'e']
            ).map((name) => ({ id: name, url: `${url.origin}/${name}` })),
          }),
        );
      } else if (phase === 0 && url.pathname === '/a') {
        response.writeHead(404).end();
      } else if (phase === 0 && url.pathname === '/b') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
      } else if (phase === 1 && url.pathname === '/b') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<article><p>A retry that has not finished');
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<article><p>Published research for ${url.pathname} survives failures elsewhere in the feed.</p></article>`,
        );
      }
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const options = {
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.json`] },
      ],
    };
    const first = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    await assert.rejects(first.run(), (error) => {
      assert(error instanceof PipelineError);
      assert.equal(error.results[0]?.count, 2);
      const failure = error.results[0]?.failures[0];
      assert.deepEqual(failure?.partition, {
        inputUrl: options.streams[0]?.inputs[0],
      });
      assert(failure?.error instanceof AggregateError);
      // The download of /a fails in the crawler; /b downloads but holds no article.
      const [download, extraction, ...rest] = failure.error.errors;
      assert.deepEqual(rest, []);
      assert(download instanceof CrawlError);
      assert(Error.isError(download.cause));
      assert.equal(download.url, `${upstream.origin}/a`);
      assert(extraction instanceof ArticleError);
      assert(Error.isError(extraction.cause));
      assert.equal(extraction.url, `${upstream.origin}/b`);
      return true;
    });

    phase = 1;
    requests.length = 0;
    const retry = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const reason = new Error('Stop after the first recovered article');
    const stopAfterOne = (message: unknown) => {
      if (
        message instanceof CopyProgress &&
        message.connection === retry.connections[0] &&
        message.committed.count === 1
      )
        controller.abort(reason);
    };
    passChannels.progress.subscribe(stopAfterOne);
    try {
      await assert.rejects(
        retry.run({ signal: controller.signal }),
        (error) => error === reason,
      );
    } finally {
      controller.abort(reason);
      passChannels.progress.unsubscribe(stopAfterOne);
    }
    assert(
      requests.includes('/a'),
      'retry must retain a URL missing from the current feed',
    );
    assert(!requests.includes('/c') && !requests.includes('/d'));

    phase = 2;
    requests.length = 0;
    const resumed = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    // The interrupted crawl resumes: /a, handed out last, downloads once more
    // unchanged, then the known pages that the feed no longer names, unchanged too.
    // The feed is due, so the run reads it again and finds /e.
    assert.equal((await resumed.run())[0]?.count, 2);
    assert.deepEqual(requests, ['/feed.json', '/a', '/b', '/c', '/d', '/e']);
    requests.length = 0;
    // The crawl finished, so the next run reads the feed again and finds nothing new.
    assert.equal((await resumed.run())[0]?.count, 0);
    assert.deepEqual(requests, ['/feed.json', '/c', '/d', '/e', '/a', '/b']);
    assert.deepEqual(
      database.connection
        .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
        .all()
        .map((row) => row.pageUrl),
      ['a', 'b', 'c', 'd', 'e'].map((name) => `${upstream.origin}/${name}`),
    );
    assert.equal(
      database.connection
        .prepare('SELECT listingUrl FROM articles WHERE pageUrl = ?')
        .get(`${upstream.origin}/b`)?.listingUrl,
      options.streams[0]?.inputs[0],
    );
  },
);

test(
  'listing, redirect and page requests to one origin start at least one second apart',
  { timeout: 30_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: { path: string; at: number }[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push({ path: url.pathname, at: performance.now() });
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel>${['a', 'b', 'c'].map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
        );
      } else if (url.pathname === '/a') {
        response.writeHead(302, { location: '/article' }).end();
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<article><p>Published observations from ${url.pathname} remain complete after download.</p></article>`,
        );
      }
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    assert.equal((await ingestion.run())[0]?.count, 3);
    // The redirect of /a is a request of its own, after the pages that the feed names.
    assert.deepEqual(
      requests.map(({ path }) => path),
      ['/feed.xml', '/a', '/b', '/c', '/article'],
    );
    for (let index = 1; index < requests.length; index++) {
      const before = requests[index - 1];
      const after = requests[index];
      assert(before && after);
      // Measure arrivals at the HTTP boundary; allow small event-loop/transport jitter.
      assert(
        after.at - before.at >= 950,
        `${after.path} started ${after.at - before.at} ms after ${before.path}`,
      );
    }
  },
);

test(
  'cancellation stops a streaming download and queued requests after an article failure',
  { timeout: 10_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const streaming = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel>${['a', 'b', 'c', 'd', 'e'].map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
        );
      } else if (url.pathname === '/a') {
        response.writeHead(404).end();
      } else if (url.pathname === '/b') {
        response.once('close', () => closed.resolve());
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<article><p>A download that has not finished');
        streaming.resolve();
      } else response.writeHead(500).end('This request should never start');
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const reason = new Error('Stop this pass');
    const stopped = assert.rejects(
      ingestion.run({ signal: controller.signal }),
      (error) => error === reason,
    );
    try {
      await streaming.promise;
      controller.abort(reason);
      await stopped;
      await closed.promise;
      assert.deepEqual(requests, ['/feed.xml', '/a', '/b']);
    } finally {
      controller.abort(reason);
      await stopped;
    }
  },
);

test(
  'a slow article holds back later downloads instead of prefetching the feed',
  { timeout: 15_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const requests: string[] = [];
    await using upstream = await new HttpServer().start(
      async (request, response) => {
        // The site has no robots.txt.
        if (request.url === '/robots.txt') {
          response.writeHead(404).end();
          return;
        }
        const url = new URL(
          request.url ?? '/',
          `http://${request.headers.host}`,
        );
        if (url.pathname === '/feed.xml') {
          response.setHeader('content-type', 'application/rss+xml');
          response.end(
            `<rss><channel>${['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
          );
        } else {
          requests.push(url.pathname);
          if (url.pathname === '/a') {
            entered.resolve();
            await release.promise;
          }
          response.setHeader('content-type', 'text/html');
          response.end(
            `<article><p>Published observations from ${url.pathname} are retained in their complete form.</p></article>`,
          );
        }
      },
    );
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const running = ingestion.run({ signal: controller.signal });
    try {
      await entered.promise;
      // A full rate-limit window lets a prefetching producer expose extra downloads.
      await setTimeout(1100);
      assert.deepEqual(requests, ['/a']);
      release.resolve();
      assert.equal((await running)[0]?.count, 6);
      assert.deepEqual(requests, ['/a', '/b', '/c', '/d', '/e', '/f']);
    } finally {
      release.resolve();
      controller.abort();
      await running.catch(() => undefined);
    }
  },
);

test('a completed scan retains successful articles and retries failures on the next refresh', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let failing = true;
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/feed.json') {
      response.setHeader('content-type', 'application/feed+json');
      response.end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Research',
          items: [
            { id: 'a', url: `${url.origin}/a` },
            { id: 'b', url: `${url.origin}/b` },
          ],
        }),
      );
    } else if (url.pathname === '/b' && failing) {
      response.writeHead(503).end('Temporarily unavailable');
    } else if (url.pathname === '/a' || url.pathname === '/b') {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<title>Research ${url.pathname}</title><article><p>Independent research findings for ${url.pathname} remain available for readers.</p></article>`,
      );
    } else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [{ stream: articles(), inputs: [`${upstream.origin}/feed.json`] }],
  };
  const first = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );

  await assert.rejects(first.run(), PipelineError);
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl, textContent FROM articles')
      .all()
      .map((row) => ({ ...row })),
    [
      {
        pageUrl: `${upstream.origin}/a`,
        textContent:
          'Independent research findings for /a remain available for readers.',
      },
    ],
  );
  failing = false;
  requests.length = 0;
  const resumed = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );
  assert.equal((await resumed.run())[0]?.count, 1);
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => row.pageUrl),
    [`${upstream.origin}/a`, `${upstream.origin}/b`],
  );
  assert(
    requests.includes('/a'),
    'a completed scan must check successful articles for updates',
  );
  assert(requests.includes('/b'));
});

test(
  'cancelling an active download preserves committed progress for a new pipeline',
  { timeout: 10_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const downloading = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let blocking = true;
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel><title>Research</title><item><link>${url.origin}/a</link></item><item><link>${url.origin}/b</link></item></channel></rss>`,
        );
      } else if (url.pathname === '/b' && blocking) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<article><p>An incomplete download');
        response.on('close', () => closed.resolve());
        downloading.resolve();
      } else if (url.pathname === '/a' || url.pathname === '/b') {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<article><p>Completed research article ${url.pathname} with its original findings.</p></article>`,
        );
      } else response.writeHead(404).end();
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const options = {
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    };
    const first = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const reason = new Error('User stopped ingestion');
    const stopped = assert.rejects(
      first.run({ signal: controller.signal }),
      (error) => error === reason,
    );
    try {
      await downloading.promise;
      controller.abort(reason);
      await stopped;
      await closed.promise;
      assert.equal(
        database.connection
          .prepare('SELECT count(*) AS count FROM articles')
          .get()?.count,
        1,
      );
      blocking = false;
      requests.length = 0;
      const resumed = await pipeline(
        new WebSource(options),
        database.path,
        checkpoints.path,
      );
      // The crawl resumes and reads the due feed again; /a, handed out last, downloads once more and writes nothing.
      assert.equal((await resumed.run())[0]?.count, 1);
      assert.equal(
        database.connection
          .prepare('SELECT count(*) AS count FROM articles')
          .get()?.count,
        2,
      );
      assert.deepEqual(requests, ['/feed.xml', '/a', '/b']);
    } finally {
      controller.abort(reason);
      await stopped;
    }
  },
);

test('chosen websites and feeds persist article metadata, make unchanged reruns empty, and replace changed articles', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let revised = false;
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
      );
    } else if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><title>Field notes</title><item><link>${url.origin}/a</link></item>${revised ? `<item><link>${url.origin}/b</link></item>` : ''}</channel></rss>`,
      );
    } else if (url.pathname === '/a' || url.pathname === '/b') {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<html lang="en"><head><title>Field notes ${url.pathname}</title><meta name="author" content="Research Team"><meta property="article:published_time" content="2026-10-24T09:00:00Z"><link rel="canonical" href="/notes${url.pathname}"></head><body><article><p>${revised ? 'Revised' : 'Original'} research findings from ${url.pathname} with evidence and reproducible observations.</p></article></body></html>`,
      );
    } else response.writeHead(404).end();
  });
  for (const input of ['/', '/feed.xml']) {
    revised = false;
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const options = {
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: articles(), inputs: [`${upstream.origin}${input}`] }],
    };
    const first = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    assert.equal((await first.run())[0]?.count, 1);
    assert.deepEqual(
      database.connection
        .prepare(
          'SELECT inputUrl, pageUrl, url, canonicalUrl, articleUrl, title, byline, publishedTime, lang, textContent FROM articles',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          inputUrl: `${upstream.origin}${input}`,
          pageUrl: `${upstream.origin}/a`,
          url: `${upstream.origin}/a`,
          canonicalUrl: `${upstream.origin}/notes/a`,
          articleUrl: `${upstream.origin}/notes/a`,
          title: 'Field notes /a',
          byline: 'Research Team',
          publishedTime: '2026-10-24T09:00:00Z',
          lang: 'en',
          textContent:
            'Original research findings from /a with evidence and reproducible observations.',
        },
      ],
    );
    assert.match(
      String(
        database.connection.prepare('SELECT content FROM articles').get()
          ?.content,
      ),
      /<p>Original research findings/,
    );
    const rerun = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    const emitted: number[] = [];
    const count = (message: unknown) => {
      if (
        message instanceof CopyProgress &&
        message.connection === rerun.connections[0]
      )
        emitted.push(message.emitted.count);
    };
    passChannels.progress.subscribe(count);
    try {
      assert.equal(
        (await rerun.run())[0]?.count,
        0,
        'unchanged records must not be re-emitted',
      );
    } finally {
      passChannels.progress.unsubscribe(count);
    }
    assert(emitted.length > 0);
    assert(
      emitted.every((count) => count === 0),
      'the source emits no unchanged records before destination deduplication',
    );
    assert.equal(
      database.connection
        .prepare('SELECT count(*) AS count FROM articles')
        .get()?.count,
      1,
    );
    revised = true;
    const changed = await pipeline(
      new WebSource(options),
      database.path,
      checkpoints.path,
    );
    assert.equal((await changed.run())[0]?.count, 2);
    assert.deepEqual(
      database.connection
        .prepare('SELECT textContent FROM articles ORDER BY pageUrl')
        .all()
        .map((row) => row.textContent),
      [
        'Revised research findings from /a with evidence and reproducible observations.',
        'Revised research findings from /b with evidence and reproducible observations.',
      ],
    );
    assert.equal((await changed.run())[0]?.count, 0);
  }
});

test('feed rollover retains articles and independent inputs keep their own progress when one fails', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let failing = true;
  let rolled = false;
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/two.json' && failing) response.writeHead(503).end();
    else if (url.pathname.endsWith('.json')) {
      response.setHeader('content-type', 'application/feed+json');
      response.end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Reading',
          items:
            url.pathname === '/one.json' && rolled
              ? []
              : [
                  { id: 'a', url: `${url.origin}/article` },
                  { id: 'menu', url: `${url.origin}/menu` },
                ],
        }),
      );
    } else if (url.pathname === '/article') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>A published observation remains available after the feed moves on.</p></article>',
      );
    } else if (url.pathname === '/menu') {
      response.setHeader('content-type', 'text/html');
      response.end('<nav><a href="/">Home</a></nav>');
    } else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const first = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: articles(),
          inputs: [
            `${upstream.origin}/two.json`,
            `${upstream.origin}/one.json`,
          ],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  await assert.rejects(first.run(), PipelineError);
  assert.deepEqual(
    database.connection
      .prepare('SELECT inputUrl FROM articles')
      .all()
      .map((row) => row.inputUrl),
    [`${upstream.origin}/one.json`],
  );
  failing = false;
  const extended = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: articles(),
          inputs: [
            `${upstream.origin}/one.json`,
            `${upstream.origin}/two.json`,
            `${upstream.origin}/three.json`,
          ],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await extended.run())[0]?.count, 2);
  assert.deepEqual(
    database.connection
      .prepare('SELECT inputUrl FROM articles ORDER BY inputUrl')
      .all()
      .map((row) => row.inputUrl),
    [
      `${upstream.origin}/one.json`,
      `${upstream.origin}/three.json`,
      `${upstream.origin}/two.json`,
    ],
  );
  rolled = true;
  assert.equal((await extended.run())[0]?.count, 0);
  assert.equal(
    database.connection.prepare('SELECT count(*) AS count FROM articles').get()
      ?.count,
    3,
  );
});

test('a failed full refresh tries later articles and preserves the last complete collection', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let revised = false;
  let failing = false;
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/sitemap.xml') {
      response.setHeader('content-type', 'application/xml');
      response.end(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/a</loc></url>${revised ? `<url><loc>${url.origin}/b</loc></url><url><loc>${url.origin}/c</loc></url>` : ''}</urlset>`,
      );
    } else if (url.pathname === '/b' && failing) response.writeHead(503).end();
    else if (['/a', '/b', '/c'].includes(url.pathname)) {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article><p>${revised ? 'Updated' : 'Original'} complete article ${url.pathname} with the published research findings.</p></article>`,
      );
    } else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      { stream: articles(), inputs: [`${upstream.origin}/sitemap.xml`] },
    ],
  });
  const destination = new SQLiteDestination({ path: database.path });
  const history = new SQLiteSyncHistory();
  const refresh = new Pipeline({
    clock: globalThis,
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        // A full refresh: the routes stream reads only incrementally.
        steps: [(await source.discover()).get('articles')].map(
          (stream) => new Copy(stream, destination.table(stream.name)),
        ),
      }),
    ],
  });
  await refresh.run();
  const before = database.connection
    .prepare('SELECT pageUrl, textContent FROM articles ORDER BY pageUrl')
    .all();
  assert.equal(before.length, 1);
  revised = true;
  failing = true;
  requests.length = 0;
  await assert.rejects(refresh.run(), PipelineError);
  assert(requests.includes('/c'));
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl, textContent FROM articles ORDER BY pageUrl')
      .all(),
    before,
  );
  failing = false;
  assert.equal((await refresh.run())[0]?.count, 3);
  assert.deepEqual(
    database.connection
      .prepare('SELECT textContent FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => row.textContent),
    [
      'Updated complete article /a with the published research findings.',
      'Updated complete article /b with the published research findings.',
      'Updated complete article /c with the published research findings.',
    ],
  );
});

test(
  'a watch checks again only when a known URL is due, so by default it does not crawl again soon after a crawl',
  { timeout: 10_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel><item><link>${url.origin}/article</link></item></channel></rss>`,
        );
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<article><p>An observation with enough readable content to keep the article.</p></article>',
        );
      }
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'articles',
              primaryKey: ['articleUrl'],
              readers: [new ListingReader()],
              extractor: new ArticleExtractor(),
            }),
            inputs: [`${upstream.origin}/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      const first = requests.splice(0);
      // AdaptiveRevisit makes the feed and the article due a day later.
      await setTimeout(300);

      assert.deepEqual(first, ['/feed.xml', '/article']);
      assert.deepEqual(requests, []);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  'pipeline watching refreshes edited articles and stops when cancelled',
  { timeout: 10_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    let body =
      'Original observation with enough readable content to keep the article.';
    await using upstream = await new HttpServer().start((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel><title>Observations</title><item><link>${url.origin}/article</link></item></channel></rss>`,
        );
      } else if (url.pathname === '/article') {
        response.setHeader('content-type', 'text/html');
        response.end(`<article><p>${body}</p></article>`);
      } else response.writeHead(404).end();
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'articles',
              primaryKey: ['articleUrl'],
              readers: [new ListingReader()],
              // What a poll interval was: one interval for every URL.
              revisit: new FixedRevisit({ every: 100 }),
              extractor: new ArticleExtractor(),
            }),
            inputs: [`${upstream.origin}/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      assert.equal(
        database.connection.prepare('SELECT textContent FROM articles').get()
          ?.textContent,
        'Original observation with enough readable content to keep the article.',
      );
      body =
        'Updated observation now includes a newly verified and published finding.';
      assert.equal((await watch.next()).done, false);
      assert.equal(
        database.connection.prepare('SELECT textContent FROM articles').get()
          ?.textContent,
        'Updated observation now includes a newly verified and published finding.',
      );
      controller.abort();
      assert.equal((await watch.next()).done, true);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  'a watched web stream with two inputs gets one pass for each due time, also when a check falls between the ends of its two crawls',
  { timeout: 10_000 },
  async (t) => {
    // The test sets the time of each visit, so the due times are known.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const start = Date.now();
    // A clock on which each wait takes a thousandth of its time, so a check
    // comes about each millisecond, also while a pass runs.
    const timers = new Map<object, NodeJS.Timeout>();
    const fast = {
      Date: globalThis.Date,
      performance: globalThis.performance,
      setTimeout: (callback: () => void, ms: number) => {
        const timer = {};
        timers.set(
          timer,
          globalThis.setTimeout(() => {
            timers.delete(timer);
            callback();
          }, ms / 1000),
        );
        return timer;
      },
      clearTimeout: (timer: unknown) => {
        if (!(timer instanceof Object)) return;
        globalThis.clearTimeout(timers.get(timer));
        timers.delete(timer);
      },
    };
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    // The first crawl of b starts 2 s after the crawl of a, so b is due 2 s
    // later.
    let visit = async (path: string) => {
      if (path === '/a/post') t.mock.timers.setTime(start + 2_000);
    };
    await using upstream = await new HttpServer().start(
      async (request, response) => {
        // The site asks for 10 ms between requests, where the default is a
        // second on the clock of the process.
        if (request.url === '/robots.txt') {
          response.end('User-agent: *\nCrawl-delay: 0.01\n');
          return;
        }
        const url = new URL(
          request.url ?? '/',
          `http://${request.headers.host}`,
        );
        requests.push(url.pathname);
        await visit(url.pathname);
        if (url.pathname.endsWith('/feed.xml'))
          response
            .writeHead(200, { 'content-type': 'application/rss+xml' })
            .end(
              `<rss><channel><item><link>${url.href.replace('feed.xml', 'post')}</link></item></channel></rss>`,
            );
        else
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(`<article><p>${observation}</p></article>`);
      },
    );
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const source = new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: feedStream('feeds', new FixedRevisit({ every: 10_000 })),
          inputs: [
            `${upstream.origin}/a/feed.xml`,
            `${upstream.origin}/b/feed.xml`,
          ],
        },
      ],
    });
    const destination = new SQLiteDestination({ path: database.path });
    const controller = new AbortController();
    const watch = new Pipeline({
      clock: fast,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'web',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
          steps: (await source.discover()).streams.map(
            (stream) =>
              new Copy(stream, destination.table(stream.name), {
                id: `web:${stream.name}`,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              }),
          ),
        }),
      ],
    }).watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      // a is due at 10 s and b at 12 s; a check at 13 s finds both due.
      t.mock.timers.setTime(start + 13_000);
      // The feed of b answers 100 ms later, so many checks come after the
      // crawl of a ended and before the crawl of b ends.
      visit = async (path) => {
        if (path === '/b/feed.xml') await setTimeout(100);
      };
      requests.splice(0);
      assert.equal((await watch.next()).done, false);
      assert.deepEqual(requests, [
        '/a/feed.xml',
        '/a/post',
        '/b/feed.xml',
        '/b/post',
      ]);
      requests.splice(0);
      visit = async () => {};

      // Both feeds are due at 23 s, so no pass comes at 13 s.
      const next = watch.next();
      const early = await Promise.race([
        next.then(() => 'a pass'),
        setTimeout(300, 'no pass'),
      ]);
      t.mock.timers.setTime(start + 24_000);
      await next;

      assert.equal(early, 'no pass');
      assert.deepEqual(requests, [
        '/a/feed.xml',
        '/a/post',
        '/b/feed.xml',
        '/b/post',
      ]);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  "a watched full refresh crawls again when its stream's revisit policy makes it due, not at each check",
  { timeout: 20_000 },
  async (t) => {
    // The test sets the time, so the due time is known.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const start = Date.now();
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml')
        response
          .writeHead(200, { 'content-type': 'application/rss+xml' })
          .end(
            `<rss><channel><item><link>${url.origin}/post</link></item></channel></rss>`,
          );
      else
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<article><p>${observation}</p></article>`);
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const source = new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'feeds',
            primaryKey: ['articleUrl'],
            readers: [new ListingReader()],
            // The feed is due 10 s after each visit, and the post never again.
            revisit: new CompositeRevisit(
              [[new URLPattern({ pathname: '/post' }), new OnceRevisit()]],
              new FixedRevisit({ every: 10_000 }),
            ),
            extractor: new ArticleExtractor(),
          }),
          inputs: [`${upstream.origin}/feed.xml`],
        },
      ],
    });
    const destination = new SQLiteDestination({ path: database.path });
    const controller = new AbortController();
    const watch = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'web',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
          // A full refresh: the routes, crawls and failures streams read only
          // incrementally.
          steps: [
            new Copy(
              (await source.discover()).get('feeds'),
              destination.table('feeds'),
            ),
          ],
        }),
      ],
    }).watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      requests.splice(0);

      // The checks come each second; the feed is due 10 s after the crawl.
      const next = watch.next();
      const early = await Promise.race([
        next.then(() => 'a pass'),
        setTimeout(2_500, 'no pass'),
      ]);
      t.mock.timers.setTime(start + 11_000);
      await next;

      assert.equal(early, 'no pass');
      // A full refresh must see every page, so it requests the post too.
      assert.deepEqual(requests, ['/feed.xml', '/post']);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  'a watched stream whose pages AlwaysRevisit makes due in every crawl has no due time of its own, so the watch does not crawl it again at each check',
  { timeout: 20_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    await using upstream = await twoBlogs(requests, () => observation);
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'news',
              primaryKey: ['articleUrl'],
              readers: [new ListingReader()],
              revisit: new AlwaysRevisit(),
              extractor: new ArticleExtractor(),
            }),
            inputs: [`${upstream.origin}/news/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      requests.splice(0);

      // The checks come each second.
      const next = watch.next();
      const again = await Promise.race([
        next.then(() => 'a pass'),
        setTimeout(2_500, 'no pass'),
      ]);
      controller.abort();
      await next;

      assert.equal(again, 'no pass');
      assert.deepEqual(requests, []);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

// A host's policy whose failed URLs wait the given time, where the crawler's
// default waits two hours.
class FailedWait extends FixedRevisit {
  protected override readonly retryAfter: number;
  constructor({
    every,
    retryAfter,
  }: {
    readonly every: number;
    readonly retryAfter: number;
  }) {
    super({ every });
    this.retryAfter = retryAfter;
  }
}

// One record for each page, its body as the heading; while the page says
// "broken", a number in place of the heading, which the schema rejects.
class BodyExtractor extends RecordExtractor {
  readonly properties = {
    id: { type: 'string', description: 'The path of the page.' },
    heading: { type: 'string', description: 'The body of the page.' },
  } as const;
  open() {
    return {
      negotiation: null,
      async read(response: Response) {
        const body = new TextDecoder().decode(response.rawBody);
        return {
          fingerprint: null,
          async records() {
            return [
              {
                id: new URL(response.url).pathname,
                heading: body === 'broken' ? 42 : body,
              },
            ];
          },
        };
      },
    };
  }
}

test(
  'a watched input whose read failed for a reason that is not a page, such as a record that the schema rejects, is read again when its starting URL is due as a failed one',
  { timeout: 20_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    let body = 'broken';
    await using upstream = await new HttpServer().start((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/feed.xml')
        response
          .writeHead(200, { 'content-type': 'application/rss+xml' })
          .end(
            `<rss><channel><item><link>${url.origin}/page</link></item></channel></rss>`,
          );
      else if (url.pathname === '/page')
        response.writeHead(200, { 'content-type': 'text/html' }).end(body);
      else response.writeHead(404).end();
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'pages',
              primaryKey: ['id'],
              readers: [new ListingReader()],
              revisit: new FailedWait({ every: day, retryAfter: 100 }),
              extractor: new BodyExtractor(),
            }),
            inputs: [`${upstream.origin}/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      const failed = await watch.next();
      assert.ok(
        !failed.done &&
          failed.value.outcomes.some(({ failures }) => failures.length > 0),
      );
      body = 'fixed';
      // The watch tries a failed copy again 10 s later on its own, so a pass
      // before then comes from the source.
      const next = await Promise.race([
        watch.next(),
        setTimeout(5_000, 'not read again'),
      ]);

      assert.notEqual(next, 'not read again');
      assert.deepEqual(
        database.connection
          .prepare('SELECT id, heading FROM pages')
          .all()
          .map((row) => ({ ...row })),
        [{ id: '/page', heading: 'fixed' }],
      );
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test(
  'a watched input whose read keeps failing is not read again before its starting URL is due as a failed one, so the watch does not retry it at once',
  { timeout: 20_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml')
        response
          .writeHead(200, { 'content-type': 'application/rss+xml' })
          .end(
            `<rss><channel><item><link>${url.origin}/page</link></item></channel></rss>`,
          );
      else if (url.pathname === '/page')
        response.writeHead(200, { 'content-type': 'text/html' }).end('broken');
      else response.writeHead(404).end();
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'pages',
              primaryKey: ['id'],
              readers: [new ListingReader()],
              revisit: new FailedWait({ every: day, retryAfter: 8_000 }),
              extractor: new BodyExtractor(),
            }),
            inputs: [`${upstream.origin}/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      const failed = await watch.next();
      assert.ok(
        !failed.done &&
          failed.value.outcomes.some(({ failures }) => failures.length > 0),
      );
      requests.splice(0);
      // A read again at once would request the feed within the origin's
      // one-second delay; the starting URL is due 8 s after the read began,
      // and the watch's own retry comes 10 s after the failure.
      const next = watch.next();
      await setTimeout(4_000);

      assert.deepEqual(requests, []);
      controller.abort();
      await next;
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

// A BodyExtractor whose first run does not open, as one whose model is not
// there yet.
class OpensOnSecondTry extends BodyExtractor {
  #tries = 0;
  override open() {
    this.#tries++;
    if (this.#tries === 1) throw new Error('The extractor did not open');
    return super.open();
  }
}

test(
  'a watched input whose read failed before its crawl began, such as an extractor that did not open, is read again when its starting URL is due as a failed one',
  { timeout: 20_000 },
  async (t) => {
    // The test sets the time, so the due time is known.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const start = Date.now();
    await using cache = await new TemporaryFiles().directory('web-cache-');
    await using upstream = await new HttpServer().start((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/feed.xml')
        response
          .writeHead(200, { 'content-type': 'application/rss+xml' })
          .end(
            `<rss><channel><item><link>${url.origin}/page</link></item></channel></rss>`,
          );
      else if (url.pathname === '/page')
        response.writeHead(200, { 'content-type': 'text/html' }).end('fixed');
      else response.writeHead(404).end();
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            stream: new WebStream({
              name: 'pages',
              primaryKey: ['id'],
              readers: [new ListingReader()],
              revisit: new FailedWait({ every: day, retryAfter: 5_000 }),
              extractor: new OpensOnSecondTry(),
            }),
            inputs: [`${upstream.origin}/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      const failed = await watch.next();
      assert.ok(
        !failed.done &&
          failed.value.outcomes.some(({ failures }) => failures.length > 0),
      );

      // The starting URL is due 5 s after the failure, and the watch's own
      // retry 10 s after it. The clock stays at 6 s, so a pass then comes
      // from the source.
      const next = watch.next();
      const early = await Promise.race([
        next.then(() => 'a pass'),
        setTimeout(2_500, 'no pass'),
      ]);
      t.mock.timers.setTime(start + 6_000);
      const due = await Promise.race([
        next.then(() => 'a pass'),
        setTimeout(6_000, 'no pass'),
      ]);

      assert.equal(early, 'no pass');
      assert.equal(due, 'a pass');
      assert.deepEqual(
        database.connection
          .prepare('SELECT id, heading FROM pages')
          .all()
          .map((row) => ({ ...row })),
        [{ id: '/page', heading: 'fixed' }],
      );
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test("an article's row keeps the language copies that the page declares, as localizedVersions, and those that its listing declares, as listedVersions, which a listing that declares other copies rewrites while the page stays the same", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The languages that the sitemap declares copies in.
  let languages = ['en', 'de'];
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const path = (language: string) =>
      language === 'en' ? '/startups' : `/${language}/startups`;
    if (url.pathname === '/sitemap.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>${url.origin}/de/startups</loc>${languages.map((language) => `<xhtml:link rel="alternate" hreflang="${language}" href="${url.origin}${path(language)}"/>`).join('')}</url></urlset>`,
        );
    else if (url.pathname === '/de/startups')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<html lang="de"><head><title>Startups</title><link rel="alternate" hreflang="en-us" href="/startups"><link rel="alternate" hreflang="de-de" href="/de/startups"></head><body><article><p>Gutschriften und Hilfe für Startups, die auf unserer Plattform bauen.</p></article></body></html>`,
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/sitemap.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  const row = database.connection
    .prepare('SELECT localizedVersions, listedVersions FROM articles')
    .get();
  assert.deepEqual(JSON.parse(String(row?.localizedVersions)), [
    { language: 'en-us', url: `${upstream.origin}/startups` },
    { language: 'de-de', url: `${upstream.origin}/de/startups` },
  ]);
  assert.deepEqual(JSON.parse(String(row?.listedVersions)), [
    { language: 'en', url: `${upstream.origin}/startups` },
    { language: 'de', url: `${upstream.origin}/de/startups` },
  ]);

  languages = ['en', 'de', 'fr'];
  await ingestion.run();

  const relisted = database.connection
    .prepare('SELECT listedVersions FROM articles')
    .get();
  assert.deepEqual(JSON.parse(String(relisted?.listedVersions)), [
    { language: 'en', url: `${upstream.origin}/startups` },
    { language: 'de', url: `${upstream.origin}/de/startups` },
    { language: 'fr', url: `${upstream.origin}/fr/startups` },
  ]);
});

test('a page whose last visit failed is a row of the failures stream until a visit of it succeeds, also through a read that a record ends, and a sitemap that failed is none', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let status = 403;
  let body = 'c';
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const xml = { 'content-type': 'application/xml' };
    if (url.pathname === '/sitemap.xml')
      response
        .writeHead(200, xml)
        .end(
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${url.origin}/pages.xml</loc></sitemap><sitemap><loc>${url.origin}/broken.xml</loc></sitemap></sitemapindex>`,
        );
    else if (url.pathname === '/pages.xml')
      response
        .writeHead(200, xml)
        .end(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/a</loc></url><url><loc>${url.origin}/b</loc></url><url><loc>${url.origin}/c</loc></url></urlset>`,
        );
    else if (url.pathname === '/a')
      response.writeHead(200, { 'content-type': 'text/html' }).end('a');
    else if (url.pathname === '/b')
      response.writeHead(status, { 'content-type': 'text/html' }).end('b');
    else if (url.pathname === '/c')
      response.writeHead(200, { 'content-type': 'text/html' }).end(body);
    else if (url.pathname === '/broken.xml') response.writeHead(403).end();
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${upstream.origin}/sitemap.xml`;
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'pages',
            primaryKey: ['id'],
            readers: [new ListingReader()],
            // Every page, and every failed one, is due in the next run.
            revisit: new FailedWait({ every: 0, retryAfter: 0 }),
            extractor: new BodyExtractor(),
          }),
          inputs: [input],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  const failures = () =>
    database.connection
      .prepare('SELECT inputUrl, url FROM pages_failures ORDER BY url')
      .all()
      .map((row) => ({ ...row }));

  await assert.rejects(ingestion.run(), PipelineError);
  const failed = failures();
  // A record that the schema rejects ends the next read while /b still fails.
  body = 'broken';
  await assert.rejects(ingestion.run(), PipelineError);
  const ended = failures();
  status = 200;
  body = 'c';
  await assert.rejects(ingestion.run(), PipelineError);

  const b = { inputUrl: input, url: `${upstream.origin}/b` };
  assert.deepEqual(failed, [b]);
  assert.deepEqual(ended, [b]);
  assert.deepEqual(failures(), []);
  assert.deepEqual(
    database.connection
      .prepare('SELECT id, heading FROM pages ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: '/a', heading: 'a' },
      { id: '/b', heading: 'b' },
      { id: '/c', heading: 'c' },
    ],
  );
});

test('explicit URL patterns restrict article downloads and preserve matching query variants', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/feed.json') {
      response.setHeader('content-type', 'application/feed+json');
      response.end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Research',
          items: [
            { id: 'outside', url: `${url.origin}/excluded` },
            { id: 'one', url: `${url.origin}/articles/report?edition=one` },
            { id: 'two', url: `${url.origin}/articles/report?edition=two` },
          ],
        }),
      );
    } else if (url.pathname === '/articles/report') {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article><p>Report edition ${url.searchParams.get('edition')} contains independently published observations.</p></article>`,
      );
    } else response.writeHead(503).end('Out of scope');
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: articles(`${upstream.origin}/articles/*`),
        inputs: [`${upstream.origin}/feed.json`],
      },
    ],
  };
  const ingestion = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 2);
  assert(
    !requests.includes('/excluded'),
    'selection must happen before HTTP fetching',
  );
  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT pageUrl, articleUrl, textContent FROM articles ORDER BY pageUrl',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        pageUrl: `${upstream.origin}/articles/report?edition=one`,
        articleUrl: `${upstream.origin}/articles/report?edition=one`,
        textContent:
          'Report edition one contains independently published observations.',
      },
      {
        pageUrl: `${upstream.origin}/articles/report?edition=two`,
        articleUrl: `${upstream.origin}/articles/report?edition=two`,
        textContent:
          'Report edition two contains independently published observations.',
      },
    ],
  );
  assert.equal((await ingestion.run())[0]?.count, 0);
});

test('a category page that matches the URL patterns is stored as a list, beside the articles it links', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // As anthropic.com/news: its category pages match the same pattern as its articles.
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/robots.txt') response.writeHead(404).end();
    else if (request.url === '/news')
      response.end(
        '<main><a href="/news/features">Features</a><a href="/news/claude-code">Claude Code</a></main>',
      );
    else if (request.url === '/news/features')
      response.end(`<html><head><title>Features</title><meta property="og:type" content="website"></head><body><main><article><h1>Features</h1><ul>
        <li><a href="/news/claude-code"><h3>Claude Code</h3><p>How the team builds the tool.</p></a></li>
        <li><a href="/news/memory"><h3>Memory</h3><p>Claude now remembers your projects.</p></a></li>
      </ul></article></main></body></html>`);
    else
      response.end(
        `<html><head><title>${request.url}</title></head><body><article><h1>${request.url}</h1><p>A report on what changed and why it matters.</p></article></body></html>`,
      );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: articles(`${upstream.origin}/news/*`),
          inputs: [`${upstream.origin}/news`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl, list FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => ({ ...row })),
    [
      ['/news/claude-code', 0],
      ['/news/features', 1],
      ['/news/memory', 0],
    ].map(([path, list]) => ({ pageUrl: `${upstream.origin}${path}`, list })),
  );
});

test("a web stream's expand patterns load the program page that the home page of a listed company links", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const article = (title: string) =>
    `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>A report on what changed and why it matters.</p></article></body></html>`;
  await using company = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/')
      response.end(
        '<nav><a href="/startups">Startups</a><a href="/pricing">Pricing</a></nav>',
      );
    else if (request.url === '/startups') response.end(article('Startups'));
    else if (request.url === '/pricing') response.end(article('Pricing'));
    else response.writeHead(404).end();
  });
  await using list = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/programs')
      response.end(`<main><a href="${company.origin}/">Company</a></main>`);
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'articles',
            primaryKey: ['articleUrl'],
            readers: [
              new PaginationReader({ strategy: 'all' }),
              new ListingReader(),
              new LinkReader({ maxDepth: 0, maxPages: 0 }),
            ],
            include: [new URLPattern(`${company.origin}/*`)],
            expand: [new URLPattern({ pathname: '*start*' })],
            extractor: new ArticleExtractor(),
          }),
          inputs: [`${list.origin}/programs`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => row.pageUrl),
    // The home page, a menu only, holds no article.
    [`${company.origin}/startups`],
  );
});

test('a Latin-1 article page is stored with its text and leaves nothing to retry', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/cafe</link></item></channel></rss>`,
      );
    } else if (url.pathname === '/cafe') {
      response.setHeader('content-type', 'text/html; charset=iso-8859-1');
      response.end(
        Buffer.from(
          '<article><h1>Café notes</h1><p>The café on the corner publishes a complete report every morning, with notes on each crème brûlée it serves.</p></article>',
          'latin1',
        ),
      );
    } else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  // A crawl or article failure would reject the run and keep the page for a retry.
  assert.equal((await ingestion.run())[0]?.count, 1);
  assert.match(
    String(
      database.connection.prepare('SELECT textContent FROM articles').get()
        ?.textContent,
    ),
    /crème brûlée/,
  );
});

test('by default an incremental crawl requests a known page again only when it is due, and the page keeps its row meanwhile', async (t) => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const later = shiftedClock(t);
  const requests: string[] = [];
  let revision = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/a</link></item></channel></rss>`,
      );
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article><p>Revision ${revision} of the research article holds the complete published observations.</p></article>`,
      );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
      },
    ],
  };
  const run = async () =>
    (
      await (
        await pipeline(new WebSource(options), database.path, checkpoints.path)
      ).run()
    )[0]?.count;
  const text = () =>
    database.connection
      .prepare('SELECT textContent FROM articles')
      .all()
      .map((row) => String(row.textContent));

  assert.equal(await run(), 1);
  revision = 2;
  later(hour);
  requests.length = 0;
  const early = await run();
  const earlyRequests = requests.splice(0);
  const earlyText = text();
  later(day - hour);
  const due = await run();

  assert.equal(early, 0);
  // The feed is not due either, so an hour later the run requests nothing.
  assert.deepEqual(earlyRequests, []);
  assert.match(earlyText.join(), /Revision 1/);
  assert.equal(due, 1);
  assert.deepEqual(requests, ['/feed.xml', '/a']);
  assert.equal(text().length, 1);
  assert.match(text().join(), /Revision 2/);
});

test('a page that was not due keeps its fingerprint, so once due and unchanged it is not loaded again', async (t) => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const later = shiftedClock(t);
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/a</link></item></channel></rss>`,
      );
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>The research article holds the complete published observations.</p></article>',
      );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
      },
    ],
  };
  const run = async () =>
    (
      await (
        await pipeline(new WebSource(options), database.path, checkpoints.path)
      ).run()
    )[0]?.count;

  const first = await run();
  later(hour);
  const deferred = await run();
  later(day - hour);
  requests.length = 0;
  const due = await run();

  assert.equal(first, 1);
  assert.equal(deferred, 0);
  assert.deepEqual(requests, ['/feed.xml', '/a']);
  assert.equal(due, 0);
});

test('a host that answers 429 stops the crawl there, keeps the loaded rows, and the run after the block loads the rest', async (t) => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const later = shiftedClock(t);
  const requests: string[] = [];
  let blocking = true;
  await using upstream = await new HttpServer().start((request, response) => {
    // The site has no robots.txt.
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    if (url.pathname === '/feed.xml') {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel>${['a', 'b', 'c', 'd'].map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
      );
    } else if (url.pathname === '/c' && blocking) {
      // Longer than Got's 30-second request timeout, so Got does not retry it.
      response.writeHead(429, { 'retry-after': '120' }).end();
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article><p>Research article ${url.pathname} contains the complete published observations.</p></article>`,
      );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [{ stream: articles(), inputs: [`${upstream.origin}/feed.xml`] }],
  };
  const rows = () =>
    database.connection
      .prepare('SELECT pageUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => String(row.pageUrl).slice(upstream.origin.length));

  const blocked = await pipeline(
    new WebSource(options),
    database.path,
    checkpoints.path,
  )
    .then((ingestion) => ingestion.run())
    .then(
      () => assert.fail('the blocked run must not succeed'),
      (error: unknown) => error,
    );
  const blockedRequests = requests.splice(0);
  const blockedRows = rows();
  later(120_000);
  blocking = false;
  const resumed = await (
    await pipeline(new WebSource(options), database.path, checkpoints.path)
  ).run();
  const resumedRequests = requests.splice(0);
  // The scan that the block interrupted kept /a and /b, so the next crawl finds them unchanged.
  const refresh = await (
    await pipeline(new WebSource(options), database.path, checkpoints.path)
  ).run();

  assert(blocked instanceof PipelineError);
  assert.equal(blocked.results[0]?.count, 2);
  assert.equal(blocked.results[0]?.failures.length, 1);
  assert.match(blocked.message, new RegExp(`${upstream.origin}.*429`));
  assert.deepEqual(blockedRequests, ['/feed.xml', '/a', '/b', '/c']);
  assert.deepEqual(blockedRows, ['/a', '/b']);
  assert.equal(resumed[0]?.count, 2);
  // The run after the block reads the due feed and loads the rest; /a and /b
  // are due too, and download again unchanged.
  assert.deepEqual(resumedRequests, ['/feed.xml', '/c', '/d', '/a', '/b']);
  assert.equal(refresh[0]?.count, 0);
  assert.deepEqual(rows(), ['/a', '/b', '/c', '/d']);
});

function articles(include?: string) {
  return new WebStream({
    name: 'articles',
    primaryKey: ['articleUrl'],
    readers: [
      new ListingReader(),
      new ArchiveReader(),
      new PaginationReader(),
      new LinkReader({ maxDepth: 3, maxPages: 100 }),
    ],
    // These tests are about one crawl's pages, so every crawl requests every page.
    revisit: new AlwaysRevisit(),
    include: include === undefined ? undefined : [new URLPattern(include)],
    extractor: new ArticleExtractor(),
  });
}

// Revisits wait hours or days, so a test moves Date.now forward; it keeps ticking, as the HTTP rate limit needs.
function shiftedClock(t: TestContext) {
  const now = Date.now.bind(Date);
  let shift = 0;
  t.mock.method(Date, 'now', () => now() + shift);
  return (ms: number) => {
    shift += ms;
  };
}

// Two blogs on one server, /news and /blog, each with a feed of one post.
// The site has no robots.txt, so requests holds the crawl's own downloads.
function twoBlogs(requests: string[], post: () => string) {
  return new HttpServer().start((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    requests.push(url.pathname);
    const feed = /^\/(news|blog)\/feed\.xml$/.exec(url.pathname)?.[1];
    if (feed !== undefined) {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(
        `<rss><channel><item><link>${url.origin}/${feed}/post</link></item></channel></rss>`,
      );
    } else if (/^\/(news|blog)\/post$/.test(url.pathname)) {
      response.setHeader('content-type', 'text/html');
      response.end(`<article><p>${post()}</p></article>`);
    } else response.writeHead(404).end();
  });
}

function feedStream(name: string, revisit?: FixedRevisit) {
  return new WebStream({
    name,
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    ...(revisit === undefined ? {} : { revisit }),
    extractor: new ArticleExtractor(),
  });
}

const observation =
  'An observation with enough readable content to keep the article.';

test('each web stream of a source loads its own target from its own inputs only', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: string[] = [];
  await using upstream = await twoBlogs(requests, () => observation);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: feedStream('news'),
          inputs: [`${upstream.origin}/news/feed.xml`],
        },
        {
          stream: feedStream('blog'),
          inputs: [`${upstream.origin}/blog/feed.xml`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  const rows = (table: string) =>
    database.connection
      .prepare(`SELECT inputUrl, pageUrl FROM ${table}`)
      .all()
      .map((row) => ({ ...row }));
  assert.deepEqual(rows('news'), [
    {
      inputUrl: `${upstream.origin}/news/feed.xml`,
      pageUrl: `${upstream.origin}/news/post`,
    },
  ]);
  assert.deepEqual(rows('blog'), [
    {
      inputUrl: `${upstream.origin}/blog/feed.xml`,
      pageUrl: `${upstream.origin}/blog/post`,
    },
  ]);
});

test("the sync history names each web stream's own inputs as its coverage", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await twoBlogs([], () => observation);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: feedStream('news'),
          inputs: [`${upstream.origin}/news/feed.xml`],
        },
        {
          stream: feedStream('blog'),
          inputs: [`${upstream.origin}/blog/feed.xml`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT stream, selection FROM extraction_coverage ORDER BY stream',
      )
      .all()
      .map(({ stream, selection }) => ({
        stream,
        inputs: JSON.parse(String(selection)).inputs,
      })),
    [
      { stream: 'blog', inputs: [`${upstream.origin}/blog/feed.xml`] },
      { stream: 'blog_crawls', inputs: [`${upstream.origin}/blog/feed.xml`] },
      {
        stream: 'blog_failures',
        inputs: [`${upstream.origin}/blog/feed.xml`],
      },
      { stream: 'blog_routes', inputs: [`${upstream.origin}/blog/feed.xml`] },
      { stream: 'news', inputs: [`${upstream.origin}/news/feed.xml`] },
      { stream: 'news_crawls', inputs: [`${upstream.origin}/news/feed.xml`] },
      {
        stream: 'news_failures',
        inputs: [`${upstream.origin}/news/feed.xml`],
      },
      { stream: 'news_routes', inputs: [`${upstream.origin}/news/feed.xml`] },
    ],
  );
});

test(
  'a watch over two web streams reads again the stream whose page is due, and only it',
  { timeout: 10_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    let post = observation;
    await using upstream = await twoBlogs(requests, () => post);
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [
          {
            // Due again 100 ms after each visit.
            stream: feedStream('news', new FixedRevisit({ every: 100 })),
            inputs: [`${upstream.origin}/news/feed.xml`],
          },
          {
            // AdaptiveRevisit: due a day after the first visit.
            stream: feedStream('blog'),
            inputs: [`${upstream.origin}/blog/feed.xml`],
          },
        ],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      requests.splice(0);
      post =
        'An updated observation that now includes a newly verified finding.';

      const again = await watch.next();

      assert.ok(!again.done);
      assert.deepEqual(
        again.value.outcomes
          .map(({ copy }) => copy.from.name)
          .filter((name) => name.startsWith('blog')),
        [],
      );
      assert.equal(
        database.connection.prepare('SELECT textContent FROM news').get()
          ?.textContent,
        post,
      );
      assert.equal(
        database.connection.prepare('SELECT textContent FROM blog').get()
          ?.textContent,
        observation,
      );
      assert.deepEqual(
        requests.filter((path) => path.startsWith('/blog/')),
        [],
      );
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test('an input is a URL in the form that the URL standard gives it, so one website is one input however the host spells it, in a list as in webInput', async () => {
  const spellings = [
    'https://News.test',
    'https://news.test/',
    'HTTPS://news.test:443/',
  ];
  const source = new WebSource({
    cachePath: join(tmpdir(), 'web-cache-unused', 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [{ stream: feedStream('news'), inputs: spellings }],
  });
  const news = (await source.discover()).get('news');

  assert.deepEqual(
    new Set(spellings.map(webInput)),
    new Set(['https://news.test/']),
  );
  assert.deepEqual(source.coverage(news).selection.inputs, [
    'https://news.test/',
  ]);
});

test('an input that is not an http or https URL is refused as the user’s to fix, in a list when the source is made, and by webInput', () => {
  const options = {
    cachePath: join(tmpdir(), 'web-cache-unused', 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
  };
  const source = new WebSource({
    ...options,
    streams: [
      { stream: feedStream('news'), inputs: ['https://news.test/feed.xml'] },
    ],
  });

  for (const make of [
    () =>
      new WebSource({
        ...options,
        streams: [
          {
            stream: feedStream('listings'),
            inputs: ['ftp://listings.test/feed.xml'],
          },
        ],
      }),
    () => webInput('ftp://listings.test/feed.xml'),
  ])
    assert.throws(make, (error) => {
      assert.equal(source.failureType(error), 'config');
      assert.match(String(error), /ftp:\/\/listings\.test\/feed\.xml/);
      return true;
    });
});

test(
  'a web stream whose host gives no inputs yet reads nothing, and a watch crawls the input that its host adds while it watches, with no new source',
  { timeout: 15_000 },
  async () => {
    await using cache = await new TemporaryFiles().directory('web-cache-');
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      requests.push(url.pathname);
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel><item><link>${url.origin}/article</link></item></channel></rss>`,
        );
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(`<article><p>${observation}</p></article>`);
      }
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    // The host's own list, which it changes while the source watches.
    const inputs = new Set<WebInput>();
    const ingestion = await pipeline(
      new WebSource({
        cachePath: join(cache.path, 'web-http.sqlite'),
        userAgent: 'elt-test/1.0',
        streams: [{ stream: feedStream('articles'), inputs: () => inputs }],
      }),
      database.path,
      checkpoints.path,
    );
    const controller = new AbortController();
    const watch = ingestion.watch({ signal: controller.signal });
    try {
      assert.equal((await watch.next()).done, false);
      const empty = requests.splice(0);
      inputs.add(webInput(`${upstream.origin}/feed.xml`));
      assert.equal((await watch.next()).done, false);
      const rows = database.connection
        .prepare('SELECT inputUrl, articleUrl FROM articles')
        .all()
        .map((row) => ({ ...row }));

      assert.deepEqual(empty, []);
      assert.deepEqual(requests, ['/feed.xml', '/article']);
      assert.deepEqual(rows, [
        {
          inputUrl: `${upstream.origin}/feed.xml`,
          articleUrl: `${upstream.origin}/article`,
        },
      ]);
    } finally {
      controller.abort();
      await watch.return(undefined);
    }
  },
);

test("a host's client is shared: an article read through it and a crawl of its origin ask the origin's robots.txt once, and the crawl leaves the client open", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The user agent of each robots.txt request.
  const robots: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/robots.txt') {
      robots.push(request.headers['user-agent'] ?? '');
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end('User-agent: *\nAllow: /');
    } else if (request.url === '/programs/credits')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<title>Startup credits</title><article><h1>Startup credits</h1><p>Startups get up to $25,000 in credits for their first year.</p></article>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  await using client = await WebClient.open(
    join(cache.path, 'web-http.sqlite'),
    'elt-test/1.0',
    undefined,
    globalThis,
  );
  const page = `${upstream.origin}/programs/credits`;
  const reader = new WebArticle([new HTMLExtraction()], client.http);

  const before = await reader.fetch(page, AbortSignal.timeout(10_000));
  await (
    await pipeline(
      new WebSource({ client, streams: [{ stream: pages(), inputs: [page] }] }),
      database.path,
      checkpoints.path,
    )
  ).run();
  const after = await reader.fetch(page, AbortSignal.timeout(10_000));

  assert.deepEqual(robots, ['elt-test/1.0']);
  assert.deepEqual(
    [before?.title, after?.title],
    ['Startup credits', 'Startup credits'],
  );
  assert.deepEqual(
    database.connection
      .prepare('SELECT articleUrl, title FROM pages')
      .all()
      .map((row) => ({ ...row })),
    [{ articleUrl: page, title: 'Startup credits' }],
  );
});

// Each starting URL is one page; the crawl follows none of its links.
function pages() {
  return new WebStream({
    name: 'pages',
    primaryKey: ['articleUrl'],
    readers: [new StartReader()],
    revisit: new AlwaysRevisit(),
    extractor: new ArticleExtractor(),
  });
}
