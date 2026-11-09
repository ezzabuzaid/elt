import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { type TimerId, createClock } from '@sinonjs/fake-timers';
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

// The clock of the runs, which the test moves: the waits of an origin take no
// real time, and the clock moves by the length of each wait, also on a busy
// machine. A real timer waits whole milliseconds and at least one, so a wait
// here lasts its length rounded up; a fake timer shorter than a millisecond
// would end at once, and the crawl would wait for the rest again and again.
function clock(now: number) {
  const fake = createClock(now);
  const timers = new Map<object, TimerId>();
  return {
    fake,
    Date: fake.Date,
    performance: fake.performance,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = {};
      timers.set(
        timer,
        fake.setTimeout(() => {
          timers.delete(timer);
          callback();
        }, Math.ceil(ms)),
      );
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      if (!(timer instanceof Object)) return;
      fake.clearTimeout(timers.get(timer));
      timers.delete(timer);
    },
  };
}

type Clock = ReturnType<typeof clock>;

// Whether the promise settled in one turn of the event loop; a rejection throws.
function settled(promise: Promise<unknown>) {
  return Promise.race([promise.then(() => true), setImmediate(false)]);
}

// One run to its end. The run waits only for the delays of origins, one at a
// time, so a pending timer is such a wait, which ends at once with the clock
// moved by its length.
async function ran(run: Promise<unknown>, time: Clock) {
  while (!(await settled(run)))
    if (time.fake.countTimers() > 0) time.fake.next();
}

// Every web stream of the source, copied incrementally into SQLite.
async function pipeline(
  source: WebSource,
  path: string,
  checkpoints: string,
  time: Clock,
) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    clock: time,
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
  const time = clock(0);
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: { path: string; at: number }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: time.performance.now() });
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
    time,
  );

  await ran(ingestion.run(), time);

  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/robots.txt', '/a.xml', '/a', '/b.xml', '/b'],
  );
  // The second input's first request waits the origin's delay after the first input's last one.
  const last = requests.find(({ path }) => path === '/a')?.at ?? Number.NaN;
  const next = requests.find(({ path }) => path === '/b.xml')?.at ?? Number.NaN;
  assert.equal(next - last, 1000);
});

test("a 429 to one input holds another input's requests to that origin", async () => {
  const time = clock(0);
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
    time,
  );

  await ran(
    ingestion.run().catch(() => undefined),
    time,
  );

  // The second input asks nothing of the blocked origin, not even its sitemap.
  assert.deepEqual(requests, ['/robots.txt', '/a.xml', '/a']);
});

test('a block and a slowdown outlive the source that met them', async () => {
  const time = clock(0);
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const cachePath = join(cache.path, 'web-http.sqlite');
  const requests: { path: string; at: number }[] = [];
  let blocking = true;
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: time.performance.now() });
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
    ran(
      (
        await pipeline(
          new WebSource({
            cachePath,
            streams: [{ stream: articles(), inputs: [input] }],
          }),
          database.path,
          checkpoints.path,
          time,
        )
      )
        .run()
        .catch(() => undefined),
      time,
    );

  await run(`${upstream.origin}/blocked.xml`);
  requests.length = 0;
  await run(`${upstream.origin}/blocked.xml`);
  const whileBlocked = requests.splice(0).map(({ path }) => path);
  blocking = false;
  // A block ends by the clock, so an hour and a second pass.
  time.fake.tick(3_601_000);
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
  assert.equal(pageAt - sitemapAt, 1900);
});

test("an article's extra requests pass the robots.txt and the delay of their origin", async () => {
  const time = clock(0);
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const requests: { path: string; at: number }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    requests.push({ path, at: time.performance.now() });
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
    time,
  );

  await ran(ingestion.run(), time);

  const paths = requests.map(({ path }) => path);
  // robots.txt disallows the Markdown alternate of /private, so it is not requested.
  assert.ok(!paths.includes('/private.md'), paths.join(' '));
  // The alternate of /public is a request of the origin, one delay after the page.
  const page =
    requests.find(({ path }) => path === '/public')?.at ?? Number.NaN;
  const alternate =
    requests.find(({ path }) => path === '/public.md')?.at ?? Number.NaN;
  assert.equal(alternate - page, 1000);
});
