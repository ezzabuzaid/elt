import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import got from 'got';

import { HTTPCache } from './http-cache.ts';
import { WebSource } from './web-source.ts';

// A new Node process for each scan proves the production cache survives restart.
const scan = `
import { WebSource } from '@workspace/source-web-articles/web-source';
import { Connection, Copy, Pipeline } from '@workspace/elt';
import { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } from '@workspace/elt-sqlite';
const [input, path, checkpoints, cachePath, id, syncMode] = process.argv.slice(1);
const source = new WebSource({ inputs: [input], cachePath, pollIntervalMs: 60000 });
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

test('production cache survives process restarts, revalidates fresh responses and rebuilds fresh checkpoints', async () => {
  let revision = 1;
  let freshness = 3600;
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
      path === '/private' ? 'no-store' : `public, max-age=${freshness}`,
    );
    if (path === '/modified') response.setHeader('last-modified', modified);
    else if (path !== '/unvalidated') response.setHeader('etag', etag);
    const conditional =
      request.headers['if-none-match'] ?? request.headers['if-modified-since'];
    assert(!Array.isArray(conditional));
    const unchanged =
      path === '/modified' ? conditional === modified : conditional === etag;
    const status = unchanged ? 304 : 200;
    requests.push({ path, conditional, status });
    if (unchanged) response.writeHead(304).end();
    else if (path === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel>' +
            ['/etag', '/modified', '/unvalidated', '/private']
              .map((url) => '<item><link>' + url + '</link></item>')
              .join('') +
            '</channel></rss>',
        );
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<article><h1>${path}</h1><p>Published report revision ${revision}.</p></article>`,
        );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  await using cache = await new Sqlite().database();
  const cachePath = cache.path;
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
        cachePath,
        'articles',
        syncMode,
      ],
      { timeout: 30000 },
    );
    assert.equal(requests.length, 5);
    return JSON.parse(result.stdout);
  }
  assert.deepEqual(await run(), [4]);
  assert(
    requests.every(
      (row) => row.status === 200 && row.conditional === undefined,
    ),
  );
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  cache.connection.exec(`
    CREATE TABLE body_writes (key TEXT NOT NULL);
    CREATE TRIGGER body_insert AFTER INSERT ON cache_bodies
      BEGIN INSERT INTO body_writes VALUES (NEW.key); END;
    CREATE TRIGGER body_update AFTER UPDATE ON cache_bodies
      BEGIN INSERT INTO body_writes VALUES (NEW.key); END;
  `);
  freshness = 7200;
  assert.deepEqual(await run(), [0]);
  assert.equal(
    cache.connection.prepare('SELECT count(*) AS count FROM body_writes').get()
      ?.count,
    0,
  );
  for (const row of cache.connection.prepare('SELECT value FROM cache').all()) {
    assert(typeof row.value === 'string');
    assert.match(row.value, /public, max-age=7200/);
  }
  for (const path of ['/feed.xml', '/etag', '/modified'])
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
  assert.equal(
    cache.connection.prepare('SELECT count(*) AS count FROM body_writes').get()
      ?.count,
    0,
  );
  revision++;
  assert.deepEqual(await run(), [4]);
  assert.equal(
    cache.connection.prepare('SELECT count(*) AS count FROM body_writes').get()
      ?.count,
    3,
  );
  assert(requests.every((row) => row.status === 200));
  for (const row of database.connection
    .prepare('SELECT textContent FROM articles')
    .all()) {
    assert(typeof row.textContent === 'string');
    assert.match(row.textContent, /Published report revision 2\.$/);
  }
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
        `${database.path}.http-cache`,
        'articles',
        'incremental',
      ],
      { timeout: 30000 },
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

test('304 retains compressed and empty bodies while no-store evicts their storage', async () => {
  let privateResponse = false;
  const statuses: number[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader(
      'cache-control',
      privateResponse ? 'no-store' : 'public, max-age=3600',
    );
    response.setHeader('etag', '"same"');
    const status =
      !privateResponse && request.headers['if-none-match'] === '"same"'
        ? 304
        : 200;
    statuses.push(status);
    if (status === 304) response.writeHead(status).end();
    else if (request.url === '/empty') response.writeHead(status).end();
    else
      response
        .writeHead(status, { 'content-encoding': 'gzip' })
        .end(gzipSync('Cached compressed article.'));
  });
  await using database = await new Sqlite().database();
  await using cache = new HTTPCache(database.path);
  const http = got.extend({ cache, headers: { 'cache-control': 'no-cache' } });
  for (const path of ['/compressed', '/empty'])
    assert.equal(
      await http(`${upstream.origin}${path}`).text(),
      path === '/empty' ? '' : 'Cached compressed article.',
    );
  const bodies = database.connection
    .prepare('SELECT key, body FROM cache_bodies ORDER BY key')
    .all();
  // Reject real SQL body writes; a 304 may update policy, but must never hit this trigger.
  database.connection.exec(
    `CREATE TRIGGER reject_body_update BEFORE UPDATE ON cache_bodies BEGIN SELECT RAISE(ABORT, 'body rewritten'); END`,
  );
  for (const path of ['/compressed', '/empty'])
    assert.equal(
      await http(`${upstream.origin}${path}`).text(),
      path === '/empty' ? '' : 'Cached compressed article.',
    );
  assert.deepEqual(statuses, [200, 200, 304, 304]);
  assert.deepEqual(
    database.connection
      .prepare('SELECT key, body FROM cache_bodies ORDER BY key')
      .all(),
    bodies,
  );
  privateResponse = true;
  for (const path of ['/compressed', '/empty'])
    await http(`${upstream.origin}${path}`);
  assert.equal(
    database.connection.prepare('SELECT count(*) AS count FROM cache').get()
      ?.count,
    0,
  );
  assert.equal(
    database.connection
      .prepare('SELECT count(*) AS count FROM cache_bodies')
      .get()?.count,
    0,
  );
});

test('a failed body write rolls back metadata and expiry deletes the body', async () => {
  await using database = await new Sqlite().database();
  await using cache = new HTTPCache(database.path);
  const original = {
    url: 'https://example.test/article',
    statusCode: 200,
    body: Buffer.from('first'),
    cachePolicy: { revision: 1 },
  };
  await cache.set('article', original);
  // SQLite can create this failure at the real storage boundary after metadata was updated.
  database.connection.exec(
    `CREATE TRIGGER reject_body_update BEFORE UPDATE ON cache_bodies BEGIN SELECT RAISE(ABORT, 'body write failed'); END`,
  );
  await assert.rejects(
    cache.set('article', {
      ...original,
      body: Buffer.from('second'),
      cachePolicy: { revision: 2 },
    }),
    /body write failed/,
  );
  assert.deepEqual(await cache.get('article'), original);
  await cache.set('expired', original, -1);
  assert.equal(await cache.get('expired'), undefined);
  assert.equal(
    database.connection
      .prepare('SELECT count(*) AS count FROM cache_bodies')
      .get()?.count,
    1,
  );
  await cache.clear();
  assert.equal(
    database.connection.prepare('SELECT count(*) AS count FROM cache').get()
      ?.count,
    0,
  );
  assert.equal(
    database.connection
      .prepare('SELECT count(*) AS count FROM cache_bodies')
      .get()?.count,
    0,
  );
});

test('HTTP cache requires a persistent file path', () => {
  for (const cachePath of ['', ':memory:', 'bad\0path']) {
    assert.throws(
      () =>
        new WebSource({
          inputs: ['https://example.com/feed.xml'],
          pollIntervalMs: 60000,
          cachePath,
        }),
      /persistent file path|Too small/,
    );
  }
});

test('a shared cache write failure fails the scan', async () => {
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  await using cache = await new Sqlite().database();
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
      cache.connection.exec('DROP TABLE cache');
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<article><p>The article itself is readable.</p></article>');
    }
  });
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        scan,
        `${upstream.origin}/feed.xml`,
        database.path,
        checkpoints.path,
        cache.path,
        'articles',
        'incremental',
      ],
      { timeout: 30000 },
    ),
    /no such table: cache/,
  );
});
