import { Readability, isProbablyReaderable } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
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
  async fetch(url: string, signal: AbortSignal) {
    try {
      const response = await fetch(url, { signal });
      url = response.url;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const options: ConstructorOptions = { url };
      const contentType = response.headers.get('content-type');
      if (contentType) options.contentType = contentType;
      const dom = new JSDOM(Buffer.from(await response.arrayBuffer()), options);
      try {
        if (
          !isProbablyReaderable(dom.window.document, {
            minContentLength: 0,
            minScore: 0,
          })
        )
          return null;
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
        const article = new Readability(dom.window.document).parse();
        if (!article?.content) return null;
        const content = createDOMPurify(dom.window).sanitize(article.content);
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
      throw new ArticleError(url, cause);
    }
  }
}
