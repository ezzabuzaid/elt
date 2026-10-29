import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import createDOMPurify from 'dompurify';
import { minify } from 'html-minifier-next';
import { convert } from 'html-to-text';
import { type ConstructorOptions, JSDOM } from 'jsdom';
import { NodeHtmlMarkdown } from 'node-html-markdown';

import { type Article, type ArticlePage, Extraction } from './extraction.ts';
import { listsPages } from './list-page.ts';

export type ArticleSelection = Omit<
  NonNullable<ReturnType<Readability['parse']>>,
  'content' | 'textContent' | 'length'
> & {
  readonly content: string;
  readonly canonicalUrl: string | null;
  readonly inferredPublished: string | null;
  /** What the page declares itself, or null when it declares neither. */
  readonly declared: 'article' | 'list' | null;
};

// schema.org's Article and its subtypes.
const articleTypes = new Set([
  'Article',
  'AdvertiserContentArticle',
  'NewsArticle',
  'AnalysisNewsArticle',
  'AskPublicNewsArticle',
  'BackgroundNewsArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  'ReviewNewsArticle',
  'Report',
  'SatiricalArticle',
  'ScholarlyArticle',
  'MedicalScholarlyArticle',
  'SocialMediaPosting',
  'BlogPosting',
  'LiveBlogPosting',
  'DiscussionForumPosting',
  'TechArticle',
  'APIReference',
]);

// schema.org's CollectionPage and its subtypes.
const collectionTypes = new Set([
  'CollectionPage',
  'MediaGallery',
  'ImageGallery',
  'VideoGallery',
]);

export class HTMLExtraction extends Extraction {
  readonly mediaTypes = ['text/html', 'application/xhtml+xml'];

  override async extract(
    page: ArticlePage,
    signal: AbortSignal,
  ): Promise<Article | null> {
    signal.throwIfAborted();
    const options: ConstructorOptions = { url: page.url };
    if (page.contentType) options.contentType = page.contentType;
    const dom = new JSDOM(page.body, options);
    try {
      const selection = await this.select(dom, signal);
      signal.throwIfAborted();
      if (!selection) return null;
      const { declared, ...article } = selection;
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
      const shape = listsPages(content, page.url);
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
        // Cards outweigh a declared article: a blog index keeps its CMS's
        // Article or og:type article (css-tricks.com, smashingmagazine.com).
        list:
          declared === 'list' ||
          shape === 'cards' ||
          (declared === null && shape === 'links'),
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
    // Post-class hints apply only where semantic article/main markup is
    // absent, and only on a page of one post: the first of several posts is
    // not the page's content. An .entry inside a .post is the same post.
    const postSelector =
      'body:not(:has(article, main, [role="article"], [role="main"])) :is(.h-entry, .hentry, .entry, .post)';
    const posts = [...dom.window.document.querySelectorAll(postSelector)];
    const outermostPosts = posts.filter(
      (post) => !posts.some((other) => other !== post && other.contains(post)),
    );
    const markedPost = outermostPosts.length === 1;
    const extracted = await Defuddle(
      dom.serialize(),
      dom.window.document.baseURI,
      {
        contentSelector: markedPost ? postSelector : undefined,
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
    // Readability reads JSON-LD only when @context is a string or names a
    // @vocab, while JSON-LD 1.1 also allows an array, as Fortune declares it;
    // the array's schema.org IRI stands for it (mozilla/readability#1030).
    for (const script of dom.window.document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      let data: unknown;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      if (
        typeof data !== 'object' ||
        data === null ||
        !('@context' in data) ||
        !Array.isArray(data['@context'])
      )
        continue;
      const schema: unknown = data['@context'].find(
        (entry: unknown) =>
          typeof entry === 'string' &&
          /^https?:\/\/schema\.org\/?$/.test(entry),
      );
      if (schema !== undefined)
        script.textContent = JSON.stringify({ ...data, '@context': schema });
    }
    // Readability accepts dateline substrings as bylines; remove that hint after content selection.
    for (const attribute of ['class', 'id']) {
      for (const element of dom.window.document.querySelectorAll(
        `[${attribute}*="dateline" i]`,
      )) {
        const value = element.getAttribute(attribute);
        if (value)
          element.setAttribute(attribute, value.replace(/dateline/gi, ' '));
      }
    }
    const article = new Readability(dom.window.document, {
      charThreshold: 1,
    }).parse();
    if (!article || !extracted.content) return null;
    // Defuddle gives the top-level JSON-LD objects of the page, whatever their @context.
    const data: unknown = extracted.schemaOrgData;
    const types = (Array.isArray(data) ? data : [data]).flatMap(
      (item: unknown) =>
        typeof item === 'object' && item !== null && '@type' in item
          ? [item['@type']].flat()
          : [],
    );
    const declares = (names: ReadonlySet<string>) =>
      types.some((type) => typeof type === 'string' && names.has(type));
    let declared: ArticleSelection['declared'] = null;
    if (declares(articleTypes)) declared = 'article';
    else if (declares(collectionTypes)) declared = 'list';
    // The schema.org type is the more specific: the-decoder.com's tag pages declare og:type article and a CollectionPage.
    else if (
      extracted.metaTags?.some(
        (tag) => tag.property === 'og:type' && tag.content === 'article',
      )
    )
      declared = 'article';
    // Defuddle reads the declared date first and otherwise takes a date from the text near the h1.
    const published = extracted.published
      ? Date.parse(extracted.published)
      : Number.NaN;
    return {
      ...article,
      content: extracted.content,
      canonicalUrl: canonicalUrl && canonicalUrl.href,
      inferredPublished: Number.isNaN(published)
        ? null
        : new Date(published).toISOString(),
      declared,
    };
  }
}
