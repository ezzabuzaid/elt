import { MIMEType } from 'node:util';

import createDOMPurify from 'dompurify';
import matter from 'gray-matter';
import { convert } from 'html-to-text';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Marked } from 'marked';
import { isDocument, parseDocument } from 'yaml';

import { type Article, type ArticlePage, Extraction } from './extraction.ts';
import { listsPages } from './list-page.ts';

export class MarkdownExtraction extends Extraction {
  readonly mediaTypes = ['text/markdown'];

  override async extract(
    page: ArticlePage,
    signal: AbortSignal,
  ): Promise<Article | null> {
    signal.throwIfAborted();
    const type = page.contentType ? new MIMEType(page.contentType) : null;
    const file = /\.(md|markdown)$/i.test(new URL(page.url).pathname);
    if (
      !(type && this.mediaTypes.includes(type.essence)) &&
      !(file && (type === null || type.essence === 'text/plain'))
    )
      return null;
    const source =
      typeof page.body === 'string'
        ? page.body
        : new TextDecoder(type?.params.get('charset') ?? undefined).decode(
            page.body,
          );
    const { content: markdown, data } = matter(source, {
      engines: {
        // YAML 1.2 keeps publication dates as source strings rather than Date objects.
        yaml: (input) => {
          const document = parseDocument(input);
          if (document.errors[0]) throw document.errors[0];
          return document;
        },
        javascript: () => {
          throw new TypeError('Executable front matter is not supported');
        },
      },
    });
    const metadata: unknown = data;
    const field = (name: string) => {
      const value: unknown = isDocument(metadata) ? metadata.get(name) : null;
      return typeof value === 'string' ? value : null;
    };
    // jsdom's own console writes its errors, such as a stylesheet it cannot
    // parse, to the host's console.
    const dom = new JSDOM(await new Marked().parse(markdown), {
      url: page.url,
      virtualConsole: new VirtualConsole(),
    });
    try {
      signal.throwIfAborted();
      const { document } = dom.window;
      createDOMPurify(dom.window).sanitize(document.body, { IN_PLACE: true });
      if (!document.body.textContent?.trim()) return null;
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        'a[href]',
      ))
        link.setAttribute('href', link.href);
      for (const image of document.querySelectorAll<HTMLImageElement>(
        'img[src]',
      ))
        image.setAttribute('src', image.src);
      const content = document.body.innerHTML;
      const textContent = convert(content, {
        wordwrap: false,
        selectors: [{ selector: 'table', format: 'dataTable' }],
      });
      return {
        url: page.url,
        canonicalUrl: null,
        title:
          field('title') ?? document.querySelector('h1')?.textContent ?? null,
        byline: field('author'),
        excerpt:
          field('description') ??
          document.querySelector('p')?.textContent ??
          null,
        siteName: null,
        lang: null,
        dir: null,
        publishedTime: field('date'),
        inferredPublished: null,
        content,
        markdown,
        textContent,
        length: textContent.length,
        list: listsPages(content, page.url) !== null,
      };
    } finally {
      dom.window.close();
    }
  }
}
