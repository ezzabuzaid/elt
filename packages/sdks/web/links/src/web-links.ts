import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Configuration, RequestQueue } from '@crawlee/core';
import { defaultExtractFn } from 'feedscout/feeds';
import { type Got, HTTPError, RequestError, type Response } from 'got';

import { decodeSitemap } from '@workspace/codec-sitemap';

import { readLinks } from './read-links.ts';
import { readListing } from './read-listing.ts';
import { webUrl } from './web-url.ts';

export type PageLocation = {
  readonly url: string;
  readonly listingUrl: string;
  /** Raw sitemap lastmod, never a publication date. */
  readonly lastModified: string | null;
};

export type LinkedPage = PageLocation & { readonly response: Response };

export class CrawlError extends Error {
  override readonly name = 'CrawlError';
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Crawl could not read ${url}: ${Error.isError(cause) ? cause.message : String(cause)}`,
      { cause },
    );
    this.url = url;
  }
}

export class WebLinks {
  readonly #http: Got;
  readonly #limits: { readonly maxDepth: number; readonly maxPages: number };

  constructor(
    http: Got,
    limits: { readonly maxDepth: number; readonly maxPages: number },
  ) {
    if (
      ![limits.maxDepth, limits.maxPages].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new RangeError('Link limits must be non-negative safe integers');
    this.#http = http;
    this.#limits = { ...limits };
  }

  async *crawl(
    inputs: Iterable<string | Response | PageLocation>,
    { signal }: { readonly signal: AbortSignal },
  ): AsyncGenerator<LinkedPage> {
    signal.throwIfAborted();
    await using resources = new AsyncDisposableStack();
    const queue = await RequestQueue.open(undefined, {
      config: new Configuration({
        purgeOnStart: false,
        storageClientOptions: {
          persistStorage: false,
          writeMetadata: false,
          localDataDirectory: join(tmpdir(), 'web-links', randomUUID()),
        },
      }),
    });
    resources.defer(() => queue.drop());
    type Job = {
      location: PageLocation;
      page: boolean;
      feed?: 'listing' | 'candidate';
      response?: Response;
    };
    const jobs = new Map<string, Job>();
    const visited = new Set<string>();
    const origins = new Set<string>();
    const errors: CrawlError[] = [];
    let followed = 0;

    const enqueue = async (
      location: PageLocation,
      depth: number,
      kind: 'page' | 'listing' | 'candidate',
      response?: Response,
    ) => {
      signal.throwIfAborted();
      const url = webUrl(location.url, location.listingUrl);
      const added = await queue.addRequest({
        url,
        uniqueKey: url,
        crawlDepth: depth,
      });
      const job = jobs.get(url);
      if (!added.wasAlreadyPresent)
        jobs.set(url, {
          location: { ...location, url },
          page: kind === 'page',
          feed: kind === 'page' ? undefined : kind,
          response,
        });
      else if (job) {
        job.page ||= kind === 'page';
        if (
          kind === 'listing' ||
          (kind === 'candidate' && job.feed === undefined)
        )
          job.feed = kind;
        job.response ??= response;
      }
    };

    for (const input of inputs) {
      const url = typeof input === 'string' ? input : input.url;
      await enqueue(
        typeof input !== 'string' && 'listingUrl' in input
          ? input
          : { url, listingUrl: webUrl(url, url), lastModified: null },
        0,
        'page',
        typeof input !== 'string' && 'rawBody' in input ? input : undefined,
      );
    }

    for await (const request of queue) {
      signal.throwIfAborted();
      const job = jobs.get(request.url);
      if (!job) throw new Error(`Missing crawl location: ${request.url}`);
      jobs.delete(request.url);
      await queue.markRequestHandled(request);
      if (visited.has(request.url)) continue;
      const follow =
        job.page &&
        (request.crawlDepth === 0 ||
          (origins.has(new URL(request.url).origin) &&
            request.crawlDepth <= this.#limits.maxDepth &&
            followed < this.#limits.maxPages));
      if (follow && request.crawlDepth > 0) followed++;
      let upstream = request.url;
      let response: Response;
      const children: {
        location: PageLocation;
        depth: number;
        kind: 'page' | 'listing' | 'candidate';
      }[] = [];
      try {
        response =
          job.response ??
          (await this.#http(request.url, {
            signal,
            responseType: 'buffer',
            throwHttpErrors: false,
          }));
        signal.throwIfAborted();
        upstream = webUrl(response.url, response.url);
        if (visited.has(upstream)) {
          visited.add(request.url);
          continue;
        }
        visited.add(request.url);
        visited.add(upstream);
        visited.add(webUrl(response.requestUrl.href, response.url));
        for (const redirect of response.redirectUrls)
          visited.add(webUrl(redirect.href, response.url));
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        if (job.feed) {
          const text = decodeSitemap(response.rawBody);
          const valid =
            job.feed === 'listing' ||
            (
              await defaultExtractFn({
                url: response.url,
                content: text,
                headers,
                status: response.statusCode,
              })
            ).isValid;
          if (valid) {
            if (!response.ok || response.statusCode === 304)
              throw new HTTPError(response);
            for (const page of readListing(text))
              children.push({
                location: {
                  ...page,
                  url: webUrl(page.url, response.url),
                  listingUrl: response.url,
                },
                depth: request.crawlDepth,
                kind: 'page',
              });
          } else if (!job.page) continue;
        }
        if (!response.ok || response.statusCode === 304) {
          if (
            request.crawlDepth > 0 &&
            job.feed !== 'listing' &&
            [404, 410].includes(response.statusCode)
          )
            continue;
          throw new HTTPError(response);
        }
        if (
          response.statusCode === 200 &&
          /^text\/html\b|^application\/xhtml\+xml\b/i.test(
            response.headers['content-type'] ?? '',
          )
        ) {
          if (request.crawlDepth === 0)
            origins.add(new URL(response.url).origin);
          if (follow && origins.has(new URL(response.url).origin)) {
            const document = readLinks(
              decodeSitemap(response.rawBody),
              response.url,
              headers,
            );
            for (const feed of document.feeds)
              children.push({
                location: {
                  url: feed.url,
                  listingUrl: response.url,
                  lastModified: null,
                },
                depth: request.crawlDepth + 1,
                kind: feed.kind,
              });
            for (const url of document.pages)
              children.push({
                location: { url, listingUrl: response.url, lastModified: null },
                depth: request.crawlDepth + 1,
                kind: 'page',
              });
          }
        }
      } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof RequestError && cause.response)
          upstream = cause.response.url;
        errors.push(new CrawlError(upstream, cause));
        continue;
      }
      for (const child of children)
        await enqueue(child.location, child.depth, child.kind);
      signal.throwIfAborted();
      if (job.page) yield { ...job.location, url: upstream, response };
    }
    signal.throwIfAborted();
    if (errors.length > 0)
      throw new AggregateError(errors, 'Some crawl pages could not be read');
  }
}
