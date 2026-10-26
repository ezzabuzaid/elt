import type { Got } from 'got';

import {
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from '@workspace/sdk-web-article';

import { type ExtractorRun, RecordExtractor } from './record-extractor.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

/** One readable article per page, native Markdown first. */
export class ArticleExtractor extends RecordExtractor {
  readonly properties = {
    articleUrl: {
      ...text,
      description:
        'The article identity: the declared canonical URL, or the final URL when the page declares none. Two URLs of one article, such as with and without a trailing slash, have one articleUrl.',
    },
    url: { ...text, description: 'Final HTTP response URL after redirects.' },
    canonicalUrl: {
      ...nullableText,
      description: 'Declared HTTP(S) canonical URL.',
    },
    title: { ...nullableText, description: 'Extracted article title.' },
    byline: {
      ...nullableText,
      description: 'Author metadata as supplied by the page.',
    },
    publishedTime: {
      ...nullableText,
      description:
        'Publication metadata as supplied, without date inference or conversion.',
    },
    content: { ...text, description: 'Sanitized article HTML.' },
    markdown: {
      ...text,
      description:
        'Native Markdown body when available, otherwise converted from sanitized article HTML.',
    },
    textContent: {
      ...text,
      description: 'Readable article text, with paragraph and table structure.',
    },
    length: {
      type: 'integer',
      minimum: 0,
      description: 'Length of textContent in JavaScript string units.',
    },
    excerpt: {
      ...nullableText,
      description: 'Extracted description or first-paragraph excerpt.',
    },
    siteName: { ...nullableText, description: 'Publisher metadata.' },
    lang: { ...nullableText, description: 'Declared content language.' },
    dir: { ...nullableText, description: 'Declared content direction.' },
  } as const;

  open(http: Got): ExtractorRun {
    const article = new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      http,
    );
    return {
      accept: article.accept,
      async read(response, signal) {
        const download = await article.read(response, signal);
        return {
          fingerprint: download.fingerprint,
          async records() {
            const extracted = await download.extract();
            return extracted === null
              ? []
              : [
                  {
                    ...extracted,
                    articleUrl: extracted.canonicalUrl ?? extracted.url,
                    // Readability's public result permits undefined metadata; stream cells use null.
                    title: extracted.title ?? null,
                    byline: extracted.byline ?? null,
                    publishedTime: extracted.publishedTime ?? null,
                    excerpt: extracted.excerpt ?? null,
                    siteName: extracted.siteName ?? null,
                    lang: extracted.lang ?? null,
                    dir: extracted.dir ?? null,
                  },
                ];
          },
        };
      },
    };
  }
}
