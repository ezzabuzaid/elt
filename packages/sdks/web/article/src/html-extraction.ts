import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import type { JSDOM } from 'jsdom';

import { type ArticleSelection, Extraction } from './extraction.ts';

export class HTMLExtraction extends Extraction {
  protected override async select(
    dom: JSDOM,
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
