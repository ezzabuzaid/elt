import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import type { Response } from 'got';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { ListingReader } from '@workspace/sdk-web-crawler';

import { RecordExtractor } from './record-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

// Two sections per page, each one record keyed by its own id.
class SectionExtractor extends RecordExtractor {
  readonly properties = {
    id: { type: 'string', description: 'Section id.' },
    heading: { type: 'string', description: 'Section heading.' },
  } as const;
  readonly #accept: string | null;
  constructor(accept: string | null) {
    super();
    this.#accept = accept;
  }
  open() {
    return {
      accept: this.#accept,
      async read(response: Response) {
        const path = new URL(response.url).pathname;
        return {
          fingerprint: null,
          async records() {
            return [1, 2].map((section) => ({
              id: `${path}#${section}`,
              heading: `${response.body} ${section}`,
            }));
          },
        };
      },
    };
  }
}

function sections(accept: string | null) {
  return new WebStream({
    name: 'sections',
    primaryKey: ['id'],
    readers: [new ListingReader()],
    extractor: new SectionExtractor(accept),
  });
}

async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'web',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: 'web:sections',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('every record an extractor returns for a page is stored with the page provenance', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/sitemap.xml')
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset><url><loc>http://${request.headers.host}/guide</loc><lastmod>2026-10-20</lastmod></url></urlset>`,
        );
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('Guide');
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${upstream.origin}/sitemap.xml`;
  const ingestion = await pipeline(
    new WebSource({
      stream: sections(null),
      inputs: [input],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  assert.equal((await ingestion.run())[0]?.count, 2);

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT inputUrl, pageUrl, listingUrl, lastModified, id, heading FROM sections ORDER BY id',
      )
      .all()
      .map((row) => ({ ...row })),
    [1, 2].map((section) => ({
      inputUrl: input,
      pageUrl: `${upstream.origin}/guide`,
      listingUrl: input,
      lastModified: '2026-10-20',
      id: `/guide#${section}`,
      heading: `Guide ${section}`,
    })),
  );
});

test('the discovered stream holds the provenance columns and the extractor properties under the input and stream keys', async () => {
  const stream = sections(null);
  const source = new WebSource({
    stream,
    inputs: ['https://example.com/'],
    pollIntervalMs: 60_000,
  });

  const discovered = (await source.discover()).get('sections');

  assert.deepEqual(Object.keys(discovered.jsonSchema.properties ?? {}), [
    'inputUrl',
    'pageUrl',
    'listingUrl',
    'lastModified',
    'id',
    'heading',
  ]);
  assert.deepEqual(discovered.jsonSchema.properties?.id, {
    type: 'string',
    description: 'Section id.',
  });
  assert.deepEqual(discovered.jsonSchema.required, [
    'inputUrl',
    'pageUrl',
    'listingUrl',
    'lastModified',
    'id',
    'heading',
  ]);
  assert.deepEqual(discovered.primaryKey, ['inputUrl', 'id']);
  assert.deepEqual(discovered.partitionKey, ['inputUrl']);
});

for (const accept of ['application/vnd.sections+json', null])
  test(`an extractor's ${accept === null ? 'null Accept leaves the client default' : 'Accept reaches only the pages handed back'}`, async () => {
    const accepts = new Map<string, string | undefined>();
    await using upstream = await new HttpServer().start((request, response) => {
      accepts.set(request.url ?? '/', request.headers.accept);
      if (request.url === '/sitemap.xml')
        response
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<urlset><url><loc>http://${request.headers.host}/guide</loc></url></urlset>`,
          );
      else
        response.writeHead(200, { 'content-type': 'text/plain' }).end('Guide');
    });
    await using database = await new Sqlite().database();
    await using checkpoints = await new Sqlite().database();
    const ingestion = await pipeline(
      new WebSource({
        stream: sections(accept),
        inputs: [`${upstream.origin}/sitemap.xml`],
        pollIntervalMs: 60_000,
      }),
      database.path,
      checkpoints.path,
    );

    await ingestion.run();

    assert.ok(accepts.has('/sitemap.xml'));
    assert.notEqual(
      accepts.get('/sitemap.xml'),
      'application/vnd.sections+json',
    );
    assert.equal(accepts.get('/guide'), accept ?? accepts.get('/sitemap.xml'));
  });
