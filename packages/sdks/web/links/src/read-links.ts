import {
  anchorAttributes,
  anchorLabels,
  defaultHeadersOptions,
  defaultHtmlOptions,
  linkSelectors,
} from 'feedscout/feeds';
import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';

import { webUrl } from './web-url.ts';

export function readLinks(html: string, url: string, headers: Headers) {
  const navigation = [
    'archives',
    'next',
    'prev',
    'prev-archive',
    'next-archive',
  ].map((rel) => ({ rel }));
  const origin = new URL(url).origin;
  const pages = new Set<string>();
  for (const uri of [
    ...discoverUrisFromHtml(html, {
      baseUrl: url,
      linkSelectors: navigation,
      anchorUris: [/.*/],
      anchorIgnoredUris: [],
      anchorLabels: [],
    }),
    ...discoverUrisFromHeaders(headers, { linkSelectors: navigation }),
  ]) {
    const target = URL.parse(uri, url);
    if (
      target &&
      target.origin === origin &&
      ['http:', 'https:'].includes(target.protocol)
    )
      pages.add(webUrl(target.href, url));
  }
  const advertised = new Set(
    [
      ...discoverUrisFromHtml(html, {
        ...defaultHtmlOptions,
        baseUrl: url,
        anchorLabels: [],
        anchorAttributes: [],
      }),
      ...discoverUrisFromHeaders(headers, defaultHeadersOptions),
    ].map((uri) => webUrl(uri, url)),
  );
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
      ...discoverUrisFromHeaders(headers, { linkSelectors: selectors }),
    ]) {
      const target = webUrl(uri, url);
      if (
        kind === 'listing' ||
        new URL(target).origin === origin ||
        advertised.has(target)
      )
        feeds.push({ url: target, kind });
    }
  }
  return { pages, feeds };
}
