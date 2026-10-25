import { RobotsTxtFile } from '@crawlee/utils';
import { defaultExtractFn } from 'feedscout/feeds';
import { discoverUrisFromHeaders } from 'feedscout/methods';
import { type Got, HTTPError, RequestError } from 'got';

import { decodeSitemap } from '@workspace/codec-sitemap';

import { readFeedLinks, readHtml } from './html-discovery.ts';
import { paginationLinks, readListing } from './listing.ts';
import type { WebLinks } from './web-links.ts';
import { webUrl } from './web-url.ts';

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
  readonly #http: Got;
  readonly #links: WebLinks | undefined;

  constructor(http: Got, links?: WebLinks) {
    this.#http = http;
    this.#links = links;
  }

  async discover(
    input: string,
    signal: AbortSignal,
  ): Promise<readonly PageLocation[]> {
    let upstream = input;
    try {
      signal.throwIfAborted();
      type ListingJob = {
        url: string;
        kind:
          'input' | 'robots' | 'listing' | 'candidate' | 'archive' | 'fallback';
      };
      const queue: ListingJob[] = [{ url: input, kind: 'input' }];
      const pages = new Map<string, PageLocation>();
      const visited = new Set<string>();
      let foundListing = false;
      let index = 0;
      while (index < queue.length) {
        const job = queue[index++];
        if (!job) break;
        upstream = job.url;
        signal.throwIfAborted();
        const url = webUrl(job.url, input);
        if (visited.has(url)) continue;
        visited.add(url);
        const response = await this.#http(url, {
          signal,
          responseType: 'buffer',
          // Missing robots and invalid heuristic candidates are allowed below.
          throwHttpErrors: false,
        });
        upstream = response.url;
        visited.add(response.url);
        await this.#links?.seed(response);
        if (
          job.kind === 'archive' &&
          [404, 410].includes(response.statusCode)
        ) {
          continue;
        }
        if (
          job.kind === 'fallback' &&
          this.#links?.hasCandidates &&
          [404, 410].includes(response.statusCode)
        )
          continue;
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        if (
          (!response.ok || response.statusCode === 304) &&
          job.kind !== 'candidate' &&
          !(job.kind === 'robots' && [404, 410].includes(response.statusCode))
        ) {
          throw new HTTPError(response);
        }
        const contentType = headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        const html =
          contentType === 'text/html' ||
          contentType === 'application/xhtml+xml';
        const text = decodeSitemap(response.body);
        if (
          job.kind === 'candidate' &&
          !(
            await defaultExtractFn({
              url: response.url,
              content: text,
              headers,
              status: response.statusCode,
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
          if (
            !foundListing &&
            !queue.some(
              (item) => item.kind === 'listing' || item.kind === 'archive',
            )
          )
            queue.push({
              url: new URL('/sitemap.xml', response.url).href,
              kind: 'fallback',
            });
          continue;
        }
        if (html) {
          if (job.kind !== 'input' && job.kind !== 'archive')
            throw new Error('Expected a listing, received HTML');
          const document = readHtml(text, response.url, headers);
          if (
            job.kind === 'archive' ||
            document.archives.size > 0 ||
            /\/archives?\/?$/i.test(new URL(response.url).pathname)
          ) {
            foundListing = true;
            for (const url of document.pages) {
              if (visited.has(url) || pages.has(url)) continue;
              pages.set(url, {
                url,
                lastModified: null,
                listingUrl: response.url,
              });
            }
            if (job.kind === 'archive') {
              for (const url of document.archives)
                queue.push({ url, kind: 'archive' });
              continue;
            }
          }
          queue.push(...readFeedLinks(text, response.url, headers));
          for (const url of document.archives)
            queue.push({ url, kind: 'archive' });
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
        for (const url of [
          ...listing.sitemaps,
          ...discoverUrisFromHeaders(headers, {
            linkSelectors: paginationLinks,
          }),
        ])
          queue.push({ url: webUrl(url, response.url), kind: 'listing' });
      }
      return [...pages.values()];
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof RequestError && cause.response)
        upstream = cause.response.url;
      throw new DiscoveryError(upstream, cause);
    }
  }
}
