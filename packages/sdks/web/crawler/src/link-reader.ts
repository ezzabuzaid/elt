import { JSDOM, VirtualConsole } from 'jsdom';
import { lexer, walkTokens } from 'marked';
import { z } from 'zod';

import {
  type CrawlRequest,
  type Finding,
  Reader,
  type Visit,
  anchorText,
  isHtml,
  pageText,
} from './reader.ts';
import { httpUrl } from './web-url.ts';

const stateSchema = z.object({
  // Origins that the crawl expands within the limits: those of the starting pages.
  origins: z.array(z.string()),
  // Pages admitted beyond the starting and listed pages.
  followed: z.number().int().nonnegative(),
});
type State = z.infer<typeof stateSchema>;

/**
 * Ordinary links in HTML and Markdown pages: on the starting pages' origins,
 * and on every origin from a page that the crawl expands one step.
 */
export class LinkReader extends Reader<never, State> {
  readonly notes = z.never();
  readonly states = stateSchema;
  readonly #limits: { readonly maxDepth: number; readonly maxPages: number };

  constructor(limits: {
    readonly maxDepth: number;
    readonly maxPages: number;
  }) {
    super();
    if (
      ![limits.maxDepth, limits.maxPages].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new RangeError('Link limits must be non-negative safe integers');
    this.#limits = { ...limits };
  }

  open(): State {
    return { origins: [], followed: 0 };
  }

  wants(request: CrawlRequest, state: State) {
    if (
      !request.page ||
      request.hops === 0 ||
      request.hops > this.#limits.maxDepth ||
      state.followed >= this.#limits.maxPages ||
      !state.origins.includes(new URL(request.url).origin)
    )
      return false;
    state.followed++;
    return true;
  }

  read(
    { response, type, request, wanted }: Visit<never>,
    state: State,
  ): readonly Finding<never>[] | null {
    if (response.statusCode !== 200) return [];
    const markdown = type === 'text/markdown';
    if (!isHtml(type) && !markdown) return [];
    const origin = new URL(response.url).origin;
    if (request.expand === 'origin' && !state.origins.includes(origin))
      state.origins.push(origin);
    const step = request.expand === 'step';
    // A page on another origin gives no links.
    if (!step && !state.origins.includes(origin)) return [];
    // Starting and listed pages always contribute links; others only when
    // admitted, so a page that is not admitted this time is skipped.
    if (!step && request.hops > 0 && !wanted) return null;
    const text = pageText(response);
    const links = markdown
      ? markdownLinks(text)
      : htmlLinks(text, response.url);
    // Each page with the first text that links it, as a logo and a name can link one page.
    const pages = new Map<string, string | null>();
    for (const link of links) {
      const target = httpUrl(link.href, response.url);
      // The crawl keeps from a one-step expansion only the links that match its patterns.
      if (target && (step || new URL(target).origin === origin))
        pages.set(target, pages.get(target) ?? link.text);
    }
    return [...pages].map(([url, text]) => ({
      url,
      naming: { how: 'link' as const, text },
      lastModified: null,
      published: null,
      page: true,
      list: false,
      linked: true,
      tolerate: [404, 410],
      note: null,
      priority: 'link' as const,
    }));
  }
}

type Link = { readonly href: string; readonly text: string | null };

function markdownLinks(text: string) {
  const links: Link[] = [];
  // The callback is synchronous, so walkTokens returns no pending promise.
  void walkTokens(lexer(text), (token) => {
    if (token.type === 'link')
      links.push({
        href: token.href,
        text: token.text.replace(/\s+/g, ' ').trim() || null,
      });
  });
  return links;
}

function htmlLinks(html: string, url: string) {
  // jsdom's own console writes its errors, such as a stylesheet it cannot
  // parse, to the host's console.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    return [
      ...dom.window.document.querySelectorAll<HTMLAnchorElement>('a[href]'),
    ].map((anchor): Link => ({ href: anchor.href, text: anchorText(anchor) }));
  } finally {
    dom.window.close();
  }
}
