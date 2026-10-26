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
 * pages a reader found as lists, and the pages their declared pagination
 * reaches. It hands back the pages each list links, follows the list's
 * pagination, and reads no other page.
 */
export class PaginationReader extends Reader<null, null> {
  readonly notes = z.null();
  readonly states = z.null();

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
    const { pagination, pages } = readList(
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
      ...[...pagination].map((url) => ({
        url,
        lastModified: null,
        page: false,
        list: true,
        linked: false,
        tolerate: [],
        note: null,
        // Later pages are backfill: they share downloads with the pages already listed instead of going first.
        priority: 'backfill' as const,
      })),
    ];
  }
}

function readList(html: string, url: string, headers: Headers) {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const origin = new URL(url).origin;
    const pagination = new Set(
      discoverUrisFromHeaders(headers, { linkSelectors: paginationLinks })
        .map((value) => webUrl(value, url))
        .filter((value) => new URL(value).origin === origin),
    );
    for (const link of document.querySelectorAll<
      HTMLAnchorElement | HTMLLinkElement
    >('a[href], link[href]')) {
      const target = URL.parse(link.href);
      if (!target || target.origin !== origin) continue;
      if (paginationLinks.some(({ rel }) => link.relList.contains(rel)))
        pagination.add(webUrl(target.href, url));
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
      if (!target || target.origin !== origin) continue;
      const page = webUrl(target.href, url);
      if (!pagination.has(page)) pages.add(page);
    }
    return { pagination, pages };
  } finally {
    dom.window.close();
  }
}
