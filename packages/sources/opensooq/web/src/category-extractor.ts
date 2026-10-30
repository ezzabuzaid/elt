import { hash } from 'node:crypto';

import { JSDOM, VirtualConsole } from 'jsdom';

import {
  type ExtractorRun,
  RecordExtractor,
} from '@workspace/source-web-pages/record-extractor';

const pathSegments = (url: string) =>
  new URL(url).pathname.split('/').filter(Boolean);

// A top-level category has one path segment after the language.
const isTopLevel = (url: string) => pathSegments(url).length === 2;

// The first path segment after the language, which a category shares with its top-level category.
const categorySlug = (url: string) => pathSegments(url)[1];

/**
 * One category per link of the hidden menu of an OpenSooq home page. The menu
 * links each top-level category, such as /en/cars, before the categories
 * under it, such as /en/cars/motorcycles.
 */
export class CategoryExtractor extends RecordExtractor {
  readonly properties = {
    url: {
      type: 'string',
      description:
        'Absolute URL of the category page, such as https://jo.opensooq.com/en/cars/motorcycles; an input of the listings stream.',
    },
    name: {
      type: 'string',
      description: 'Category name as the menu shows it, such as Motorcycles.',
    },
    group: {
      type: ['string', 'null'],
      description:
        'Name of the top-level category that the category is under, such as Autos; null for a top-level category.',
    },
  } as const;

  open(): ExtractorRun {
    return {
      negotiation: null,
      async read(response) {
        const dom = new JSDOM(response.rawBody, {
          url: response.url,
          contentType: response.headers['content-type'],
          // jsdom's own console writes its errors, such as a stylesheet it
          // cannot parse, to the host's console.
          virtualConsole: new VirtualConsole(),
        });
        let links: { url: string; name: string }[];
        try {
          const menu = dom.window.document.getElementById('megaMenuRaw');
          if (menu === null)
            throw new Error(`${response.url} has no megaMenuRaw menu`);
          links = [...menu.querySelectorAll('a[href]')].map((link) => ({
            url: new URL(link.getAttribute('href') ?? '', response.url).href,
            name: link.textContent.trim(),
          }));
        } finally {
          dom.window.close();
        }
        const tops = new Map(
          links
            .filter(({ url }) => isTopLevel(url))
            .map(({ url, name }) => [categorySlug(url), name]),
        );
        const records = links.map(({ url, name }) => ({
          url,
          name,
          group: isTopLevel(url) ? null : (tops.get(categorySlug(url)) ?? null),
        }));
        return {
          fingerprint: hash('sha256', JSON.stringify(records)),
          records: async () => records,
        };
      },
    };
  }
}
