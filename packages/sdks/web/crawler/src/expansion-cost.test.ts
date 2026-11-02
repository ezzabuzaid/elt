import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  AdaptiveRevisit,
  type Crawl,
  FixedRevisit,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  hour,
} from './index.ts';

// Got retries no network error, so a test's failure is its first answer.
const noRetries = got.extend({ retry: { limit: 0 } });

// As the startup-credits app: a list of programs links the home page of each
// company, and the crawl searches the home page one step for a program page.
function programs(origins: Origins) {
  return origins.crawler(
    noRetries,
    [
      new PaginationReader({ strategy: 'all' }),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ],
    new AdaptiveRevisit(),
  );
}

const expand = [new URLPattern({ pathname: '*startup*' })] as const;

// A website that logs "host path" for each request it is asked for and
// answers each path with its HTML, its own content type, or 404.
function website(
  log: string[],
  paths: () => Record<string, string | { type: string; body: string }>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    log.push(`${request.headers.host} ${request.url}`);
    const answer = paths()[request.url ?? ''];
    if (answer === undefined) response.writeHead(404).end();
    else if (typeof answer === 'string')
      response.writeHead(200, { 'content-type': 'text/html' }).end(answer);
    else
      response.writeHead(200, { 'content-type': answer.type }).end(answer.body);
  };
}

const xml = (body: string) => ({ type: 'application/xml', body });

// A website whose robots.txt names a sitemap index of many child sitemaps,
// each with one page that expand does not match; only the last child lists
// a program page, as www.microsoft.com and aws.amazon.com do.
function large(origin: () => string, children: number) {
  const paths: Record<string, string | { type: string; body: string }> = {
    '/': '<p>A large company.</p>',
    '/robots.txt': {
      type: 'text/plain',
      body: `Sitemap: ${origin()}/sitemap-index.xml`,
    },
    '/sitemap-index.xml': xml(
      `<sitemapindex>${Array.from({ length: children }, (_, child) => `<sitemap><loc>${origin()}/sitemaps/${child}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
    ),
    '/startups': '<p>Credits.</p>',
  };
  for (let child = 0; child < children; child++) {
    paths[`/sitemaps/${child}.xml`] = xml(
      `<urlset><url><loc>${origin()}/${child === children - 1 ? 'startups' : `product-${child}`}</loc></url></urlset>`,
    );
    paths[`/product-${child}`] = '<p>A product.</p>';
  }
  return paths;
}

// A website whose program page is only in the sitemap that its robots.txt names.
function small(origin: () => string) {
  return {
    '/': '<p>A small company.</p>',
    '/robots.txt': {
      type: 'text/plain',
      body: `Sitemap: ${origin()}/sitemap.xml`,
    },
    '/sitemap.xml': xml(
      `<urlset><url><loc>${origin()}/startup-program</loc></url></urlset>`,
    ),
    '/startup-program': '<p>Credits.</p>',
  };
}

// Each run of a crawl: the pages it handed back, and the log of every
// request and every handed-back page, "page URL", in order.
async function run(crawl: Crawl, log: string[]) {
  const pages: string[] = [];
  for await (const entry of crawl) {
    if ('error' in entry) throw entry.error;
    if ('response' in entry) {
      pages.push(entry.url);
      log.push(`page ${entry.url}`);
    }
  }
  return pages;
}

test("a small site's program page comes back in the first run, before the large site's child sitemaps are all read", async () => {
  const log: string[] = [];
  await using microsoft = await new HttpServer().start(
    website(log, () => large(() => microsoft.origin, 40)),
  );
  await using vercel = await new HttpServer().start(
    website(log, () => small(() => vercel.origin)),
  );
  await using list = await new HttpServer().start(
    website(log, () => ({
      '/programs': `<main><a href="${microsoft.origin}/">Microsoft</a><a href="${vercel.origin}/">Vercel</a></main>`,
    })),
  );

  const pages = await run(
    programs(new Origins(noRetries, null)).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(120_000),
        include: [
          new URLPattern(`${microsoft.origin}/*`),
          new URLPattern(`${vercel.origin}/*`),
        ],
        expand,
      },
    ),
    log,
  );

  assert.ok(pages.includes(`${vercel.origin}/startup-program`), pages.join());
  const children = log.filter((line) => line.includes(' /sitemaps/'));
  assert.ok(children.length < 40, `${children.length} child sitemaps`);
});

test("the large site's other child sitemaps are read in later runs, each once, until its program page comes back, and their routes are recorded", async () => {
  const log: string[] = [];
  await using microsoft = await new HttpServer().start(
    website(log, () => large(() => microsoft.origin, 40)),
  );
  await using list = await new HttpServer().start(
    website(log, () => ({
      '/programs': `<main><a href="${microsoft.origin}/">Microsoft</a></main>`,
    })),
  );
  const options = {
    signal: AbortSignal.timeout(120_000),
    include: [new URLPattern(`${microsoft.origin}/*`)] as const,
    expand,
  };
  const pages: string[] = [];
  const routes: string[] = [];
  let memento: unknown = null;
  let runs = 0;
  // Each run is a read of its own: its origins' records start from the last
  // read's, and each read spends a new expansion budget.
  let origins = new Origins(noRetries, null);
  do {
    origins = new Origins(noRetries, origins.snapshot());
    const crawl = programs(origins).crawl(
      [`${list.origin}/programs`],
      memento,
      options,
    );
    for await (const entry of crawl) {
      if ('error' in entry) throw entry.error;
      if ('response' in entry) pages.push(entry.url);
      if ('routes' in entry)
        for (const { listingUrl, complete, routes: named } of entry.routes) {
          assert.ok(complete, listingUrl);
          for (const { url } of named)
            routes.push(
              `${new URL(listingUrl).pathname} ${new URL(url).pathname}`,
            );
        }
    }
    memento = JSON.parse(JSON.stringify(crawl.snapshot()));
    runs++;
    // A crawl that the budget left unfinished is due again at once.
    if (crawl.snapshot().crawl !== null) {
      const due = crawl.nextDue();
      assert.ok(due !== null && due <= Date.now(), `due at ${due}`);
    }
    // Each run requests each child sitemap at most once.
    const children = log.filter((line) => line.includes(' /sitemaps/'));
    assert.equal(new Set(children).size, children.length, children.join());
    log.length = 0;
    assert.ok(runs <= 20, 'the crawl never completes');
  } while (
    typeof memento === 'object' &&
    memento !== null &&
    'crawl' in memento &&
    memento.crawl !== null
  );

  assert.ok(runs > 1, `${runs} runs`);
  assert.ok(pages.includes(`${microsoft.origin}/startups`), pages.join());
  for (let child = 0; child < 40; child++)
    assert.ok(
      routes.includes(`/sitemap-index.xml /sitemaps/${child}.xml`),
      `index names child ${child}`,
    );
  assert.ok(routes.includes('/sitemaps/39.xml /startups'), routes.join('\n'));
});

test("origins take turns: one starting site's many child sitemaps do not hold up another site's page", async () => {
  const log: string[] = [];
  await using microsoft = await new HttpServer().start(
    website(log, () => large(() => microsoft.origin, 40)),
  );
  await using vercel = await new HttpServer().start(
    website(log, () => ({
      '/sitemap-index.xml': xml(
        `<sitemapindex><sitemap><loc>${vercel.origin}/pages.xml</loc></sitemap></sitemapindex>`,
      ),
      '/pages.xml': xml(
        `<urlset><url><loc>${vercel.origin}/startups</loc></url></urlset>`,
      ),
      '/startups': '<p>Credits.</p>',
    })),
  );

  // Starting origins are not budgeted, so the large site's index is read
  // whole in this run.
  await run(
    new Origins(noRetries, null)
      .crawler(noRetries, [new ListingReader()], new AdaptiveRevisit())
      .crawl(
        [
          `${microsoft.origin}/sitemap-index.xml`,
          `${vercel.origin}/sitemap-index.xml`,
        ],
        null,
        {
          signal: AbortSignal.timeout(120_000),
          include: [new URLPattern(`${vercel.origin}/*`)],
        },
      ),
    log,
  );

  const handed = log.indexOf(`page ${vercel.origin}/startups`);
  const lastChild = log.indexOf(
    `${new URL(microsoft.origin).host} /sitemaps/39.xml`,
  );
  assert.ok(handed !== -1 && lastChild !== -1, log.join('\n'));
  assert.ok(handed < lastChild, log.join('\n'));
});

test('a second expanded site whose robots.txt names no sitemap gets its /sitemap.xml guess, after another site read a sitemap', async () => {
  await using vercel = await new HttpServer().start(
    website([], () => small(() => vercel.origin)),
  );
  await using pinecone = await new HttpServer().start(
    website([], () => ({
      '/': '<p>Pinecone.</p>',
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /' },
      '/sitemap.xml': xml(
        `<urlset><url><loc>${pinecone.origin}/startup-program/</loc></url></urlset>`,
      ),
      '/startup-program/': '<p>Credits.</p>',
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${vercel.origin}/">Vercel</a><a href="${pinecone.origin}/">Pinecone</a></main>`,
    })),
  );

  const pages = await run(
    programs(new Origins(noRetries, null)).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(120_000),
        include: [
          new URLPattern(`${vercel.origin}/*`),
          new URLPattern(`${pinecone.origin}/*`),
        ],
        expand,
      },
    ),
    [],
  );

  assert.ok(
    pages.includes(`${pinecone.origin}/startup-program/`),
    pages.join(),
  );
});

test('a run that continues a crawl held back by the budget reads its list again when the list is due, and the new row comes back before the held sitemaps are read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const log: string[] = [];
  await using microsoft = await new HttpServer().start(
    website(log, () => large(() => microsoft.origin, 40)),
  );
  await using vercel = await new HttpServer().start(
    website(log, () => small(() => vercel.origin)),
  );
  let rows = `<a href="${microsoft.origin}/">Microsoft</a>`;
  await using list = await new HttpServer().start(
    website(log, () => ({ '/programs': `<main>${rows}</main>` })),
  );
  // The list is due every hour, as the startup-credits app reads its lists.
  const crawler = new Origins(noRetries, null).crawler(
    noRetries,
    [
      new PaginationReader({ strategy: 'all' }),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ],
    new FixedRevisit({ every: hour }),
  );
  const options = {
    signal: AbortSignal.timeout(120_000),
    include: [
      new URLPattern(`${microsoft.origin}/*`),
      new URLPattern(`${vercel.origin}/*`),
    ] as const,
    expand,
  };
  const first = crawler.crawl([`${list.origin}/programs`], null, options);
  await run(first, log);
  const memento: unknown = JSON.parse(JSON.stringify(first.snapshot()));
  assert.notEqual(first.snapshot().crawl, null);
  // An hour later, the list has a new row.
  t.mock.timers.setTime(Date.now() + hour);
  rows += `<a href="${vercel.origin}/">Vercel</a>`;
  log.length = 0;

  const second = crawler.crawl([`${list.origin}/programs`], memento, options);
  const pages = await run(second, log);

  assert.ok(pages.includes(`${vercel.origin}/startup-program`), pages.join());
  assert.notEqual(second.snapshot().crawl, null, 'the held sitemaps remain');
  // The list is due again an hour after the run that read it, not after the
  // run that started the crawl.
  t.mock.timers.setTime(Date.now() + 60_000);
  log.length = 0;
  await run(
    crawler.crawl(
      [`${list.origin}/programs`],
      JSON.parse(JSON.stringify(second.snapshot())),
      options,
    ),
    log,
  );
  assert.ok(!log.some((line) => line.endsWith(' /programs')), log.join('\n'));
});

test('a run that continues a crawl at once does not read its list again before the list is due', async () => {
  const log: string[] = [];
  await using microsoft = await new HttpServer().start(
    website(log, () => large(() => microsoft.origin, 40)),
  );
  await using list = await new HttpServer().start(
    website(log, () => ({
      '/programs': `<main><a href="${microsoft.origin}/">Microsoft</a></main>`,
    })),
  );
  const crawler = new Origins(noRetries, null).crawler(
    noRetries,
    [
      new PaginationReader({ strategy: 'all' }),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ],
    new FixedRevisit({ every: hour }),
  );
  const options = {
    signal: AbortSignal.timeout(120_000),
    include: [new URLPattern(`${microsoft.origin}/*`)] as const,
    expand,
  };
  const first = crawler.crawl([`${list.origin}/programs`], null, options);
  await run(first, log);
  log.length = 0;

  await run(
    crawler.crawl(
      [`${list.origin}/programs`],
      JSON.parse(JSON.stringify(first.snapshot())),
      options,
    ),
    log,
  );

  assert.ok(!log.some((line) => line.endsWith(' /programs')), log.join('\n'));
});
