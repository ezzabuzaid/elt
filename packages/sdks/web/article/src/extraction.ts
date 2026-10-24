import type { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { minify } from 'html-minifier-next';
import { convert } from 'html-to-text';
import { type ConstructorOptions, JSDOM } from 'jsdom';

export type ArticlePage = {
  readonly url: string;
  readonly html: string | Buffer;
  readonly contentType: string | undefined;
};

export type ArticleSelection = Omit<
  NonNullable<ReturnType<Readability['parse']>>,
  'content' | 'textContent' | 'length'
> & {
  readonly content: string;
  readonly canonicalUrl: string | null;
};

export type Article = NonNullable<Awaited<ReturnType<Extraction['extract']>>>;

export abstract class Extraction {
  protected abstract select(
    dom: JSDOM,
    signal: AbortSignal,
  ): Promise<ArticleSelection | null>;

  async extract(page: ArticlePage, signal: AbortSignal) {
    signal.throwIfAborted();
    const options: ConstructorOptions = { url: page.url };
    if (page.contentType) options.contentType = page.contentType;
    const dom = new JSDOM(page.html, options);
    try {
      const article = await this.select(dom, signal);
      signal.throwIfAborted();
      if (!article) return null;
      const content = createDOMPurify(dom.window).sanitize(
        await minify(article.content, {
          collapseWhitespace: true,
          conservativeCollapse: true,
          removeComments: true,
        }),
        { FORBID_TAGS: ['footer'], ADD_FORBID_CONTENTS: ['footer'] },
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
        url: page.url,
      } as const;
    } finally {
      dom.window.close();
    }
  }
}
