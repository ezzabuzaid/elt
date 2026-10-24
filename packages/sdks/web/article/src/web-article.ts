import { type Got, HTTPError, RequestError } from 'got';

import { type ArticlePage, type Extraction } from './extraction.ts';

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
    try {
      const response = await this.#http(url, {
        signal,
        responseType: 'buffer',
      });
      url = response.url;
      // There is no cached representation to extract after a conditional response.
      if (response.statusCode === 304) throw new HTTPError(response);
      const page: ArticlePage = {
        url,
        html: response.body,
        contentType: response.headers['content-type'],
      };
      for (const extraction of this.#extractions) {
        signal.throwIfAborted();
        const article = await extraction.extract(page, signal);
        signal.throwIfAborted();
        if (article !== null) return article;
      }
      return null;
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof RequestError && cause.response)
        url = cause.response.url;
      throw new ArticleError(url, cause);
    }
  }
}
