import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  type Crawl,
  FixedRevisit,
  LinkReader,
  ListingReader,
  Origins,
  PaginationReader,
  day,
  hour,
} from './index.ts';

// Got retries no network error, so a test's failure is its first answer.
const noRetries = got.extend({ retry: { limit: 0 } });

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

async function drain(crawl: Crawl) {
  for await (const entry of crawl) if ('error' in entry) throw entry.error;
}

test('a page that is due every hour is requested again in the next run while the expansion budget keeps the crawl unfinished', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const log: string[] = [];
  // A large site whose robots.txt names 40 child sitemaps.
  await using microsoft = await new HttpServer().start(
    website(log, () => {
      const paths: Record<string, string | { type: string; body: string }> = {
        '/': '<p>A large company.</p>',
        '/robots.txt': {
          type: 'text/plain',
          body: `Sitemap: ${microsoft.origin}/sitemap-index.xml`,
        },
        '/sitemap-index.xml': xml(
          `<sitemapindex>${Array.from({ length: 40 }, (_, child) => `<sitemap><loc>${microsoft.origin}/sitemaps/${child}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
        ),
      };
      for (let child = 0; child < 40; child++)
        paths[`/sitemaps/${child}.xml`] = xml('<urlset></urlset>');
      return paths;
    }),
  );
  await using news = await new HttpServer().start(
    website(log, () => ({ '/credits': '<p>Credits.</p>' })),
  );
  await using list = await new HttpServer().start(
    website(log, () => ({
      '/programs': `<main><a href="${microsoft.origin}/">Microsoft</a><a href="${news.origin}/credits">Credits</a></main>`,
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
    include: [
      new URLPattern(`${microsoft.origin}/*`),
      new URLPattern(`${news.origin}/*`),
    ] as const,
    expand: [new URLPattern({ pathname: '*startup*' })] as const,
  };
  const first = crawler.crawl([`${list.origin}/programs`], null, options);
  await drain(first);
  assert.notEqual(first.snapshot().crawl, null);
  t.mock.timers.setTime(Date.now() + hour);
  log.length = 0;

  const second = crawler.crawl(
    [`${list.origin}/programs`],
    JSON.parse(JSON.stringify(first.snapshot())),
    options,
  );
  await drain(second);

  assert.ok(
    log.includes(`${new URL(news.origin).host} /credits`),
    log.join('\n'),
  );
  assert.notEqual(second.snapshot().crawl, null, 'the held sitemaps remain');
});

test('a new crawl does not request a starting URL that is not due', async () => {
  const log: string[] = [];
  await using site = await new HttpServer().start(
    website(log, () => ({
      '/sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/post</loc></url></urlset>`,
      ),
      '/post': '<p>A post.</p>',
    })),
  );
  const crawler = new Origins(noRetries, null).crawler(
    noRetries,
    [new ListingReader()],
    new FixedRevisit({ every: day }),
  );
  const options = { signal: AbortSignal.timeout(120_000) };
  const first = crawler.crawl([`${site.origin}/sitemap.xml`], null, options);
  await drain(first);
  assert.equal(first.snapshot().crawl, null);
  log.length = 0;

  await drain(
    crawler.crawl(
      [`${site.origin}/sitemap.xml`],
      JSON.parse(JSON.stringify(first.snapshot())),
      options,
    ),
  );

  assert.deepEqual(log, []);
});
