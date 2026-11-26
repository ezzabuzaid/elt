import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { WebProduct } from './index.ts';

// The time each page was downloaded.
const at = Date.parse('2026-11-24T12:00:00Z');

function page(blocks: readonly string[], body = '', lang = 'en') {
  return `<!doctype html><html lang="${lang}"><head>${blocks
    .map((block) => `<script type="application/ld+json">${block}</script>`)
    .join('')}</head><body>${body}</body></html>`;
}

const price = (amount: string, currency = 'JOD') => ({
  amount,
  currency,
  regular: null,
  range: null,
});

test('a JSON-LD block that JSON.parse refuses is read, when a trailing comma, a CDATA or comment frame or HTML entities break it, and one that nothing repairs leaves the next block', () => {
  const url = 'https://shop.example.jo/products/kettle';
  const product = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Kettle "Black"',
    url,
    offers: { '@type': 'Offer', price: '12.000', priceCurrency: 'JOD' },
  });
  for (const [form, blocks] of Object.entries({
    'a trailing comma': [product.replace(/}$/, ',}')],
    'a CDATA frame': [`/*<![CDATA[*/${product}/*]]>*/`],
    'an HTML comment frame': [`<!--${product}-->`],
    'HTML entities': [product.replaceAll('"', '&quot;')],
    'a block that nothing repairs before it': ['<%= product %>', product],
  })) {
    const read = WebProduct.read(page(blocks), url, at);
    assert.deepEqual(
      { name: read?.name, price: read?.price },
      { name: 'Kettle "Black"', price: price('12') },
      form,
    );
  }
  // A script element's text is raw: valid JSON keeps the entities it writes.
  assert.equal(
    WebProduct.read(
      page([
        JSON.stringify({ '@type': 'Product', name: 'Salt &amp; Pepper', url }),
      ]),
      url,
      at,
    )?.name,
    'Salt &amp; Pepper',
  );
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
    'https://leaders.jo/%d8%a7%d9%84%d9%85%d9%86%d8%aa%d8%ac/folg-10s/?utm_source=search';
  const related = {
    '@type': 'Product',
    name: 'Folg 10S case',
    url: 'https://leaders.jo/case',
  };
  const cases = {
    // leaders.jo writes its @id with Arabic letters and its page URL with
    // lowercase escapes, which a URL parser writes in upper case.
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

test("a variant is not the page's product: the group that names it is, whether it names the group or the group lists it by @id", () => {
  const url = 'https://shop.example.jo/products/shirt';
  const group = {
    '@type': 'ProductGroup',
    '@id': `${url}#group`,
    name: 'Shirt',
    hasVariant: [{ '@id': `${url}?size=m#variant` }],
  };
  const listed = {
    '@type': 'Product',
    '@id': `${url}?size=m#variant`,
    name: 'Shirt - M',
    size: 'M',
    offers: { '@type': 'Offer', price: '15', priceCurrency: 'JOD' },
  };
  const naming = {
    '@type': 'Product',
    name: 'Shirt - L',
    size: 'L',
    isVariantOf: { '@id': `${url}#group` },
  };

  const read = WebProduct.read(
    page([JSON.stringify({ '@graph': [listed, naming, group] })]),
    'https://shop.example.jo/c/shirts',
    at,
  );
  assert.deepEqual(
    { name: read?.name, variants: read?.variants.map(({ size }) => size) },
    { name: 'Shirt', variants: ['M'] },
  );
});

test('a product that a page writes in both JSON-LD and microdata is one product, read from its JSON-LD', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = WebProduct.read(
    page(
      [JSON.stringify({ '@type': 'Product', name: 'Kettle', url })],
      '<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Kettle</h1></div>',
    ),
    'https://shop.example.jo/p/1?ref=home',
    at,
  );

  assert.deepEqual(
    { name: read?.name, syntax: read?.syntax },
    { name: 'Kettle', syntax: 'json-ld' },
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

// The price of an offer of 20.000 with a specification of 18.000 and a struck
// price of the given amount and price type.
const struckPrice = (regular: string, priceType: string) => {
  const url = 'https://shop.example.jo/p/1';
  return WebProduct.read(
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
};

// WooCommerce marks its regular price ListPrice, WPSSO StrikethroughPrice.
void test.each(
  [
    'https://schema.org/StrikethroughPrice',
    'https://schema.org/ListPrice',
    'https://schema.org/RegularPrice',
    'https://schema.org/MSRP',
    'https://schema.org/SRP',
  ],
  (priceType) =>
    test(`the offer’s price wins over its price specifications, and a struck price higher than it is the regular price: ${priceType}`, () => {
      assert.deepEqual(
        struckPrice('25.000', priceType),
        { ...price('20'), regular: '25' },
        priceType,
      );
    }),
);

test('a struck price lower than the offer’s price is not the regular price', () => {
  assert.deepEqual(
    struckPrice('15.000', 'https://schema.org/ListPrice'),
    price('20'),
    'a lower struck price',
  );
});

test('without an offer price, the active price specification is the price: no price type but SalePrice, no member tier, and inside its validFrom and validThrough', () => {
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
      { price: '12.000', priceCurrency: 'JOD', priceType: 'ListPrice' },
      {
        price: '6.000',
        priceCurrency: 'JOD',
        validForMemberTier: { name: 'Gold' },
      },
      { price: '7.000', priceCurrency: 'JOD', validThrough: '2026-11-01' },
      { price: '8.000', priceCurrency: 'JOD', validFrom: '2026-12-01' },
      { price: '10.000', priceCurrency: 'JOD', validThrough: '2026-12-31' },
    ]),
    { ...price('10'), regular: '12' },
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
    price('9'),
  );
});

test("an AggregateOffer's lowest price is the price, with its range, and its price stands in for a lowPrice that it does not give", () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (offers: object) =>
    WebProduct.read(
      page([
        JSON.stringify({ '@type': 'Product', name: 'Kettle', url, offers }),
      ]),
      url,
      at,
    )?.price;

  assert.deepEqual(
    read({
      '@type': 'AggregateOffer',
      lowPrice: 5,
      highPrice: '9.500',
      priceCurrency: 'JOD',
      offerCount: 3,
    }),
    { ...price('5'), range: { low: '5', high: '9.5' } },
  );
  assert.deepEqual(
    read({ '@type': 'AggregateOffer', price: '7', priceCurrency: 'JOD' }),
    price('7'),
  );
});

test('of several offers, the lowest that a buyer can order wins, in the currency of the first offer', () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (offers: readonly object[]) => {
    const product = WebProduct.read(
      page([
        JSON.stringify({ '@type': 'Product', name: 'Kettle', url, offers }),
      ]),
      url,
      at,
    );
    return { price: product?.price, availability: product?.availability };
  };

  assert.deepEqual(
    read([
      { price: '15.000', priceCurrency: 'JOD', availability: 'InStock' },
      { price: '10.000', priceCurrency: 'JOD', availability: 'OutOfStock' },
      {
        price: '14.000',
        priceCurrency: 'JOD',
        availability: 'https://schema.org/InStock',
      },
      { price: '12.000', priceCurrency: 'USD', availability: 'InStock' },
    ]),
    { price: price('14'), availability: 'InStock' },
  );
  assert.deepEqual(
    read([
      { price: '15.000', priceCurrency: 'JOD', availability: 'OutOfStock' },
      { price: '13.000', priceCurrency: 'JOD', availability: 'SoldOut' },
    ]),
    { price: price('13'), availability: 'SoldOut' },
    'every offer out of stock',
  );
  assert.deepEqual(
    read([
      { price: '15.000', priceCurrency: 'JOD', availability: 'OutOfStock' },
      { price: '16.000', priceCurrency: 'JOD' },
    ]),
    { price: price('16'), availability: null },
    'an offer that gives no availability',
  );
  // A currency is kept as the shop gives it.
  assert.deepEqual(read([{ price: '30', priceCurrency: 'USD' }]), {
    price: price('30', 'USD'),
    availability: null,
  });
});

test('a price is an exact decimal string with one spelling for each value, and a value that is not one positive price is no price', () => {
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
      '۱۵۰',
      '007.50',
      'Call us',
      '0',
      '0.000',
      '1.2.3',
    ].map(read),
    [
      '12',
      '12.5',
      '70',
      '70',
      '1299.99',
      '120',
      '150',
      '7.5',
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
  // 2026-11-24, with the description and the shipping details shortened, and
  // a related product beside it, so the page's own is found by its @id.
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
        name: 'Folg 10S case',
        url: 'https://leaders.jo/case/',
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
    price: price('104'),
    availability: 'InStock',
    itemCondition: 'NewCondition',
    variants: [],
    syntax: 'json-ld',
  });
});

test('an object that a product names by @id is found also where another object nests it', () => {
  const url = 'https://shop.example.jo/p/1';
  const block = JSON.stringify({
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        publisher: {
          '@type': 'Organization',
          '@id': `${url}#maker`,
          name: 'Panasonic',
        },
      },
      {
        '@type': 'Product',
        name: 'Trimmer',
        url,
        brand: { '@id': `${url}#maker` },
      },
    ],
  });

  assert.equal(WebProduct.read(page([block]), url, at)?.brand, 'Panasonic');
});

test('a product that a page declares only in microdata is read with its offer, its content attributes and its URLs resolved', () => {
  const url =
    'https://timemachine.jo/ar_001/shop/90100058180-black-pixoo-slingbag-spark-your-life-2108';
  // The microdata of timemachine.jo's Odoo shop as it gave it on 2026-11-24,
  // in a page of language ar-001: hidden spans, a URL and an image without
  // the page's language prefix, and Odoo's own listPrice, which schema.org
  // does not define. The meta element is the content form that Shopify
  // themes use, and the link element a second image by a relative URL.
  const body = `
    <div itemscope="itemscope" itemtype="http://schema.org/Product" id="wrap">
      <h1 itemprop="name">Pixoo Slingbag - Spark Your Life</h1>
      <span itemprop="url" style="display:none;">https://www.TimeMachine.jo/shop/90100058180-black-pixoo-slingbag-spark-your-life-2108</span>
      <span itemprop="image" style="display:none;">https://www.TimeMachine.jo/web/image/product.template/2108/image_1920?unique=8709572</span>
      <link itemprop="image" href="/web/image/product.template/2108/image_1024">
      <div itemprop="offers" itemscope="itemscope" itemtype="http://schema.org/Offer">
        <span itemprop="price" style="display:none;">70.0</span>
        <span itemprop="priceCurrency" style="display:none;">JOD</span>
        <span style="text-decoration: line-through;" itemprop="listPrice">JD 70.000</span>
        <meta itemprop="availability" content="https://schema.org/InStock">
      </div>
    </div>`;

  const read = WebProduct.read(page([], body, 'ar-001'), url, at);

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
        'https://timemachine.jo/web/image/product.template/2108/image_1024',
      ],
      price: price('70'),
      availability: 'InStock',
      syntax: 'microdata',
    },
  );
});

test("a ProductGroup gives its variants, and its price is the variant's that the page's URL names by its id or its SKU, else the cheapest in the first variant's currency", () => {
  const product = 'https://xmart.jo/products/trimmer';
  const black = {
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
  };
  const silver = {
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
  };
  // The shape of Shopify's structured_data filter for a product with variants.
  const group = (variants: readonly object[]) =>
    JSON.stringify({
      '@context': 'http://schema.org/',
      '@type': 'ProductGroup',
      '@id': `${product}#product`,
      name: 'Trimmer',
      url: product,
      brand: { '@type': 'Brand', name: 'Panasonic' },
      productGroupID: '8842',
      variesBy: ['https://schema.org/color'],
      hasVariant: variants,
    });
  const read = (url: string, variants: readonly object[] = [black, silver]) =>
    WebProduct.read(page([group(variants)]), url, at);

  const named = read(`${product}?variant=101`);
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
      price: price('99'),
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
      price: price('89'),
      availability: 'OutOfStock',
    },
  ]);
  assert.deepEqual(
    { price: named?.price, availability: named?.availability },
    { price: price('99'), availability: 'InStock' },
    'the variant that the URL names by its id',
  );
  assert.deepEqual(
    read(`${product}?variant=ER-B`)?.price,
    price('99'),
    'the variant that the URL names by its SKU',
  );
  assert.deepEqual(read(product)?.price, price('89'), 'the cheapest variant');
  const unpriced = {
    '@type': 'Product',
    name: 'Trimmer - Gold',
    url: `${product}?variant=103`,
  };
  const dollars = {
    '@type': 'Product',
    name: 'Trimmer - Import',
    url: `${product}?variant=104`,
    offers: { '@type': 'Offer', price: '50', priceCurrency: 'USD' },
  };
  assert.deepEqual(
    read(`${product}?variant=103`, [black, silver, unpriced, dollars])?.price,
    price('89'),
    'a named variant without a price, and a cheaper one in another currency',
  );
});

test("a product's identifiers, rating and attributes are read, its availability and condition as bare names, and a GTIN in URL form is left out", () => {
  const url = 'https://shop.example.jo/p/1';
  const read = (product: object) =>
    WebProduct.read(
      page([
        JSON.stringify({ '@type': 'Product', name: 'MSI', url, ...product }),
      ]),
      url,
      at,
    );

  const full = read({
    sku: 'CityCenter_19067',
    productID: 'CityCenter_19067',
    mpn: '9S7-15C121-042',
    model: { '@type': 'ProductModel', name: '9S7-265343-214' },
    gtin: '04711377183746',
    gtin8: '47113771',
    gtin12: '471137718374',
    gtin13: ['4711377183746', 'https://id.gs1.org/01/04711377183746'],
    gtin14: '14711377183743',
    brand: 'MSI',
    image: '/image/msi-crosshair-16.png',
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
      itemCondition: 'https://schema.org/RefurbishedCondition',
    },
  });
  assert.deepEqual(
    {
      sku: full?.sku,
      productId: full?.productId,
      mpn: full?.mpn,
      model: full?.model,
      gtins: full?.gtins,
      brand: full?.brand,
      images: full?.images,
      category: full?.category,
      color: full?.color,
      size: full?.size,
      rating: full?.rating,
      availability: full?.availability,
      itemCondition: full?.itemCondition,
    },
    {
      sku: 'CityCenter_19067',
      productId: 'CityCenter_19067',
      mpn: '9S7-15C121-042',
      model: '9S7-265343-214',
      gtins: [
        { type: 'gtin', value: '04711377183746' },
        { type: 'gtin8', value: '47113771' },
        { type: 'gtin12', value: '471137718374' },
        { type: 'gtin13', value: '4711377183746' },
        { type: 'gtin14', value: '14711377183743' },
      ],
      brand: 'MSI',
      images: ['https://shop.example.jo/image/msi-crosshair-16.png'],
      category: 'Laptops',
      color: 'Core Black',
      size: '16 inch',
      rating: { value: '4.5', count: 12 },
      availability: 'LimitedAvailability',
      // The offer's condition is the one of what it sells.
      itemCondition: 'RefurbishedCondition',
    },
  );
  assert.deepEqual(
    read({
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: '3.8',
        ratingCount: 40,
      },
    })?.rating,
    { value: '3.8', count: 40 },
    'a ratingCount',
  );
});
