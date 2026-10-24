import { RobotsTxtFile } from '@crawlee/utils';
import { XMLValidator } from 'fast-xml-parser';
import {
  anchorAttributes,
  anchorLabels,
  defaultExtractFn,
  linkSelectors,
} from 'feedscout/feeds';
import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';
import {
  detectJsonFeed,
  detectRdfFeed,
  parseJsonFeed,
  parseRdfFeed,
} from 'feedsmith';

import {
  type SitemapListing,
  decodeSitemap,
  parseSitemap,
} from '@workspace/codec-sitemap';

export type PageLocation = {
  readonly url: string;
  /** Raw sitemap lastmod, never a publication date. */
  readonly lastModified: string | null;
  /** Final URL of the listing which first supplied this candidate. */
  readonly listingUrl: string;
};

export class DiscoveryError extends Error {
  override readonly name = 'DiscoveryError';
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(
      `Discovery could not read ${url}: ${Error.isError(cause) ? cause.message : String(cause)}`,
      { cause },
    );
    this.url = url;
  }
}

export class WebDiscovery {
  async discover(
    input: string,
    signal: AbortSignal,
  ): Promise<readonly PageLocation[]> {
    let upstream = input;
    try {
      const queue: {
        url: string;
        kind: 'input' | 'robots' | 'listing' | 'candidate';
      }[] = [{ url: input, kind: 'input' }];
      const pages = new Map<string, PageLocation>();
      const visited = new Set<string>();
      let foundListing = false;
      for (const job of queue) {
        upstream = job.url;
        signal.throwIfAborted();
        const url = webUrl(job.url, input);
        if (visited.has(url)) continue;
        visited.add(url);
        const response = await fetch(url, { signal });
        upstream = response.url;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          !response.ok &&
          job.kind !== 'candidate' &&
          !(job.kind === 'robots' && [404, 410].includes(response.status))
        ) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = decodeSitemap(bytes);
        if (
          job.kind === 'candidate' &&
          !(
            await defaultExtractFn({
              url: response.url,
              content: text,
              headers: response.headers,
              status: response.status,
            })
          ).isValid
        )
          continue;
        if (job.kind === 'robots') {
          const sitemaps = response.ok
            ? RobotsTxtFile.from(response.url, text).getSitemaps({
                enqueueStrategy: 'all',
              })
            : [];
          for (const url of sitemaps)
            queue.push({ url: webUrl(url, response.url), kind: 'listing' });
          if (!foundListing && !queue.some((item) => item.kind === 'listing'))
            queue.push({
              url: new URL('/sitemap.xml', response.url).href,
              kind: 'listing',
            });
          continue;
        }
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType === 'text/html' ||
          contentType === 'application/xhtml+xml'
        ) {
          if (job.kind !== 'input')
            throw new Error('Expected a listing, received HTML');
          for (const { kind, selectors } of [
            {
              kind: 'listing',
              selectors: [
                ...linkSelectors.map((selector) =>
                  selector.types === undefined
                    ? selector
                    : {
                        ...selector,
                        types: selector.types.filter(
                          (type) => type !== 'application/json',
                        ),
                      },
                ),
                { rel: 'sitemap' },
              ],
            },
            {
              kind: 'candidate',
              selectors: [{ rel: 'alternate', types: ['application/json'] }],
            },
          ] satisfies {
            kind: 'listing' | 'candidate';
            selectors: typeof linkSelectors;
          }[]) {
            for (const uri of [
              ...discoverUrisFromHtml(text, {
                baseUrl: response.url,
                linkSelectors: selectors,
                anchorUris: [],
                anchorIgnoredUris: [],
                anchorLabels:
                  kind === 'candidate'
                    ? anchorLabels.map(
                        (label) =>
                          new RegExp(`\\b${RegExp.escape(label)}\\b`, 'i'),
                      )
                    : [],
                anchorAttributes: kind === 'candidate' ? anchorAttributes : [],
              }),
              ...discoverUrisFromHeaders(response.headers, {
                linkSelectors: selectors,
              }),
            ])
              queue.push({ url: webUrl(uri, response.url), kind });
          }
          queue.push({
            url: new URL('/robots.txt', response.url).href,
            kind: 'robots',
          });
          continue;
        }
        const listing = readListing(text);
        foundListing = true;
        for (const page of listing.pages) {
          const url = webUrl(page.url, response.url);
          if (!pages.has(url))
            pages.set(url, { ...page, url, listingUrl: response.url });
        }
        for (const url of listing.sitemaps)
          queue.push({ url: webUrl(url, response.url), kind: 'listing' });
      }
      return [...pages.values()];
    } catch (cause) {
      signal.throwIfAborted();
      throw new DiscoveryError(upstream, cause);
    }
  }
}

function webUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`Expected HTTP(S) URL: ${url.href}`);
  url.hash = '';
  return url.href;
}

function readListing(text: string): SitemapListing {
  if (detectJsonFeed(text)) {
    const feed = parseJsonFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.url === undefined ? [] : [{ url: item.url, lastModified: null }],
      ),
      sitemaps: [],
    };
  }
  if (detectRdfFeed(text)) {
    // Feedsmith parses RDF without asking its XML parser to validate it.
    const valid = XMLValidator.validate(text);
    if (valid !== true) throw new Error(valid.err.msg);
    const feed = parseRdfFeed(text);
    return {
      pages: (feed.items ?? []).flatMap((item) =>
        item.link === undefined ? [] : [{ url: item.link, lastModified: null }],
      ),
      sitemaps: [],
    };
  }
  return parseSitemap(text);
}
