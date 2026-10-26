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

const noteSchema = z.object({ kind: z.literal('archive') });
type Note = z.infer<typeof noteSchema>;

const calendarPath = new RegExp(
  `/\\d{4}(?:/(?:0?[1-9]|1[0-2]|${Array.from({ length: 12 }, (_, month) => {
    const name = new Date(Date.UTC(2000, month)).toLocaleString('en', {
      month: 'long',
    });
    return `${name}|${name.slice(0, 3)}`;
  }).join('|')}))?/?$`,
  'i',
);

/** HTML archives: archive indexes, calendar pages and pagination, and the pages they list. */
export class ArchiveReader extends Reader<Note, null> {
  readonly notes = noteSchema;
  readonly states = z.null();
  readonly #startsAreArchives: boolean;

  /** `starts: 'archives'` takes every starting page for an archive, such as a category whose pages fit on one page. */
  constructor(options: { readonly starts?: 'archives' } = {}) {
    super();
    this.#startsAreArchives = options.starts === 'archives';
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
    note,
  }: Visit<Note>): readonly Finding<Note>[] {
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    const { archives, pages } = readArchive(
      pageText(response),
      response.url,
      headers,
    );
    // A starting page lists pages when the caller declares it an archive, links archives or is an archive itself.
    const listing =
      note !== null ||
      (request.start &&
        (this.#startsAreArchives ||
          archives.size > 0 ||
          /\/archives?\/?$/i.test(new URL(response.url).pathname)));
    return [
      ...(listing
        ? [...pages].map((url) => ({
            url,
            lastModified: null,
            page: true,
            linked: false,
            tolerate: [],
            note: null,
            priority: 'page' as const,
          }))
        : []),
      ...[...archives].map((url) => ({
        url,
        lastModified: null,
        page: false,
        linked: !request.start && note === null,
        tolerate: [404, 410],
        note: { kind: 'archive' as const },
        // Archives are backfill: they share downloads with new pages instead of going first.
        priority: 'backfill' as const,
      })),
    ];
  }
}

function readArchive(html: string, url: string, headers: Headers) {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const origin = new URL(url).origin;
    const archives = new Set(
      discoverUrisFromHeaders(headers, {
        linkSelectors: [...paginationLinks, { rel: 'archives' }],
      })
        .map((value) => webUrl(value, url))
        .filter((value) => new URL(value).origin === origin),
    );
    for (const link of document.querySelectorAll<
      HTMLAnchorElement | HTMLLinkElement
    >('a[href], link[href]')) {
      const target = URL.parse(link.href);
      if (!target || target.origin !== origin) continue;
      if (
        ['archives', 'next', 'prev'].some((rel) =>
          link.relList.contains(rel),
        ) ||
        /\/archives?(?:\/|$)/i.test(target.pathname) ||
        calendarPath.test(target.pathname) ||
        /^(?:(?:blog|post|article|full|complete) )?archives?$|(?:^|\s)(?:older|newer|previous|next) (?:posts|entries|articles|page)(?:\s|$)|^(?:all|more) (?:posts|entries|articles|content)$|^content index$/i.test(
          link.textContent.trim(),
        )
      )
        archives.add(webUrl(target.href, url));
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
      if (!archives.has(page)) pages.add(page);
    }
    return { archives, pages };
  } finally {
    dom.window.close();
  }
}
