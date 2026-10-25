import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { DiscoveryError, WebDiscovery, WebLinks } from './index.ts';

test('article responses supply links once and secondary feeds stop after one document', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const path = request.url;
    assert.ok(path);
    requests.push(path);
    if (path === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/feed+json" href="/feed/1"><a href="/known">Known</a>',
        );
    else if (path.startsWith('/feed/')) {
      const n = Number(path.at(-1));
      response.writeHead(200, { 'content-type': 'application/feed+json' }).end(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'Feed',
          items: [{ id: String(n), url: n === 1 ? '/known' : `/article/${n}` }],
          ...(n < 3 ? { next_url: `/feed/${n + 1}` } : {}),
        }),
      );
    } else if (path === '/known')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<a href="/hidden">Hidden</a><link rel="alternate" type="application/feed+json" href="/extra/1">',
        );
    else if (path === '/extra/1')
      response
        .writeHead(200, {
          'content-type': 'application/feed+json',
          link: '</header-next>; rel="next"',
        })
        .end(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: 'Extra',
            items: [
              { id: 'new', url: '/extra-article' },
              { id: 'known', url: '/known' },
            ],
            next_url: '/extra/2',
          }),
        );
    else response.writeHead(404).end();
  });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
  const signal = AbortSignal.timeout(5000);
  const pages = await new WebDiscovery(got, links).discover(
    upstream.origin,
    signal,
  );
  const known = new Set(pages.map((page) => page.url));
  assert.equal(pages.length, 3);
  assert.deepEqual(await links.take(got, known, signal), []);
  const http = got.extend({
    hooks: { afterResponse: [(response) => links.collect(response, 0)] },
  });
  const response = await http(`${upstream.origin}/known`, {
    responseType: 'buffer',
    signal,
  });
  assert.match(response.body.toString(), /Hidden/);
  await links.collect(response, 0);
  const discovered = await links.take(got, known, signal);
  assert.deepEqual(
    discovered.map((page) => page.url),
    [`${upstream.origin}/hidden`, `${upstream.origin}/extra-article`],
  );
  assert.equal(requests.filter((path) => path === '/known').length, 1);
  assert.ok(requests.includes('/feed/3'));
  assert.ok(!requests.includes('/extra/2'));
  assert.ok(!requests.includes('/header-next'));
  assert.equal(discovered[1]?.listingUrl, `${upstream.origin}/extra/1`);
});

test('page and depth budgets bound expansion while retaining candidate identity', async () => {
  const targets = ['/post', '/post/', '/post?a=1&b=2', '/post?b=2&a=1'];
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/robots.txt' || request.url === '/sitemap.xml')
      response.writeHead(404).end();
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          request.url === '/'
            ? targets.map((url) => `<a href="${url}#part">Post</a>`).join('')
            : '<a href="/deep">Deep</a>',
        );
  });
  for (const limits of [
    { maxDepth: 3, maxPages: 2 },
    { maxDepth: 0, maxPages: 2 },
    { maxDepth: 3, maxPages: 0 },
  ]) {
    await using links = await WebLinks.open(limits);
    const signal = AbortSignal.timeout(5000);
    await new WebDiscovery(got, links).discover(upstream.origin, signal);
    const pages = await links.take(got, new Set(), signal);
    assert.deepEqual(
      pages.map((page) => page.url),
      targets.map((url) => upstream.origin + url),
    );
    assert.equal(
      pages.filter((page) => page.follow).length,
      limits.maxDepth === 0 ? 0 : limits.maxPages,
    );
    for (const page of pages.filter((page) => page.follow))
      await got(page.url, {
        signal,
        hooks: {
          afterResponse: [(response) => links.collect(response, page.depth)],
        },
      });
    const more = await links.take(
      got,
      new Set(pages.map((page) => page.url)),
      signal,
    );
    assert.ok(more.every((page) => !page.follow));
    assert.ok(more.length <= 1);
  }
});

test('feed-only inputs do not turn their articles into new crawl roots', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/feed')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/article</link></item></channel></rss>',
        );
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/unrelated">More</a>');
  });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
  const signal = AbortSignal.timeout(5000);
  const pages = await new WebDiscovery(got, links).discover(
    `${upstream.origin}/feed`,
    signal,
  );
  await got(`${upstream.origin}/article`, {
    hooks: { afterResponse: [(response) => links.collect(response, 0)] },
  });
  assert.deepEqual(
    await links.take(got, new Set(pages.map((page) => page.url)), signal),
    [],
  );
});

test('reusing scheduled articles does not refill the expansion budget with extra pages', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/known">Known</a><a href="/helper">Helper</a>');
    else if (request.url === '/known')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/hidden">Hidden</a>');
    else response.writeHead(404).end();
  });
  const signal = AbortSignal.timeout(5000);
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 1 });
  await new WebDiscovery(got, links).discover(upstream.origin, signal);
  const known = new Set([`${upstream.origin}/known`]);
  const pages = await links.take(got, known, signal);
  assert.deepEqual(
    pages.map((page) => [page.url, page.follow]),
    [[`${upstream.origin}/helper`, false]],
  );
  await got(`${upstream.origin}/known`, {
    hooks: { afterResponse: [(r) => links.collect(r, 0)] },
  });
  assert.deepEqual(
    (await links.take(got, known, signal)).map((page) => [
      page.url,
      page.follow,
    ]),
    [[`${upstream.origin}/hidden`, false]],
  );
});

test('secondary feed cancellation keeps its reason and explicit failures remain attributable', async () => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/article">Article</a>');
    else if (request.url === '/article')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/rss+xml" href="/slow-feed">',
        );
    else if (request.url === '/slow-feed') {
      entered.resolve();
      response.on('close', () => closed.resolve());
    } else response.writeHead(404).end();
  });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
  await new WebDiscovery(got, links).discover(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  await got(`${upstream.origin}/article`, {
    hooks: { afterResponse: [(response) => links.collect(response, 1)] },
  });
  const stop = new AbortController(),
    reason = new Error('stop feed');
  const result = links.take(got, new Set(), stop.signal);
  try {
    await entered.promise;
    stop.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    await closed.promise;
  } finally {
    stop.abort(reason);
  }
  await using other = await WebLinks.open({ maxDepth: 1, maxPages: 1 });
  await assert.rejects(
    new WebDiscovery(got, other).discover(
      `${upstream.origin}/missing`,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DiscoveryError &&
      error.url === `${upstream.origin}/missing`,
  );
});

test('archive declarations preserve their boundary and explicit missing sitemaps still fail', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/archive/">Archive</a>');
    else if (request.url === '/archive/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="sitemap" href="ftp://example.test/map"><a href="/article">Article</a>',
        );
    else if (request.url === '/explicit')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="sitemap" href="/missing"><a href="/article">Article</a>',
        );
    else response.writeHead(404).end();
  });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
  assert.equal(
    (
      await new WebDiscovery(got, links).discover(
        upstream.origin,
        AbortSignal.timeout(5000),
      )
    ).length,
    1,
  );
  await assert.rejects(
    new WebDiscovery(got, links).discover(
      `${upstream.origin}/explicit`,
      AbortSignal.timeout(5000),
    ),
    DiscoveryError,
  );
});

test('large queues drain and storage stays in memory despite ambient settings', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'web-links-test-'),
  );
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          Array.from(
            { length: 1200 },
            (_, i) => `<a href="/post/p${i}">Post</a>`,
          ).join(''),
        );
    else response.writeHead(404).end();
  });
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {WebDiscovery,WebLinks} from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
    import got from ${JSON.stringify(import.meta.resolve('got'))};
    await using links=await WebLinks.open({maxDepth:3,maxPages:2});
    await new WebDiscovery(got,links).discover(${JSON.stringify(upstream.origin)},AbortSignal.timeout(5000));
    const pages=await links.take(got,new Set(),AbortSignal.timeout(5000));
    assert.equal(pages.length,1200);assert.equal(pages.filter(p=>p.follow).length,2);
  `,
    ],
    {
      cwd: directory.path,
      timeout: 15000,
      env: {
        ...process.env,
        TMPDIR: directory.path,
        CRAWLEE_STORAGE_DIR: directory.path,
        CRAWLEE_PERSIST_STORAGE: 'true',
        CRAWLEE_PURGE_ON_START: 'true',
      },
    },
  );
  assert.deepEqual(await readdir(directory.path), []);
});

test('invalid link limits fail before creating a queue', async () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      WebLinks.open({ maxDepth: value, maxPages: 1 }),
      RangeError,
    );
    await assert.rejects(
      WebLinks.open({ maxDepth: 1, maxPages: value }),
      RangeError,
    );
  }
});

test('cross-origin secondary feeds need a declaration or a feed-path hint', async () => {
  const remoteRequests: string[] = [];
  await using remote = await new HttpServer().start((request, response) => {
    assert.ok(request.url);
    remoteRequests.push(request.url);
    if (request.url === '/feed' || request.url === '/rss/blog/123')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss><channel><item><link>/published</link></item></channel></rss>',
        );
    else response.writeHead(503).end();
  });
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/article">Article</a>');
    else if (request.url === '/article')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<a href="${remote.origin}/wiki/Atom_(standard)">Atom</a><link rel="alternate" type="application/rss+xml" href="${remote.origin}/feed"><a href="${remote.origin}/rss/blog/123">RSS</a>`,
        );
    else response.writeHead(404).end();
  });
  const signal = AbortSignal.timeout(5000),
    http = got.extend({ retry: { limit: 0 } });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 1 });
  await new WebDiscovery(http, links).discover(upstream.origin, signal);
  await http(`${upstream.origin}/article`, {
    hooks: { afterResponse: [(r) => links.collect(r, 0)] },
  });
  const pages = await links.take(http, new Set(), signal);
  assert.deepEqual(remoteRequests, ['/feed', '/rss/blog/123']);
  assert.equal(pages[0]?.url, `${remote.origin}/published`);
  assert.equal(pages[0]?.follow, false);
});

test('HTTP archive links retain provenance and secondary feed errors name their URL', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<a href="/article">Article</a>');
    else if (request.url === '/article')
      response
        .writeHead(200, {
          'content-type': 'text/html',
          link: '</history>; rel="archives"',
        })
        .end('<p>An article.</p>');
    else if (request.url === '/history')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<link rel="alternate" type="application/rss+xml" href="/broken-feed">',
        );
    else response.writeHead(request.url === '/broken-feed' ? 503 : 404).end();
  });
  const signal = AbortSignal.timeout(5000);
  const http = got.extend({ retry: { limit: 0 } });
  await using links = await WebLinks.open({ maxDepth: 3, maxPages: 100 });
  await new WebDiscovery(http, links).discover(upstream.origin, signal);
  await http(`${upstream.origin}/article`, {
    hooks: { afterResponse: [(r) => links.collect(r, 1)] },
  });
  const pages = await links.take(
    http,
    new Set([`${upstream.origin}/article`]),
    signal,
  );
  assert.equal(pages[0]?.url, `${upstream.origin}/history`);
  assert.equal(pages[0]?.listingUrl, `${upstream.origin}/article`);
  await http(`${upstream.origin}/history`, {
    hooks: { afterResponse: [(r) => links.collect(r, 2)] },
  });
  await assert.rejects(
    links.take(http, new Set(), signal),
    (error) =>
      error instanceof DiscoveryError &&
      error.url === `${upstream.origin}/broken-feed`,
  );
});
