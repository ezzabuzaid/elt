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

export class ArticleError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Could not extract article from ${url}`, { cause });
    this.name = 'ArticleError';
    this.url = url;
  }
}

export class WebArticle {
  readonly #extractions: readonly Extraction[];
  readonly #http: Got;

  constructor(extractions: readonly Extraction[], http: Got) {
    if (extractions.length === 0)
      throw new TypeError('At least one article extraction is required');
    this.#extractions = extractions.slice();
    this.#http = http;
  }

  async fetch(url: string, signal: AbortSignal) {
    const mediaTypes = [
      ...new Set(
        this.#extractions.flatMap((extraction) => extraction.mediaTypes),
      ),
    ];
    const htmlTypes = mediaTypes.filter(
      (type) => type === 'text/html' || type === 'application/xhtml+xml',
    );
    return this.#fetch(
      url,
      signal,
      mediaTypes,
      mediaTypes[0] === 'text/markdown' && htmlTypes.length > 0
        ? htmlTypes
        : undefined,
    );
  }

  async #fetch(
    url: string,
    signal: AbortSignal,
    accepted: readonly string[],
    fallback?: readonly string[],
  ): Promise<Article | null> {
    try {
      let response: Response<Buffer>;
      try {
        response = await this.#http(url, {
          signal,
          responseType: 'buffer',
          headers: {
            accept: accepted
              .map((type, index) => `${type};q=${(1 / (index + 1)).toFixed(3)}`)
              .join(', '),
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        if (
          fallback &&
          error instanceof HTTPError &&
          error.response.statusCode === 406
        )
          return await this.#fetch(error.response.url, signal, fallback);
        throw error;
      }
      url = response.url;
      // There is no cached representation to extract after a conditional response.
      if (response.statusCode === 304) throw new HTTPError(response);
      const contentType = response.headers['content-type'];
      const type = contentType ? new MIMEType(contentType).essence : null;
      const preferred =
        type === null
          ? []
          : accepted.slice(0, Math.max(0, accepted.indexOf(type)));
      const alternatives = this.#alternatives(response, preferred);
      signal.throwIfAborted();
      try {
        const article = await this.#extractResponse(
          response,
          preferred,
          alternatives,
          signal,
        );
        if (article && fallback && type === 'text/markdown') {
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
        if (article !== null || !fallback || type !== 'text/markdown')
          return article;
      } catch (error) {
        signal.throwIfAborted();
        if (!fallback || type !== 'text/markdown') throw error;
      }
      return await this.#fetch(url, signal, fallback);
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof ArticleError) throw cause;
      if (cause instanceof RequestError && cause.response)
        url = cause.response.url;
      throw new ArticleError(url, cause);
    }
  }

  async #withHTML(
    native: Article,
    response: Response<Buffer>,
    signal: AbortSignal,
  ): Promise<Article> {
    const contentType = response.headers['content-type'];
    const type = contentType ? new MIMEType(contentType).essence : null;
    if (type !== 'text/html' && type !== 'application/xhtml+xml') return native;
    let html: Article | null;
    try {
      html = await this.#extract(
        { url: response.url, body: response.body, contentType },
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

  #alternatives(response: Response<Buffer>, preferred: readonly string[]) {
    if (preferred.length === 0) return [];
    const page: ArticlePage = {
      url: response.url,
      body: response.body,
      contentType: response.headers['content-type'],
    };
    const { url } = page;
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
    const type = page.contentType
      ? new MIMEType(page.contentType).essence
      : null;
    if (type === 'text/html' || type === 'application/xhtml+xml') {
      const dom = new JSDOM(page.body, { url, contentType: page.contentType });
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
    response: Response<Buffer>,
    preferred: readonly string[],
    alternatives: readonly string[],
    signal: AbortSignal,
  ) {
    const page: ArticlePage = {
      url: response.url,
      body: response.body,
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
