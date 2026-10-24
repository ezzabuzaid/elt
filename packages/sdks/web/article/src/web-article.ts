import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import createDOMPurify from 'dompurify';
import { type Got, HTTPError, RequestError } from 'got';
import { minify } from 'html-minifier-next';
import { convert } from 'html-to-text';
import { JSDOM } from 'jsdom';
import type { ConstructorOptions } from 'jsdom';

export type Article = NonNullable<Awaited<ReturnType<WebArticle['fetch']>>>;

export class ArticleError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Could not extract article from ${url}`, { cause });
    this.name = 'ArticleError';
    this.url = url;
  }
}

export class WebArticle {
  readonly #http: Got;

  constructor(http: Got) {
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
      const options: ConstructorOptions = { url };
      const contentType = response.headers['content-type'];
      if (contentType) options.contentType = contentType;
      const dom = new JSDOM(response.body, options);
      try {
        for (const navigation of dom.window.document.querySelectorAll(
          'nav, [role="navigation"]',
        ))
          navigation.remove();
        const canonical = dom.window.document.querySelector<HTMLLinkElement>(
          'link[rel~="canonical"][href]',
        );
        let canonicalUrl = canonical ? URL.parse(canonical.href) : null;
        if (
          canonicalUrl &&
          !['http:', 'https:'].includes(canonicalUrl.protocol)
        )
          canonicalUrl = null;
        if (canonicalUrl) canonicalUrl.hash = '';
        const extracted = await Defuddle(
          dom.serialize(),
          dom.window.document.baseURI,
          {
            // Class-name substrings such as "frontMatter" can contain article prose.
            removePartialSelectors: false,
            // Preserve the publisher's inline punctuation and code formatting.
            standardize: false,
            useAsync: false,
          },
        );
        const article = new Readability(dom.window.document, {
          charThreshold: 1,
        }).parse();
        if (!article || !extracted.content) return null;
        const content = createDOMPurify(dom.window).sanitize(
          await minify(extracted.content, {
            collapseWhitespace: true,
            conservativeCollapse: true,
            removeComments: true,
          }),
        );
        const prose = JSDOM.fragment(content);
        for (const link of prose.querySelectorAll(
          'a[href]:not(article a, [role="article"] a, table a)',
        ))
          link.remove();
        if (!prose.textContent?.trim()) return null;
        const textContent = convert(content, {
          wordwrap: false,
          selectors: [{ selector: 'table', format: 'dataTable' }],
        });
        return {
          ...article,
          content,
          textContent,
          length: textContent.length,
          url,
          canonicalUrl: canonicalUrl && canonicalUrl.href,
        } as const;
      } finally {
        dom.window.close();
      }
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof RequestError && cause.response)
        url = cause.response.url;
      throw new ArticleError(url, cause);
    }
  }
}
