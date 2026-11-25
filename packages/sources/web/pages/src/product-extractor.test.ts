import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';
import { z } from 'zod';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { AlwaysRevisit, ListingReader } from '@eltjs/sdk-web-crawler';

import { ProductExtractor } from './product-extractor.ts';
import { WebSource } from './web-source.ts';
import { WebStream } from './web-stream.ts';

async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'shops',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: `shops:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('a web stream with ProductExtractor stores one product per product page of a sitemap with its variants flattened, none for a category page, and a change elsewhere in a page changes no row', async () => {
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let banner = 'Free delivery';
  let amount = '104.00';
  await using upstream = await new HttpServer().start((request, response) => {
    const { origin } = upstream;
    switch (request.url) {
      case '/sitemap.xml':
        response
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<urlset><url><loc>${origin}/product/folg-10s/</loc></url><url><loc>${origin}/products/trimmer</loc></url><url><loc>${origin}/category/tablets/</loc></url></urlset>`,
          );
        break;
      case '/product/folg-10s/':
        // WooCommerce's JSON-LD as leaders.jo gives it, shortened, with an ad
        // banner around it that changes on its own.
        response
          .writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
          .end(
            `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(
              {
                '@context': 'https://schema.org',
                '@graph': [
                  {
                    '@type': 'Product',
                    '@id': `${origin}/product/folg-10s/#product`,
                    name: 'تابلت فولج 10S',
                    url: `${origin}/product/folg-10s/`,
                    sku: '92859918',
                    gtin13: '6291041500213',
                    image: `${origin}/folg-10s.jpg`,
                    brand: { '@type': 'Brand', name: 'Folg' },
                    offers: [
                      {
                        '@type': 'Offer',
                        priceSpecification: [
                          {
                            '@type': 'UnitPriceSpecification',
                            price: amount,
                            priceCurrency: 'JOD',
                          },
                        ],
                        availability: 'https://schema.org/InStock',
                      },
                    ],
                    itemCondition: 'https://schema.org/NewCondition',
                  },
                ],
              },
            )}</script></head><body><aside>${banner}</aside></body></html>`,
          );
        break;
      case '/products/trimmer':
        // The shape of Shopify's structured_data filter for a product with
        // variants: the first variant has two barcode numbers and two images.
        response
          .writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
          .end(
            `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(
              {
                '@context': 'http://schema.org/',
                '@type': 'ProductGroup',
                name: 'Trimmer',
                url: `${origin}/products/trimmer`,
                hasVariant: [
                  {
                    '@type': 'Product',
                    name: 'Trimmer - Black',
                    sku: 'ER-B',
                    gtin13: '4549980000011',
                    gtin14: '14549980000018',
                    url: `${origin}/products/trimmer?variant=101`,
                    image: [`${origin}/black.jpg`, `${origin}/black-side.jpg`],
                    offers: {
                      '@type': 'Offer',
                      price: '99.0',
                      priceCurrency: 'JOD',
                      availability: 'http://schema.org/InStock',
                    },
                  },
                ],
              },
            )}</script></head><body></body></html>`,
          );
        break;
      default:
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<h1>Tablets</h1><a href="/product/folg-10s/">Folg 10S</a>');
    }
  });
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const input = `${upstream.origin}/sitemap.xml`;
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [
        {
          stream: new WebStream({
            name: 'products',
            primaryKey: ['pageUrl'],
            readers: [new ListingReader()],
            revisit: new AlwaysRevisit(),
            extractor: new ProductExtractor(),
          }),
          inputs: [input],
        },
      ],
    }),
    database.path,
    checkpoints.path,
  );
  const rows = () =>
    database.connection
      .prepare(
        'SELECT pageUrl, name, sku, gtins, images, brand, price, currency, availability, itemCondition, variants, syntax FROM products ORDER BY pageUrl',
      )
      .all()
      .map((row) => ({ ...row }));

  assert.equal((await ingestion.run())[0]?.count, 2);
  const [folg, trimmer] = rows();
  assert.deepEqual(
    {
      ...trimmer,
      variants: z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(String(trimmer?.variants))),
    },
    {
      pageUrl: `${upstream.origin}/products/trimmer`,
      name: 'Trimmer',
      sku: null,
      gtins: '[]',
      images: '[]',
      brand: null,
      price: '99',
      currency: 'JOD',
      availability: 'InStock',
      itemCondition: null,
      // A variant item holds scalars only: its first barcode number and image.
      variants: [
        {
          name: 'Trimmer - Black',
          url: `${upstream.origin}/products/trimmer?variant=101`,
          sku: 'ER-B',
          mpn: null,
          gtin: '4549980000011',
          image: `${upstream.origin}/black.jpg`,
          color: null,
          size: null,
          price: '99',
          regularPrice: null,
          currency: 'JOD',
          availability: 'InStock',
        },
      ],
      syntax: 'json-ld',
    },
  );
  assert.deepEqual(
    [folg],
    [
      {
        pageUrl: `${upstream.origin}/product/folg-10s/`,
        name: 'تابلت فولج 10S',
        sku: '92859918',
        gtins: JSON.stringify([{ type: 'gtin13', value: '6291041500213' }]),
        images: JSON.stringify([`${upstream.origin}/folg-10s.jpg`]),
        brand: 'Folg',
        price: '104',
        currency: 'JOD',
        availability: 'InStock',
        itemCondition: 'NewCondition',
        variants: '[]',
        syntax: 'json-ld',
      },
    ],
  );

  banner = 'Two-year warranty';
  assert.equal((await ingestion.run())[0]?.count, 0, 'only the banner changed');

  amount = '89.00';
  assert.equal((await ingestion.run())[0]?.count, 1, 'the price changed');
  assert.deepEqual(
    rows().map(({ price }) => price),
    ['89', '99'],
  );
});
