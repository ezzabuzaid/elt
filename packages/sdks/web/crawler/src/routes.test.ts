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
  PaginationReader,
  WebCrawler,
  day,
} from './index.ts';

// As the startup-credits app: a list of programs links the home page of each
// company, and the crawl searches the home page one step for a program page.
function programs(revisit?: FixedRevisit) {
  return new WebCrawler(
    got.extend({ retry: { limit: 0 } }),
    [
      new PaginationReader({ strategy: 'all' }),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ],
    revisit,
  );
}

const expand = [new URLPattern({ pathname: '*startup*' })] as const;

// Each route of a crawl as one line, "listing how url text"; a failure fails the test.
async function routes(crawl: Crawl) {
  const lines: string[] = [];
  for await (const entry of crawl) {
    if ('error' in entry) throw entry.error;
    if ('routes' in entry)
      for (const { listingUrl, routes } of entry.routes)
        for (const { url, how, text } of routes)
          lines.push(`${listingUrl} ${how} ${url} ${text ?? '-'}`);
  }
  return lines.toSorted();
}

// A website that records the paths it is asked for and answers each path with
// its HTML, its own content type, or 404.
function website(
  requests: string[],
  paths: () => Record<
    string,
    string | { type: string; body: string } | { redirect: string }
  >,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? '');
    const answer = paths()[request.url ?? ''];
    if (answer === undefined) response.writeHead(404).end();
    else if (typeof answer === 'string')
      response.writeHead(200, { 'content-type': 'text/html' }).end(answer);
    else if ('redirect' in answer)
      response.writeHead(301, { location: answer.redirect }).end();
    else
      response.writeHead(200, { 'content-type': answer.type }).end(answer.body);
  };
}

const xml = (body: string) => ({ type: 'application/xml', body });

// The routes that a starting list on a website with no robots.txt always
// gives: its own robots.txt, and the /sitemap.xml guess that robots.txt gives.
function listRoutes(list: string) {
  const origin = new URL(list).origin;
  return [
    `${list} robots ${origin}/robots.txt -`,
    `${origin}/robots.txt sitemap-guess ${origin}/sitemap.xml -`,
  ];
}

test('the routes connect a list to the program page that the home page it links gives through its menu and its robots.txt sitemap, with the text of each link', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': '<nav><a href="/startups">Startups</a><a href="/pricing">Pricing</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/pricing': '<p>Prices.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/crawled-sitemap.xml`,
      },
      '/crawled-sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/startups</loc></url><url><loc>${site.origin}/blog/launch</loc></url></urlset>`,
      ),
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/"><img alt=""></a> <a href="${site.origin}/">Vercel  for
        Startups</a> <a href="/LICENSE">License</a></main>`,
    })),
  );

  const lines = await routes(
    programs().crawl([`${list.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [new URLPattern(`${site.origin}/*`)],
      expand,
    }),
  );

  assert.deepEqual(
    lines,
    [
      ...listRoutes(`${list.origin}/programs`),
      `${list.origin}/programs list-item ${site.origin}/ Vercel for Startups`,
      `${site.origin}/ link ${site.origin}/startups Startups`,
      `${site.origin}/ robots ${site.origin}/robots.txt -`,
      `${site.origin}/robots.txt robots-sitemap ${site.origin}/crawled-sitemap.xml -`,
      `${site.origin}/crawled-sitemap.xml sitemap-entry ${site.origin}/startups -`,
    ].toSorted(),
  );
});

test('a program page that the list also links keeps the routes from the home page that name it, and is downloaded once', async () => {
  const requests: string[] = [];
  await using site = await new HttpServer().start(
    website(requests, () => ({
      '/': '<nav><a href="/startups">Startups</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/crawled-sitemap.xml`,
      },
      '/crawled-sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/startups</loc></url></urlset>`,
      ),
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Vercel</a><a href="${site.origin}/startups">Vercel for Startups</a></main>`,
    })),
  );

  const lines = await routes(
    programs().crawl([`${list.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [new URLPattern(`${site.origin}/*`)],
      expand,
    }),
  );

  assert.deepEqual(
    lines,
    [
      ...listRoutes(`${list.origin}/programs`),
      `${list.origin}/programs list-item ${site.origin}/ Vercel`,
      `${list.origin}/programs list-item ${site.origin}/startups Vercel for Startups`,
      `${site.origin}/ link ${site.origin}/startups Startups`,
      `${site.origin}/ robots ${site.origin}/robots.txt -`,
      `${site.origin}/robots.txt robots-sitemap ${site.origin}/crawled-sitemap.xml -`,
      `${site.origin}/crawled-sitemap.xml sitemap-entry ${site.origin}/startups -`,
      // /startups is itself a page that the list links on another website, so it is expanded one step too.
      `${site.origin}/startups robots ${site.origin}/robots.txt -`,
    ].toSorted(),
  );
  assert.equal(requests.filter((path) => path === '/startups').length, 1);
});

test('every page expanded on one origin has a route to its robots.txt, which the crawl reads once, and a sitemap on another host keeps its routes', async () => {
  const sister: string[] = [];
  await using showcase = await new HttpServer().start(
    website(sister, () => ({
      '/sitemap.xml': xml(
        `<urlset><url><loc>${showcase.origin}/startups</loc></url></urlset>`,
      ),
      '/startups': '<p>Credits.</p>',
    })),
  );
  const requests: string[] = [];
  await using site = await new HttpServer().start(
    website(requests, () => ({
      '/': '<p>A company.</p>',
      '/about': '<p>About.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${showcase.origin}/sitemap.xml`,
      },
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">ElevenLabs</a><a href="${site.origin}/about">About</a></main>`,
    })),
  );
  // The robots.txt of an origin that one page names is read as often.
  const once: string[] = [];
  await using alone = await new HttpServer().start(
    website(once, () => ({
      '/': '<p>A company.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using single = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${alone.origin}/">Alone</a></main>`,
    })),
  );
  await routes(
    programs().crawl([`${single.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [new URLPattern(`${alone.origin}/*`)],
      expand,
    }),
  );

  const lines = await routes(
    programs().crawl([`${list.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [
        new URLPattern(`${site.origin}/*`),
        new URLPattern(`${showcase.origin}/*`),
      ],
      expand,
    }),
  );

  assert.deepEqual(
    lines,
    [
      ...listRoutes(`${list.origin}/programs`),
      `${list.origin}/programs list-item ${site.origin}/ ElevenLabs`,
      `${list.origin}/programs list-item ${site.origin}/about About`,
      `${site.origin}/ robots ${site.origin}/robots.txt -`,
      `${site.origin}/about robots ${site.origin}/robots.txt -`,
      `${site.origin}/robots.txt robots-sitemap ${showcase.origin}/sitemap.xml -`,
      `${showcase.origin}/sitemap.xml sitemap-entry ${showcase.origin}/startups -`,
    ].toSorted(),
  );
  assert.equal(
    requests.filter((path) => path === '/robots.txt').length,
    once.filter((path) => path === '/robots.txt').length,
  );
});

test('a URL that a list names and that redirects names the URL it was redirected to, whose routes follow', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/old': { redirect: '/home' },
      '/home': '<a href="/startups">Startups</a>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/old">Company</a></main>`,
    })),
  );

  const lines = await routes(
    programs().crawl([`${list.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [new URLPattern(`${site.origin}/*`)],
      expand,
    }),
  );

  assert.deepEqual(
    lines,
    [
      ...listRoutes(`${list.origin}/programs`),
      `${list.origin}/programs list-item ${site.origin}/old Company`,
      `${site.origin}/old redirect ${site.origin}/home -`,
      `${site.origin}/home link ${site.origin}/startups Startups`,
      `${site.origin}/home robots ${site.origin}/robots.txt -`,
      `${site.origin}/robots.txt sitemap-guess ${site.origin}/sitemap.xml -`,
    ].toSorted(),
  );
});

test('a feed names each item with its title, and a sitemap names its pages and its child sitemaps without text', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/feed.xml': xml(
        `<rss><channel><item><title>Startup credits open</title><link>${site.origin}/credits</link></item></channel></rss>`,
      ),
      '/atom.xml': xml(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Founders &amp;amp; credits</title><link href="${site.origin}/founders"/></entry></feed>`,
      ),
      '/index.xml': xml(
        `<sitemapindex><sitemap><loc>${site.origin}/pages.xml</loc></sitemap></sitemapindex>`,
      ),
      '/pages.xml': xml(
        `<urlset><url><loc>${site.origin}/pricing</loc></url></urlset>`,
      ),
      '/credits': '<p>Credits.</p>',
      '/founders': '<p>Founders.</p>',
      '/pricing': '<p>Prices.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );

  const lines = await routes(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new ListingReader(),
    ]).crawl(
      [
        `${site.origin}/feed.xml`,
        `${site.origin}/atom.xml`,
        `${site.origin}/index.xml`,
      ],
      null,
      { signal: AbortSignal.timeout(5000) },
    ),
  );

  assert.deepEqual(
    lines,
    [
      `${site.origin}/feed.xml feed-item ${site.origin}/credits Startup credits open`,
      `${site.origin}/atom.xml feed-item ${site.origin}/founders Founders &amp; credits`,
      `${site.origin}/index.xml sitemap-index ${site.origin}/pages.xml -`,
      `${site.origin}/pages.xml sitemap-entry ${site.origin}/pricing -`,
    ].toSorted(),
  );
});

test('a list read again in a later crawl names a page that is known and not due, and the crawl does not download that page again', async () => {
  const requests: string[] = [];
  await using site = await new HttpServer().start(
    website(requests, () => ({
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/startups">Startups</a></main>`,
    })),
  );
  const crawler = programs(new FixedRevisit({ every: day }));
  const options = {
    signal: AbortSignal.timeout(5000),
    include: [new URLPattern(`${site.origin}/*`)] as const,
  };
  const first = crawler.crawl([`${list.origin}/programs`], null, options);
  await routes(first);
  const memento: unknown = JSON.parse(JSON.stringify(first.snapshot()));

  const lines = await routes(
    crawler.crawl([`${list.origin}/programs`], memento, options),
  );

  assert.ok(
    lines.includes(
      `${list.origin}/programs list-item ${site.origin}/startups Startups`,
    ),
    lines.join('\n'),
  );
  assert.equal(requests.filter((path) => path === '/startups').length, 1);
});

test('a crawl that stops after it hands back the routes of a list gives them again when it resumes', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/startups">Startups</a></main>`,
    })),
  );
  const crawler = programs();
  const options = {
    signal: AbortSignal.timeout(5000),
    include: [new URLPattern(`${site.origin}/*`)] as const,
  };
  const first = crawler.crawl([`${list.origin}/programs`], null, options);
  for await (const entry of first)
    if ('routes' in entry && entry.routes.length > 0) break;
  const memento: unknown = JSON.parse(JSON.stringify(first.snapshot()));

  const lines = await routes(
    crawler.crawl([`${list.origin}/programs`], memento, options),
  );

  assert.ok(
    lines.includes(
      `${list.origin}/programs list-item ${site.origin}/startups Startups`,
    ),
    lines.join('\n'),
  );
});

test('a failure says whether its URL is a page or a document, such as a broken sitemap', async () => {
  await using site = await new HttpServer().start((request, response) => {
    if (request.url === '/robots.txt')
      response
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(`Sitemap: http://${request.headers.host}/broken.xml`);
    else if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<p>Home.</p>');
    else response.writeHead(500).end();
  });
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a><a href="${site.origin}/startups">Startups</a></main>`,
    })),
  );

  const failures: [string, boolean][] = [];
  for await (const entry of programs().crawl(
    [`${list.origin}/programs`],
    null,
    {
      signal: AbortSignal.timeout(5000),
      include: [new URLPattern(`${site.origin}/*`)],
      expand,
    },
  ))
    if ('error' in entry)
      failures.push([new URL(entry.error.url).pathname, entry.error.page]);

  assert.deepEqual(failures.toSorted(), [
    ['/broken.xml', false],
    ['/startups', true],
  ]);
});

test('a page that LinkReader does not admit in a later crawl gives an incomplete group, which says that the page names more than its routes', async () => {
  let pages = '<a href="/listed">Listed</a>';
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': pages,
      '/first': '<p>First.</p>',
      '/listed': '<a href="/deep">Deep</a>',
      '/deep': '<p>Deep.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  // One admitted page for each crawl; every page is handed back, so a page
  // that LinkReader does not admit is still downloaded and read.
  const crawler = new WebCrawler(
    got.extend({ retry: { limit: 0 } }),
    [new LinkReader({ maxDepth: 2, maxPages: 1 })],
    new FixedRevisit({ every: 0 }),
  );
  const options = { signal: AbortSignal.timeout(5000) };
  // Each group of the crawl as "listing complete routes".
  const groups = async (crawl: Crawl) => {
    const lines: string[] = [];
    for await (const entry of crawl) {
      if ('error' in entry) throw entry.error;
      if ('routes' in entry)
        for (const { listingUrl, complete, routes } of entry.routes)
          lines.push(
            `${new URL(listingUrl).pathname} ${String(complete)} ${routes.map(({ url }) => new URL(url).pathname).join(',')}`,
          );
    }
    return lines.toSorted();
  };
  const first = crawler.crawl([`${site.origin}/`], null, options);
  assert.ok((await groups(first)).includes('/listed true /deep'));
  const memento: unknown = JSON.parse(JSON.stringify(first.snapshot()));
  // The home page now links another page first, which takes the budget.
  pages = '<a href="/first">First</a><a href="/listed">Listed</a>';

  const lines = await groups(
    crawler.crawl([`${site.origin}/`], memento, options),
  );

  assert.ok(lines.includes('/listed false '), lines.join('\n'));
});

test('a page that the crawl downloaded keeps its routes after the budget of LinkReader is spent', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': '<a href="/a">A</a>',
      '/a': '<a href="/b">B</a>',
      '/b': '<a href="/a">Back to A</a>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );

  const lines = await routes(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new LinkReader({ maxDepth: 2, maxPages: 2 }),
    ]).crawl([`${site.origin}/`], null, {
      signal: AbortSignal.timeout(5000),
      // No page is handed back: LinkReader admits each page that it reads.
      include: [new URLPattern({ pathname: '/none' })],
    }),
  );

  assert.ok(
    lines.includes(`${site.origin}/b link ${site.origin}/a Back to A`),
    lines.join('\n'),
  );
});
