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
import { AlwaysRevisit, ListingReader } from '@workspace/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

const userAgent =
  'WhatIsGoingOn/0.1 (+https://github.com/ezzabuzaid/what-is-going-on)';

test('every request carries the user agent that the host gives', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const agents = new Map<string, string | undefined>();
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    agents.set(request.url, request.headers['user-agent']);
    site(request.url, response, 'User-agent: *\nAllow: /\n');
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  const result = await crawl(
    upstream.origin,
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.equal(result, 1);
  assert.deepEqual(Object.fromEntries(agents), {
    '/robots.txt': userAgent,
    '/feed.xml': userAgent,
    '/report': userAgent,
  });
});

test('a robots.txt group for the product token disallows the crawl, although the * group allows it', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    site(
      request.url,
      response,
      'User-agent: WhatIsGoingOn\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  const result = await crawl(
    upstream.origin,
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.equal(result, 0);
  assert.deepEqual(requests, ['/robots.txt']);
});

test('a robots.txt group for another crawler only does not stop the crawl', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    site(request.url, response, 'User-agent: ClaudeBot\nDisallow: /\n');
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  const result = await crawl(
    upstream.origin,
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.equal(result, 1);
  assert.deepEqual(requests, ['/robots.txt', '/feed.xml', '/report']);
});

test('Content-Signal search=no in the * group leaves the whole origin out', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    site(
      request.url,
      response,
      'User-agent: *\nContent-Signal: search=no\nAllow: /\n',
    );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  const result = await crawl(
    upstream.origin,
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.equal(result, 0);
  assert.deepEqual(requests, ['/robots.txt']);
});

test('Content-Signal that allows search and refuses AI training does not stop the crawl', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    site(
      request.url,
      response,
      'User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n',
    );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  const result = await crawl(
    upstream.origin,
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.equal(result, 1);
  assert.deepEqual(requests, ['/robots.txt', '/feed.xml', '/report']);
});

// A site whose feed lists one article, and whose robots.txt is the given text.
function site(
  url: string,
  response: Parameters<Parameters<HttpServer['start']>[0]>[1],
  robots: string,
) {
  if (url === '/robots.txt')
    response.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
  else if (url === '/feed.xml')
    response
      .writeHead(200, { 'content-type': 'application/rss+xml' })
      .end('<rss><channel><item><link>/report</link></item></channel></rss>');
  else if (url === '/report')
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        '<article><p>The field report explains the published observations in full.</p></article>',
      );
  else response.writeHead(404).end();
}

// One incremental run over the site's feed; the count of records it wrote.
async function crawl(
  origin: string,
  cache: string,
  database: string,
  checkpoints: string,
) {
  const source = new WebSource({
    cachePath: join(cache, 'web-http.sqlite'),
    userAgent,
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          revisit: new AlwaysRevisit(),
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${origin}/feed.xml`],
      },
    ],
  });
  const destination = new SQLiteDestination({ path: database });
  const [result] = await new Pipeline({
    history: new SQLiteSyncHistory(),
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
  }).run();
  return result?.count;
}
