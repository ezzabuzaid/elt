import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  ArchiveReader,
  type Crawl,
  LinkReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from './index.ts';

// As the startup-credits app: a list of programs links the home page of each
// company, and the program page is elsewhere on that website or on another one.
function programs(link: {
  readonly maxDepth: number;
  readonly maxPages: number;
}) {
  return new WebCrawler(got.extend({ retry: { limit: 0 } }), [
    new PaginationReader({ strategy: 'all' }),
    new ListingReader(),
    new LinkReader(link),
  ]);
}

const expand = [new URLPattern({ pathname: '*start*' })] as const;

// The URLs that a crawl hands back as pages; a failure fails the test.
async function handed(crawl: Crawl) {
  const urls: string[] = [];
  for await (const entry of crawl) {
    if ('error' in entry) throw entry.error;
    if ('response' in entry) urls.push(entry.url);
  }
  return urls.toSorted();
}

// A website that records the paths it is asked for and answers each path with
// its HTML, its own content type, or 404.
function website(
  requests: string[],
  paths: () => Record<string, string | { type: string; body: string }>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url ?? '');
    const answer = paths()[request.url ?? ''];
    if (answer === undefined) response.writeHead(404).end();
    else if (typeof answer === 'string')
      response.writeHead(200, { 'content-type': 'text/html' }).end(answer);
    else
      response.writeHead(200, { 'content-type': answer.type }).end(answer.body);
  };
}

const xml = (body: string) => ({ type: 'application/xml', body });

test('the home page that a list links on another website gives its links on every origin that match the expand patterns, and not the others', async () => {
  const third: string[] = [];
  await using elsewhere = await new HttpServer().start(
    website(third, () => ({
      '/cloud/start-ups': '<p>Akamai for start-ups.</p>',
      '/cloud/pricing': '<p>Prices.</p>',
    })),
  );
  const company: string[] = [];
  await using site = await new HttpServer().start(
    website(company, () => ({
      '/': `<nav><a href="/startups">Startups</a><a href="/pricing">Pricing</a></nav><a href="${elsewhere.origin}/cloud/start-ups">Start-ups</a><a href="${elsewhere.origin}/cloud/pricing">Cloud</a>`,
      '/startups': '<p>Credits.</p>',
      '/pricing': '<p>Prices.</p>',
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a></main>`,
    })),
  );

  const pages = await handed(
    programs({ maxDepth: 0, maxPages: 0 }).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(5000),
        include: [
          new URLPattern(`${site.origin}/*`),
          new URLPattern(`${elsewhere.origin}/*`),
        ],
        expand,
      },
    ),
  );

  assert.deepEqual(
    pages,
    [
      `${site.origin}/`,
      `${site.origin}/startups`,
      `${elsewhere.origin}/cloud/start-ups`,
    ].toSorted(),
  );
  assert.ok(!company.includes('/pricing'), company.join(' '));
  assert.ok(!third.includes('/cloud/pricing'), third.join(' '));
});

test('the sitemaps that the robots.txt of a linked home page declares give only the pages that match the expand patterns', async () => {
  const company: string[] = [];
  await using site = await new HttpServer().start(
    website(company, () => ({
      '/': '<p>A company.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/sitemap-index.xml`,
      },
      '/sitemap-index.xml': xml(
        `<sitemapindex><sitemap><loc>${site.origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      ),
      '/sitemap-pages.xml': xml(
        `<urlset><url><loc>${site.origin}/startup-program/</loc></url><url><loc>${site.origin}/blog/launch</loc></url></urlset>`,
      ),
      '/startup-program/': '<p>Credits.</p>',
      '/blog/launch': '<p>A post.</p>',
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a></main>`,
    })),
  );

  const pages = await handed(
    programs({ maxDepth: 0, maxPages: 0 }).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(5000),
        include: [new URLPattern(`${site.origin}/*`)],
        expand,
      },
    ),
  );

  assert.deepEqual(
    pages,
    [`${site.origin}/`, `${site.origin}/startup-program/`].toSorted(),
  );
  assert.ok(company.includes('/sitemap-pages.xml'), company.join(' '));
  assert.ok(!company.includes('/blog/launch'), company.join(' '));
});

test('a page that an expansion finds is not expanded again: its links and the sitemaps of its own website are not read', async () => {
  const third: string[] = [];
  await using elsewhere = await new HttpServer().start(
    website(third, () => ({
      '/start-ups': `<a href="/start-ups/apply">Apply</a>`,
      '/start-ups/apply': '<p>Apply.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${elsewhere.origin}/startup-sitemap.xml`,
      },
      '/startup-sitemap.xml': xml(
        `<urlset><url><loc>${elsewhere.origin}/startup-deep</loc></url></urlset>`,
      ),
    })),
  );
  const company: string[] = [];
  await using site = await new HttpServer().start(
    website(company, () => ({
      '/': `<a href="/startups">Startups</a><a href="${elsewhere.origin}/start-ups">Start-ups</a>`,
      '/startups': '<a href="/startups/apply">Apply</a>',
      '/startups/apply': '<p>Apply.</p>',
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a></main>`,
    })),
  );

  // LinkReader follows links three hops deep on the starting website, so a
  // website that the crawl expanded whole would give the apply pages.
  const pages = await handed(
    programs({ maxDepth: 3, maxPages: 100 }).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(5000),
        include: [
          new URLPattern(`${site.origin}/*`),
          new URLPattern(`${elsewhere.origin}/*`),
        ],
        expand,
      },
    ),
  );

  assert.deepEqual(
    pages,
    [
      `${site.origin}/`,
      `${site.origin}/startups`,
      `${elsewhere.origin}/start-ups`,
    ].toSorted(),
  );
  assert.ok(!company.includes('/startups/apply'), company.join(' '));
  assert.ok(!third.includes('/start-ups/apply'), third.join(' '));
  assert.ok(!third.includes('/startup-sitemap.xml'), third.join(' '));
});

test('a list that an expansion finds hands back only the pages that match, and expands none of them', async () => {
  const fourth: string[] = [];
  await using elsewhere = await new HttpServer().start(
    website(fourth, () => ({
      '/startup-hub': `<a href="/startups-apply">Apply</a>`,
      '/startups-apply': '<p>Apply.</p>',
    })),
  );
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': '<a rel="archives" href="/startups/2024/">2024</a>',
      '/startups/2024/': `<main><a href="/startups/one">One</a><a href="/blog/launch">Launch</a><a href="${elsewhere.origin}/startup-hub">Hub</a></main>`,
      '/startups/one': '<p>One.</p>',
      '/blog/launch': '<p>A post.</p>',
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a></main>`,
    })),
  );

  const pages = await handed(
    new WebCrawler(got.extend({ retry: { limit: 0 } }), [
      new PaginationReader({ strategy: 'all' }),
      new ArchiveReader(),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ]).crawl([`${list.origin}/programs`], null, {
      signal: AbortSignal.timeout(5000),
      include: [
        new URLPattern(`${site.origin}/*`),
        new URLPattern(`${elsewhere.origin}/*`),
      ],
      expand,
    }),
  );

  assert.deepEqual(
    pages,
    [
      `${site.origin}/`,
      // A link of the expanded page, and a list too.
      `${site.origin}/startups/2024/`,
      `${site.origin}/startups/one`,
      `${elsewhere.origin}/startup-hub`,
    ].toSorted(),
  );
  assert.ok(!fourth.includes('/startups-apply'), fourth.join(' '));
});

test('a page that a sitemap or a feed lists on another website is not expanded', async () => {
  const company: string[] = [];
  await using site = await new HttpServer().start(
    website(company, () => ({
      '/': '<a href="/startups">Startups</a>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/sitemap.xml`,
      },
      '/sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/startup-program/</loc></url></urlset>`,
      ),
      '/startup-program/': '<p>Credits.</p>',
    })),
  );
  await using listing = await new HttpServer().start(
    website([], () => ({
      '/sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/</loc></url></urlset>`,
      ),
      '/feed.xml': {
        type: 'application/rss+xml',
        body: `<rss><channel><item><link>${site.origin}/</link></item></channel></rss>`,
      },
    })),
  );

  for (const start of ['/sitemap.xml', '/feed.xml']) {
    company.length = 0;
    const pages = await handed(
      programs({ maxDepth: 0, maxPages: 0 }).crawl(
        [`${listing.origin}${start}`],
        null,
        {
          signal: AbortSignal.timeout(5000),
          include: [new URLPattern(`${site.origin}/*`)],
          expand,
        },
      ),
    );

    assert.deepEqual(pages, [`${site.origin}/`], start);
    assert.deepEqual(company, ['/robots.txt', '/'], start);
  }
});

test('a page that a sitemap and a list both name is expanded, whether the sitemap names it before or after its download', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': '<a href="/startups">Startups</a>',
      '/startups': '<p>Credits.</p>',
    })),
  );
  // The sitemap names the home page first. The first page of the list names
  // it while it is pending; the second page names it after its download.
  for (const [later, firstPage] of [
    ['first page', `<main><a href="${site.origin}/">Company</a></main>`],
    ['second page', '<link rel="next" href="/programs?page=2">'],
  ] as const) {
    await using list = await new HttpServer().start(
      website([], () => ({
        '/sitemap.xml': xml(
          `<urlset><url><loc>${site.origin}/</loc></url></urlset>`,
        ),
        '/programs': firstPage,
        '/programs?page=2': `<main><a href="${site.origin}/">Company</a></main>`,
      })),
    );

    const pages = await handed(
      programs({ maxDepth: 0, maxPages: 0 }).crawl(
        [`${list.origin}/sitemap.xml`, `${list.origin}/programs`],
        null,
        {
          signal: AbortSignal.timeout(5000),
          include: [new URLPattern(`${site.origin}/*`)],
          expand,
        },
      ),
    );

    assert.deepEqual(
      pages,
      [`${site.origin}/`, `${site.origin}/startups`],
      later,
    );
  }
});

test('without expand patterns, the home page that a list links on another website is handed back and not expanded', async () => {
  const company: string[] = [];
  await using site = await new HttpServer().start(
    website(company, () => ({
      '/': '<a href="/startups">Startups</a>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/sitemap.xml`,
      },
      '/sitemap.xml': xml(
        `<urlset><url><loc>${site.origin}/startup-program/</loc></url></urlset>`,
      ),
    })),
  );
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<main><a href="${site.origin}/">Company</a></main>`,
    })),
  );

  const pages = await handed(
    programs({ maxDepth: 3, maxPages: 100 }).crawl(
      [`${list.origin}/programs`],
      null,
      {
        signal: AbortSignal.timeout(5000),
        include: [new URLPattern(`${site.origin}/*`)],
      },
    ),
  );

  assert.deepEqual(pages, [`${site.origin}/`]);
  assert.deepEqual(company, ['/robots.txt', '/']);
});

test('a crawl stopped at any entry and resumed from its snapshot expands the same pages, and still not the pages of the starting website', async () => {
  await using site = await new HttpServer().start(
    website([], () => ({
      '/': '<a href="/startups">Startups</a>',
      '/startups': '<p>Credits.</p>',
      '/startups-from-own': '<p>Credits.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/sitemap-index.xml`,
      },
      '/sitemap-index.xml': xml(
        `<sitemapindex><sitemap><loc>${site.origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      ),
      '/sitemap-pages.xml': xml(
        `<urlset><url><loc>${site.origin}/startup-program/</loc></url><url><loc>${site.origin}/blog/launch</loc></url></urlset>`,
      ),
      '/startup-program/': '<p>Credits.</p>',
      '/blog/launch': '<p>A post.</p>',
    })),
  );
  // The second page of the list links a page of the list's own website,
  // which a crawl that forgot its starting origins would expand: its link to
  // the company would then come back.
  await using list = await new HttpServer().start(
    website([], () => ({
      '/programs': `<link rel="next" href="/programs?page=2"><main><a href="${site.origin}/">Company</a></main>`,
      '/programs?page=2': '<main><a href="/own">Own</a></main>',
      '/own': `<a href="${site.origin}/startups-from-own">Startups</a>`,
    })),
  );
  const crawler = programs({ maxDepth: 0, maxPages: 0 });
  const options = {
    include: [
      new URLPattern(`${site.origin}/*`),
      new URLPattern(`${list.origin}/own`),
    ],
    expand,
  } as const;
  const expected = [
    `${site.origin}/`,
    `${site.origin}/startups`,
    `${site.origin}/startup-program/`,
    `${list.origin}/own`,
  ].toSorted();
  const whole = await handed(
    crawler.crawl([`${list.origin}/programs`], null, {
      ...options,
      signal: AbortSignal.timeout(5000),
    }),
  );
  assert.deepEqual(whole, expected);

  // One stop after each entry, until a crawl ends before its stop, so a
  // snapshot holds each URL pending once.
  for (let stop = 1, stopped = true; stopped; stop++) {
    const first = crawler.crawl([`${list.origin}/programs`], null, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    const pages = new Set<string>();
    let seen = 0;
    stopped = false;
    for await (const entry of first) {
      if ('response' in entry) pages.add(entry.url);
      if (++seen === stop) {
        stopped = true;
        break;
      }
    }
    const snapshot: unknown = JSON.parse(JSON.stringify(first.snapshot()));
    for (const url of await handed(
      crawler.crawl([], snapshot, {
        ...options,
        signal: AbortSignal.timeout(5000),
      }),
    ))
      pages.add(url);

    assert.deepEqual([...pages].toSorted(), expected, `stop ${stop}`);
  }
});
