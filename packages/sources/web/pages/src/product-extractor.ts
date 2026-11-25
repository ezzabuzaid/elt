import { hash } from 'node:crypto';

import { pageText } from '@eltjs/sdk-web-crawler';
import { WebProduct } from '@eltjs/sdk-web-product';

import { type ExtractorRun, RecordExtractor } from './record-extractor.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
// An exact decimal as text, such as JOD's "12.000", never through a float.
const nullableDecimal = {
  type: ['string', 'null'],
  format: 'decimal',
} as const;

/**
 * One product per page that declares one in schema.org JSON-LD or microdata,
 * read by @eltjs/sdk-web-product; a page that declares none, such as a
 * category page, gives no record.
 */
export class ProductExtractor extends RecordExtractor {
  readonly properties = {
    name: { ...text, description: "The product's name." },
    url: {
      ...text,
      description:
        "The product's own URL as the page declares it, resolved; else the page's final URL.",
    },
    canonicalUrl: {
      ...nullableText,
      description:
        'The canonical URL that the page declares in its head; null when it declares none.',
    },
    description: {
      ...nullableText,
      description: "The product's description; null when the page gives none.",
    },
    brand: {
      ...nullableText,
      description: "The brand's name; null when the page gives none.",
    },
    category: {
      ...nullableText,
      description:
        "The product's category as the shop writes it, such as Laptops; null when the page gives none.",
    },
    sku: {
      ...nullableText,
      description:
        "The shop's own code of the product; null when the page gives none.",
    },
    mpn: {
      ...nullableText,
      description: "The maker's part number; null when the page gives none.",
    },
    model: {
      ...nullableText,
      description:
        "schema.org model, such as a maker's part number; null when the page gives none.",
    },
    productId: {
      ...nullableText,
      description: 'schema.org productID; null when the page gives none.',
    },
    gtins: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'],
            description: 'The schema.org property that gives the number.',
          },
          value: {
            type: 'string',
            description: 'The barcode number, as digits.',
          },
        },
        required: ['type', 'value'],
      },
      description:
        'The barcode numbers that the page declares; a GTIN in URL form is left out.',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: "The product's image URLs, resolved.",
    },
    color: {
      ...nullableText,
      description: "The product's colour; null when the page gives none.",
    },
    size: {
      ...nullableText,
      description: "The product's size; null when the page gives none.",
    },
    ratingValue: {
      ...nullableDecimal,
      description:
        "The average of the product's ratings; null when the page gives none.",
    },
    ratingCount: {
      type: ['integer', 'null'],
      description:
        'How many ratings or reviews the average is of; null when the page gives none.',
    },
    price: {
      ...nullableDecimal,
      description:
        "The price to pay as Google's merchant listings read it, with its decimals as written; null when the page gives no price greater than zero.",
    },
    regularPrice: {
      ...nullableDecimal,
      description:
        'The price before a sale, only when it is higher than price; null otherwise.',
    },
    currency: {
      ...nullableText,
      description:
        'The ISO 4217 code of the prices, as the shop gives it; null when it gives none.',
    },
    lowPrice: {
      ...nullableDecimal,
      description:
        'The lowest price of an AggregateOffer, which is price; null for a single offer.',
    },
    highPrice: {
      ...nullableDecimal,
      description:
        'The highest price of an AggregateOffer; null for a single offer.',
    },
    availability: {
      ...nullableText,
      description:
        'The bare schema.org availability of the offer that gives the price, such as InStock; null when the page gives none.',
    },
    itemCondition: {
      ...nullableText,
      description:
        'The bare schema.org condition, such as NewCondition; null when the page gives none.',
    },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            ...text,
            description: "The variant's name, else the group's.",
          },
          url: { ...text, description: "The variant's URL, resolved." },
          sku: {
            ...nullableText,
            description: "The shop's own code of the variant.",
          },
          mpn: {
            ...nullableText,
            description: "The maker's part number of the variant.",
          },
          gtin: {
            ...nullableText,
            description:
              "The first of the variant's barcode numbers; a variant item holds scalars only.",
          },
          image: {
            ...nullableText,
            description: "The first of the variant's image URLs.",
          },
          color: { ...nullableText, description: "The variant's colour." },
          size: { ...nullableText, description: "The variant's size." },
          price: {
            ...nullableDecimal,
            description: "The variant's price to pay.",
          },
          regularPrice: {
            ...nullableDecimal,
            description: "The variant's price before a sale, when higher.",
          },
          currency: {
            ...nullableText,
            description: "The ISO 4217 code of the variant's prices.",
          },
          availability: {
            ...nullableText,
            description:
              "The bare schema.org availability of the variant's offer.",
          },
        },
        required: [
          'name',
          'url',
          'sku',
          'mpn',
          'gtin',
          'image',
          'color',
          'size',
          'price',
          'regularPrice',
          'currency',
          'availability',
        ],
      },
      description:
        "The variants of a ProductGroup; empty for a Product. The group's price is the variant's that the page's URL names, else the cheapest.",
    },
    syntax: {
      type: 'string',
      enum: ['json-ld', 'microdata'],
      description: 'The syntax that the page declares the product in.',
    },
  } as const;

  open(): ExtractorRun {
    return {
      negotiation: null,
      async read(response) {
        // When the page was made: its Date header (RFC 9110), which an
        // answer from the HTTP cache keeps, else the time of the request,
        // which a cache answer has none of; with neither, a price
        // specification's validFrom and validThrough bound nothing.
        const date = Date.parse(response.headers.date ?? '');
        const product = WebProduct.read(
          pageText(response),
          response.url,
          Number.isNaN(date) ? (response.timings?.start ?? Number.NaN) : date,
        );
        return {
          // From the product and the URL it is stored under, so markup,
          // ads and timestamps elsewhere in the page are no change.
          fingerprint: hash('sha256', JSON.stringify([response.url, product])),
          async records() {
            if (product === null) return [];
            const { price, rating, variants } = product;
            return [
              {
                name: product.name,
                url: product.url,
                canonicalUrl: product.canonicalUrl,
                description: product.description,
                brand: product.brand,
                category: product.category,
                sku: product.sku,
                mpn: product.mpn,
                model: product.model,
                productId: product.productId,
                gtins: product.gtins.map(({ type, value }) => ({
                  type,
                  value,
                })),
                images: [...product.images],
                color: product.color,
                size: product.size,
                ratingValue: rating?.value ?? null,
                ratingCount: rating?.count ?? null,
                price: price?.amount ?? null,
                regularPrice: price?.regular ?? null,
                currency: price?.currency ?? null,
                lowPrice: price?.range?.low ?? null,
                highPrice: price?.range?.high ?? null,
                availability: product.availability,
                itemCondition: product.itemCondition,
                variants: variants.map((variant) => ({
                  name: variant.name,
                  url: variant.url,
                  sku: variant.sku,
                  mpn: variant.mpn,
                  gtin: variant.gtins[0]?.value ?? null,
                  image: variant.images[0] ?? null,
                  color: variant.color,
                  size: variant.size,
                  price: variant.price?.amount ?? null,
                  regularPrice: variant.price?.regular ?? null,
                  currency: variant.price?.currency ?? null,
                  availability: variant.availability,
                })),
                syntax: product.syntax,
              },
            ];
          },
        };
      },
    };
  }
}
