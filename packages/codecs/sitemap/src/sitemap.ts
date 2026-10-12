import { gunzipSync } from 'node:zlib';

import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

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
// prefixes removed, attributes under @, the elements isArray names always
// arrays, a repeated element it does not name an array, and an element with
// neither children nor attributes ''.
const empty = z.literal('');
const entry = z.object({ loc: z.string() });
const urlset = z.object({ url: z.array(entry).optional() });
const sitemapindex = z.object({ sitemap: z.array(entry).optional() });
// RSS 2.0 makes every element of an item optional, so an item may name no page.
const rss = z.object({
  channel: z
    .union([
      empty,
      z.object({
        item: z
          .array(
            z.union([
              empty,
              z.object({ link: z.array(z.string()).optional() }),
            ]),
          )
          .optional(),
      }),
    ])
    .optional(),
});
const feed = z.object({
  entry: z
    .array(
      z.union([
        empty,
        z.object({
          link: z
            .array(
              z.object({
                '@href': z.string().optional(),
                '@rel': z.string().optional(),
              }),
            )
            .optional(),
        }),
      ]),
    )
    .optional(),
});

// The document under its root element, or every way it breaks the format,
// such as a <url> without exactly one <loc>. An empty root lists nothing.
function parseRoot<Schema extends z.ZodType>(
  root: string,
  schema: Schema,
  value: unknown,
): z.infer<Schema> | undefined {
  if (value === '') return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new SitemapFormatError(
    `<${root}> ${parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ')}`,
  );
}

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
  let document: unknown;
  try {
    document = parser.parse(text, true);
  } catch (error) {
    // fast-xml-parser throws a plain Error, with no code or cause.
    if (!Error.isError(error)) throw error;
    throw new SitemapFormatError(error.message);
  }
  const loc = ({ loc }: z.infer<typeof entry>) => loc.trim();
  if (typeof document === 'object' && document !== null) {
    if ('urlset' in document) {
      const set = parseRoot('urlset', urlset, document.urlset);
      return { pages: (set?.url ?? []).map(loc), sitemaps: [] };
    }
    if ('sitemapindex' in document) {
      const index = parseRoot(
        'sitemapindex',
        sitemapindex,
        document.sitemapindex,
      );
      return {
        pages: [],
        sitemaps: (index?.sitemap ?? []).map(loc),
      };
    }
    if ('rss' in document) {
      const channel = parseRoot('rss', rss, document.rss)?.channel;
      return {
        pages:
          channel === undefined || channel === ''
            ? []
            : (channel.item ?? []).flatMap((item) =>
                item === '' ? [] : (item.link ?? []),
              ),
        sitemaps: [],
      };
    }
    if ('feed' in document) {
      const atom = parseRoot('feed', feed, document.feed);
      return {
        pages: (atom?.entry ?? []).flatMap((item) =>
          item === ''
            ? []
            : (item.link ?? [])
                .filter((link) => (link['@rel'] ?? 'alternate') === 'alternate')
                .flatMap((link) => link['@href'] ?? []),
        ),
        sitemaps: [],
      };
    }
  }
  throw new SitemapFormatError(
    'not a sitemap, sitemap index, RSS or Atom document',
  );
}
