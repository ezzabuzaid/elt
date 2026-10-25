import { anchorAttributes, anchorLabels, linkSelectors } from 'feedscout/feeds';
import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';
import { JSDOM } from 'jsdom';

import { paginationLinks } from './listing.ts';
import { webUrl } from './web-url.ts';

const calendarPath = new RegExp(
  `/\\d{4}(?:/(?:0?[1-9]|1[0-2]|${Array.from({ length: 12 }, (_, month) => {
    const name = new Date(Date.UTC(2000, month)).toLocaleString('en', {
      month: 'long',
    });
    return `${name}|${name.slice(0, 3)}`;
  }).join('|')}))?/?$`,
  'i',
);

export function readHtml(html: string, url: string, headers: Headers) {
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
    const links = new Set<string>();
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      'a[href]',
    )) {
      const target = URL.parse(link.href);
      if (target && target.origin === origin)
        links.add(webUrl(target.href, url));
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
    return { archives, pages, links };
  } finally {
    dom.window.close();
  }
}

export function readFeedLinks(html: string, url: string, headers: Headers) {
  const feeds: { url: string; kind: 'listing' | 'candidate' }[] = [];
  for (const { kind, selectors } of [
    {
      kind: 'listing',
      selectors: [
        ...linkSelectors.map((selector) =>
          selector.types === undefined
            ? selector
            : {
                ...selector,
                types: selector.types.filter(
                  (type) => type !== 'application/json',
                ),
              },
        ),
        { rel: 'sitemap' },
      ],
    },
    {
      kind: 'candidate',
      selectors: [{ rel: 'alternate', types: ['application/json'] }],
    },
  ] satisfies {
    kind: 'listing' | 'candidate';
    selectors: typeof linkSelectors;
  }[]) {
    for (const uri of [
      ...discoverUrisFromHtml(html, {
        baseUrl: url,
        linkSelectors: selectors,
        anchorUris: [],
        anchorIgnoredUris: [],
        anchorLabels:
          kind === 'candidate'
            ? anchorLabels.map(
                (label) => new RegExp(`\\b${RegExp.escape(label)}\\b`, 'i'),
              )
            : [],
        anchorAttributes: kind === 'candidate' ? anchorAttributes : [],
      }),
      ...discoverUrisFromHeaders(headers, {
        linkSelectors: selectors,
      }),
    ])
      feeds.push({ url: webUrl(uri, url), kind });
  }
  return feeds;
}
