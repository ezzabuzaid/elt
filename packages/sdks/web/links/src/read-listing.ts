import { XMLValidator } from 'fast-xml-parser';
import {
  detectJsonFeed,
  detectRdfFeed,
  parseJsonFeed,
  parseRdfFeed,
} from 'feedsmith';

import { parseSitemap } from '@workspace/codec-sitemap';

export function readListing(text: string) {
  if (detectJsonFeed(text))
    return (parseJsonFeed(text).items ?? []).flatMap((item) =>
      item.url === undefined ? [] : [{ url: item.url, lastModified: null }],
    );
  if (detectRdfFeed(text)) {
    // Feedsmith's RDF parser does not validate XML itself.
    const valid = XMLValidator.validate(text);
    if (valid !== true) throw new Error(valid.err.msg);
    return (parseRdfFeed(text).items ?? []).flatMap((item) =>
      item.link === undefined ? [] : [{ url: item.link, lastModified: null }],
    );
  }
  return parseSitemap(text).pages;
}
