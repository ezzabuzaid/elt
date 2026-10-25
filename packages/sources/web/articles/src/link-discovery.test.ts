import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';

import { WebSource } from './web-source.ts';

test('ordinary links reach unlisted articles while feed pages and unchanged reruns survive', async () => {
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
    inputs: [upstream.origin],
    include: [`${upstream.origin}/articles/*`],
    pollIntervalMs: 60_000,
    cachePath: `${database.path}.http-cache`,
  });
  const destination = new SQLiteDestination({ path: database.path });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
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

test('new URLs before the cursor survive interruption without downloading the parent again', async () => {
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
    inputs: [upstream.origin],
    include: [`${upstream.origin}/articles/*`],
    pollIntervalMs: 60000,
    cachePath: `${database.path}.http-cache`,
  });
  const destination = new SQLiteDestination({ path: database.path }),
    history = new SQLiteSyncHistory();
  await history.install([destination]);
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
  assert.ok(!requests.includes('/articles/z'));
  assert.equal(requests.filter((url) => url === '/articles/a').length, 1);
  assert.equal(
    database.connection.prepare('SELECT count(*) AS count FROM articles').get()
      ?.count,
    2,
  );
});

test('Markdown companion responses discover articles and cap secondary feed pagination', async () => {
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
          '<rss><channel><item><link>/articles/native</link></item></channel></rss>',
        );
    else if (request.url === '/articles/native') {
      if (request.headers.accept?.startsWith('text/markdown'))
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end(
            '# Published observations\n\nThe complete original research is available in this native Markdown article.',
          );
      else
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            '<article><p>The published observations have an HTML companion.</p></article><link rel="alternate" type="application/feed+json" href="/extra/1">',
          );
    } else if (request.url === '/extra/1')
      response.writeHead(200, { 'content-type': 'application/feed+json' }).end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Extra',
          items: [{ id: 'extra', url: '/articles/extra' }],
          next_url: '/extra/2',
        }),
      );
    else if (request.url === '/articles/extra')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<article><p>The secondary feed supplies another complete published research article.</p></article>',
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    inputs: [upstream.origin],
    include: [`${upstream.origin}/articles/*`],
    pollIntervalMs: 60000,
    cachePath: `${database.path}.http-cache`,
  });
  const destination = new SQLiteDestination({ path: database.path }),
    history = new SQLiteSyncHistory();
  await history.install([destination]);
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
  assert.equal((await ingestion.run())[0]?.count, 2);
  assert.equal(requests.filter((url) => url === '/articles/native').length, 2);
  assert.equal(requests.filter((url) => url === '/articles/extra').length, 1);
  assert.ok(!requests.includes('/extra/2'));
});
