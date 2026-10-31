import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import type { Response } from 'got';
import { z } from 'zod';

import {
  Connection,
  Copy,
  CopyConfiguration,
  Pipeline,
  PipelineError,
  StreamStatus,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  AlwaysRevisit,
  CrawlError,
  FixedRevisit,
  LinkReader,
  ListingReader,
  PaginationReader,
  day,
} from '@workspace/sdk-web-crawler';

import { RecordExtractor } from './record-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

// One record for each page: its path.
class PathExtractor extends RecordExtractor {
  readonly properties = {
    path: { type: 'string', description: 'The path of the page.' },
  } as const;
  open() {
    return {
      negotiation: null,
      async read(response: Response) {
        return {
          fingerprint: null,
          async records() {
            return [{ path: new URL(response.url).pathname }];
          },
        };
      },
    };
  }
}

// As the startup-credits app: each list hands back the pages it links on
// every website, and a linked page on another website is searched one step.
function programs(include: string, revisit?: FixedRevisit) {
  return new WebStream({
    name: 'programs',
    primaryKey: ['path'],
    readers: [
      new PaginationReader({ strategy: 'all' }),
      new ListingReader(),
      new LinkReader({ maxDepth: 0, maxPages: 0 }),
    ],
    expand: [new URLPattern({ pathname: '*startup*' })],
    include: [new URLPattern(`${include}/*`)],
    ...(revisit === undefined ? {} : { revisit }),
    extractor: new PathExtractor(),
  });
}

// A website that answers each path with its HTML, its own content type, or 404.
function website(
  paths: () => Record<string, string | { type: string; body: string }>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const answer = paths()[request.url ?? ''];
    if (answer === undefined) response.writeHead(404).end();
    else if (typeof answer === 'string')
      response.writeHead(200, { 'content-type': 'text/html' }).end(answer);
    else
      response.writeHead(200, { 'content-type': answer.type }).end(answer.body);
  };
}

// The host may list the routes stream's copy before its web stream's.
async function pipeline(
  source: WebSource,
  path: string,
  checkpoints: string,
  routesFirst: boolean,
) {
  const destination = new SQLiteDestination({ path });
  const { streams } = await source.discover();
  return new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (routesFirst ? streams.toReversed() : streams).map(
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

test('the routes stream stores each URL a listing named, so a walk from the home page that a list links reaches the program page that its menu and its robots.txt sitemap name', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using site = await new HttpServer().start(
    website(() => ({
      '/': '<nav><a href="/startups">Startups</a><a href="/pricing">Pricing</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${site.origin}/crawled-sitemap.xml`,
      },
      '/crawled-sitemap.xml': {
        type: 'application/xml',
        body: `<urlset><url><loc>${site.origin}/startups</loc></url></urlset>`,
      },
    })),
  );
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}/">Vercel for Startups</a></main>`,
    })),
  );
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${list.origin}/programs`;
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: programs(site.origin), inputs: [input] }],
    }),
    database.path,
    checkpoints.path,
    false,
  );

  await ingestion.run();

  assert.deepEqual(
    routes(database.connection),
    [
      `${input} | ${input} | list-item | ${site.origin}/ | Vercel for Startups`,
      `${input} | ${input} | robots | ${list.origin}/robots.txt | -`,
      `${input} | ${list.origin}/robots.txt | sitemap-guess | ${list.origin}/sitemap.xml | -`,
      `${input} | ${site.origin}/ | link | ${site.origin}/startups | Startups`,
      `${input} | ${site.origin}/ | robots | ${site.origin}/robots.txt | -`,
      `${input} | ${site.origin}/crawled-sitemap.xml | sitemap-entry | ${site.origin}/startups | -`,
      `${input} | ${site.origin}/robots.txt | robots-sitemap | ${site.origin}/crawled-sitemap.xml | -`,
    ].toSorted(),
  );
  // The program page's record names only the listing that supplied it first,
  // the sitemap, as the crawl reads listings before pages.
  assert.deepEqual(
    database.connection
      .prepare("SELECT listingUrl FROM programs WHERE path = '/startups'")
      .all()
      .map((row) => row.listingUrl),
    [`${site.origin}/crawled-sitemap.xml`],
  );
});

test('a list that links the program page and the home page keeps both routes to the program page, in the same run when the routes copy comes first', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using site = await new HttpServer().start(
    website(() => ({
      '/': '<nav><a href="/startups">Startups</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}/">Vercel</a><a href="${site.origin}/startups">Vercel for Startups</a></main>`,
    })),
  );
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${list.origin}/programs`;
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: programs(site.origin), inputs: [input] }],
    }),
    database.path,
    checkpoints.path,
    true,
  );

  await ingestion.run();

  assert.deepEqual(
    routes(database.connection).filter(
      (line) => line.split(' | ')[3] === `${site.origin}/startups`,
    ),
    [
      `${input} | ${input} | list-item | ${site.origin}/startups | Vercel for Startups`,
      `${input} | ${site.origin}/ | link | ${site.origin}/startups | Startups`,
    ].toSorted(),
  );
});

test('a list read again replaces its routes, and a listing that the run does not read keeps its rows', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  let programPages = ['/startups', '/startup-credits'];
  await using site = await new HttpServer().start(
    website(() => ({
      '/': '<nav><a href="/startups">Startups</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/startup-credits': '<p>More credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}/">Vercel</a>${programPages.map((path) => `<a href="${site.origin}${path}">${path}</a>`).join('')}</main>`,
    })),
  );
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${list.origin}/programs`;
  // The list is a starting URL, read in every crawl; the pages of the
  // website are due again only the next day.
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: programs(site.origin, new FixedRevisit({ every: day })),
          inputs: [input],
        },
      ],
    }),
    database.path,
    checkpoints.path,
    false,
  );
  await ingestion.run();
  const before = routes(database.connection);
  programPages = ['/startups'];

  await ingestion.run();

  assert.deepEqual(
    routes(database.connection),
    before.filter(
      (line) =>
        !line.includes(
          `| ${input} | list-item | ${site.origin}/startup-credits |`,
        ),
    ),
  );
  assert.ok(
    before.includes(
      `${input} | ${site.origin}/ | link | ${site.origin}/startups | Startups`,
    ),
    before.join('\n'),
  );
});

// One read as the engine runs it, which keeps each stream's last state in
// states; stop ends it once the web stream has ended, as a process that
// stops there. It gives the routes that the read loaded, "listing how url".
async function read(
  source: WebSource,
  states: Map<string, unknown>,
  stop: boolean,
) {
  const catalog = (await source.discover()).streams.map(
    (stream) =>
      new CopyConfiguration(stream, {
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      }),
  );
  const records: string[] = [];
  for await (const message of source.read(catalog, states)) {
    if (message instanceof StreamStatus) {
      assert.notEqual(message.status, 'FAILED', String(message.error));
      if (stop && message.stream === 'programs' && message.status === 'ENDED')
        break;
    } else if ('type' in message) {
      if (message.type === 'STATE') states.set(message.stream, message.state);
    } else if (message.stream === 'programs_routes') {
      const { listingUrl, how, url } = route.parse(message.data);
      records.push(`${listingUrl} ${how} ${url}`);
    }
  }
  return records;
}

test('a run that stops after the web stream commits its crawl and before the routes stream commits gives those routes in the next run', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using site = await new HttpServer().start(
    website(() => ({
      '/': '<nav><a href="/startups">Startups</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}/">Vercel</a></main>`,
    })),
  );
  // The home page is due again only the next day, so the next run reads
  // only the list, and the routes of the home page come from the state.
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: programs(site.origin, new FixedRevisit({ every: day })),
        inputs: [`${list.origin}/programs`],
      },
    ],
  };
  const states = new Map<string, unknown>();
  assert.deepEqual(await read(new WebSource(options), states, true), []);

  const records = await read(new WebSource(options), states, false);

  assert.ok(
    records.includes(`${site.origin}/ link ${site.origin}/startups`),
    records.join('\n'),
  );
});

test('the state of the web stream drops the routes that the routes stream committed, also when each run is a new process', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using site = await new HttpServer().start(
    website(() => ({
      '/startups': '<p>Credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}/startups">Startups</a></main>`,
    })),
  );
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      { stream: programs(site.origin), inputs: [`${list.origin}/programs`] },
    ],
  };
  const states = new Map<string, unknown>();
  // The numbers of the groups of routes that the web stream's state holds.
  const held = () =>
    outbox
      .parse(states.get('programs'))
      .partitions.flatMap(({ state }) => state.outbox.map(({ seq }) => seq));
  await read(new WebSource(options), states, false);
  await read(new WebSource(options), states, false);
  const second = held();

  await read(new WebSource(options), states, false);

  // Only the groups of the last run, which its routes stream committed but
  // which the next run leaves out.
  const third = held();
  assert.ok(second.length > 0 && third.length > 0);
  assert.ok(Math.min(...third) > Math.max(...second), JSON.stringify(third));
});

test('a web stream whose state starts over numbers its routes after those the routes stream committed, so a run that stops before they are committed loses none', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using site = await new HttpServer().start(
    website(() => ({
      '/': '<nav><a href="/startups">Startups</a></nav>',
      '/other': '<nav><a href="/startup-credits">Credits</a></nav>',
      '/startups': '<p>Credits.</p>',
      '/startup-credits': '<p>More credits.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  let home = '/';
  await using list = await new HttpServer().start(
    website(() => ({
      '/programs': `<main><a href="${site.origin}${home}">Company</a></main>`,
    })),
  );
  const options = {
    cachePath: join(cache.path, 'web-http.sqlite'),
    userAgent: 'elt-test/1.0',
    streams: [
      {
        stream: programs(site.origin, new FixedRevisit({ every: day })),
        inputs: [`${list.origin}/programs`],
      },
    ],
  };
  const states = new Map<string, unknown>();
  await read(new WebSource(options), states, false);
  // The web stream starts over, as after its checkpoint is removed, and the
  // run stops before the routes stream commits.
  states.delete('programs');
  home = '/other';
  await read(new WebSource(options), states, true);

  const records = await read(new WebSource(options), states, false);

  assert.ok(
    records.includes(
      `${site.origin}/other link ${site.origin}/startup-credits`,
    ),
    records.join('\n'),
  );
});

test('a page that LinkReader does not admit in a later run keeps the routes of its earlier read', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  let links = '<a href="/listed">Listed</a>';
  await using site = await new HttpServer().start(
    website(() => ({
      '/': links,
      '/first': '<p>First.</p>',
      '/listed': '<a href="/deep">Deep</a>',
      '/deep': '<p>Deep.</p>',
      '/robots.txt': { type: 'text/plain', body: '' },
    })),
  );
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${site.origin}/`;
  // One admitted page for each crawl, and every page every crawl.
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'programs',
            primaryKey: ['path'],
            readers: [new LinkReader({ maxDepth: 2, maxPages: 1 })],
            revisit: new AlwaysRevisit(),
            extractor: new PathExtractor(),
          }),
          inputs: [input],
        },
      ],
    }),
    database.path,
    checkpoints.path,
    false,
  );
  await ingestion.run();
  const deep = `${input} | ${site.origin}/listed | link | ${site.origin}/deep | Deep`;
  assert.ok(routes(database.connection).includes(deep));
  // The home page now links another page first, which takes the budget.
  links = '<a href="/first">First</a><a href="/listed">Listed</a>';

  await ingestion.run();

  assert.ok(
    routes(database.connection).includes(deep),
    routes(database.connection).join('\n'),
  );
});

test('a failure that the source reports says whether it is a page, so a host can leave out a broken sitemap', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
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
    website(() => ({
      '/programs': `<main><a href="${site.origin}/">Company</a><a href="${site.origin}/startups">Startups</a></main>`,
    })),
  );
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: programs(site.origin),
          inputs: [`${list.origin}/programs`],
        },
      ],
    }),
    database.path,
    checkpoints.path,
    false,
  );

  await assert.rejects(ingestion.run(), (error) => {
    assert(error instanceof PipelineError);
    const failure = error.results[0]?.failures[0]?.error;
    assert(failure instanceof AggregateError);
    assert.deepEqual(
      failure.errors.map((reason) => {
        assert(reason instanceof CrawlError);
        return [new URL(reason.url).pathname, reason.page];
      }),
      [
        ['/startups', true],
        ['/broken.xml', false],
      ].toSorted(),
    );
    return true;
  });
});

const route = z.object({
  listingUrl: z.string(),
  how: z.string(),
  url: z.string(),
});

// The routes that the web stream's state holds, which only these tests read.
const outbox = z.object({
  partitions: z.array(
    z.object({
      state: z.object({ outbox: z.array(z.object({ seq: z.number() })) }),
    }),
  ),
});

// The stored routes, one line each, "input | listing | how | url | text", in order.
function routes(connection: DatabaseSync) {
  return connection
    .prepare(
      'SELECT inputUrl, listingUrl, how, url, text FROM programs_routes ORDER BY listingUrl, url',
    )
    .all()
    .map(
      (row) =>
        `${String(row.inputUrl)} | ${String(row.listingUrl)} | ${String(row.how)} | ${String(row.url)} | ${row.text === null ? '-' : String(row.text)}`,
    )
    .toSorted();
}
