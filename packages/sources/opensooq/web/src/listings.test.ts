import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
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

// Trimmed copies of the listing objects live listing pages embedded on 2026-10-26, one per schema.org shape OpenSooq uses.
function offer(price: string) {
  return {
    '@type': 'Offer',
    availability: 'https://schema.org/InStock',
    price,
    priceCurrency: 'JOD',
    priceValidUntil: '2026-10-29',
  };
}

// Category Motorcycles.
function motorcycle(id: string, price: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Motorcycle',
    name: `TARO RANGER 401cc ${id}`,
    sku: Number(id),
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
    offers: {
      ...offer(price),
      url: `http://jo.opensooq.com/en/search/${id}`,
      description: 'Brand new, with warranty.',
    },
  };
}

// Categories Pets and Fashion: no image.datePublished, no itemCondition.
function product(id: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Persian kittens',
    sku: Number(id),
    description: 'Two months old, vaccinated.',
    url: `http://jo.opensooq.com/en/search/${id}`,
    image: {
      '@type': 'ImageObject',
      contentUrl: `https://opensooq-imagesv2.os-cdn.com/previews/700x0/${id}.webp`,
      contentLocation: 'Zarqa, Jordan',
    },
    offers: offer('80'),
  };
}

// Category Property: no sku, no description, the image under photo.
function residence(id: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Residence',
    name: 'Apartment for rent in Al Rahebat Al Wardiah',
    url: `http://jo.opensooq.com/en/search/${id}`,
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'Jordan',
      addressRegion: 'Irbid',
      addressLocality: 'Al Rahebat Al Wardiah',
    },
    numberOfRooms: 0,
    photo: {
      '@type': 'ImageObject',
      caption: 'Apartment',
      width: 700,
      height: 480,
      contentUrl: `https://opensooq-imagesv2.os-cdn.com/previews/700x0/${id}.webp`,
      contentLocation: 'Irbid, Jordan',
      uploadDate: '25-10-2026',
      datePublished: '25-10-2026',
    },
    offers: offer('150'),
  };
}

// Category Services: no sku.
function service(id: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Sub Category',
    url: `http://jo.opensooq.com/en/search/${id}`,
    name: 'Home cleaning',
    description: 'Weekly cleaning of apartments.',
    image: {
      '@type': 'ImageObject',
      contentUrl: `https://opensooq-imagesv2.os-cdn.com/previews/700x0/${id}.webp`,
      contentLocation: 'Amman, Jordan',
      datePublished: '26-10-2026',
    },
    offers: {
      ...offer('30'),
      url: `http://jo.opensooq.com/en/search/${id}`,
      description: 'Weekly cleaning of apartments.',
    },
  };
}

// A listing page: the page-wide Organization, BreadcrumbList and FAQPage objects, then the given objects.
// Like every live listing page on 2026-10-26, it links its city/brand/model/year filter in the breadcrumb and its year filter in the basic info
// (copied from the live page of 289081186, with the breadcrumb made relative), and other listings as related ads.
function listingPage(objects: object[], ad = 'Sponsored') {
  return `<html><head>${[
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
    ...objects,
  ]
    .map(
      (object) =>
        `<script type="application/ld+json">${JSON.stringify(object)}</script>`,
    )
    .join(
      '',
    )}</head><body><ol><li itemProp="itemListElement"><a data-ghost="breadcrumb" href="/en/amman/cars/motorcycles/o38719-Taro/T9-150/2024"><span>2024</span></a></li></ol><div class="ad">${ad}</div><h1>Listing</h1><section id="listingViewBasicInfo"><ul><li><span>Year</span><a href="/en/cars/motorcycles/2024" aria-label="Year: 2024">2024</a></li></ul></section><section><h2>Related ads</h2><a href="/en/search/287909099">Related ad</a></section></body></html>`;
}

// A category with two listing pages: page 1 links two listings and rel="next" to page 2, which links one more.
async function market(page: { ad: string; price: string }) {
  const requests: string[] = [];
  const upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
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
        listingPage([motorcycle(listing[1] ?? '', page.price)], page.ad),
      );
    else response.writeHead(404).end();
  });
  return Object.assign(upstream, { requests });
}

// A one-page category linking the given listings; each page embeds the objects its entry returns when requested.
// Like a live category with few listings on 2026-10-26: no rel="next" or rel="prev", no ?page= links, and links to other categories.
async function category(pages: Record<string, () => object[]>) {
  const requests: string[] = [];
  const upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    const objects = pages[url.pathname.replace('/en/search/', '')];
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/en/category')
      response.end(
        `<html><body><a href="/en/cars">Cars</a><main>${Object.keys(pages)
          .map((id) => `<a href="/en/search/${id}">${id}</a>`)
          .join('')}</main><a href="/en/property">Property</a></body></html>`,
      );
    else if (objects) response.end(listingPage(objects()));
    else response.writeHead(404).end();
  });
  return Object.assign(upstream, { requests });
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

test('listings that a listing page links as related ads are neither downloaded nor stored', async () => {
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

  assert(!upstream.requests.includes('/en/search/287909099'));
  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010', '287909011', '287909012'],
  );
});

test('every listing of a category without pagination is stored, and nothing else is downloaded', async () => {
  await using upstream = await category({
    '287909010': () => [motorcycle('287909010', '4499')],
    '287909011': () => [motorcycle('287909011', '3999')],
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/category`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  assert.equal((await ingestion.run())[0]?.count, 2);

  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010', '287909011'],
  );
  assert.deepEqual(upstream.requests.toSorted(), [
    '/en/category',
    '/en/search/287909010',
    '/en/search/287909011',
  ]);
});

test('a category crawl reads only the category and its next pages, not the filters and the other-language category they link', async () => {
  // The live page of /en/cars/motorcycles/2000 on 2026-10-26 links its Arabic twin twice: an hreflang alternate and the language switch.
  // That category fits on one page; the rel="next" link is the one the live /en/cars/motorcycles carries (backlog #2993).
  // The year filters and the city/brand/model/year filters are linked from the listing pages (listingPage).
  const twin = '/ar/دراجات-نارية/دراجات/2000';
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    const listing = /^\/(?:en|ar)\/search\/(\d+)$/.exec(url.pathname);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/en/cars/motorcycles/2000' && url.search === '')
      response.end(
        `<html><head><link rel="next" href="/en/cars/motorcycles/2000?page=2"><link href="${twin}" rel="alternate" hrefLang="ar-jo"></head><body><nav><a id="change_lang_link" href="${twin}">عربي</a></nav><main><a href="/en/search/289081186">Taro T9</a><a href="/en/search/289120264">QJ</a></main></body></html>`,
      );
    else if (
      url.pathname === '/en/cars/motorcycles/2000' &&
      url.search === '?page=2'
    )
      response.end(
        '<html><body><main><a href="/en/search/289165164">For sale</a></main></body></html>',
      );
    else if (listing)
      response.end(listingPage([motorcycle(listing[1] ?? '', '700')]));
    // A filter or the twin: a category of other listings.
    else
      response.end(
        '<html><body><main><a href="/en/search/289999001">Other</a><a href="/ar/search/289999002">Other</a></main></body></html>',
      );
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/cars/motorcycles/2000`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(requests.toSorted(), [
    '/en/cars/motorcycles/2000',
    '/en/cars/motorcycles/2000?page=2',
    '/en/search/289081186',
    '/en/search/289120264',
    '/en/search/289165164',
  ]);
  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['289081186', '289120264', '289165164'],
  );
});

test('listings of every real schema.org shape are stored with their mapped fields', async () => {
  await using upstream = await category({
    '287909010': () => [motorcycle('287909010', '4499')],
    '287800001': () => [product('287800001')],
    '286825886': () => [residence('286825886')],
    '287015352': () => [service('287015352')],
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/category`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  assert.equal((await ingestion.run())[0]?.count, 4);

  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT id, title, description, url, type, price, currency, location, imageUrls, condition, availability, publishedAt FROM opensooq_listings ORDER BY id',
      )
      .all()
      .map((row) => ({ ...row, imageUrls: JSON.parse(String(row.imageUrls)) })),
    [
      {
        id: '286825886',
        title: 'Apartment for rent in Al Rahebat Al Wardiah',
        description: null,
        url: `${upstream.origin}/en/search/286825886`,
        type: 'Residence',
        price: 150,
        currency: 'JOD',
        location: 'Irbid, Jordan',
        imageUrls: [
          'https://opensooq-imagesv2.os-cdn.com/previews/700x0/286825886.webp',
        ],
        condition: null,
        availability: 'https://schema.org/InStock',
        publishedAt: '25-10-2026',
      },
      {
        id: '287015352',
        title: 'Home cleaning',
        description: 'Weekly cleaning of apartments.',
        url: `${upstream.origin}/en/search/287015352`,
        type: 'Service',
        price: 30,
        currency: 'JOD',
        location: 'Amman, Jordan',
        imageUrls: [
          'https://opensooq-imagesv2.os-cdn.com/previews/700x0/287015352.webp',
        ],
        condition: null,
        availability: 'https://schema.org/InStock',
        publishedAt: '26-10-2026',
      },
      {
        id: '287800001',
        title: 'Persian kittens',
        description: 'Two months old, vaccinated.',
        url: `${upstream.origin}/en/search/287800001`,
        type: 'Product',
        price: 80,
        currency: 'JOD',
        location: 'Zarqa, Jordan',
        imageUrls: [
          'https://opensooq-imagesv2.os-cdn.com/previews/700x0/287800001.webp',
        ],
        condition: null,
        availability: 'https://schema.org/InStock',
        publishedAt: null,
      },
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
    ],
  );
});

test('a listing page without an object for its listing fails, and the next run tries it again', async () => {
  let broken = true;
  await using upstream = await category({
    '287909010': () => [motorcycle('287909010', '4499')],
    // Only another listing's object, as a related ad would embed.
    '287909011': () => [motorcycle(broken ? '287909099' : '287909011', '4499')],
    '287909012': () => [motorcycle('287909012', '4499')],
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = () =>
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/category`],
      pollIntervalMs: 60_000,
    });
  const ingestion = await pipeline(source(), database.path, checkpoints.path);

  await assert.rejects(ingestion.run(), (error) => {
    assert(error instanceof PipelineError);
    assert.equal(error.results[0]?.count, 2);
    const failure = error.results[0]?.failures[0];
    assert(failure?.error instanceof AggregateError);
    assert.equal(failure.error.errors.length, 1);
    assert.match(failure.error.message, /287909011/);
    return true;
  });
  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010', '287909012'],
  );
  broken = false;
  upstream.requests.length = 0;

  const retry = await pipeline(source(), database.path, checkpoints.path);
  assert.equal((await retry.run())[0]?.count, 1);

  assert(upstream.requests.includes('/en/search/287909011'));
  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010', '287909011', '287909012'],
  );
});

test('a listing whose offer has no price fails, and the next run tries it again', async () => {
  let broken = true;
  await using upstream = await category({
    '287909010': () => [motorcycle('287909010', '4499')],
    '287909011': () => {
      const listing = motorcycle('287909011', '4499');
      if (!broken) return [listing];
      const { price: _price, ...offers } = listing.offers;
      return [{ ...listing, offers }];
    },
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = () =>
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/category`],
      pollIntervalMs: 60_000,
    });
  const ingestion = await pipeline(source(), database.path, checkpoints.path);

  await assert.rejects(ingestion.run(), (error) => {
    assert(error instanceof PipelineError);
    assert.equal(error.results[0]?.count, 1);
    const failure = error.results[0]?.failures[0];
    assert(failure?.error instanceof AggregateError);
    assert.equal(failure.error.errors.length, 1);
    assert.match(failure.error.message, /price/);
    return true;
  });
  assert.deepEqual(
    database.connection
      .prepare('SELECT id FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => row.id),
    ['287909010'],
  );
  broken = false;
  upstream.requests.length = 0;

  const retry = await pipeline(source(), database.path, checkpoints.path);
  assert.equal((await retry.run())[0]?.count, 1);

  assert(upstream.requests.includes('/en/search/287909011'));
  assert.deepEqual(
    {
      ...database.connection
        .prepare("SELECT price FROM opensooq_listings WHERE id = '287909011'")
        .get(),
    },
    { price: 4499 },
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

  assert.equal(rerun[0]?.count, 3);
  assert.deepEqual(
    database.connection
      .prepare('SELECT id, price FROM opensooq_listings ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: '287909010', price: 4299 },
      { id: '287909011', price: 4299 },
      { id: '287909012', price: 4299 },
    ],
  );
});

test('the listing stored is the JSON-LD object whose url has the listing id of the page', async () => {
  await using upstream = await category({
    // Another listing's object comes first, as a related ad would.
    '287909020': () => [
      { ...motorcycle('287909099', '3999'), name: 'Related ad' },
      motorcycle('287909020', '4499'),
    ],
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      stream: listings,
      inputs: [`${upstream.origin}/en/category`],
      pollIntervalMs: 60_000,
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT id, title, price FROM opensooq_listings')
      .all()
      .map((row) => ({ ...row })),
    [{ id: '287909020', title: 'TARO RANGER 401cc 287909020', price: 4499 }],
  );
});
