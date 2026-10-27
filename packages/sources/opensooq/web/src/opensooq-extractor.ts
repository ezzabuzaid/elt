import { hash } from 'node:crypto';

import { JSDOM } from 'jsdom';
import { z } from 'zod';

import {
  type ExtractorRun,
  RecordExtractor,
} from '@workspace/source-web-pages/record-extractor';

const listingPath = new URLPattern({ pathname: '/:lang/search/:id(\\d+)' });

// The listing object's image. Product listings (Pets, Fashion) had no datePublished live on 2026-10-26.
const image = z.object({
  contentUrl: z.url(),
  contentLocation: z.string(),
  datePublished: z.string().optional(),
});

// The schema.org object a listing page describes its listing with; the page also embeds Organization, BreadcrumbList and FAQPage objects.
// Live on 2026-10-26 the shapes were Motorcycle, Product, Residence, Service and Vehicle; Residence keeps its image under photo.
const fields = {
  '@type': z.string(),
  name: z.string(),
  url: z.url(),
  // Residence listings (Property) had no description live on 2026-10-26.
  description: z.string().optional(),
  // Product, Residence and Service listings had no itemCondition live on 2026-10-26.
  itemCondition: z.string().optional(),
  offers: z.object({
    price: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .transform(Number),
    priceCurrency: z.string(),
    availability: z.string(),
  }),
};
const listingSchema = z.union([
  z.object({ ...fields, image }),
  z.object({ ...fields, photo: image }),
]);

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

/** One listing per OpenSooq listing page, read from the page's schema.org JSON-LD. */
export class OpenSooqExtractor extends RecordExtractor {
  readonly properties = {
    id: { ...text, description: 'Listing id, the number in the listing URL.' },
    title: { ...text, description: 'Listing title.' },
    description: {
      ...nullableText,
      description: 'Listing description; null when the listing has none.',
    },
    url: {
      ...text,
      description: 'Final HTTP response URL of the listing page.',
    },
    type: {
      ...text,
      description: 'schema.org type of the listed item, such as Motorcycle.',
    },
    price: { type: 'number', description: 'Asking price in currency.' },
    currency: {
      ...text,
      description: 'ISO 4217 currency code of the price.',
    },
    location: {
      ...text,
      description:
        'Listing location as the image gives it, such as "Amman, Jordan".',
    },
    imageUrls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Listing image URLs.',
    },
    condition: {
      ...nullableText,
      description:
        'schema.org item condition URL, such as https://schema.org/NewCondition; null when the listing has none.',
    },
    availability: {
      ...text,
      description:
        'schema.org availability URL, such as https://schema.org/InStock.',
    },
    publishedAt: {
      ...nullableText,
      description:
        'Publication date as the image gives it (day-month-year), without conversion; null when the image has none.',
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
        let objects: unknown[];
        try {
          objects = [
            ...dom.window.document.querySelectorAll(
              'script[type="application/ld+json"]',
            ),
          ].flatMap((script): unknown => JSON.parse(script.textContent));
        } finally {
          dom.window.close();
        }
        // The listing object is the one whose url is this listing's path; its url is http while the page is https.
        const found = objects.find(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            'url' in value &&
            typeof value.url === 'string' &&
            listingPath.exec(value.url)?.pathname.groups.id === id,
        );
        if (found === undefined)
          throw new Error(
            `${response.url} has no JSON-LD object whose url is its listing path`,
          );
        const listing = listingSchema.parse(found);
        const { contentUrl, contentLocation, datePublished } =
          'image' in listing ? listing.image : listing.photo;
        const record = {
          id,
          title: listing.name,
          description: listing.description ?? null,
          url: response.url,
          type: listing['@type'],
          price: listing.offers.price,
          currency: listing.offers.priceCurrency,
          location: contentLocation,
          imageUrls: [contentUrl],
          condition: listing.itemCondition ?? null,
          availability: listing.offers.availability,
          publishedAt: datePublished ?? null,
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
