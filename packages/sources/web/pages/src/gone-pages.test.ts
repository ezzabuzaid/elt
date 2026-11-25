import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import type { Response } from 'got';

import { Connection, Copy, Pipeline, PipelineError } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import {
  AlwaysRevisit,
  FixedRevisit,
  ListingReader,
  type RevisitPolicy,
  hour,
} from '@eltjs/sdk-web-crawler';

import { RecordExtractor } from './record-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

// The records that a page names in its body, "a,b", each keyed by the page
// and its name, so a page can give fewer records than before.
class NamedRecords extends RecordExtractor {
  readonly properties = {
    id: { type: 'string', description: 'The path of the page and the name.' },
  } as const;
  open() {
    return {
      negotiation: null,
      async read(response: Response) {
        const path = new URL(response.url).pathname;
        const body = new TextDecoder().decode(response.rawBody);
        return {
          fingerprint: null,
          async records() {
            return body.split(',').map((name) => ({ id: `${path}#${name}` }));
          },
        };
      },
    };
  }
}

// A shop with no robots.txt whose sitemap lists the paths of `listed`. Each
// path of `pages` answers its records, or the status that stands in their
// place.
type Site = { listed: string[]; pages: Record<string, string | number> };

function shop(site: Site) {
  return new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const page = site.pages[url.pathname];
    if (url.pathname === '/sitemap.xml') {
      response.setHeader('content-type', 'application/xml');
      response.end(
        `<urlset>${site.listed.map((path) => `<url><loc>${url.origin}${path}</loc></url>`).join('')}</urlset>`,
      );
    } else if (typeof page === 'string') {
      response.setHeader('content-type', 'text/plain');
      response.end(page);
    } else response.writeHead(page ?? 404).end();
  });
}

// Each run reads the shop's sitemap with a new source, as a host that starts
// again does, into one destination with incremental copies.
// The stream's revisit policy and include patterns are read at each run, so a
// test can change what the host selects between runs.
async function runs(
  origin: string,
  stream: {
    readonly revisit?: RevisitPolicy<unknown>;
    include?: readonly [URLPattern, ...URLPattern[]];
  } = {},
) {
  const resources = new AsyncDisposableStack();
  const cache = resources.use(
    await new TemporaryFiles().directory('web-cache-'),
  );
  const database = resources.use(await new Sqlite().database());
  const checkpoints = resources.use(await new Sqlite().database());
  const source = () =>
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'pages',
            primaryKey: ['id'],
            readers: [new ListingReader()],
            revisit: stream.revisit ?? new AlwaysRevisit(),
            ...(stream.include === undefined
              ? {}
              : { include: stream.include }),
            extractor: new NamedRecords(),
          }),
          inputs: [`${origin}/sitemap.xml`],
        },
      ],
    });
  return {
    async run() {
      const web = source();
      const destination = new SQLiteDestination({ path: database.path });
      const pipeline = new Pipeline({
        clock: globalThis,
        history: new SQLiteSyncHistory(),
        connections: [
          new Connection({
            name: 'web',
            source: web,
            destination,
            checkpoints: new SQLiteCheckpointStore({ path: checkpoints.path }),
            steps: (await web.discover()).streams.map(
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
      await pipeline.run();
    },
    rows() {
      return database.connection
        .prepare('SELECT id FROM pages ORDER BY id')
        .all()
        .map((row) => String(row.id));
    },
    failures() {
      return database.connection
        .prepare('SELECT url FROM pages_failures ORDER BY url')
        .all()
        .map((row) => new URL(String(row.url)).pathname);
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

test('a page that the sitemap lists and that answers 404 or 410 is no failure: the run that finds it gone ends without error, deletes every row the page gave and keeps the rows of the other pages, and the page is no row of the failures stream', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2', '/p/3'],
    pages: { '/p/1': 'a,b', '/p/2': 'c', '/p/3': 'd' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.pages['/p/1'] = 404;
  site.pages['/p/2'] = 410;

  await web.run();

  assert.deepEqual(
    { rows: web.rows(), failures: web.failures() },
    { rows: ['/p/3#d'], failures: [] },
  );
});

test('a page read again with fewer records has the row of the record it no longer gives deleted, and the rows it still gives stay', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a,b', '/p/2': 'c' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.pages['/p/1'] = 'a';

  await web.run();

  assert.deepEqual(web.rows(), ['/p/1#a', '/p/2#c']);
});

test('a page that only left its listings is still a page the crawl knows: it keeps its rows while it answers, and loses them once it answers 404', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a', '/p/2': 'b' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.listed = ['/p/2'];
  const rows = [];

  await web.run();
  rows.push(web.rows());
  site.pages['/p/1'] = 404;
  await web.run();
  rows.push(web.rows());

  assert.deepEqual(rows, [['/p/1#a', '/p/2#b'], ['/p/2#b']]);
});
test('a gone page that answers again later is stored again', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a', '/p/2': 'b' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.pages['/p/1'] = 404;
  await web.run();
  const gone = web.rows();
  site.pages['/p/1'] = 'a';

  await web.run();

  assert.deepEqual(
    { gone, back: web.rows() },
    { gone: ['/p/2#b'], back: ['/p/1#a', '/p/2#b'] },
  );
});

test('a page that fails once keeps its rows through that run, and when it answers again with fewer records, the row of the record it no longer gives is deleted', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a,b', '/p/2': 'c' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.pages['/p/1'] = 503;
  await assert.rejects(web.run(), PipelineError);
  const failed = web.rows();
  site.pages['/p/1'] = 'a';

  await web.run();

  assert.deepEqual(
    { failed, answered: web.rows() },
    {
      failed: ['/p/1#a', '/p/1#b', '/p/2#c'],
      answered: ['/p/1#a', '/p/2#c'],
    },
  );
});

test('a page whose visits fail three times in a row keeps its rows through the first two failures and has them deleted in the run of the third, which finds it gone', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a', '/p/2': 'b' },
  };
  await using upstream = await shop(site);
  await using web = await runs(upstream.origin);
  await web.run();
  site.pages['/p/1'] = 503;
  const rows = [];

  for (const failed of [true, true, false]) {
    if (failed) await assert.rejects(web.run(), PipelineError);
    else await web.run();
    rows.push(web.rows());
  }

  assert.deepEqual(rows, [
    ['/p/1#a', '/p/2#b'],
    ['/p/1#a', '/p/2#b'],
    ['/p/2#b'],
  ]);
});

test('a failed page that a run does not request, because its retry is not due, keeps its rows, and a later visit that finds it gone deletes them', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a', '/p/2': 'b' },
  };
  await using upstream = await shop(site);
  // Pages that answered are due at once; a failed one waits two hours.
  await using web = await runs(upstream.origin, {
    revisit: new FixedRevisit({ every: 0 }),
  });
  await web.run();
  site.pages['/p/1'] = 503;
  await assert.rejects(web.run(), PipelineError);
  const rows = [];

  t.mock.timers.setTime(Date.now() + hour);
  await web.run();
  rows.push(web.rows());
  site.pages['/p/1'] = 404;
  t.mock.timers.setTime(Date.now() + 2 * hour);
  await web.run();
  rows.push(web.rows());

  assert.deepEqual(rows, [['/p/1#a', '/p/2#b'], ['/p/2#b']]);
});

test('a page that the host no longer selects keeps its rows', async () => {
  const site: Site = {
    listed: ['/p/1', '/p/2'],
    pages: { '/p/1': 'a', '/p/2': 'b' },
  };
  await using upstream = await shop(site);
  const stream: { include: readonly [URLPattern, ...URLPattern[]] } = {
    include: [new URLPattern({ pathname: '/p/*' })],
  };
  await using web = await runs(upstream.origin, stream);
  await web.run();
  stream.include = [new URLPattern({ pathname: '/p/2' })];

  await web.run();

  assert.deepEqual(web.rows(), ['/p/1#a', '/p/2#b']);
});
