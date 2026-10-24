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
  detectAtomFeed,
  detectJsonFeed,
  detectRdfFeed,
  detectRssFeed,
  parseAtomFeed,
  parseJsonFeed,
  parseRdfFeed,
  parseRssFeed,
} from 'feedsmith';
import { type Got, HTTPError, RequestError } from 'got';
import { JSDOM } from 'jsdom';

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
  readonly #http: Got;

  constructor(http: Got) {
    this.#http = http;
  }

  async discover(
    input: string,
    signal: AbortSignal,
  ): Promise<readonly PageLocation[]> {
    let upstream = input;
    try {
      const queue: {
        url: string;
        kind: 'input' | 'robots' | 'listing' | 'candidate' | 'archive';
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
        const response = await this.#http(url, {
          signal,
          responseType: 'buffer',
          // Missing robots and invalid heuristic candidates are allowed below.
          throwHttpErrors: false,
        });
        upstream = response.url;
        visited.add(response.url);
        if (job.kind === 'archive' && [404, 410].includes(response.statusCode))
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
              kind: 'listing',
            });
          continue;
        }
        const contentType = headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType === 'text/html' ||
          contentType === 'application/xhtml+xml'
        ) {
          if (job.kind !== 'input' && job.kind !== 'archive')
            throw new Error('Expected a listing, received HTML');
          const archive = readArchive(text, response.url, headers);
          if (
            job.kind === 'archive' ||
            archive.archives.size > 0 ||
            /\/archives?\/?$/i.test(new URL(response.url).pathname)
          ) {
            foundListing = true;
            for (const url of archive.pages) {
              if (visited.has(url) || pages.has(url)) continue;
              pages.set(url, {
                url,
                lastModified: null,
                listingUrl: response.url,
              });
            }
            if (job.kind === 'archive') {
              for (const url of archive.archives)
                queue.push({ url, kind: 'archive' });
              continue;
            }
          }
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
              ...discoverUrisFromHeaders(headers, {
                linkSelectors: selectors,
              }),
            ])
              queue.push({ url: webUrl(uri, response.url), kind });
          }
          for (const url of archive.archives)
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

const paginationLinks = ['next', 'prev', 'prev-archive', 'next-archive'].map(
  (rel) => ({ rel }),
);

const calendarPath = new RegExp(
  `/\\d{4}(?:/(?:0?[1-9]|1[0-2]|${Array.from({ length: 12 }, (_, month) => {
    const name = new Date(Date.UTC(2000, month)).toLocaleString('en', {
      month: 'long',
    });
    return `${name}|${name.slice(0, 3)}`;
  }).join('|')}))?/?$`,
  'i',
);

function readArchive(html: string, url: string, headers: Headers) {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const origin = new URL(url).origin;
    const archives = new Set(
      discoverUrisFromHeaders(headers, {
        linkSelectors: [...paginationLinks, { rel: 'archives' }],
      })
        .map((value) => webUrl(value, url))
        .filter((value) => new URL(value).origin === origin),
    );
    for (const link of document.querySelectorAll<
      HTMLAnchorElement | HTMLLinkElement
    >('a[href], link[href]')) {
      const target = URL.parse(link.href);
      if (!target || target.origin !== origin) continue;
      if (
        ['archives', 'next', 'prev'].some((rel) =>
          link.relList.contains(rel),
        ) ||
        /\/archives?(?:\/|$)/i.test(target.pathname) ||
        calendarPath.test(target.pathname) ||
        /^(?:(?:blog|post|article|full|complete) )?archives?$|(?:^|\s)(?:older|newer|previous|next) (?:posts|entries|articles|page)(?:\s|$)|^(?:all|more) (?:posts|entries|articles|content)$|^content index$/i.test(
          link.textContent.trim(),
        )
      )
        archives.add(webUrl(target.href, url));
    }
    for (const navigation of document.querySelectorAll(
      'nav, footer, [role="navigation"]',
    ))
      navigation.remove();
    const pages = new Set<string>();
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      'a[href]',
    )) {
      const target = URL.parse(link.href);
      if (!target || target.origin !== origin) continue;
      const page = webUrl(target.href, url);
      if (!archives.has(page)) pages.add(page);
    }
    return { archives, pages };
  } finally {
    dom.window.close();
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
      sitemaps: feed.next_url === undefined ? [] : [feed.next_url],
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
  const listing = parseSitemap(text);
  const links = detectAtomFeed(text)
    ? parseAtomFeed(text).links
    : detectRssFeed(text)
      ? parseRssFeed(text).atom?.links
      : undefined;
  return {
    ...listing,
    sitemaps: [
      ...listing.sitemaps,
      ...(links ?? []).flatMap((link) =>
        link.href !== undefined &&
        link.rel !== undefined &&
        ['next', 'prev', 'prev-archive', 'next-archive'].includes(link.rel)
          ? [link.href]
          : [],
      ),
    ],
  };
}
