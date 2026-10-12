import { gunzipSync } from 'node:zlib';

import { XMLParser } from 'fast-xml-parser';

export class SitemapFormatError extends Error {
  override readonly name = 'SitemapFormatError';
}

export type SitemapListing = {
  readonly pages: readonly string[];
  readonly sitemaps: readonly string[];
};

// The protocol's ceiling for one sitemap file, uncompressed.
const MAX_BYTES = 50 * 1024 * 1024;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  // Decodes numeric character references (&#38;) as well as named ones.
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => ['url', 'sitemap', 'item', 'entry', 'link'].includes(name),
});

/**
 * The text of a sitemap file, gzipped or not. zlib's and TextDecoder's own
 * errors pass through unchanged.
 */
export function decodeSitemap(bytes: Uint8Array): string {
  const body =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_BYTES })
      : bytes;
  if (body.byteLength > MAX_BYTES)
    throw new SitemapFormatError(`larger than ${MAX_BYTES} bytes`);
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

// The documents a sitemap can be, as fast-xml-parser shapes them: namespace
// prefixes removed, attributes under @, repeated elements always arrays.
type SitemapDocument = {
  readonly urlset?: { readonly url?: readonly { readonly loc: string }[] };
  readonly sitemapindex?: {
    readonly sitemap?: readonly { readonly loc: string }[];
  };
  readonly rss?: {
    readonly channel?: {
      readonly item?: readonly { readonly link?: readonly string[] }[];
    };
  };
  readonly feed?: {
    readonly entry?: readonly {
      readonly link?: readonly {
        readonly '@href'?: string;
        readonly '@rel'?: string;
      }[];
    }[];
  };
};

/**
 * The page URLs and child sitemaps one sitemap lists: an XML url set, a
 * sitemap index, an RSS 2.0 or Atom feed, or a plain-text list.
 */
export function parseSitemap(text: string): SitemapListing {
  if (!text.trimStart().startsWith('<')) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines)
      if (!URL.canParse(line))
        throw new SitemapFormatError(
          `line ${JSON.stringify(line)} is not a URL`,
        );
    return { pages: lines, sitemaps: [] };
  }
  let document: SitemapDocument;
  try {
    document = parser.parse(text, true);
  } catch (error) {
    // fast-xml-parser throws a plain Error, with no code or cause.
    if (!Error.isError(error)) throw error;
    throw new SitemapFormatError(error.message);
  }
  const loc = ({ loc }: { loc: string }) => loc.trim();
  if (document.urlset)
    return { pages: (document.urlset.url ?? []).map(loc), sitemaps: [] };
  if (document.sitemapindex)
    return {
      pages: [],
      sitemaps: (document.sitemapindex.sitemap ?? []).map(loc),
    };
  if (document.rss)
    return {
      pages: (document.rss.channel?.item ?? []).flatMap(
        (item) => item.link ?? [],
      ),
      sitemaps: [],
    };
  if (document.feed)
    return {
      pages: (document.feed.entry ?? []).flatMap((entry) =>
        (entry.link ?? [])
          .filter((link) => (link['@rel'] ?? 'alternate') === 'alternate')
          .flatMap((link) => link['@href'] ?? []),
      ),
      sitemaps: [],
    };
  throw new SitemapFormatError(
    'not a sitemap, sitemap index, RSS or Atom document',
  );
}
