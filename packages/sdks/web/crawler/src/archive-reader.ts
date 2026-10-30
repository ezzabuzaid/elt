import { discoverUrisFromHeaders } from 'feedscout/methods';
import { JSDOM, VirtualConsole } from 'jsdom';
import { z } from 'zod';

import {
  type Finding,
  Reader,
  type Visit,
  isHtml,
  pageText,
} from './reader.ts';
import { webUrl } from './web-url.ts';

const monthNames = Array.from({ length: 12 }, (_, month) => {
  const name = new Date(Date.UTC(2000, month)).toLocaleString('en', {
    month: 'long',
  });
  return `${name}|${name.slice(0, 3)}`;
}).join('|');

// A year archive puts the year first in the path, after at most a language
// code and one blog section, such as /2026/Oct/, /blog/2024/ or /en/2023/05/.
// A year anywhere else, such as /en/cars/motorcycles/2022, is a filter, and
// a number out of the years, such as /products/2048, is an id.
const calendarPath = new RegExp(
  `^(?:/[a-z]{2}(?:-[a-z]{2,4})?)?(?:/(?:blog|posts?|news|articles?|journal|diary|archives?))?/(\\d{4})(?:/(?:0?[1-9]|1[0-2]|${monthNames}))?/?$`,
  'i',
);

function isCalendar(pathname: string) {
  const year = Number(calendarPath.exec(pathname)?.[1]);
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1;
}

/**
 * HTML archives that a page links, guessed from `rel="archives"`, archive and
 * calendar paths, and labels such as "Older posts". Each is a list: a reader
 * of lists, such as PaginationReader, lists its pages.
 */
export class ArchiveReader extends Reader<null, null> {
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
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    return [...readArchives(pageText(response), response.url, headers)].map(
      (url) => ({
        url,
        lastModified: null,
        published: null,
        page: false,
        list: true,
        // An archive that a list links is no hop; one that an ordinary page links is.
        linked: !request.start && !request.list,
        tolerate: [404, 410],
        note: null,
        // Archives are backfill: they share downloads with new pages instead of going first.
        priority: 'backfill' as const,
      }),
    );
  }
}

function readArchives(html: string, url: string, headers: Headers) {
  // jsdom's own console writes its errors, such as a stylesheet it cannot
  // parse, to the host's console.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const origin = new URL(url).origin;
    const archives = new Set(
      discoverUrisFromHeaders(headers, { linkSelectors: [{ rel: 'archives' }] })
        .map((value) => webUrl(value, url))
        .filter((value) => new URL(value).origin === origin),
    );
    for (const link of document.querySelectorAll<
      HTMLAnchorElement | HTMLLinkElement
    >('a[href], link[href]')) {
      const target = URL.parse(link.href);
      if (!target || target.origin !== origin) continue;
      if (
        link.relList.contains('archives') ||
        /\/archives?(?:\/|$)/i.test(target.pathname) ||
        isCalendar(target.pathname) ||
        /^(?:(?:blog|post|article|full|complete) )?archives?$|(?:^|\s)(?:older|newer|previous|next) (?:posts|entries|articles|page)(?:\s|$)|^(?:all|more) (?:posts|entries|articles|content)$|^content index$/i.test(
          link.textContent.trim(),
        )
      )
        archives.add(webUrl(target.href, url));
    }
    return archives;
  } finally {
    dom.window.close();
  }
}
