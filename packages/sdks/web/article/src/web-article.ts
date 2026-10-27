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
  readonly fingerprint: string;
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

// There is no cached representation to extract after a conditional response.
function readable(response: Response) {
  return response.ok && response.statusCode !== 304;
}

function page(response: Response): ArticlePage {
  return {
    url: response.url,
    body: response.rawBody,
    contentType: response.headers['content-type'],
  };
}

/** Each part is a response that extraction reads, or a fixed string in its place. */
function fingerprint(parts: readonly (Response | string)[]) {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (typeof part === 'string') {
      hash.update(JSON.stringify(part));
    } else {
      const metadata = [
        part.url,
        part.headers['content-type'],
        part.rawBody.length,
      ];
      hash.update(JSON.stringify(metadata)).update(part.rawBody);
    }
  }
  return hash.digest('hex');
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
    return this.#read(
      await this.#request(url, signal, acceptHeader(accepted)),
      signal,
      accepted,
      fallback,
    );
  }

  /** The response, also of an HTTP error, for the reader to judge. */
  async #request(url: string | URL, signal: AbortSignal, accept: string) {
    try {
      return await this.#http(url, {
        signal,
        responseType: 'buffer',
        headers: { accept },
      });
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof HTTPError) return cause.response;
      throw new ArticleError(
        cause instanceof RequestError && cause.response
          ? cause.response.url
          : String(url),
        cause,
      );
    }
  }

  // Every response that extraction can need is requested here, so the fingerprint covers it.
  async #read(
    response: Response,
    signal: AbortSignal,
    accepted: readonly string[],
    fallback: readonly string[] | undefined,
  ): Promise<ArticleDownload> {
    const url = response.url;
    // #request and #read throw only ArticleError, or the reason of a cancellation.
    const failure = (error: ArticleError) => {
      signal.throwIfAborted();
      return error;
    };
    return this.#attributed(url, signal, async () => {
      if (fallback && response.statusCode === 406)
        return await this.#download(url, signal, fallback, undefined);
      if (!readable(response)) throw new HTTPError(response);
      const type = mediaType(response.headers['content-type']);
      if (fallback !== undefined && type === 'text/markdown') {
        const companion = await this.#request(
          url,
          signal,
          acceptHeader(fallback),
        ).catch(failure);
        // The same response is the HTML companion and the HTML fallback.
        const html =
          companion instanceof ArticleError
            ? companion
            : await this.#read(companion, signal, fallback, undefined).catch(
                failure,
              );
        return {
          fingerprint: fingerprint([
            response,
            html instanceof ArticleError
              ? 'missing HTML companion'
              : html.fingerprint,
          ]),
          extract: () => this.#extractNative(response, companion, html, signal),
        };
      }
      const preferred =
        type === null
          ? []
          : accepted.slice(0, Math.max(0, accepted.indexOf(type)));
      const parts: (Response | string)[] = [response];
      const alternates: Response[] = [];
      const visited = new Set([url]);
      for (const alternative of this.#alternatives(response, preferred)) {
        const target = URL.parse(alternative, url);
        if (!target || !['http:', 'https:'].includes(target.protocol)) continue;
        target.hash = '';
        if (visited.has(target.href)) continue;
        visited.add(target.href);
        const alternate = await this.#request(
          target,
          signal,
          preferred.join(', '),
        ).catch(failure);
        if (alternate instanceof ArticleError || !readable(alternate))
          parts.push(`missing ${target.href}`);
        else {
          parts.push(alternate);
          alternates.push(alternate);
        }
      }
      return {
        fingerprint: fingerprint(parts),
        extract: () =>
          this.#attributed(url, signal, () =>
            this.#extractResponse(response, preferred, alternates, signal),
          ),
      };
    });
  }

  async #attributed<T>(
    url: string,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      signal.throwIfAborted();
      return await run();
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof ArticleError) throw cause;
      throw new ArticleError(url, cause);
    }
  }

  #extractNative(
    response: Response,
    companion: Response | ArticleError,
    html: ArticleDownload | ArticleError,
    signal: AbortSignal,
  ) {
    return this.#attributed(response.url, signal, async () => {
      let article: Article | null = null;
      try {
        article = await this.#extract(
          page(response),
          signal,
          this.#extractions,
        );
      } catch {
        // Native Markdown that cannot be read falls back to HTML.
        signal.throwIfAborted();
      }
      // The companion is optional; a readable native response survives its failure.
      if (article)
        return companion instanceof ArticleError || !readable(companion)
          ? article
          : this.#withHTML(article, companion, signal);
      if (html instanceof ArticleError) throw html;
      return html.extract();
    });
  }

  async #withHTML(
    native: Article,
    response: Response,
    signal: AbortSignal,
  ): Promise<Article> {
    const type = mediaType(response.headers['content-type']);
    if (!isHtml(type)) return native;
    let html: Article | null;
    try {
      html = await this.#extract(
        page(response),
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
    alternates: readonly Response[],
    signal: AbortSignal,
  ) {
    const extractions = this.#extractions.filter((extraction) =>
      extraction.mediaTypes.some((type) => preferred.includes(type)),
    );
    for (const alternate of alternates) {
      try {
        const article = await this.#extract(
          page(alternate),
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
    return this.#extract(page(response), signal, this.#extractions);
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
