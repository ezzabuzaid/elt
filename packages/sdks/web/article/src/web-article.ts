import { createHash } from 'node:crypto';
import { MIMEType } from 'node:util';

import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';
import { type Got, HTTPError, RequestError, type Response } from 'got';
import { JSDOM } from 'jsdom';

import {
  type Article,
  type ArticlePage,
  type Extraction,
} from './extraction.ts';

type ArticleDownload = {
  readonly fingerprint: string | null;
  extract(): Promise<Article | null>;
};

export class ArticleError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Could not extract article from ${url}`, { cause });
    this.name = 'ArticleError';
    this.url = url;
  }
}

function mediaType(contentType: string | undefined) {
  return contentType ? new MIMEType(contentType).essence : null;
}

function isHtml(
  type: string | null,
): type is 'text/html' | 'application/xhtml+xml' {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function acceptHeader(types: readonly string[]) {
  return types
    .map((type, index) => `${type};q=${(1 / (index + 1)).toFixed(3)}`)
    .join(', ');
}

export class WebArticle {
  /** The Accept header for a page downloaded elsewhere and given to read(). */
  readonly accept: string;
  readonly #extractions: readonly Extraction[];
  readonly #http: Got;
  readonly #mediaTypes: readonly string[];
  readonly #fallback: readonly string[] | undefined;

  constructor(extractions: readonly Extraction[], http: Got) {
    if (extractions.length === 0)
      throw new TypeError('At least one article extraction is required');
    this.#extractions = extractions.slice();
    this.#http = http;
    this.#mediaTypes = [
      ...new Set(
        this.#extractions.flatMap((extraction) => extraction.mediaTypes),
      ),
    ];
    const htmlTypes = this.#mediaTypes.filter(isHtml);
    this.#fallback =
      this.#mediaTypes[0] === 'text/markdown' && htmlTypes.length > 0
        ? htmlTypes
        : undefined;
    this.accept = acceptHeader(this.#mediaTypes);
  }

  async fetch(url: string, signal: AbortSignal) {
    return (await this.download(url, signal)).extract();
  }

  async download(url: string, signal: AbortSignal) {
    return this.#download(url, signal, this.#mediaTypes, this.#fallback);
  }

  async read(response: Response, signal: AbortSignal) {
    return this.#read(response, signal, this.#mediaTypes, this.#fallback);
  }

  async #download(
    url: string,
    signal: AbortSignal,
    accepted: readonly string[],
    fallback: readonly string[] | undefined,
  ): Promise<ArticleDownload> {
    try {
      const response = await this.#http(url, {
        signal,
        responseType: 'buffer',
        headers: { accept: acceptHeader(accepted) },
      });
      return await this.#read(response, signal, accepted, fallback);
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof ArticleError) throw cause;
      if (cause instanceof HTTPError)
        return this.#read(cause.response, signal, accepted, fallback);
      if (cause instanceof RequestError && cause.response)
        url = cause.response.url;
      throw new ArticleError(url, cause);
    }
  }

  async #read(
    response: Response,
    signal: AbortSignal,
    accepted: readonly string[],
    fallback: readonly string[] | undefined,
  ): Promise<ArticleDownload> {
    const url = response.url;
    try {
      signal.throwIfAborted();
      if (fallback && response.statusCode === 406)
        return await this.#download(url, signal, fallback, undefined);
      // There is no cached representation to extract after a conditional response.
      if (!response.ok || response.statusCode === 304)
        throw new HTTPError(response);
      const contentType = response.headers['content-type'];
      const type = mediaType(contentType);
      const nativeMarkdown = fallback !== undefined && type === 'text/markdown';
      const preferred =
        type === null
          ? []
          : accepted.slice(0, Math.max(0, accepted.indexOf(type)));
      const alternatives = this.#alternatives(response, preferred);
      return {
        // Alternate and fallback representations can change independently of this response.
        fingerprint:
          alternatives.length > 0 || nativeMarkdown
            ? null
            : createHash('sha256')
                .update(JSON.stringify([url, contentType]))
                .update(response.rawBody)
                .digest('hex'),
        extract: async () => {
          try {
            signal.throwIfAborted();
            try {
              const article = await this.#extractResponse(
                response,
                preferred,
                alternatives,
                signal,
              );
              if (article && nativeMarkdown) {
                try {
                  const companion = await this.#http(url, {
                    signal,
                    responseType: 'buffer',
                    headers: { accept: fallback.join(', ') },
                  });
                  return await this.#withHTML(article, companion, signal);
                } catch {
                  // The companion is optional; a readable native response survives its failure.
                  signal.throwIfAborted();
                  return article;
                }
              }
              if (article !== null || !nativeMarkdown) return article;
            } catch (error) {
              signal.throwIfAborted();
              if (!nativeMarkdown) throw error;
            }
            return await (
              await this.#download(url, signal, fallback, undefined)
            ).extract();
          } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof ArticleError) throw cause;
            throw new ArticleError(url, cause);
          }
        },
      };
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof ArticleError) throw cause;
      throw new ArticleError(url, cause);
    }
  }

  async #withHTML(
    native: Article,
    response: Response,
    signal: AbortSignal,
  ): Promise<Article> {
    const contentType = response.headers['content-type'];
    const type = mediaType(contentType);
    if (!isHtml(type)) return native;
    let html: Article | null;
    try {
      html = await this.#extract(
        { url: response.url, body: response.rawBody, contentType },
        signal,
        this.#extractions.filter((extraction) =>
          extraction.mediaTypes.includes(type),
        ),
      );
    } catch {
      signal.throwIfAborted();
      return native;
    }
    if (!html) return native;
    return {
      ...html,
      url: native.url,
      markdown: native.markdown,
      title: native.title ?? html.title,
      byline: native.byline ?? html.byline,
      publishedTime: native.publishedTime ?? html.publishedTime,
      excerpt: native.excerpt ?? html.excerpt,
      canonicalUrl: native.canonicalUrl ?? html.canonicalUrl,
      siteName: native.siteName ?? html.siteName,
      lang: native.lang ?? html.lang,
      dir: native.dir ?? html.dir,
    };
  }

  #alternatives(response: Response, preferred: readonly string[]) {
    if (preferred.length === 0) return [];
    const { url } = response;
    const contentType = response.headers['content-type'];
    const linkSelectors = [{ rel: 'alternate', types: [...preferred] }];
    const headers = new Headers();
    if (response.headers.link)
      headers.set(
        'link',
        Array.isArray(response.headers.link)
          ? response.headers.link.join(', ')
          : response.headers.link,
      );
    const alternatives = discoverUrisFromHeaders(headers, { linkSelectors });
    if (isHtml(mediaType(contentType))) {
      const dom = new JSDOM(response.rawBody, { url, contentType });
      try {
        alternatives.push(
          ...discoverUrisFromHtml(dom.serialize(), {
            baseUrl: url,
            linkSelectors,
            anchorUris: [],
            anchorLabels: [],
            anchorIgnoredUris: [],
          }),
        );
      } finally {
        dom.window.close();
      }
    }
    return alternatives;
  }

  async #extractResponse(
    response: Response,
    preferred: readonly string[],
    alternatives: readonly string[],
    signal: AbortSignal,
  ) {
    const page: ArticlePage = {
      url: response.url,
      body: response.rawBody,
      contentType: response.headers['content-type'],
    };
    const { url } = page;
    const extractions = this.#extractions.filter((extraction) =>
      extraction.mediaTypes.some((type) => preferred.includes(type)),
    );
    const visited = new Set([url]);
    for (const alternative of alternatives) {
      const target = URL.parse(alternative, url);
      if (!target || !['http:', 'https:'].includes(target.protocol)) continue;
      target.hash = '';
      if (visited.has(target.href)) continue;
      visited.add(target.href);
      try {
        const alternate = await this.#http(target, {
          signal,
          responseType: 'buffer',
          headers: { accept: preferred.join(', ') },
        });
        const contentType = alternate.headers['content-type'];
        if (alternate.statusCode === 304) continue;
        const article = await this.#extract(
          { url: alternate.url, body: alternate.body, contentType },
          signal,
          extractions,
        );
        if (article)
          return preferred[0] === 'text/markdown'
            ? await this.#withHTML(article, response, signal)
            : article;
      } catch {
        // An optional representation must not hide the original page; cancellation still wins.
        signal.throwIfAborted();
      }
    }
    return this.#extract(page, signal, this.#extractions);
  }

  async #extract(
    page: ArticlePage,
    signal: AbortSignal,
    extractions: readonly Extraction[],
  ) {
    for (const extraction of extractions) {
      signal.throwIfAborted();
      const article = await extraction.extract(page, signal);
      signal.throwIfAborted();
      if (article !== null) return article;
    }
    return null;
  }
}
