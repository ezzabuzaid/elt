import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { day } from '@eltjs/sdk-web-crawler';
import { WebSource } from '@eltjs/source-web-pages/web-source';

import { products } from './products.ts';

// The first product of highhawks.jo's Store API as it answered on
// 2026-11-24, with its descriptions shortened.
const laptop = {
  id: 14196,
  name: 'Lenovo IdeaPad Slim 3 15IRU8-Core i3-1315U-8GB RAM-256GB SSD-15.6 &#8220;FHD-Windows 11 Laptop',
  permalink:
    'https://highhawks.jo/product/lenovo-ideapad-slim-3-15iru8-core-i3-1315u-8gb-ram-256gb-ssd-15-6-fhd-windows-11-laptop/',
  type: 'simple',
  sku: '',
  short_description:
    '<p>PROCESSOR : INTEL CORE I3-1315U<br />\nRAM : 8GB RAM</p>',
  description:
    '<p>Lenovo IdeaPad Slim 3 15IRU8-Core i3-1315U-8GB RAM-256GB SSD-15.6 &#8220;FHD-Windows 11 Laptop</p>',
  on_sale: true,
  prices: {
    price: '36900',
    regular_price: '42500',
    sale_price: '36900',
    price_range: null,
    currency_code: 'JOD',
    currency_symbol: 'د.ا',
    currency_minor_unit: 2,
    currency_decimal_separator: ',',
    currency_thousand_separator: '.',
    currency_prefix: '',
    currency_suffix: ' د.ا',
  },
  average_rating: '0',
  review_count: 0,
  images: [
    {
      id: 14197,
      src: 'https://highhawks.jo/wp-content/uploads/2026/11/Ideapad-slim-3-15IAH8-99-1200x1200-1.jpg',
      name: 'Ideapad-slim-3',
      alt: '',
    },
  ],
  categories: [
    { id: 2401, name: 'Computers &amp; Laptops', slug: 'computers-laptops' },
    { id: 2410, name: 'Laptops', slug: 'laptops' },
    { id: 2420, name: 'Office', slug: 'office' },
    { id: 2420, name: 'Office', slug: 'office' },
  ],
  brands: [],
  attributes: [],
  variations: [],
  is_purchasable: true,
  is_in_stock: true,
  is_on_backorder: false,
};

function shop(pages: readonly (readonly object[] | object)[]) {
  return new HttpServer().start((request, response) => {
    const page = Number(
      new URL(request.url ?? '/', 'http://shop').searchParams.get('page') ?? 1,
    );
    const list = `http://${request.headers.host}/wp-json/wc/store/v1/products?per_page=2`;
    // The header as WordPress gives it, with its & escaped as &#038;.
    response
      .writeHead(200, {
        'content-type': 'application/json; charset=UTF-8',
        ...(page < pages.length
          ? { link: `<${list}&page=${page + 1}#038;page=${page}>; rel="next"` }
          : {}),
      })
      // A page past the last answers an empty list, as highhawks.jo's did on
      // 2026-11-25.
      .end(JSON.stringify(pages[page - 1] ?? []));
  });
}

async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'woocommerce',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: `woocommerce:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

async function ingestion(
  origin: string,
  database: string,
  checkpoints: string,
  cache: string,
) {
  return pipeline(
    new WebSource({
      cachePath: join(cache, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: products,
          inputs: [`${origin}/wp-json/wc/store/v1/products?per_page=2`],
        },
      ],
    }),
    database,
    checkpoints,
  );
}

test('a page of the Store API whose body is not a list of products fails the run, and the products of the pages before it are stored', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // A plugin that answers 200 with WordPress's error object.
  await using upstream = await shop([
    [laptop],
    {
      code: 'rest_no_route',
      message: 'No route was found',
      data: { status: 404 },
    },
  ]);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const run = await ingestion(
    upstream.origin,
    database.path,
    checkpoints.path,
    cache.path,
  );

  await assert.rejects(
    run.run(),
    (error: Error) =>
      error.message.includes('page=2') &&
      error.message.includes('expected array'),
  );
  assert.deepEqual(
    database.connection
      .prepare('SELECT productId FROM woocommerce_products')
      .all()
      .map((row) => ({ ...row })),
    [{ productId: '14196' }],
  );
});

test("the products of every page of a shop's Store API are stored, with their prices from minor units, decoded names and schema.org availability", async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // Two products of other shops as their Store API answered on 2026-11-25:
  // alyoum.jo prices in USD, writes zero for "price on request" and gives a
  // barcode number as its sku and a brand; gcesoft.com.jo prices JOD with
  // three decimals, gives its own sku, two images and no brand.
  const cupcake = {
    ...laptop,
    id: 2101,
    name: 'Cupcake Vanilla Box 10 pcs',
    permalink: 'https://alyoum.jo/product/cupcake-vanilla-box-10-pcs/',
    sku: '6253341505367',
    short_description: '',
    description: '',
    prices: {
      ...laptop.prices,
      price: '0',
      regular_price: '0',
      sale_price: '0',
      currency_code: 'USD',
      currency_symbol: '$',
    },
    images: [
      {
        ...laptop.images[0],
        src: 'https://alyoum.jo/wp-content/uploads/2026/09/Alyoum-Cupcake-vanilla-Box-10-pcs.png',
      },
    ],
    categories: [{ name: 'Bakery' }, { name: 'Cupcake' }],
    brands: [{ name: 'Alyoum' }],
  };
  const zebra = {
    ...laptop,
    id: 12304,
    name: 'Zebra ZT421',
    permalink: 'https://gcesoft.com.jo/product/zebra-zt421-jo/',
    sku: 'ZT42162-T0E0000Z',
    short_description: '',
    description: '',
    prices: {
      ...laptop.prices,
      price: '0',
      regular_price: '0',
      sale_price: '0',
      currency_minor_unit: 3,
    },
    images: [
      {
        src: 'https://gcesoft.com.jo/wp-content/uploads/2025/06/zt421-zebra2027.jpg',
      },
      {
        src: 'https://gcesoft.com.jo/wp-content/uploads/2025/06/zt421-zebra2027.jo5-jo.jpg',
      },
    ],
    categories: [{ name: 'ZEBRA' }],
    brands: [],
  };
  // The other kinds of product that the API gives, built on the laptop with
  // the fields that WooCommerce's Store API documents: a variable product
  // with its price range from a WooCommerce before 9.6, which gives no
  // brands; a product on back order, which WooCommerce gives as in stock and
  // on back order, with two brands and reviews, in three decimals; a price
  // below one unit, with fewer digits than the minor unit; and a product whose zero price has a regular price.
  const { brands: _, ...withoutBrands } = laptop;
  const variable = {
    ...withoutBrands,
    id: 15001,
    name: 'Gaming Mouse',
    permalink: 'https://highhawks.jo/product/gaming-mouse/',
    type: 'variable',
    sku: 'GM-1',
    short_description: '',
    description: '',
    prices: {
      ...laptop.prices,
      price: '1500',
      regular_price: '1500',
      price_range: { min_amount: '1500', max_amount: '2250' },
    },
    variations: [
      { id: 15002, attributes: [] },
      { id: 15003, attributes: [] },
    ],
  };
  const backOrder = {
    ...laptop,
    id: 15010,
    name: 'Keyboard',
    permalink: 'https://highhawks.jo/product/keyboard/',
    sku: 'KB-1',
    prices: {
      ...laptop.prices,
      price: '12500',
      regular_price: '9000',
      currency_minor_unit: 3,
    },
    brands: [{ name: 'Logitech &amp; Co' }, { name: 'Other' }],
    average_rating: '4.50',
    review_count: 2,
    is_in_stock: true,
    is_on_backorder: true,
  };
  const cable = {
    ...laptop,
    id: 15030,
    name: 'Cable',
    permalink: 'https://highhawks.jo/product/cable/',
    sku: 'CB-1',
    prices: { ...laptop.prices, price: '5', regular_price: '5' },
    is_in_stock: false,
  };
  const onRequest = {
    ...laptop,
    id: 15040,
    name: 'Server',
    permalink: 'https://highhawks.jo/product/server/',
    sku: 'SV-1',
    prices: { ...laptop.prices, price: '0', regular_price: '500000' },
  };
  await using upstream = await shop([
    [laptop],
    [variable, backOrder, cupcake, zebra],
    [cable, onRequest],
  ]);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const run = await ingestion(
    upstream.origin,
    database.path,
    checkpoints.path,
    cache.path,
  );

  assert.equal((await run.run())[0]?.count, 7);
  const rows = database.connection
    .prepare(
      'SELECT productId, name, url, type, sku, description, shortDescription, brand, categories, images, price, regularPrice, currency, lowPrice, highPrice, availability, ratingValue, ratingCount, variationIds FROM woocommerce_products ORDER BY CAST(productId AS INTEGER)',
    )
    .all()
    .map((row) => ({ ...row }));
  const laptopRow = {
    productId: '14196',
    name: 'Lenovo IdeaPad Slim 3 15IRU8-Core i3-1315U-8GB RAM-256GB SSD-15.6 “FHD-Windows 11 Laptop',
    url: laptop.permalink,
    type: 'simple',
    sku: null,
    description:
      'Lenovo IdeaPad Slim 3 15IRU8-Core i3-1315U-8GB RAM-256GB SSD-15.6 “FHD-Windows 11 Laptop',
    shortDescription: 'PROCESSOR : INTEL CORE I3-1315U\nRAM : 8GB RAM',
    brand: null,
    categories: JSON.stringify([
      'Computers & Laptops',
      'Laptops',
      'Office',
      'Office',
    ]),
    images: JSON.stringify([laptop.images[0]?.src]),
    price: '369',
    regularPrice: '425',
    currency: 'JOD',
    lowPrice: null,
    highPrice: null,
    availability: 'InStock',
    ratingValue: null,
    ratingCount: null,
    variationIds: '[]',
  };
  assert.deepEqual(rows, [
    {
      ...laptopRow,
      productId: '2101',
      name: 'Cupcake Vanilla Box 10 pcs',
      url: cupcake.permalink,
      sku: '6253341505367',
      description: null,
      shortDescription: null,
      brand: 'Alyoum',
      categories: JSON.stringify(['Bakery', 'Cupcake']),
      images: JSON.stringify([cupcake.images[0]?.src]),
      price: null,
      regularPrice: null,
      currency: 'USD',
    },
    {
      ...laptopRow,
      productId: '12304',
      name: 'Zebra ZT421',
      url: zebra.permalink,
      sku: 'ZT42162-T0E0000Z',
      description: null,
      shortDescription: null,
      categories: JSON.stringify(['ZEBRA']),
      images: JSON.stringify(zebra.images.map(({ src }) => src)),
      price: null,
      regularPrice: null,
    },
    laptopRow,
    {
      ...laptopRow,
      productId: '15001',
      name: 'Gaming Mouse',
      url: variable.permalink,
      type: 'variable',
      sku: 'GM-1',
      description: null,
      shortDescription: null,
      price: '15',
      regularPrice: null,
      lowPrice: '15',
      highPrice: '22.5',
      variationIds: '[15002,15003]',
    },
    {
      ...laptopRow,
      productId: '15010',
      name: 'Keyboard',
      url: backOrder.permalink,
      sku: 'KB-1',
      brand: 'Logitech & Co',
      price: '12.5',
      regularPrice: null,
      availability: 'BackOrder',
      ratingValue: '4.5',
      ratingCount: 2,
    },
    {
      ...laptopRow,
      productId: '15030',
      name: 'Cable',
      url: cable.permalink,
      sku: 'CB-1',
      price: '0.05',
      regularPrice: null,
      availability: 'OutOfStock',
    },
    {
      ...laptopRow,
      productId: '15040',
      name: 'Server',
      url: onRequest.permalink,
      sku: 'SV-1',
      price: null,
      regularPrice: null,
    },
  ]);
});

test('a product that the shop removes is deleted, and the product that moves to the page before keeps its row', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await using cache = await new TemporaryFiles().directory('web-cache-');
  const second = { ...laptop, id: 2 };
  const third = { ...laptop, id: 3 };
  const pages = [[laptop, second], [third]];
  await using upstream = await shop(pages);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const run = () =>
    ingestion(
      upstream.origin,
      database.path,
      checkpoints.path,
      cache.path,
    ).then((ingested) => ingested.run());
  await run();
  // The shop removes the laptop: the third product moves to the first page.
  pages.splice(0, pages.length, [second, third]);
  // Each page of the list is due again a day after its first read.
  t.mock.timers.setTime(Date.now() + 2 * day);

  await run();

  assert.deepEqual(
    database.connection
      .prepare('SELECT productId FROM woocommerce_products ORDER BY productId')
      .all()
      .map((row) => row.productId),
    ['2', '3'],
  );
});
