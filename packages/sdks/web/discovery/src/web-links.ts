import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Configuration,
  EnqueueStrategy,
  RequestQueue,
  enqueueLinks,
} from '@crawlee/core';
import {
  defaultExtractFn,
  defaultHeadersOptions,
  defaultHtmlOptions,
} from 'feedscout/feeds';
import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';
import { type Got, HTTPError, RequestError, type Response } from 'got';

import { decodeSitemap } from '@workspace/codec-sitemap';

import { readFeedLinks, readHtml } from './html-discovery.ts';
import { readListing } from './listing.ts';
import { DiscoveryError, type PageLocation } from './web-discovery.ts';
import { webUrl } from './web-url.ts';

export type LinkedPage = PageLocation & {
  readonly depth: number;
  readonly follow: boolean;
};

export class WebLinks implements AsyncDisposable {
  readonly #queue: RequestQueue;
  readonly #limits: { readonly maxDepth: number; readonly maxPages: number };
  readonly #origins = new Set<string>();
  readonly #visited = new Set<string>();
  readonly #pages = new Map<string, PageLocation>();
  readonly #feeds: {
    url: string;
    kind: 'listing' | 'candidate';
    depth: number;
  }[] = [];
  #feedIndex = 0;
  #followed = 0;

  private constructor(
    queue: RequestQueue,
    limits: { readonly maxDepth: number; readonly maxPages: number },
  ) {
    this.#queue = queue;
    this.#limits = limits;
  }

  static async open(limits: {
    readonly maxDepth: number;
    readonly maxPages: number;
  }) {
    if (
      ![limits.maxDepth, limits.maxPages].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new RangeError('Link limits must be non-negative safe integers');
    return new WebLinks(
      await RequestQueue.open(undefined, {
        config: new Configuration({
          purgeOnStart: false,
          storageClientOptions: {
            persistStorage: false,
            writeMetadata: false,
            localDataDirectory: join(tmpdir(), 'web-discovery', randomUUID()),
          },
        }),
      }),
      limits,
    );
  }

  get hasCandidates() {
    return this.#pages.size > 0;
  }

  async seed(response: Response) {
    if (
      response.statusCode === 200 &&
      /^text\/html\b|^application\/xhtml\+xml\b/i.test(
        response.headers['content-type'] ?? '',
      )
    )
      this.#origins.add(new URL(response.url).origin);
    await this.#collect(response, 0, false);
    this.#visited.add(response.url);
    this.#visited.add(response.requestUrl.href);
  }

  async collect(response: Response, depth: number) {
    return this.#collect(response, depth, true);
  }

  async #collect(response: Response, depth: number, feeds: boolean) {
    if (
      response.statusCode !== 200 ||
      this.#visited.has(response.url) ||
      !this.#origins.has(new URL(response.url).origin)
    )
      return response;
    if (
      !/^text\/html\b|^application\/xhtml\+xml\b/i.test(
        response.headers['content-type'] ?? '',
      )
    )
      return response;
    this.#visited.add(response.url);
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers))
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const text = decodeSitemap(response.rawBody);
    const document = readHtml(text, response.url, headers);
    const urls = [...new Set([...document.links, ...document.archives])];
    for (const url of urls)
      if (!this.#pages.has(url))
        this.#pages.set(url, {
          url,
          lastModified: null,
          listingUrl: response.url,
        });
    await enqueueLinks({
      urls,
      requestQueue: this.#queue,
      baseUrl: response.url,
      strategy: EnqueueStrategy.SameOrigin,
      waitForAllRequestsToBeAdded: true,
      transformRequestFunction: (request) => ({
        ...request,
        uniqueKey: request.url,
        crawlDepth: depth + 1,
      }),
    });
    if (feeds) {
      const advertised = new Set(
        [
          ...discoverUrisFromHtml(text, {
            ...defaultHtmlOptions,
            baseUrl: response.url,
            anchorLabels: [],
            anchorAttributes: [],
          }),
          ...discoverUrisFromHeaders(headers, defaultHeadersOptions),
        ].map((uri) => webUrl(uri, response.url)),
      );
      this.#feeds.push(
        ...readFeedLinks(text, response.url, headers)
          .filter(
            (feed) =>
              feed.kind === 'listing' ||
              new URL(feed.url).origin === new URL(response.url).origin ||
              advertised.has(feed.url),
          )
          .map((feed) => ({ ...feed, depth: depth + 1 })),
      );
    }
    return response;
  }

  async take(
    http: Got,
    known: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<readonly LinkedPage[]> {
    let upstream = '';
    try {
      signal.throwIfAborted();
      while (this.#feedIndex < this.#feeds.length) {
        const feed = this.#feeds[this.#feedIndex++];
        if (!feed || this.#visited.has(feed.url)) continue;
        upstream = feed.url;
        this.#visited.add(feed.url);
        const response = await http(feed.url, {
          signal,
          responseType: 'buffer',
          throwHttpErrors: false,
        });
        upstream = response.url;
        this.#visited.add(response.url);
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const text = decodeSitemap(response.body);
        if (
          feed.kind === 'candidate' &&
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
        if (!response.ok || response.statusCode === 304)
          throw new HTTPError(response);
        // Secondary feeds contribute one document; the primary discovery owns complete pagination.
        const listing = readListing(text);
        for (const page of listing.pages) {
          const url = webUrl(page.url, response.url);
          this.#pages.set(url, { ...page, url, listingUrl: response.url });
          await this.#queue.addRequest({
            url,
            uniqueKey: url,
            crawlDepth: feed.depth,
          });
        }
      }
      const pages: LinkedPage[] = [];
      for await (const request of this.#queue) {
        signal.throwIfAborted();
        await this.#queue.markRequestHandled(request);
        if (this.#visited.has(request.url)) continue;
        const page = this.#pages.get(request.url);
        if (!page) throw new Error(`Missing link provenance: ${request.url}`);
        const follow =
          this.#origins.has(new URL(request.url).origin) &&
          request.crawlDepth <= this.#limits.maxDepth &&
          this.#followed < this.#limits.maxPages;
        if (follow) this.#followed++;
        if (known.has(request.url)) continue;
        pages.push({ ...page, depth: request.crawlDepth, follow });
      }
      return pages;
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof RequestError && cause.response)
        upstream = cause.response.url;
      throw new DiscoveryError(upstream, cause);
    }
  }

  async [Symbol.asyncDispose]() {
    await this.#queue.drop();
  }
}
