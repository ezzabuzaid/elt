import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ArticleError } from '@workspace/sdk-web-article';
import {
  AlwaysRevisit,
  ArchiveReader,
  CrawlError,
  FixedRevisit,
  LinkReader,
  ListingReader,
  PaginationReader,
  day,
  hour,
} from '@workspace/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

test('native articles persist clean text and refresh independently changing HTML metadata', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.xml`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles(),
    inputs: [upstream.origin],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.xml`],
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

test('an article that a feed and a sitemap list with and without a trailing slash is stored once, and an unchanged rerun writes nothing', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [upstream.origin],
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
              id: 'web:articles',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('temporary listing and article failures recover within one pipeline run', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.xml`],
    }),
    database.path,
    checkpoints.path,
  );

  assert.equal((await ingestion.run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT textContent FROM articles').get()
      ?.textContent,
    'The recovered article contains the complete published observations.',
  );
  assert.deepEqual(requests, [
    '/feed.xml',
    '/feed.xml',
    '/article',
    '/article',
  ]);
});

test('a site that refuses the first connection, as during a short network drop, is stored within one run', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: articles(),
        inputs: [`${upstream.origin}/feed.xml`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: articles(),
        inputs: [`${upstream.origin}/feed.xml`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles(),
    inputs: [`${upstream.origin}/feed.xml`],
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
  { timeout: 15_000 },
  async () => {
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.json`],
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
      assert.deepEqual(failure?.partition, { inputUrl: options.inputs[0] });
      assert(failure?.error instanceof AggregateError);
      // The download of /a fails in the crawler; /b downloads but holds no article.
      const [download, extraction, ...rest] = failure.error.errors;
      assert.deepEqual(rest, []);
      assert(download instanceof CrawlError);
      assert(download.cause instanceof Error);
      assert.equal(download.url, `${upstream.origin}/a`);
      assert(extraction instanceof ArticleError);
      assert(extraction.cause instanceof Error);
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
    const observed = new Pipeline({
      connections: retry.connections,
      history: retry.history,
      observer: {
        begin: () => ({
          progress: (progress) => {
            if (progress.committed.count === 1) controller.abort(reason);
          },
          finish: () => {},
          fail: () => {},
        }),
      },
    });
    try {
      await assert.rejects(
        observed.run({ signal: controller.signal }),
        (error) => error === reason,
      );
    } finally {
      controller.abort(reason);
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
    // The interrupted crawl resumes without reading the feed again: /a, handed out last, downloads once more
    // unchanged, then the known pages that the feed no longer names, unchanged too.
    assert.equal((await resumed.run())[0]?.count, 1);
    assert.deepEqual(requests, ['/a', '/b', '/c', '/d']);
    requests.length = 0;
    // The crawl finished, so the next run reads the feed again: only /e is new.
    assert.equal((await resumed.run())[0]?.count, 1);
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
      options.inputs[0],
    );
  },
);

test(
  'listing, redirect and retry requests share the request-start rate limit',
  { timeout: 10_000 },
  async () => {
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
    const requests: { path: string; at: number }[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      // The site has no robots.txt.
      if (request.url === '/robots.txt') {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const retried = requests.some((item) => item.path === url.pathname);
      requests.push({ path: url.pathname, at: performance.now() });
      if (url.pathname === '/feed.xml') {
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          `<rss><channel>${['a', 'b', 'c'].map((name) => `<item><link>${url.origin}/${name}</link></item>`).join('')}</channel></rss>`,
        );
      } else if (url.pathname === '/a') {
        response.writeHead(302, { location: '/article' }).end();
      } else if (url.pathname === '/b' && !retried) {
        response.writeHead(429, { 'retry-after': '1' }).end();
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
        stream: articles(),
        inputs: [`${upstream.origin}/feed.xml`],
      }),
      database.path,
      checkpoints.path,
    );
    assert.equal((await ingestion.run())[0]?.count, 3);
    assert.equal(requests.length, 6);
    for (let index = 2; index < requests.length; index++) {
      const first = requests[index - 2];
      const third = requests[index];
      assert(first && third);
      // Measure arrivals at the HTTP boundary; allow small event-loop/transport jitter.
      assert(
        third.at - first.at >= 950,
        'at most two requests may start within one second, including redirects and retries',
      );
    }
    const attempts = requests.filter((item) => item.path === '/b');
    assert.equal(attempts.length, 2);
    assert(attempts[0] && attempts[1]);
    assert(
      attempts[1].at - attempts[0].at >= 950,
      'Retry-After must delay the next attempt',
    );
  },
);

test(
  'cancellation stops a streaming download and queued requests after an article failure',
  { timeout: 10_000 },
  async () => {
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: articles(),
        inputs: [`${upstream.origin}/feed.xml`],
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
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: articles(),
        inputs: [`${upstream.origin}/feed.xml`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles(),
    inputs: [`${upstream.origin}/feed.json`],
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
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.xml`],
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
      // The crawl resumes without the feed; /a, handed out last, downloads once more and writes nothing.
      assert.equal((await resumed.run())[0]?.count, 1);
      assert.equal(
        database.connection
          .prepare('SELECT count(*) AS count FROM articles')
          .get()?.count,
        2,
      );
      assert.deepEqual(requests, ['/a', '/b']);
    } finally {
      controller.abort(reason);
      await stopped;
    }
  },
);

test('chosen websites and feeds persist article metadata, make unchanged reruns empty, and replace changed articles', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}${input}`],
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
    const observed = new Pipeline({
      connections: rerun.connections,
      history: rerun.history,
      observer: {
        begin: () => ({
          progress: (progress) => {
            emitted.push(progress.emitted.count);
          },
          finish: () => {},
          fail: () => {},
        }),
      },
    });
    assert.equal(
      (await observed.run())[0]?.count,
      0,
      'unchanged records must not be re-emitted',
    );
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/two.json`, `${upstream.origin}/one.json`],
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
      stream: articles(),
      inputs: [
        `${upstream.origin}/one.json`,
        `${upstream.origin}/two.json`,
        `${upstream.origin}/three.json`,
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles(),
    inputs: [`${upstream.origin}/sitemap.xml`],
  });
  const destination = new SQLiteDestination({ path: database.path });
  const history = new SQLiteSyncHistory();
  const refresh = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        steps: (await source.discover()).streams.map(
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
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
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
    await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          // What a poll interval was: one interval for every URL.
          revisit: new FixedRevisit({ every: 100 }),
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
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

test('explicit URL patterns restrict article downloads and preserve matching query variants', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles([`${upstream.origin}/articles/*`]),
    inputs: [`${upstream.origin}/feed.json`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles([`${upstream.origin}/news/*`]),
      inputs: [`${upstream.origin}/news`],
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

test('a Latin-1 article page is stored with its text and leaves nothing to retry', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
      stream: articles(),
      inputs: [`${upstream.origin}/feed.xml`],
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
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: new WebStream({
      name: 'articles',
      primaryKey: ['articleUrl'],
      readers: [new ListingReader()],
      extractor: new ArticleExtractor(),
    }),
    inputs: [`${upstream.origin}/feed.xml`],
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
  assert.deepEqual(earlyRequests, ['/feed.xml']);
  assert.match(earlyText.join(), /Revision 1/);
  assert.equal(due, 1);
  assert.deepEqual(requests, ['/feed.xml', '/a']);
  assert.equal(text().length, 1);
  assert.match(text().join(), /Revision 2/);
});

test('a page that was not due keeps its fingerprint, so once due and unchanged it is not loaded again', async (t) => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: new WebStream({
      name: 'articles',
      primaryKey: ['articleUrl'],
      readers: [new ListingReader()],
      extractor: new ArticleExtractor(),
    }),
    inputs: [`${upstream.origin}/feed.xml`],
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

test('a host that answers 429 stops the crawl there, keeps the loaded rows, and the run after the block loads only the rest', async (t) => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    stream: articles(),
    inputs: [`${upstream.origin}/feed.xml`],
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
  assert.deepEqual(resumedRequests, ['/c', '/d']);
  assert.equal(refresh[0]?.count, 0);
  assert.deepEqual(rows(), ['/a', '/b', '/c', '/d']);
});

function articles(include?: readonly string[]) {
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
    include: include?.map((pattern) => new URLPattern(pattern)),
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
