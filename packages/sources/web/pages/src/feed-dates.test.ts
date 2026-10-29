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

test('an RSS item gives its page the pubDate as the publication time, and a pubDate that is not a date gives none', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.xml')
      response.writeHead(200, { 'content-type': 'application/rss+xml' }).end(
        `<rss><channel>
            <item><link>/articles/dated</link><pubDate>Tue, 27 Oct 2026 09:30:00 +0300</pubDate></item>
            <item><link>/articles/undated</link><pubDate>yesterday afternoon</pubDate></item>
          </channel></rss>`,
      );
    else if (request.url?.startsWith('/articles/'))
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><p>The post at ${request.url} carries no date of its own, only complete published research observations.</p></article>`,
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  await run(
    [`${upstream.origin}/feed.xml`],
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT pageUrl, publishedTime, published, lastModified FROM articles ORDER BY pageUrl',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        pageUrl: `${upstream.origin}/articles/dated`,
        publishedTime: null,
        published: '2026-10-27T06:30:00.000Z',
        lastModified: null,
      },
      {
        pageUrl: `${upstream.origin}/articles/undated`,
        publishedTime: null,
        published: null,
        lastModified: null,
      },
    ],
  );
});

test('an Atom entry gives published as the publication time and updated only as the modification hint, while a sitemap keeps its lastmod', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/atom.xml')
      response.writeHead(200, { 'content-type': 'application/atom+xml' }).end(
        `<feed xmlns="http://www.w3.org/2005/Atom">
            <entry><link href="/articles/published"/><published>2026-10-26T21:03:24-02:00</published><updated>2026-10-28T08:00:00Z</updated></entry>
            <entry><link href="/articles/updated"/><updated>2026-10-28T08:00:00Z</updated></entry>
          </feed>`,
      );
    else if (request.url === '/sitemap.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          '<urlset><url><loc>/articles/mapped</loc><lastmod>2026-10-20</lastmod></url></urlset>',
        );
    else if (request.url?.startsWith('/articles/'))
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><p>The post at ${request.url} carries no date of its own, only complete published research observations.</p></article>`,
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  await run(
    [`${upstream.origin}/atom.xml`, `${upstream.origin}/sitemap.xml`],
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT pageUrl, publishedTime, published, lastModified FROM articles ORDER BY pageUrl',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        pageUrl: `${upstream.origin}/articles/mapped`,
        publishedTime: null,
        published: null,
        lastModified: '2026-10-20',
      },
      {
        pageUrl: `${upstream.origin}/articles/published`,
        publishedTime: null,
        published: '2026-10-26T23:03:24.000Z',
        lastModified: '2026-10-28T08:00:00Z',
      },
      {
        pageUrl: `${upstream.origin}/articles/updated`,
        publishedTime: null,
        published: null,
        lastModified: '2026-10-28T08:00:00Z',
      },
    ],
  );
});

test('a JSON Feed item gives date_published as the publication time and date_modified as the modification hint', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed.json')
      response.writeHead(200, { 'content-type': 'application/feed+json' }).end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Posts',
          items: [
            {
              id: 'post',
              url: '/articles/post',
              date_published: '2026-10-26T21:03:24-02:00',
              date_modified: '2026-10-28T08:00:00Z',
            },
          ],
        }),
      );
    else if (request.url?.startsWith('/articles/'))
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><p>The post at ${request.url} carries no date of its own, only complete published research observations.</p></article>`,
        );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();

  await run(
    [`${upstream.origin}/feed.json`],
    cache.path,
    database.path,
    checkpoints.path,
  );

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT pageUrl, publishedTime, published, lastModified FROM articles ORDER BY pageUrl',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        pageUrl: `${upstream.origin}/articles/post`,
        publishedTime: null,
        published: '2026-10-26T23:03:24.000Z',
        lastModified: '2026-10-28T08:00:00Z',
      },
    ],
  );
});

async function run(
  inputs: readonly string[],
  cache: string,
  database: string,
  checkpoints: string,
) {
  const source = new WebSource({
    cachePath: join(cache, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    stream: new WebStream({
      name: 'articles',
      primaryKey: ['articleUrl'],
      readers: [new ListingReader()],
      revisit: new AlwaysRevisit(),
      extractor: new ArticleExtractor(),
    }),
    inputs,
  });
  const destination = new SQLiteDestination({ path: database });
  await new Pipeline({
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
              id: 'feed-dates',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  }).run();
}
