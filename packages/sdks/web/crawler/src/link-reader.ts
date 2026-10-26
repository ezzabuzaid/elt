import { discoverUrisFromHtml } from 'feedscout/methods';
import { lexer, walkTokens } from 'marked';
import { z } from 'zod';

import { decodeSitemap } from '@workspace/codec-sitemap';

import {
  type CrawlRequest,
  type Finding,
  Reader,
  type Visit,
  isHtml,
} from './reader.ts';
import { httpUrl } from './web-url.ts';

const stateSchema = z.object({
  // Origins of the starting pages; links are followed only there.
  origins: z.array(z.string()),
  // Pages admitted beyond the starting and listed pages.
  followed: z.number().int().nonnegative(),
});
type State = z.infer<typeof stateSchema>;

/** Ordinary links in HTML and Markdown pages, on the starting pages' origins. */
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
  ): readonly Finding<never>[] {
    if (response.statusCode !== 200) return [];
    const markdown = type === 'text/markdown';
    if (!isHtml(type) && !markdown) return [];
    const origin = new URL(response.url).origin;
    if (request.start && !state.origins.includes(origin))
      state.origins.push(origin);
    // Starting and listed pages always contribute links; others only when admitted.
    if ((request.hops > 0 && !wanted) || !state.origins.includes(origin))
      return [];
    const text = decodeSitemap(response.rawBody);
    const links = markdown
      ? markdownLinks(text)
      : discoverUrisFromHtml(text, {
          baseUrl: response.url,
          linkSelectors: [],
          anchorUris: [/.*/],
          anchorIgnoredUris: [],
          anchorLabels: [],
        });
    const pages = new Set<string>();
    for (const link of links) {
      const target = httpUrl(link, response.url);
      if (target && new URL(target).origin === origin) pages.add(target);
    }
    return [...pages].map((url) => ({
      url,
      lastModified: null,
      page: true,
      linked: true,
      tolerate: [404, 410],
      note: null,
      priority: 'link' as const,
    }));
  }
}

function markdownLinks(text: string) {
  const links: string[] = [];
  // The callback is synchronous, so walkTokens returns no pending promise.
  void walkTokens(lexer(text), (token) => {
    if (token.type === 'link') links.push(token.href);
  });
  return links;
}
