import { discoverUrisFromHeaders } from 'feedscout/methods';
import { JSDOM } from 'jsdom';
import { z } from 'zod';

import { paginationLinks } from './listing.ts';
import {
  type Finding,
  Reader,
  type Visit,
  isHtml,
  pageText,
} from './reader.ts';
import { webUrl } from './web-url.ts';

/**
 * Lists of pages, such as categories and archives: the starting pages, the
 * pages a reader found as lists, and the pages their pagination reaches. It
 * hands back the pages each list links, follows the list's pagination, and
 * reads no other page.
 */
export class PaginationReader extends Reader<null, null> {
  readonly notes = z.null();
  readonly states = z.null();
  readonly #origins: readonly string[];
  readonly #pagination: readonly URLPattern[] | undefined;

  /**
   * @param options.origins Origins besides its own whose pages a list hands
   *   back, such as a blog whose cards link a sister site.
   * @param options.pagination The URL forms of a list's other pages, for a
   *   site that declares no rel="next"; omitted, a link to the same list with
   *   another page number is its pagination.
   */
  constructor({
    origins = [],
    pagination,
  }: {
    readonly origins?: readonly string[];
    readonly pagination?: readonly URLPattern[];
  } = {}) {
    super();
    for (const origin of origins)
      if (new URL(origin).origin !== origin)
        throw new TypeError(
          `Expected an origin, such as https://example.com: ${origin}`,
        );
    this.#origins = [...origins];
    this.#pagination = pagination && [...pagination];
  }

  open() {
    return null;
  }

  wants() {
    return false;
  }

  read({
    response,
    headers,
    type,
    request,
  }: Visit<null>): readonly Finding<null>[] {
    if (!request.start && !request.list) return [];
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    const { pagination, pages } = this.#readList(
      pageText(response),
      response.url,
      headers,
    );
    return [
      ...[...pages].map((url) => ({
        url,
        lastModified: null,
        page: true,
        list: false,
        linked: false,
        // An item that a list still links but that is gone, such as a sold listing, is an ordinary answer.
        tolerate: [404, 410],
        note: null,
        priority: 'page' as const,
      })),
      ...[...pagination].map(([url, tolerate]) => ({
        url,
        lastModified: null,
        page: false,
        list: true,
        linked: false,
        tolerate,
        note: null,
        // Later pages are backfill: they share downloads with the pages already listed instead of going first.
        priority: 'backfill' as const,
      })),
    ];
  }

  #readList(html: string, url: string, headers: Headers) {
    const dom = new JSDOM(html, { url });
    try {
      const document = dom.window.document;
      const origin = new URL(url).origin;
      // A declared next page that fails is an error; a page that a link only
      // looks like, such as Fortune's linked /page/0/ that answers 404, is not.
      const pagination = new Map<string, readonly number[]>(
        discoverUrisFromHeaders(headers, { linkSelectors: paginationLinks })
          .map((value) => webUrl(value, url))
          .filter((value) => new URL(value).origin === origin)
          .map((value) => [value, []]),
      );
      const list = pageOf(url);
      for (const link of document.querySelectorAll<
        HTMLAnchorElement | HTMLLinkElement
      >('a[href], link[href]')) {
        const target = URL.parse(link.href);
        if (!target || target.origin !== origin) continue;
        const next = webUrl(target.href, url);
        if (paginationLinks.some(({ rel }) => link.relList.contains(rel)))
          pagination.set(next, []);
        else if (
          !pagination.has(next) &&
          (this.#pagination === undefined
            ? isPageOf(next, url, list)
            : this.#pagination.some((pattern) => pattern.test(next)))
        )
          pagination.set(next, [404, 410]);
      }
      for (const navigation of document.querySelectorAll(
        'nav, footer, [role="navigation"]',
      ))
        navigation.remove();
      const pages = new Set<string>();
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        'a[href]',
      )) {
        const target = URL.parse(link.href);
        if (
          !target ||
          (target.origin !== origin && !this.#origins.includes(target.origin))
        )
          continue;
        const page = webUrl(target.href, url);
        if (!pagination.has(page)) pages.add(page);
      }
      return { pagination, pages };
    } finally {
      dom.window.close();
    }
  }
}

// The list a URL shows one page of, and whether the URL names a page number,
// in the CMS forms: /page/N/ (WordPress, Ghost, Hugo), ?page=N (Django,
// Drupal) and ?paged=N (WordPress). A trailing slash does not change the list.
function pageOf(value: string) {
  const list = new URL(value);
  const path = list.pathname.replace(/\/page\/\d+\/?$/, '');
  let numbered = path !== list.pathname;
  for (const key of ['page', 'paged']) {
    const page = list.searchParams.get(key);
    if (page !== null && /^\d+$/.test(page)) {
      list.searchParams.delete(key);
      numbered = true;
    }
  }
  list.pathname = path.replace(/\/$/, '');
  return { list: list.href, numbered };
}

// Another page of the same list: a year or a filter in the path or the query is a different list.
function isPageOf(
  target: string,
  url: string,
  list: ReturnType<typeof pageOf>,
) {
  const page = pageOf(target);
  return (
    target !== url &&
    page.list === list.list &&
    (page.numbered || list.numbered)
  );
}
