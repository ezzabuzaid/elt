import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import got from 'got';

import {
  Connection,
  Copy,
  CopyConfiguration,
  Pipeline,
  diffGroupedSnapshot,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  type ArticlePage,
  HTMLExtraction,
  WebArticle,
} from '@workspace/sdk-web-article';
import {
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
} from '@workspace/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

test('committed groups skip extraction after 304 and identical 200, but fresh and full scans extract', async () => {
  let revision = 1;
  let extractions = 0;
  let revalidated = 0;
  class CountedHTML extends HTMLExtraction {
    override async extract(page: ArticlePage, signal: AbortSignal) {
      extractions++;
      return super.extract(page, signal);
    }
  }
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('etag', `"${revision}"`);
    response.setHeader('cache-control', 'no-cache');
    if (request.headers['if-none-match'] === `"${revision}"`) {
      revalidated++;
      response.writeHead(304).end();
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><p>Published report revision ${revision}.</p></article>`,
        );
    }
  });
  const source = new WebSource({
    stream: articles(),
    inputs: [upstream.origin],
    pollIntervalMs: 60_000,
  });
  const stream = (await source.discover()).get('articles');
  const incremental = new CopyConfiguration(stream, {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const full = new CopyConfiguration(stream, {
    syncMode: 'full_refresh',
    destinationSyncMode: 'overwrite',
  });
  const http = got.extend({
    cache: new Map(),
    headers: { 'cache-control': 'no-cache' },
  });
  const signal = AbortSignal.timeout(10_000);
  async function scan(
    state: unknown,
    configuration = incremental,
    client = http,
  ) {
    const download = await new WebArticle([new CountedHTML()], client).download(
      upstream.origin,
      signal,
    );
    let next: unknown = null;
    let records = 0;
    for await (const message of diffGroupedSnapshot(
      configuration,
      [
        {
          key: upstream.origin,
          fingerprint: download.fingerprint,
          async *records() {
            const article = await download.extract();
            if (article)
              yield {
                ...article,
                inputUrl: upstream.origin,
                pageUrl: upstream.origin,
                articleUrl: upstream.origin,
              };
          },
        },
      ],
      state,
      { signal },
    )) {
      if ('type' in message && message.type === 'STATE') next = message.state;
      if ('data' in message) records++;
    }
    return { state: next, records };
  }
  const first = await scan(null);
  assert.equal(first.records, 1);
  assert.equal(extractions, 1);
  const unchanged = await scan(JSON.parse(JSON.stringify(first.state)));
  assert.equal(unchanged.records, 0);
  assert.equal(extractions, 1);
  assert.equal(revalidated, 1);
  assert.equal((await scan(unchanged.state, incremental, got)).records, 0);
  assert.equal(extractions, 1);
  revision++;
  const edited = await scan(unchanged.state);
  assert.equal(edited.records, 1);
  assert.equal(extractions, 2);
  assert.equal((await scan(null)).records, 1);
  assert.equal(extractions, 3);
  assert.equal((await scan(edited.state, full)).records, 1);
  assert.equal(extractions, 4);
});

test('restarted source keeps unchanged rows and detects listing metadata and article edits', async () => {
  let lastModified = '2026-10-01';
  let revision = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/sitemap.xml') {
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset><url><loc>http://${request.headers.host}/article</loc><lastmod>${lastModified}</lastmod></url></urlset>`,
        );
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><p>Published report revision ${revision}.</p></article>`,
        );
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  async function run() {
    const source = new WebSource({
      stream: articles(),
      inputs: [`${upstream.origin}/sitemap.xml`],
      pollIntervalMs: 60_000,
    });
    const destination = new SQLiteDestination({ path: database.path });
    const history = new SQLiteSyncHistory();
    await history.install([destination]);
    return new Pipeline({
      history,
      connections: [
        new Connection({
          name: 'web',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
          steps: [
            new Copy(
              (await source.discover()).get('articles'),
              destination.table('articles'),
              {
                id: 'web:articles',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
          ],
        }),
      ],
    }).run();
  }
  assert.equal((await run())[0]?.count, 1);
  assert.equal((await run())[0]?.count, 0);
  lastModified = '2026-10-02';
  assert.equal((await run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT lastModified FROM articles').get()
      ?.lastModified,
    lastModified,
  );
  revision++;
  assert.equal((await run())[0]?.count, 1);
  assert.equal(
    database.connection.prepare('SELECT textContent FROM articles').get()
      ?.textContent,
    'Published report revision 2.',
  );
  assert.equal((await run())[0]?.count, 0);
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
    include: include?.map((pattern) => new URLPattern(pattern)),
    extractor: new ArticleExtractor(),
  });
}
