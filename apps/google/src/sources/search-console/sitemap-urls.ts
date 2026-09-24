import { gunzipSync } from 'node:zlib';

import { XMLParser } from 'fast-xml-parser';

export type SitemapFetch = (
  url: string,
  init: { readonly redirect: 'follow'; readonly signal: AbortSignal },
) => Promise<Response>;

export class SitemapError extends Error {
  override readonly name = 'SitemapError';
  readonly sitemapUrl: string;

  constructor(
    sitemapUrl: string,
    reason: string,
    options?: { cause: unknown },
  ) {
    super(`Sitemap ${sitemapUrl} could not be read: ${reason}`, options);
    this.sitemapUrl = sitemapUrl;
  }
}

// The protocol's ceiling for one sitemap file, uncompressed.
const MAX_BYTES = 50 * 1024 * 1024;
// Google does not support nested indexes; a few levels tolerate sites that
// nest anyway without letting a cycle or a crawler trap run forever.
const MAX_DEPTH = 3;
const TIMEOUT_MS = 60_000;

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

// One listed sitemap's outcome: its page URLs (following any index it is),
// or why it could not be read.
export type SitemapRead =
  | { readonly urls: readonly string[]; readonly error: null }
  | { readonly urls: null; readonly error: string };

/**
 * Reads each listed sitemap on its own, so one broken sitemap does not hide
 * the pages the others list; its failure is returned for the caller to
 * record rather than dropped.
 */
export async function readSitemaps(
  fetch: SitemapFetch,
  sitemapUrls: readonly string[],
): Promise<Map<string, SitemapRead>> {
  const reads = new Map<string, SitemapRead>();
  for (const url of sitemapUrls) {
    try {
      reads.set(url, {
        urls: [...(await readSitemapUrls(fetch, [url]))],
        error: null,
      });
    } catch (error) {
      if (!(error instanceof SitemapError)) throw error;
      reads.set(url, { urls: null, error: error.message });
    }
  }
  return reads;
}

/**
 * Every page URL the given sitemaps list: XML url sets, sitemap indexes
 * (followed), RSS 2.0 and Atom feeds, and plain-text lists, gzipped or not.
 * Throws SitemapError naming the first sitemap that cannot be read.
 */
async function readSitemapUrls(
  fetch: SitemapFetch,
  sitemapUrls: readonly string[],
): Promise<Set<string>> {
  const urls = new Set<string>();
  const visited = new Set<string>();
  const queue = sitemapUrls.map((url) => ({ url, depth: 0 }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    const listing = parse(next.url, await download(fetch, next.url));
    for (const url of listing.pages) urls.add(url);
    for (const child of listing.sitemaps) {
      if (next.depth >= MAX_DEPTH)
        throw new SitemapError(
          next.url,
          `sitemap indexes nest deeper than ${MAX_DEPTH} levels`,
        );
      queue.push({ url: child, depth: next.depth + 1 });
    }
  }
  return urls;
}

async function download(fetch: SitemapFetch, url: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new SitemapError(url, describe(cause), { cause });
  }
  try {
    const body =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes, { maxOutputLength: MAX_BYTES })
        : bytes;
    if (body.byteLength > MAX_BYTES)
      throw new Error(`larger than ${MAX_BYTES} bytes`);
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (cause) {
    throw new SitemapError(url, describe(cause), { cause });
  }
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

function parse(
  url: string,
  text: string,
): { pages: readonly string[]; sitemaps: readonly string[] } {
  if (!text.trimStart().startsWith('<')) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines)
      if (!URL.canParse(line))
        throw new SitemapError(
          url,
          `line ${JSON.stringify(line)} is not a URL`,
        );
    return { pages: lines, sitemaps: [] };
  }
  let document: SitemapDocument;
  try {
    document = parser.parse(text, true);
  } catch (cause) {
    throw new SitemapError(url, describe(cause), { cause });
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
  throw new SitemapError(
    url,
    'not a sitemap, sitemap index, RSS or Atom document',
  );
}

// fetch() reports every network failure as "fetch failed" and keeps the
// reason (for example ECONNRESET) on its cause, so the chain is spelled out.
function describe(cause: unknown): string {
  const reasons: string[] = [];
  let error = cause as (Error & { code?: string }) | undefined;
  for (
    ;
    error instanceof Error && reasons.length < 3;
    error = error.cause as typeof error
  )
    reasons.push(
      error.code ? `${error.code}: ${error.message}` : error.message,
    );
  if (reasons.length === 0) reasons.push(String(cause));
  return reasons.join(' (') + ')'.repeat(reasons.length - 1);
}
