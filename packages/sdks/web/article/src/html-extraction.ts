import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import createDOMPurify from 'dompurify';
import { minify } from 'html-minifier-next';
import { convert } from 'html-to-text';
import { type ConstructorOptions, JSDOM } from 'jsdom';
import { NodeHtmlMarkdown } from 'node-html-markdown';

import { type Article, type ArticlePage, Extraction } from './extraction.ts';

export type ArticleSelection = Omit<
  NonNullable<ReturnType<Readability['parse']>>,
  'content' | 'textContent' | 'length'
> & {
  readonly content: string;
  readonly canonicalUrl: string | null;
};

export class HTMLExtraction extends Extraction {
  override async extract(
    page: ArticlePage,
    signal: AbortSignal,
  ): Promise<Article | null> {
    signal.throwIfAborted();
    const options: ConstructorOptions = { url: page.url };
    if (page.contentType) options.contentType = page.contentType;
    const dom = new JSDOM(page.body, options);
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
        markdown: NodeHtmlMarkdown.translate(content, {
          codeBlockStyle: 'indented',
          // Escape literal HTML in prose; the converter leaves code spans/blocks alone.
          textReplace: [
            [/&/g, '&amp;'],
            [/</g, '&lt;'],
          ],
        }),
        textContent,
        length: textContent.length,
        url: page.url,
      };
    } finally {
      dom.window.close();
    }
  }

  protected async select(
    dom: JSDOM,
    _signal: AbortSignal,
  ): Promise<ArticleSelection | null> {
    for (const navigation of dom.window.document.querySelectorAll(
      'nav, [role="navigation"]',
    ))
      navigation.remove();
    const canonical = dom.window.document.querySelector<HTMLLinkElement>(
      'link[rel~="canonical"][href]',
    );
    let canonicalUrl = canonical ? URL.parse(canonical.href) : null;
    if (canonicalUrl && !['http:', 'https:'].includes(canonicalUrl.protocol))
      canonicalUrl = null;
    if (canonicalUrl) canonicalUrl.hash = '';
    // Post-class hints apply only where semantic article/main markup is absent.
    const postSelector =
      'body:not(:has(article, main, [role="article"], [role="main"])) :is(.h-entry, .hentry, .entry)';
    const markedPost = dom.window.document.querySelector(postSelector);
    const extracted = await Defuddle(
      dom.serialize(),
      dom.window.document.baseURI,
      {
        contentSelector: postSelector,
        // Declared content boundaries can contain editorial asides.
        removeExactSelectors:
          !markedPost &&
          !dom.window.document.querySelector(
            'article, main, [role="article"], [role="main"]',
          ),
        // Class-name substrings such as "frontMatter" can contain article prose.
        removePartialSelectors: false,
        // Keep linked title rows within a post; score clutter on unmarked pages.
        removeLowScoring: !markedPost,
        // Preserve the publisher's inline punctuation and code formatting.
        standardize: false,
        useAsync: false,
      },
    );
    const article = new Readability(dom.window.document, {
      charThreshold: 1,
    }).parse();
    if (!article || !extracted.content) return null;
    return {
      ...article,
      content: extracted.content,
      canonicalUrl: canonicalUrl && canonicalUrl.href,
    };
  }
}
