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

const noteSchema = z.object({ kind: z.literal('pagination') });
type Note = z.infer<typeof noteSchema>;

/**
 * Paginated lists, such as categories: the starting pages, the pages their
 * declared pagination reaches, and the pages each of them lists. It guesses
 * nothing from paths or labels, and reads no other page.
 */
export class PaginationReader extends Reader<Note, null> {
  readonly notes = noteSchema;
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
    note,
  }: Visit<Note>): readonly Finding<Note>[] {
    if (!request.start && note === null) return [];
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    const { pagination, pages } = readPagination(
      pageText(response),
      response.url,
      headers,
    );
    return [
      ...[...pages].map((url) => ({
        url,
        lastModified: null,
        page: true,
        linked: false,
        tolerate: [],
        note: null,
        priority: 'page' as const,
      })),
      ...[...pagination].map((url) => ({
        url,
        lastModified: null,
        page: false,
        linked: false,
        tolerate: [],
        note: { kind: 'pagination' as const },
        // Later pages are backfill: they share downloads with the pages already listed instead of going first.
        priority: 'backfill' as const,
      })),
    ];
  }
}

// Copied from readArchive in archive-reader.ts without its archive guesses (docs/copied-code.md).
function readPagination(html: string, url: string, headers: Headers) {
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
