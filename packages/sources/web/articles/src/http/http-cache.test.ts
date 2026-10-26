import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

// A new Node process for each scan proves the production cache survives restart.
const scan = `
import { WebSource } from ${JSON.stringify(import.meta.resolve('@workspace/source-web-articles/web-source'))};
import { Connection, Copy, Pipeline } from ${JSON.stringify(import.meta.resolve('@workspace/elt'))};
import { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } from ${JSON.stringify(import.meta.resolve('@workspace/elt-sqlite'))};
const [input, path, checkpoints, id, syncMode] = process.argv.slice(1);
const source = new WebSource({ inputs: [input], pollIntervalMs: 60000 });
const destination = new SQLiteDestination({ path });
const history = new SQLiteSyncHistory();
await history.install([destination]);
const result = await new Pipeline({ history, connections: [new Connection({
  name: 'web', source, destination,
  checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
  steps: [new Copy((await source.discover()).get('articles'), destination.table('articles'), {
    id, syncMode, destinationSyncMode: syncMode === 'full_refresh' ? 'overwrite' : 'append_dedup',
  })],
})] }).run();
process.stdout.write(JSON.stringify(result.map(row => row.count)));
`;

test('HTTP resource scope exit cancels queued requests without caller cancellation', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    requests.push(request.url);
    response.end('ready');
  });
  await using directory = await mkdtempDisposable(join(tmpdir(), 'web-http-'));
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { webHttp } from ${JSON.stringify(new URL('./web-http.ts', import.meta.url).href)};
const [origin] = process.argv.slice(1);
const rejected = [];
{
  await using client = await webHttp(undefined);
  assert.equal(client.signal.aborted, false);
  await client.http(origin + '/first', { signal: client.signal });
  await client.http(origin + '/second', { signal: client.signal });
  rejected.push(assert.rejects(
    client.http(origin + '/queued', { signal: client.signal }),
    { name: 'AbortError' },
  ));
  await setImmediate();
}
await Promise.all(rejected);
`,
      upstream.origin,
    ],
    { cwd: directory.path, timeout: 10_000 },
  );
  assert.deepEqual(requests, ['/first', '/second']);
});

test('production cache survives process restarts, revalidates fresh responses and rebuilds fresh checkpoints', async () => {
  let revision = 1;
  let freshness = 3600;
  let storable = true;
  const requests: {
    path: string;
    conditional: string | undefined;
    status: number;
  }[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url ?? '/';
    const modified = new Date(Date.UTC(2026, 9, revision)).toUTCString();
    const etag = `"${revision}"`;
    response.setHeader(
      'cache-control',
      path === '/private' || !storable
        ? 'no-store'
        : `public, max-age=${freshness}`,
    );
    if (path === '/modified') response.setHeader('last-modified', modified);
    else if (path !== '/unvalidated') response.setHeader('etag', etag);
    const conditional =
      request.headers['if-none-match'] ?? request.headers['if-modified-since'];
    assert(!Array.isArray(conditional));
    const unchanged =
      storable &&
      (path === '/modified' ? conditional === modified : conditional === etag);
    const status = unchanged ? 304 : 200;
    requests.push({ path, conditional, status });
    if (unchanged) response.writeHead(304).end();
    else if (path === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel>' +
            ['/etag', '/modified', '/unvalidated', '/private', '/empty']
              .map((url) => '<item><link>' + url + '</link></item>')
              .join('') +
            '</channel></rss>',
        );
    else if (path === '/empty')
      response.writeHead(200, { 'content-type': 'text/html' }).end();
    else {
      const body = `<article><h1>${path}</h1><p>Published report revision ${revision}.</p></article>`;
      if (path === '/etag') response.setHeader('content-encoding', 'gzip');
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(path === '/etag' ? gzipSync(body) : body);
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  await using directory = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  const cachePath = join(directory.path, '.cache/web-http.sqlite');
  async function run(
    checkpointPath = checkpoints.path,
    syncMode = 'incremental',
  ) {
    requests.length = 0;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        scan,
        `${upstream.origin}/feed.xml`,
        database.path,
        checkpointPath,
        'articles',
        syncMode,
      ],
      { cwd: directory.path, timeout: 30000 },
    );
    assert.equal(requests.length, 6);
    return JSON.parse(result.stdout);
  }
  assert.deepEqual(await run(), [4]);
  assert(
    requests.every(
      (row) => row.status === 200 && row.conditional === undefined,
    ),
  );
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(directory.path, '.cache'))).mode & 0o777,
    0o700,
  );
  using cache = new DatabaseSync(cachePath);
  freshness = 7200;
  assert.deepEqual(await run(), [0]);
  for (const row of cache.prepare('SELECT value FROM keyv').all()) {
    assert(typeof row.value === 'string');
    assert.match(row.value, /public, max-age=7200/);
  }
  for (const path of ['/feed.xml', '/etag', '/modified', '/empty'])
    assert.equal(requests.find((row) => row.path === path)?.status, 304);
  for (const path of ['/unvalidated', '/private']) {
    assert.equal(requests.find((row) => row.path === path)?.status, 200);
    assert.equal(
      requests.find((row) => row.path === path)?.conditional,
      undefined,
    );
  }
  assert.deepEqual(await run(`${checkpoints.path}.fresh`), [4]);
  assert.equal(requests.find((row) => row.path === '/etag')?.status, 304);
  assert.deepEqual(await run(checkpoints.path, 'full_refresh'), [4]);
  revision++;
  assert.deepEqual(await run(), [4]);
  assert(requests.every((row) => row.status === 200));
  for (const row of database.connection
    .prepare('SELECT textContent FROM articles')
    .all()) {
    assert(typeof row.textContent === 'string');
    assert.match(row.textContent, /Published report revision 2\.$/);
  }
  storable = false;
  assert.deepEqual(await run(), [0]);
  assert.equal(
    cache.prepare('SELECT count(*) AS count FROM keyv').get()?.count,
    0,
  );
  assert.deepEqual(await run(), [0]);
  assert(
    requests.every(
      (row) => row.status === 200 && row.conditional === undefined,
    ),
  );
});

test('persistent HTTP cache respects negotiated Markdown and HTML metadata', async () => {
  let date = '2026-10-24';
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('cache-control', 'public, max-age=3600');
    if (request.url === '/feed.xml') {
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
      return;
    }
    const native = request.headers.accept?.startsWith('text/markdown');
    const etag = native ? '"native"' : `"${date}"`;
    response.setHeader('vary', 'Accept');
    response.setHeader('etag', etag);
    if (request.headers['if-none-match'] === etag)
      response.writeHead(304).end();
    else if (native)
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end('# Field report\n\nPublisher Markdown.');
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<html><head><meta name="author" content="Lina"><meta property="article:published_time" content="${date}"></head><body><article><p>Publisher Markdown.</p></article></body></html>`,
        );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  await using directory = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  for (const expected of [1, 0, 1]) {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        scan,
        `${upstream.origin}/feed.xml`,
        database.path,
        checkpoints.path,
        'articles',
        'incremental',
      ],
      { cwd: directory.path, timeout: 30000 },
    );
    assert.deepEqual(JSON.parse(result.stdout), [expected]);
    const article = database.connection
      .prepare('SELECT markdown, byline, publishedTime FROM articles')
      .get();
    assert.equal(article?.markdown, '# Field report\n\nPublisher Markdown.');
    assert.equal(article?.byline, 'Lina');
    assert.equal(article?.publishedTime, date);
    if (expected === 0) date = '2026-10-25';
  }
});

for (const revalidate of [false, true])
  test(`a shared cache write failure fails a ${revalidate ? '304' : 'cold'} scan`, async () => {
    let fail = !revalidate;
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'web-cache-'),
    );
    await using upstream = await new HttpServer().start((request, response) => {
      response.setHeader('cache-control', 'public, max-age=3600');
      if (request.url === '/feed.xml') {
        response
          .writeHead(200, { 'content-type': 'application/rss+xml' })
          .end(
            '<rss><channel><item><link>/article</link></item></channel></rss>',
          );
      } else {
        // A real schema fault at the storage boundary while the HTTP request is in flight.
        if (fail) {
          assert.equal(
            request.headers['if-none-match'],
            revalidate ? '"article"' : undefined,
          );
          using cache = new DatabaseSync(
            join(directory.path, '.cache/web-http.sqlite'),
          );
          cache.exec('DROP TABLE keyv');
        }
        response.setHeader('etag', '"article"');
        if (request.headers['if-none-match'] === '"article"') {
          response.writeHead(304).end();
          return;
        }
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<article><p>The article itself is readable.</p></article>');
      }
    });
    const run = () =>
      promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          scan,
          `${upstream.origin}/feed.xml`,
          database.path,
          checkpoints.path,
          'articles',
          'incremental',
        ],
        { cwd: directory.path, timeout: 30000 },
      );
    if (revalidate) {
      await run();
      fail = true;
    }
    await assert.rejects(run(), {
      message: /no such table: keyv/,
      stderr: /PipelineError/,
    });
  });
