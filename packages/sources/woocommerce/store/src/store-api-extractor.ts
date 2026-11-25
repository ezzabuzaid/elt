import { hash } from 'node:crypto';

import { decodeHTML } from 'entities';
import { convert } from 'html-to-text';
import { z } from 'zod';

import {
  type ExtractorRun,
  RecordExtractor,
} from '@eltjs/source-web-pages/record-extractor';

// The fields of a product that a page of the Store API gives and that the
// record reads, as highhawks.jo's shop answered on 2026-11-24.
const named = z.object({ name: z.string() });
const product = z.object({
  id: z.number().int(),
  name: z.string(),
  permalink: z.url(),
  type: z.string(),
  sku: z.string(),
  description: z.string(),
  short_description: z.string(),
  prices: z.object({
    price: z.string(),
    regular_price: z.string(),
    price_range: z
      .object({ min_amount: z.string(), max_amount: z.string() })
      .nullable(),
    currency_code: z.string(),
    currency_minor_unit: z.number().int().min(0),
  }),
  images: z.array(z.object({ src: z.url() })),
  categories: z.array(named),
  // WooCommerce before 9.6 gives no brands.
  brands: z.array(named).optional(),
  average_rating: z.string(),
  review_count: z.number().int(),
  is_in_stock: z.boolean(),
  is_on_backorder: z.boolean(),
  variations: z.array(z.object({ id: z.number().int() })),
});
const page = z.array(product);

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
// An exact decimal as text, such as "369" for 36900 fils, never through a float.
const nullableDecimal = {
  type: ['string', 'null'],
  format: 'decimal',
} as const;

// An exact decimal of one spelling, as @eltjs/sdk-web-product writes a price
// and elt's decimal format asks: no leading zero before the point, and no
// trailing zero after it.
function decimal(integer: string, fraction: string) {
  const whole = integer.replace(/^0+(?=\d)/, '') || '0';
  const decimals = fraction.replace(/0+$/, '');
  return decimals === '' ? whole : `${whole}.${decimals}`;
}

/**
 * An amount that the Store API gives in the currency's minor unit, such as
 * 36900 with minor unit 2, which is "369". Zero is no price, as Google shows
 * only a price greater than zero.
 */
function amount(minor: string, unit: number): string | null {
  if (!/^\d+$/.test(minor) || /^0+$/.test(minor)) return null;
  const digits = minor.padStart(unit + 1, '0');
  const point = digits.length - unit;
  return decimal(digits.slice(0, point), digits.slice(point));
}

// The average of a product's reviews, such as "4.50", which is "4.5".
function rating(average: string): string | null {
  const [, integer, fraction = ''] = /^(\d+)(?:\.(\d+))?$/.exec(average) ?? [];
  return integer === undefined ? null : decimal(integer, fraction);
}

function availability(item: {
  is_on_backorder: boolean;
  is_in_stock: boolean;
}): 'InStock' | 'BackOrder' | 'OutOfStock' {
  // WooCommerce's is_in_stock() is true for a product on back order too, so
  // the back order decides first.
  if (item.is_on_backorder) return 'BackOrder';
  if (item.is_in_stock) return 'InStock';
  return 'OutOfStock';
}

function plain(html: string) {
  return convert(html, { wordwrap: false }).trim() || null;
}

/** The products of a page of a WooCommerce shop's Store API, one record each. */
export class StoreApiExtractor extends RecordExtractor {
  readonly properties = {
    productId: {
      ...text,
      description: "The product's post id in the shop; the key with inputUrl.",
    },
    name: { ...text, description: "The product's name, decoded." },
    url: { ...text, description: "The product's page, its permalink." },
    type: {
      ...text,
      description: 'The WooCommerce product type, such as simple or variable.',
    },
    sku: {
      ...nullableText,
      description: "The shop's own code of the product; null when it has none.",
    },
    description: {
      ...nullableText,
      description: "The product's description as text; null when it has none.",
    },
    shortDescription: {
      ...nullableText,
      description:
        "The product's short description as text; null when it has none.",
    },
    brand: {
      ...nullableText,
      description:
        "The name of the product's first brand; null when it has none.",
    },
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: "The names of the product's categories, decoded.",
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: "The product's image URLs.",
    },
    price: {
      ...nullableDecimal,
      description:
        'The price to pay, as an exact decimal of one spelling; null when it is zero.',
    },
    regularPrice: {
      ...nullableDecimal,
      description:
        'The price before a sale, only when it is higher than price.',
    },
    currency: { ...text, description: 'The ISO 4217 code of the prices.' },
    lowPrice: {
      ...nullableDecimal,
      description:
        "The lowest price of a variable product's variations; null otherwise.",
    },
    highPrice: {
      ...nullableDecimal,
      description:
        "The highest price of a variable product's variations; null otherwise.",
    },
    availability: {
      type: 'string',
      enum: ['InStock', 'BackOrder', 'OutOfStock'],
      description: 'The schema.org availability of the product.',
    },
    ratingValue: {
      ...nullableDecimal,
      description:
        "The average of the product's reviews; null when it has none.",
    },
    ratingCount: {
      type: ['integer', 'null'],
      description: 'How many reviews the product has; null when it has none.',
    },
    variationIds: {
      type: 'array',
      items: { type: 'integer' },
      description:
        "The post ids of a variable product's variations; the list response gives none of their prices.",
    },
  } as const;

  open(): ExtractorRun {
    return {
      negotiation: null,
      async read(response) {
        // A body that is not a list of products fails the page, so the
        // crawler asks it again when it is due.
        // JSON between systems is UTF-8 (RFC 8259).
        const products = page.parse(
          JSON.parse(new TextDecoder().decode(response.rawBody)),
        );
        const records = products.map((item) => {
          const unit = item.prices.currency_minor_unit;
          const price = amount(item.prices.price, unit);
          const regular = amount(item.prices.regular_price, unit);
          const range = item.prices.price_range;
          return {
            productId: String(item.id),
            name: decodeHTML(item.name),
            url: item.permalink,
            type: item.type,
            sku: item.sku || null,
            description: plain(item.description),
            shortDescription: plain(item.short_description),
            brand:
              item.brands?.[0] === undefined
                ? null
                : decodeHTML(item.brands[0].name),
            categories: item.categories.map(({ name }) => decodeHTML(name)),
            images: item.images.map(({ src }) => src),
            price,
            // A regular price is the price before a sale, so a product
            // without a price has none, as Zyte's regularPrice.
            regularPrice:
              price !== null &&
              regular !== null &&
              Number(regular) > Number(price)
                ? regular
                : null,
            currency: item.prices.currency_code,
            lowPrice: range === null ? null : amount(range.min_amount, unit),
            highPrice: range === null ? null : amount(range.max_amount, unit),
            availability: availability(item),
            ratingValue:
              item.review_count > 0 ? rating(item.average_rating) : null,
            ratingCount: item.review_count > 0 ? item.review_count : null,
            variationIds: item.variations.map(({ id }) => id),
          };
        });
        return {
          // From the products and the URL they are stored under.
          fingerprint: hash('sha256', JSON.stringify([response.url, records])),
          records: async () => records,
        };
      },
    };
  }
}
