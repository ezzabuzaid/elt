import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import {
  AlwaysRevisit,
  CrawlStarted,
  ListingReader,
  crawlChannels,
} from '@eltjs/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { PageExtracted, pageChannels } from './page-channels.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

test('each page publishes the records it gave once read, and a page whose fingerprint did not change publishes none extracted', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // A feed of one article, which a synthetic site serves offline.
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/robots.txt') response.writeHead(404).end();
    else if (request.url === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end('<rss><channel><item><link>/report</link></item></channel></rss>');
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><body><article><h1>Field report</h1><p>Read the findings of the field.</p></article></body></html>',
        );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          // The second run reads the page again, unchanged.
          revisit: new AlwaysRevisit(),
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
      },
    ],
  });
  const destination = new SQLiteDestination({ path: database.path });
  const pipeline = new Pipeline({
    clock: globalThis,
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
  });
  const heard: PageExtracted[] = [];
  const crawls: unknown[] = [];
  const hear = (message: unknown) => {
    if (message instanceof PageExtracted) heard.push(message);
    if (message instanceof CrawlStarted) crawls.push(message.crawl);
  };
  pageChannels.extract.subscribe(hear);
  crawlChannels.start.subscribe(hear);

  try {
    await pipeline.run();
    await pipeline.run();
  } finally {
    pageChannels.extract.unsubscribe(hear);
    crawlChannels.start.unsubscribe(hear);
  }

  assert.deepEqual(
    heard.map(({ stream, url, extracted }) => [
      stream,
      new URL(url).pathname,
      extracted?.records ?? null,
    ]),
    [
      ['articles', '/report', 1],
      ['articles', '/report', null],
    ],
  );
  assert.ok(heard.every(({ read }) => read >= 0));
  // Each run's page names that run's crawl.
  assert.equal(crawls.length, 2);
  assert.deepEqual(
    heard.map(({ crawl }) => crawls.indexOf(crawl)),
    [0, 1],
  );
});
