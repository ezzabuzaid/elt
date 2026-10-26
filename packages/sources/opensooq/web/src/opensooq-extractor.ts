import { hash } from 'node:crypto';

import { JSDOM } from 'jsdom';
import { z } from 'zod';

import {
  type ExtractorRun,
  RecordExtractor,
} from '@workspace/source-web-pages/record-extractor';

const listingPath = new URLPattern({ pathname: '/:lang/search/:id(\\d+)' });

// The schema.org object a listing page describes its listing with; the page also embeds Organization, BreadcrumbList and FAQPage objects.
const listingSchema = z.object({
  '@type': z.string(),
  name: z.string(),
  sku: z.number().int(),
  description: z.string(),
  image: z.object({
    contentUrl: z.url(),
    contentLocation: z.string().optional(),
    datePublished: z.string().optional(),
  }),
  itemCondition: z.string().optional(),
  offers: z
    .object({
      price: z
        .string()
        .regex(/^\d+(?:\.\d+)?$/)
        .transform(Number),
      priceCurrency: z.string().optional(),
      availability: z.string().optional(),
    })
    .optional(),
});

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

/** One listing per OpenSooq listing page, read from the page's schema.org JSON-LD. */
export class OpenSooqExtractor extends RecordExtractor {
  readonly properties = {
    id: { ...text, description: 'Listing id, the number in the listing URL.' },
    title: { ...text, description: 'Listing title.' },
    description: { ...text, description: 'Listing description.' },
    url: {
      ...text,
      description: 'Final HTTP response URL of the listing page.',
    },
    type: {
      ...text,
      description: 'schema.org type of the listed item, such as Motorcycle.',
    },
    price: {
      type: ['number', 'null'],
      description:
        'Asking price in currency; null when the listing has no offer.',
    },
    currency: {
      ...nullableText,
      description: 'ISO 4217 currency code of the price.',
    },
    location: {
      ...nullableText,
      description: 'Listing location as given, such as "Amman, Jordan".',
    },
    imageUrls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Listing image URLs.',
    },
    condition: {
      ...nullableText,
      description:
        'schema.org item condition URL, such as https://schema.org/NewCondition.',
    },
    availability: {
      ...nullableText,
      description:
        'schema.org availability URL, such as https://schema.org/InStock.',
    },
    publishedAt: {
      ...nullableText,
      description:
        'Publication date as the page gives it (day-month-year), without conversion.',
    },
  } as const;

  open(): ExtractorRun {
    return {
      accept: null,
      async read(response) {
        const id = listingPath.exec(response.url)?.pathname.groups.id;
        if (id === undefined)
          return { fingerprint: null, records: async () => [] };
        const dom = new JSDOM(response.rawBody, {
          url: response.url,
          contentType: response.headers['content-type'],
        });
        let found: unknown;
        try {
          found = [
            ...dom.window.document.querySelectorAll(
              'script[type="application/ld+json"]',
            ),
          ]
            .flatMap((script): unknown => JSON.parse(script.textContent))
            .find(
              (value) =>
                typeof value === 'object' &&
                value !== null &&
                'sku' in value &&
                value.sku === Number(id),
            );
        } finally {
          dom.window.close();
        }
        if (found === undefined)
          return { fingerprint: null, records: async () => [] };
        const listing = listingSchema.parse(found);
        const record = {
          id: String(listing.sku),
          title: listing.name,
          description: listing.description,
          url: response.url,
          type: listing['@type'],
          price: listing.offers?.price ?? null,
          currency: listing.offers?.priceCurrency ?? null,
          location: listing.image.contentLocation ?? null,
          imageUrls: [listing.image.contentUrl],
          condition: listing.itemCondition ?? null,
          availability: listing.offers?.availability ?? null,
          publishedAt: listing.image.datePublished ?? null,
        };
        return {
          // From the listing's data and the URL it is stored under, so ads and timestamps elsewhere in the page are no change.
          fingerprint: hash('sha256', JSON.stringify([response.url, listing])),
          records: async () => [record],
        };
      },
    };
  }
}
