import {
  SitemapFormatError,
  type SitemapListing,
  decodeSitemap,
  parseSitemap,
} from '@workspace/codec-sitemap';

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

// Google does not support nested indexes; a few levels tolerate sites that
// nest anyway without letting a cycle or a crawler trap run forever.
const MAX_DEPTH = 3;
const TIMEOUT_MS = 60_000;

// One listed sitemap's outcome: its page URLs (following any index it is),
// or why it could not be read.
export type SitemapRead =
  | { readonly urls: readonly string[]; readonly error: null }
  | { readonly urls: null; readonly error: string };

/**
 * Reads each listed sitemap on its own, so one broken sitemap does not hide
 * the pages the others list; its failure is returned for the caller to
 * record rather than dropped. An abort of signal stops the read and rejects
 * with its reason; it is not a sitemap's failure.
 */
export async function readSitemaps(
  sitemapUrls: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, SitemapRead>> {
  const reads = new Map<string, SitemapRead>();
  for (const url of sitemapUrls) {
    try {
      reads.set(url, {
        urls: [...(await readSitemapUrls([url], signal))],
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
  sitemapUrls: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  const urls = new Set<string>();
  const visited = new Set<string>();
  const queue = sitemapUrls.map((url) => ({ url, depth: 0 }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    const listing = parse(next.url, await download(next.url, signal));
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

async function download(
  url: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.any([
        AbortSignal.timeout(TIMEOUT_MS),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    throw new SitemapError(url, describe(cause), { cause });
  }
  try {
    return decodeSitemap(bytes);
  } catch (cause) {
    throw new SitemapError(url, describe(cause), { cause });
  }
}

function parse(url: string, text: string): SitemapListing {
  try {
    return parseSitemap(text);
  } catch (error) {
    if (!(error instanceof SitemapFormatError)) throw error;
    throw new SitemapError(url, error.message, { cause: error });
  }
}

// fetch() reports every network failure as "fetch failed" and keeps the
// reason (for example ECONNRESET) on its cause, so the chain is spelled out.
function describe(cause: unknown): string {
  const reasons: string[] = [];
  for (
    let error = cause;
    Error.isError(error) && reasons.length < 3;
    error = error.cause
  )
    reasons.push(
      'code' in error && typeof error.code === 'string' && error.code
        ? `${error.code}: ${error.message}`
        : error.message,
    );
  if (reasons.length === 0) reasons.push(String(cause));
  return reasons.join(' (') + ')'.repeat(reasons.length - 1);
}
