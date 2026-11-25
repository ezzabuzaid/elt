import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebProduct } from './index.ts';

// The time each page was downloaded.
const at = Date.parse('2026-11-24T12:00:00Z');

function page(blocks: readonly string[], body = '') {
  return `<!doctype html><html><head>${blocks
    .map((block) => `<script type="application/ld+json">${block}</script>`)
    .join('')}</head><body>${body}</body></html>`;
}

const price = (amount: string, currency = 'JOD') => ({
  amount,
  currency,
  regular: null,
  range: null,
});

test('a JSON-LD block that JSON.parse refuses is read, when a trailing comma, a CDATA or comment frame or HTML entities break it', () => {
  const url = 'https://shop.example.jo/products/kettle';
  const product = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Kettle "Black"',
    url,
    offers: { '@type': 'Offer', price: '12.000', priceCurrency: 'JOD' },
  });
  for (const [form, block] of Object.entries({
    'a trailing comma': product.replace(/}$/, ',}'),
    'a CDATA frame': `/*<![CDATA[*/${product}/*]]>*/`,
    'an HTML comment frame': `<!--${product}-->`,
    'HTML entities': product.replaceAll('"', '&quot;'),
  })) {
    const read = WebProduct.read(page([block]), url, at);
    assert.deepEqual(
      { name: read?.name, price: read?.price },
      { name: 'Kettle "Black"', price: price('12.000') },
      form,
    );
  }
});

test("a page that declares several products of which none is the page's has no product", () => {
  const block = JSON.stringify([
    { '@type': 'Product', name: 'Kettle', url: 'https://shop.example.jo/p/1' },
    { '@type': 'Product', name: 'Toaster', url: 'https://shop.example.jo/p/2' },
  ]);

  assert.equal(
    WebProduct.read(page([block]), 'https://shop.example.jo/c/kitchen', at),
    null,
  );
});

test("the page's product is the one whose url or @id is the page or its canonical URL, also when a related product comes first", () => {
  const url =
    'https://leaders.jo/%D8%A7%D9%84%D9%85%D9%86%D8%AA%D8%AC/folg-10s/?utm_source=search';
  const related = {
    '@type': 'Product',
    name: 'Folg 10S case',
    url: 'https://leaders.jo/case',
  };
  const cases = {
    // leaders.jo writes its @id with Arabic letters and its page with escapes.
    'its @id, with the escapes and a fragment': {
      '@type': 'Product',
      '@id': 'https://leaders.jo/المنتج/folg-10s/?utm_source=search#product',
      name: 'Folg 10S',
    },
    'its url, with another scheme': {
      '@type': 'Product',
      name: 'Folg 10S',
      url: 'http://leaders.jo/المنتج/folg-10s?utm_source=search',
    },
    'the canonical URL': {
      '@type': 'Product',
      name: 'Folg 10S',
      url: 'https://leaders.jo/folg-10s',
    },
  };
  for (const [form, product] of Object.entries(cases))
    assert.equal(
      WebProduct.read(
        page(
          [JSON.stringify([related, product])],
          '<link rel="canonical" href="https://leaders.jo/folg-10s/">',
        ),
        url,
        at,
      )?.name,
      'Folg 10S',
      form,
    );
});

test('a product without a name is no product', () => {
  const url = 'https://shop.example.jo/p/1';
  const block = JSON.stringify({
    '@type': 'Product',
    url,
    offers: { '@type': 'Offer', price: '5', priceCurrency: 'JOD' },
  });

  assert.equal(WebProduct.read(page([block]), url, at), null);
});

test('the offer’s price wins over its price specifications, and a struck price is the regular price only when it is higher', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (regular: string, priceType: string) =>
    WebProduct.read(
      page([
        JSON.stringify({
          '@type': 'Product',
          name: 'Kettle',
          url,
          offers: {
            '@type': 'Offer',
            price: '20.000',
            priceCurrency: 'JOD',
            priceSpecification: [
              { '@type': 'UnitPriceSpecification', price: '18.000' },
              { '@type': 'UnitPriceSpecification', price: regular, priceType },
            ],
          },
        }),
      ]),
      url,
      at,
    )?.price;
  // WooCommerce marks its regular price ListPrice, WPSSO StrikethroughPrice.
  for (const priceType of [
    'https://schema.org/StrikethroughPrice',
    'https://schema.org/ListPrice',
    'https://schema.org/RegularPrice',
    'https://schema.org/MSRP',
    'https://schema.org/SRP',
  ])
    assert.deepEqual(
      read('25.000', priceType),
      { ...price('20.000'), regular: '25.000' },
      priceType,
    );
  assert.deepEqual(
    read('15.000', 'https://schema.org/ListPrice'),
    price('20.000'),
    'a lower struck price',
  );
});

test('without an offer price, the active price specification is the price: no member tier, and inside its validFrom and validThrough', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (specifications: readonly object[]) =>
    WebProduct.read(
      page([
        JSON.stringify({
          '@type': 'Product',
          name: 'Kettle',
          url,
          offers: { '@type': 'Offer', priceSpecification: specifications },
        }),
      ]),
      url,
      at,
    )?.price;

  assert.deepEqual(
    read([
      {
        price: '6.000',
        priceCurrency: 'JOD',
        validForMemberTier: { name: 'Gold' },
      },
      { price: '7.000', priceCurrency: 'JOD', validThrough: '2026-11-01' },
      { price: '8.000', priceCurrency: 'JOD', validFrom: '2026-12-01' },
      { price: '10.000', priceCurrency: 'JOD', validThrough: '2026-12-31' },
      { price: '12.000', priceCurrency: 'JOD', priceType: 'ListPrice' },
    ]),
    { ...price('10.000'), regular: '12.000' },
  );
  // WooCommerce gives a variable product on sale a SalePrice specification.
  assert.deepEqual(
    read([
      {
        price: '9.000',
        priceCurrency: 'JOD',
        priceType: 'https://schema.org/SalePrice',
      },
    ]),
    price('9.000'),
  );
});

test("an AggregateOffer's lowest price is the price, with its range", () => {
  const url = 'https://shop.example.jo/p/1';
  const block = JSON.stringify({
    '@type': 'Product',
    name: 'Kettle',
    url,
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: 5,
      highPrice: '9.500',
      priceCurrency: 'JOD',
      offerCount: 3,
    },
  });

  assert.deepEqual(WebProduct.read(page([block]), url, at)?.price, {
    ...price('5'),
    range: { low: '5', high: '9.500' },
  });
});

test('of several offers, the lowest that a buyer can order wins, in the currency of the first offer', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (offers: readonly object[]) =>
    WebProduct.read(
      page([
        JSON.stringify({ '@type': 'Product', name: 'Kettle', url, offers }),
      ]),
      url,
      at,
    );

  const several = read([
    { price: '15.000', priceCurrency: 'JOD', availability: 'OutOfStock' },
    { price: '12.000', priceCurrency: 'USD', availability: 'InStock' },
    {
      price: '14.000',
      priceCurrency: 'JOD',
      availability: 'https://schema.org/InStock',
    },
    { price: '16.000', priceCurrency: 'JOD', availability: 'InStock' },
  ]);
  assert.deepEqual(
    { price: several?.price, availability: several?.availability },
    { price: price('14.000'), availability: 'InStock' },
  );
  // A currency is kept as the shop gives it.
  assert.deepEqual(
    read([{ price: '30', priceCurrency: 'USD' }])?.price,
    price('30', 'USD'),
  );
});

test('a price is a decimal string with its decimals as written, and a value that is not one positive price is no price', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (value: unknown) =>
    WebProduct.read(
      page([
        JSON.stringify({
          '@type': 'Product',
          name: 'Kettle',
          url,
          offers: { '@type': 'Offer', price: value, priceCurrency: 'JOD' },
        }),
      ]),
      url,
      at,
    )?.price?.amount ?? null;

  assert.deepEqual(
    [
      '12.000',
      12.5,
      'JD 70.000',
      '70.000 د.أ',
      '1,299.99',
      '١٢٠',
      'Call us',
      '0',
      '0.000',
      '1.2.3',
    ].map(read),
    [
      '12.000',
      '12.5',
      '70.000',
      '70.000',
      '1299.99',
      '120',
      null,
      null,
      null,
      null,
    ],
  );
});

test('a WooCommerce product in a @graph is read with the objects its @id references name, as leaders.jo gave it', () => {
  const url =
    'https://leaders.jo/%D8%A7%D9%84%D9%85%D9%86%D8%AA%D8%AC/%d8%aa%d8%a7%d8%a8%d9%84%d8%aa-%d9%81%d9%88%d9%84%d8%ac-10s-%d9%84%d9%88%d9%86-%d9%84%d8%a7%d9%81%d9%86%d8%af%d8%b1-%d8%a3%d9%88%d8%b1%d8%a7/';
  const id =
    'https://leaders.jo/المنتج/%d8%aa%d8%a7%d8%a8%d9%84%d8%aa-%d9%81%d9%88%d9%84%d8%ac-10s-%d9%84%d9%88%d9%86-%d9%84%d8%a7%d9%81%d9%86%d8%af%d8%b1-%d8%a3%d9%88%d8%b1%d8%a7/';
  const image =
    'https://leaders.jo/wp-content/uploads/2025/06/تابلت-فولج-10S-لون-لافندر-أورا.jpg';
  // The objects of the page's @graph that the product refers to, captured on
  // 2026-11-24, with the description and the shipping details shortened.
  const block = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': ['WebPage', 'ItemPage'], '@id': id, url: id },
      {
        '@type': 'ImageObject',
        '@id': `${id}#primaryimage`,
        url: image,
        contentUrl: image,
        width: 700,
        height: 700,
      },
      {
        '@type': ['Organization', 'Place'],
        '@id': 'https://leaders.jo/#organization',
      },
      {
        '@type': 'Product',
        '@id': `${id}#product`,
        name: 'تابلت فولج 10S لون لافندر أورا',
        url: id,
        description: 'المواصفات الرئيسية',
        image: { '@id': `${id}#primaryimage` },
        sku: '92859918',
        offers: [
          {
            '@type': 'Offer',
            priceSpecification: [
              {
                '@type': 'UnitPriceSpecification',
                price: '104.00',
                priceCurrency: 'JOD',
                valueAddedTaxIncluded: false,
              },
            ],
            availability: 'https://schema.org/InStock',
            url: id,
            seller: { '@id': 'https://leaders.jo/#organization' },
            '@id': 'https://leaders.jo/#/schema/offer/322100-0',
          },
        ],
        brand: { '@type': 'Brand', name: 'بدون ماركة' },
        itemCondition: 'https://schema.org/NewCondition',
        mainEntityOfPage: { '@id': id },
      },
    ],
  });

  const read = WebProduct.read(
    page([block], `<link rel="canonical" href="${id}">`),
    url,
    at,
  );
  assert.ok(read);
  const { data, ...product } = read;
  assert.equal(data['@id'], `${id}#product`);
  assert.deepEqual(product, {
    name: 'تابلت فولج 10S لون لافندر أورا',
    url: new URL(id).href,
    canonicalUrl: new URL(id).href,
    description: 'المواصفات الرئيسية',
    brand: 'بدون ماركة',
    category: null,
    sku: '92859918',
    mpn: null,
    model: null,
    productId: null,
    gtins: [],
    images: [new URL(image).href],
    color: null,
    size: null,
    rating: null,
    price: price('104.00'),
    availability: 'InStock',
    itemCondition: 'NewCondition',
    variants: [],
    syntax: 'json-ld',
  });
});

test('a product that a page declares only in microdata is read with its offer, its content attributes and its URLs resolved', () => {
  const url =
    'https://timemachine.jo/ar_001/shop/90100058180-black-pixoo-slingbag-spark-your-life-2108';
  // The microdata of timemachine.jo's Odoo shop as it gave it on 2026-11-24:
  // hidden spans, a URL and an image without the page's language prefix, and
  // Odoo's own listPrice, which schema.org does not define. The meta element
  // is the content form that Shopify themes use.
  const body = `
    <div itemscope="itemscope" itemtype="http://schema.org/Product" id="wrap">
      <h1 itemprop="name">Pixoo Slingbag - Spark Your Life</h1>
      <span itemprop="url" style="display:none;">https://www.TimeMachine.jo/shop/90100058180-black-pixoo-slingbag-spark-your-life-2108</span>
      <span itemprop="image" style="display:none;">https://www.TimeMachine.jo/web/image/product.template/2108/image_1920?unique=8709572</span>
      <div itemprop="offers" itemscope="itemscope" itemtype="http://schema.org/Offer">
        <span itemprop="price" style="display:none;">70.0</span>
        <span itemprop="priceCurrency" style="display:none;">JOD</span>
        <span style="text-decoration: line-through;" itemprop="listPrice">JD 70.000</span>
        <meta itemprop="availability" content="https://schema.org/InStock">
      </div>
    </div>`;

  const read = WebProduct.read(page([], body), url, at);

  assert.deepEqual(
    {
      name: read?.name,
      url: read?.url,
      images: read?.images,
      price: read?.price,
      availability: read?.availability,
      syntax: read?.syntax,
    },
    {
      name: 'Pixoo Slingbag - Spark Your Life',
      url: 'https://www.timemachine.jo/shop/90100058180-black-pixoo-slingbag-spark-your-life-2108',
      images: [
        'https://www.timemachine.jo/web/image/product.template/2108/image_1920?unique=8709572',
      ],
      price: price('70.0'),
      availability: 'InStock',
      syntax: 'microdata',
    },
  );
});

test("a ProductGroup gives its variants, and its price is the variant's that the page's URL names, else the cheapest", () => {
  const product = 'https://xmart.jo/products/trimmer';
  // The shape of Shopify's structured_data filter for a product with variants.
  const block = JSON.stringify({
    '@context': 'http://schema.org/',
    '@type': 'ProductGroup',
    '@id': `${product}#product`,
    name: 'Trimmer',
    url: product,
    brand: { '@type': 'Brand', name: 'Panasonic' },
    productGroupID: '8842',
    variesBy: ['https://schema.org/color'],
    hasVariant: [
      {
        '@type': 'Product',
        '@id': `${product}?variant=101#variant`,
        name: 'Trimmer - Black',
        sku: 'ER-B',
        gtin13: '4549980000011',
        color: 'Black',
        url: `${product}?variant=101`,
        image: `${product}-black.jpg`,
        offers: {
          '@type': 'Offer',
          price: '99.0',
          priceCurrency: 'JOD',
          availability: 'http://schema.org/InStock',
        },
      },
      {
        '@type': 'Product',
        '@id': `${product}?variant=102#variant`,
        name: 'Trimmer - Silver',
        sku: 'ER-S',
        color: 'Silver',
        url: `${product}?variant=102`,
        offers: {
          '@type': 'Offer',
          price: '89.0',
          priceCurrency: 'JOD',
          availability: 'http://schema.org/OutOfStock',
        },
      },
    ],
  });

  const named = WebProduct.read(page([block]), `${product}?variant=101`, at);
  assert.deepEqual(named?.variants, [
    {
      name: 'Trimmer - Black',
      url: `${product}?variant=101`,
      sku: 'ER-B',
      mpn: null,
      gtins: [{ type: 'gtin13', value: '4549980000011' }],
      images: [`${product}-black.jpg`],
      color: 'Black',
      size: null,
      price: price('99.0'),
      availability: 'InStock',
    },
    {
      name: 'Trimmer - Silver',
      url: `${product}?variant=102`,
      sku: 'ER-S',
      mpn: null,
      gtins: [],
      images: [],
      color: 'Silver',
      size: null,
      price: price('89.0'),
      availability: 'OutOfStock',
    },
  ]);
  assert.deepEqual(
    { price: named?.price, availability: named?.availability },
    { price: price('99.0'), availability: 'InStock' },
    'the variant that the URL names',
  );
  assert.deepEqual(
    WebProduct.read(page([block]), product, at)?.price,
    price('89.0'),
    'the cheapest variant',
  );
});

test("a product's identifiers, rating and attributes are read, its availability and condition as bare names, and a GTIN in URL form is left out", () => {
  const url = 'https://shop.example.jo/p/1';
  const block = JSON.stringify({
    '@type': 'Product',
    name: 'MSI Crosshair 16 HX',
    url,
    sku: 'CityCenter_19067',
    productID: 'CityCenter_19067',
    mpn: '9S7-15C121-042',
    model: { '@type': 'ProductModel', name: '9S7-265343-214' },
    gtin13: ['4711377183746', 'https://id.gs1.org/01/04711377183746'],
    brand: 'MSI',
    category: 'Laptops',
    color: 'Core Black',
    size: '16 inch',
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: '12',
    },
    itemCondition: 'schema:UsedCondition',
    offers: {
      '@type': 'Offer',
      price: '1899',
      priceCurrency: 'JOD',
      availability: 'http://schema.org/LimitedAvailability',
    },
  });

  const read = WebProduct.read(page([block]), url, at);

  assert.deepEqual(
    {
      sku: read?.sku,
      productId: read?.productId,
      mpn: read?.mpn,
      model: read?.model,
      gtins: read?.gtins,
      brand: read?.brand,
      category: read?.category,
      color: read?.color,
      size: read?.size,
      rating: read?.rating,
      availability: read?.availability,
      itemCondition: read?.itemCondition,
    },
    {
      sku: 'CityCenter_19067',
      productId: 'CityCenter_19067',
      mpn: '9S7-15C121-042',
      model: '9S7-265343-214',
      gtins: [{ type: 'gtin13', value: '4711377183746' }],
      brand: 'MSI',
      category: 'Laptops',
      color: 'Core Black',
      size: '16 inch',
      rating: { value: '4.5', count: 12 },
      availability: 'LimitedAvailability',
      itemCondition: 'UsedCondition',
    },
  );
});
