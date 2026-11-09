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
import { FixedRevisit, ListingReader } from '@eltjs/sdk-web-crawler';

import { ArticleExtractor } from './article-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

// Each input of a web source is its own crawl; the origins they ask share one record.

// Every web stream of the source, copied incrementally into SQLite.
async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    clock: globalThis,
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
  });
}

// A web stream of articles that sitemaps list, whose every URL is due in every run.
function articles() {
  return new WebStream({
    name: 'articles',
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    revisit: new FixedRevisit({ every: 0 }),
    extractor: new ArticleExtractor(),
  });
}

function sitemap(origin: string, paths: readonly string[]) {
  return `<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
}

const article = (path: string) =>
  `<html><head><title>${path}</title></head><body><article><p>The report at ${path} has enough words to read as an article of its own.</p></article></body></html>`;

test('two inputs on one origin share its robots.txt and its delay', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: { path: string; at: number }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: performance.now() });
    if (path === '/robots.txt')
      response.writeHead(200, { 'content-type': 'text/plain' }).end('');
    else if (path === '/a.xml' || path === '/b.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(sitemap(upstream.origin, [path.replace('.xml', '')]));
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article(path));
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      streams: [
        {
          stream: articles(),
          inputs: [`${upstream.origin}/a.xml`, `${upstream.origin}/b.xml`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/robots.txt', '/a.xml', '/a', '/b.xml', '/b'],
  );
  // The second input's first request waits the origin's delay after the first input's last one.
  const last = requests.find(({ path }) => path === '/a')?.at ?? Number.NaN;
  const next = requests.find(({ path }) => path === '/b.xml')?.at ?? Number.NaN;
  assert.ok(next - last >= 990, `/b.xml started ${next - last} ms after /a`);
});

test("a 429 to one input holds another input's requests to that origin", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push(path);
    if (path === '/robots.txt') response.writeHead(404).end();
    else if (path === '/a.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(sitemap(upstream.origin, ['/a']));
    else if (path === '/a')
      response.writeHead(429, { 'retry-after': '3600' }).end();
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article(path));
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      streams: [
        {
          stream: articles(),
          inputs: [`${upstream.origin}/a.xml`, `${upstream.origin}/b.xml`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run().catch(() => undefined);

  // The second input asks nothing of the blocked origin, not even its sitemap.
  assert.deepEqual(requests, ['/robots.txt', '/a.xml', '/a']);
});

test('a block and a slowdown outlive the source that met them', async (t) => {
  // A block ends by the clock; the test moves Date forward past it.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const cachePath = join(cache.path, 'web-http.sqlite');
  const requests: { path: string; at: number }[] = [];
  let blocking = true;
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: performance.now() });
    if (path === '/robots.txt') response.writeHead(404).end();
    else if (path === '/blocked.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(sitemap(upstream.origin, ['/held']));
    else if (path === '/held' && blocking)
      response.writeHead(429, { 'retry-after': '3600' }).end();
    else if (path === '/slow.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(sitemap(upstream.origin, ['/page']));
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article(path));
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  // Each run is a new source, as a process that starts again makes one.
  const run = async (input: string) =>
    (
      await pipeline(
        new WebSource({
          cachePath,
          streams: [{ stream: articles(), inputs: [input] }],
        }),
        database.path,
        checkpoints.path,
      )
    )
      .run()
      .catch(() => undefined);

  await run(`${upstream.origin}/blocked.xml`);
  requests.length = 0;
  await run(`${upstream.origin}/blocked.xml`);
  const whileBlocked = requests.splice(0).map(({ path }) => path);
  blocking = false;
  t.mock.timers.setTime(Date.now() + 3_601_000);
  await run(`${upstream.origin}/slow.xml`);

  // The block of an hour outlived the first source, so the second asked nothing.
  assert.deepEqual(whileBlocked, []);
  // The 429 left a slowdown of a second, which the third source keeps: its
  // first answer shortened it by a tenth, on top of the delay of a second.
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/slow.xml', '/page'],
  );
  const [sitemapAt = 0, pageAt = 0] = requests.map(({ at }) => at);
  assert.ok(
    pageAt - sitemapAt >= 1880,
    `/page waited ${pageAt - sitemapAt} ms`,
  );
});

test("an article's extra requests pass the robots.txt and the delay of their origin", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: { path: string; at: number }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: performance.now() });
    if (path === '/robots.txt')
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end('User-agent: *\nDisallow: /private.md\n');
    else if (path === '/sitemap.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(sitemap(upstream.origin, ['/private', '/public']));
    else if (path.endsWith('.md'))
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end(`# ${path}\n\nThe Markdown of the page.`);
    else
      response
        .writeHead(200, {
          'content-type': 'text/html',
          link: `<${path}.md>; rel="alternate"; type="text/markdown"`,
        })
        .end(article(path));
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      streams: [
        { stream: articles(), inputs: [`${upstream.origin}/sitemap.xml`] },
      ],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  const paths = requests.map(({ path }) => path);
  // robots.txt disallows the Markdown alternate of /private, so it is not requested.
  assert.ok(!paths.includes('/private.md'), paths.join(' '));
  // The alternate of /public is a request of the origin, one delay after the page.
  const page =
    requests.find(({ path }) => path === '/public')?.at ?? Number.NaN;
  const alternate =
    requests.find(({ path }) => path === '/public.md')?.at ?? Number.NaN;
  assert.ok(
    alternate - page >= 990,
    `/public.md started ${alternate - page} ms after /public`,
  );
});
