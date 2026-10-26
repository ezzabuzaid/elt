import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { type ExtractorRun } from '@workspace/source-web-pages/record-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { listings } from './listings.ts';
import { OpenSooqExtractor } from './opensooq-extractor.ts';

// Trimmed copies of the JSON-LD objects a live listing page embeds; only the listing object carries the listing's sku.
function listingPage(
  id: number,
  page: { ad: string; price: string },
  offers: boolean,
) {
  const objects = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'OpenSooq',
      url: 'https://jo.opensooq.com',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Motorcycles' },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Is the price negotiable?' }],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Motorcycle',
      name: `TARO RANGER 401cc ${id}`,
      sku: id,
      description: 'Brand new, with warranty.',
      url: `http://jo.opensooq.com/en/search/${id}`,
      category: 'Category',
      image: {
        '@type': 'ImageObject',
        caption: 'TARO RANGER',
        width: 700,
        height: 480,
        contentUrl: `https://opensooq-imagesv2.os-cdn.com/previews/700x0/${id}.webp`,
        contentLocation: 'Amman, Jordan',
        uploadDate: '25-10-2026',
        datePublished: '25-10-2026',
      },
      itemCondition: 'https://schema.org/NewCondition',
      ...(offers
        ? {
            offers: {
              '@type': 'Offer',
              url: `http://jo.opensooq.com/en/search/${id}`,
              description: 'Brand new, with warranty.',
              availability: 'https://schema.org/InStock',
              price: page.price,
              priceCurrency: 'JOD',
              priceValidUntil: '2026-10-29',
            },
          }
        : {}),
    },
  ];
  return `<html><head>${objects
    .map(
      (object) =>
        `<script type="application/ld+json">${JSON.stringify(object)}</script>`,
    )
    .join(
      '',
    )}</head><body><div class="ad">${page.ad}</div><h1>TARO RANGER</h1></body></html>`;
}

// A category with two listing pages: page 1 links two listings and rel="next" to page 2, which links one more.
async function market(page: { ad: string; price: string }) {
  return new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const listing = /^\/en\/search\/(\d+)$/.exec(url.pathname);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (
      url.pathname === '/en/cars/motorcycles' &&
      !url.searchParams.has('page')
    )
      response.end(
        '<html><head><link rel="next" href="/en/cars/motorcycles?page=2"></head><body><main><a href="/en/search/287909010">First</a><a href="/en/search/287909011">Second</a></main><a href="/en/cars/motorcycles?page=2">2</a></body></html>',
      );
    else if (
      url.pathname === '/en/cars/motorcycles' &&
      url.searchParams.get('page') === '2'
    )
      response.end(
        '<html><body><main><a href="/en/search/287909012">Third</a></main><a href="/en/cars/motorcycles">1</a></body></html>',
      );
    else if (listing)
      response.end(
        listingPage(Number(listing[1]), page, listing[1] !== '287909012'),
      );
    else response.writeHead(404).end();
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
        name: 'opensooq',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: 'opensooq:listings',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('every listing of a paginated category is stored with its JSON-LD fields', async () => {
  await using upstream = await market({ ad: 'Sponsored', price: '4499' });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  assert.equal((await ingestion.run())[0]?.count, 3);

  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010', '287909011', '287909012'],
  );
  const row = database.connection
    .prepare(
      "SELECT id, title, description, url, type, price, currency, location, imageUrls, condition, availability, publishedAt FROM opensooq_listings WHERE id = '287909010'",
    )
    .get();
  assert.deepEqual(
    { ...row, imageUrls: JSON.parse(String(row?.imageUrls)) },
    {
      id: '287909010',
      title: 'TARO RANGER 401cc 287909010',
      description: 'Brand new, with warranty.',
      url: `${upstream.origin}/en/search/287909010`,
      type: 'Motorcycle',
      price: 4499,
      currency: 'JOD',
      location: 'Amman, Jordan',
      imageUrls: [
        'https://opensooq-imagesv2.os-cdn.com/previews/700x0/287909010.webp',
      ],
      condition: 'https://schema.org/NewCondition',
      availability: 'https://schema.org/InStock',
      publishedAt: '25-10-2026',
    },
  );
});

test('a listing without an offer stores no price and no currency', async () => {
  await using upstream = await market({ ad: 'Sponsored', price: '4499' });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    {
      ...database.connection
        .prepare(
          "SELECT price, currency, availability FROM opensooq_listings WHERE id = '287909012'",
        )
        .get(),
    },
    { price: null, currency: null, availability: null },
  );
});

test('an unchanged rerun writes nothing', async () => {
  await using upstream = await market({ ad: 'Sponsored', price: '4499' });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 3);

  const rerun = await ingestion.run();

  assert.equal(rerun[0]?.count, 0);
});

// Counts the pages whose records are extracted, which the destination cannot show: an unchanged record writes nothing either way.
class CountedExtractor extends OpenSooqExtractor {
  extractions = 0;
  override open(): ExtractorRun {
    const run = super.open();
    return {
      accept: run.accept,
      read: async (response, signal) => {
        const output = await run.read(response, signal);
        return {
          fingerprint: output.fingerprint,
          records: () => {
            this.extractions++;
            return output.records();
          },
        };
      },
    };
  }
}

test('a listing page whose markup changes outside its JSON-LD is not extracted again', async () => {
  const page = { ad: 'Sponsored: helmets', price: '4499' };
  await using upstream = await market(page);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const extractor = new CountedExtractor();
  const ingestion = await pipeline(
    new WebSource({
      stream: new WebStream({
        name: listings.name,
        primaryKey: listings.primaryKey,
        readers: listings.readers,
        include: listings.include,
        extractor,
      }),
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 3);
  assert.equal(extractor.extractions, 3);
  page.ad = 'Sponsored: gloves';

  const rerun = await ingestion.run();

  assert.equal(rerun[0]?.count, 0);
  assert.equal(extractor.extractions, 3);
});

test('a listing whose JSON-LD changes is written again with the new values', async () => {
  const page = { ad: 'Sponsored', price: '4499' };
  await using upstream = await market(page);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );
  assert.equal((await ingestion.run())[0]?.count, 3);
  page.price = '4299';

  const rerun = await ingestion.run();

  assert.equal(rerun[0]?.count, 2);
  assert.deepEqual(
    database.connection
      .prepare('SELECT id, price FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: '287909010', price: 4299 },
      { id: '287909011', price: 4299 },
      { id: '287909012', price: null },
    ],
  );
});

test('the listing stored is the JSON-LD object whose sku is the id in the page URL', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/en/cars/motorcycles')
      response.end(
        '<html><head><link rel="next" href="/en/cars/motorcycles?page=2"></head><body><main><a href="/en/search/287909020">Listing</a></main></body></html>',
      );
    else if (request.url === '/en/search/287909020')
      response.end(
        // Another listing's object comes first, as a related ad would.
        listingPage(
          287909020,
          { ad: 'Sponsored', price: '4499' },
          true,
        ).replace(
          '<head>',
          `<head><script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Motorcycle',
            name: 'Related ad',
            sku: 287909099,
            description: 'Another listing.',
            image: {
              contentUrl:
                'https://opensooq-imagesv2.os-cdn.com/previews/700x0/287909099.webp',
            },
          })}</script>`,
        ),
      );
    else response.writeHead(404).end();
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT id, title FROM opensooq_listings')
      .all()
      .map((row) => ({ ...row })),
    [{ id: '287909020', title: 'TARO RANGER 401cc 287909020' }],
  );
});
