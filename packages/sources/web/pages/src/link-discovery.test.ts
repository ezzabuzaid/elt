import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  AlwaysRevisit,
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
} from '@workspace/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

test('ordinary links reach unlisted articles while feed pages and unchanged reruns survive', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  let revalidated = 0;
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><nav><a href="/topics">Topics</a></nav>',
        );
    else if (request.url === '/topics')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<nav><a href="/articles/listed">A listed article</a></nav>');
    else if (request.url === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/articles/listed</link></item></channel></rss>',
        );
    else if (request.url?.startsWith('/articles/')) {
      if (request.headers['if-none-match'] === '"article-v1"') {
        revalidated++;
        response.writeHead(304, { etag: '"article-v1"' }).end();
      } else
        response
          .writeHead(200, {
            'content-type': 'text/html',
            etag: '"article-v1"',
            'cache-control': 'public, max-age=0',
          })
          .end(
            `<article><p>The published observations for ${request.url} explain the results in full.</p><a href="/articles/hidden">Related</a></article>`,
          );
    } else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    stream: articles([`${upstream.origin}/articles/*`]),
    inputs: [upstream.origin],
  });
  const destination = new SQLiteDestination({ path: database.path });
  const history = new SQLiteSyncHistory();
  const ingestion = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
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
  assert.equal((await ingestion.run())[0]?.count, 2);
  assert.equal(requests.filter((url) => url === '/articles/listed').length, 1);
  assert.equal(requests.filter((url) => url === '/articles/hidden').length, 1);
  assert.equal(requests.filter((url) => url === '/topics').length, 1);
  assert.deepEqual(
    database.connection
      .prepare('SELECT pageUrl, listingUrl FROM articles ORDER BY pageUrl')
      .all()
      .map((row) => ({ pageUrl: row.pageUrl, listingUrl: row.listingUrl })),
    [
      {
        pageUrl: `${upstream.origin}/articles/hidden`,
        listingUrl: `${upstream.origin}/articles/listed`,
      },
      {
        pageUrl: `${upstream.origin}/articles/listed`,
        listingUrl: `${upstream.origin}/feed.xml`,
      },
    ],
  );
  assert.equal((await ingestion.run())[0]?.count, 0);
  assert.equal(revalidated, 2);
});

test('new URLs survive interruption, and only the page in flight downloads again', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<link rel="alternate" type="application/rss+xml" href="/feed">');
    else if (request.url === '/feed')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/articles/z</link></item></channel></rss>',
        );
    else if (request.url === '/articles/z')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<article><p>The parent contains complete published research observations.</p><a href="/articles/a">Earlier URL</a></article>',
        );
    else if (request.url === '/articles/a')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<article><p>The newly discovered article contains independent published research observations.</p><a href="/articles/z">Parent</a></article>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    stream: articles([`${upstream.origin}/articles/*`]),
    inputs: [upstream.origin],
  });
  const destination = new SQLiteDestination({ path: database.path }),
    history = new SQLiteSyncHistory();
  const connection = new Connection({
    name: 'web',
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
    steps: (await source.discover()).streams.map(
      (stream) =>
        new Copy(stream, destination.table(stream.name), {
          id: 'reuse',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    ),
  });
  const stop = new AbortController(),
    reason = new Error('stop after parent');
  const first = new Pipeline({
    connections: [connection],
    history,
    observer: {
      begin: () => ({
        progress: (progress) => {
          if (progress.committed.count === 1) stop.abort(reason);
        },
        finish: () => {},
        fail: () => {},
      }),
    },
  });
  await assert.rejects(
    first.run({ signal: stop.signal }),
    (error) => error === reason,
  );
  requests.length = 0;
  const resumed = new Pipeline({ connections: [connection], history });
  assert.equal((await resumed.run())[0]?.count, 1);
  // The parent was in flight when the run stopped: it downloads once more, and the diff writes nothing for it.
  assert.equal(requests.filter((url) => url === '/articles/z').length, 1);
  assert.ok(!requests.includes('/') && !requests.includes('/feed'));
  assert.equal(requests.filter((url) => url === '/articles/a').length, 1);
  assert.equal(
    database.connection.prepare('SELECT count(*) AS count FROM articles').get()
      ?.count,
    2,
  );
});

test('Markdown pages supply links, and feeds declared on crawled pages are read completely', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    const article = (text: string, head = '') =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`${head}<article><p>${text}</p></article>`);
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<link rel="alternate" type="application/rss+xml" href="/feed">');
    else if (request.url === '/feed')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/articles/native</link></item></channel></rss>',
        );
    else if (request.url === '/articles/native') {
      if (request.headers.accept?.startsWith('text/markdown'))
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end(
            '# Published observations\n\nThe complete original research is available in this native Markdown article. See [related research](/articles/extra).',
          );
      else article('The published observations have an HTML companion.');
    } else if (request.url === '/articles/extra')
      article(
        'The linked page supplies another complete published research article.',
        '<link rel="alternate" type="application/feed+json" href="/extra/1">',
      );
    else if (request.url === '/extra/1' || request.url === '/extra/2')
      response.writeHead(200, { 'content-type': 'application/feed+json' }).end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Extra',
          ...(request.url === '/extra/1'
            ? {
                items: [{ id: 'second', url: '/articles/second' }],
                next_url: '/extra/2',
              }
            : { items: [{ id: 'third', url: '/articles/third' }] }),
        }),
      );
    else if (
      request.url === '/articles/second' ||
      request.url === '/articles/third'
    )
      article(
        `The secondary feed page ${request.url} supplies complete published research.`,
      );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    stream: articles([`${upstream.origin}/articles/*`]),
    inputs: [upstream.origin],
  });
  const destination = new SQLiteDestination({ path: database.path }),
    history = new SQLiteSyncHistory();
  const ingestion = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: 'markdown-links',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
  assert.equal((await ingestion.run())[0]?.count, 4);
  // The crawl's Markdown download, then the article reader's HTML companion for metadata.
  assert.equal(requests.filter((url) => url === '/articles/native').length, 2);
  assert.equal(requests.filter((url) => url === '/articles/extra').length, 1);
  assert.equal(requests.filter((url) => url === '/extra/2').length, 1);
});

test('an interruption during a long stretch of archive pages keeps the progress saved up to a second before it', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: { url: string; at: number }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push({ url: request.url, at: performance.now() });
    const archive = /^\/archive\/(\d+)$/.exec(request.url);
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/archive/1">Archives</a>');
    else if (archive) {
      const number = Number(archive[1]);
      // Each archive page is slow, so the chain is a long stretch without pages.
      setTimeout(() => {
        if (response.destroyed) return;
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            number < 12
              ? `<a rel="next" href="/archive/${number + 1}">Next</a>`
              : '<main><a href="/articles/first">The first article</a></main>',
          );
      }, 250);
    } else if (request.url === '/articles/first')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<article><p>The first article contains complete published research observations.</p></article>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    stream: articles([`${upstream.origin}/articles/*`]),
    inputs: [upstream.origin],
  });
  const destination = new SQLiteDestination({ path: database.path }),
    history = new SQLiteSyncHistory();
  const connection = new Connection({
    name: 'web',
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
    steps: (await source.discover()).streams.map(
      (stream) =>
        new Copy(stream, destination.table(stream.name), {
          id: 'archive-progress',
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    ),
  });
  const stop = new AbortController(),
    reason = new Error('stop during the archive chain');
  let stoppedAt = 0;
  const timer = setTimeout(() => {
    stoppedAt = performance.now();
    stop.abort(reason);
  }, 4000);
  try {
    await assert.rejects(
      new Pipeline({ connections: [connection], history }).run({
        signal: stop.signal,
      }),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
  const read = requests.filter(({ url }) => url.startsWith('/archive/'));
  // The source starts at most two requests a second, so about five archive pages are read.
  assert.ok(read.length >= 4, `${read.length} archive pages before the stop`);
  assert.ok(!read.some(({ url }) => url === '/archive/12'));
  const firstRun = new Map(read.map(({ url, at }) => [url, at]));
  requests.length = 0;
  assert.equal(
    (await new Pipeline({ connections: [connection], history }).run())[0]
      ?.count,
    1,
  );
  const again = requests.flatMap(({ url }) => {
    const at = firstRun.get(url);
    return at === undefined ? [] : [{ url, before: stoppedAt - at }];
  });
  assert.ok(!requests.some(({ url }) => url === '/'));
  // Progress is saved at most once a second; the archive page in flight at the last save, up to one
  // request slot and one slow download earlier, is read once more.
  assert.ok(
    again.every(({ before }) => before <= 2000),
    JSON.stringify(again),
  );
  assert.deepEqual(
    requests.filter(({ url }) => url === '/archive/12').length,
    1,
  );
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
