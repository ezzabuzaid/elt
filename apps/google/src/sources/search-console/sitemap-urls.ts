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
  let document: unknown;
  try {
    document = parser.parse(text, true);
  } catch (cause) {
    throw new SitemapError(url, describe(cause), { cause });
  }
  const root = (name: string): unknown =>
    document !== null && typeof document === 'object'
      ? Reflect.get(document, name)
      : undefined;
  const urlset = root('urlset');
  if (urlset !== undefined)
    return { pages: locations(url, list(urlset, 'url')), sitemaps: [] };
  const index = root('sitemapindex');
  if (index !== undefined)
    return { pages: [], sitemaps: locations(url, list(index, 'sitemap')) };
  const rss = root('rss');
  if (rss !== undefined)
    return {
      pages: list(Reflect.get(Object(rss), 'channel'), 'item').flatMap((item) =>
        texts(Reflect.get(Object(item), 'link')),
      ),
      sitemaps: [],
    };
  const feed = root('feed');
  if (feed !== undefined)
    return {
      pages: list(feed, 'entry').flatMap((entry) =>
        list(entry, 'link')
          .filter((link) =>
            ['alternate', undefined].includes(
              Reflect.get(Object(link), '@rel'),
            ),
          )
          .flatMap((link) => texts(Reflect.get(Object(link), '@href'))),
      ),
      sitemaps: [],
    };
  throw new SitemapError(
    url,
    'not a sitemap, sitemap index, RSS or Atom document',
  );
}

function locations(url: string, entries: readonly unknown[]): string[] {
  return entries.map((entry) => {
    const location: unknown = Reflect.get(Object(entry), 'loc');
    if (typeof location !== 'string' || !location.trim())
      throw new SitemapError(url, 'an entry has no <loc>');
    return location.trim();
  });
}

function list(value: unknown, key: string): unknown[] {
  const entries: unknown =
    value !== null && typeof value === 'object'
      ? Reflect.get(value, key)
      : undefined;
  return Array.isArray(entries) ? entries : [];
}

function texts(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (text): text is string => typeof text === 'string' && text.trim() !== '',
  );
}

// fetch() reports every network failure as "fetch failed" and keeps the
// reason (for example ECONNRESET) on its cause, so the chain is spelled out.
function describe(cause: unknown): string {
  const reasons: string[] = [];
  for (let error = cause; error !== undefined && reasons.length < 3; ) {
    if (!(error instanceof Error)) {
      reasons.push(String(error));
      break;
    }
    const code: unknown = Reflect.get(error, 'code');
    reasons.push(
      typeof code === 'string' ? `${code}: ${error.message}` : error.message,
    );
    error = error.cause;
  }
  return reasons.join(' (') + ')'.repeat(reasons.length - 1);
}
