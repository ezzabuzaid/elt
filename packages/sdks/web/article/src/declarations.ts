import LinkHeader from 'http-link-header';

import type { ArticlePage, LocalizedVersion } from './extraction.ts';

/** A URL that a page declares: resolved against the page, HTTP(S) only, without its fragment; null for any other. */
export function declaredUrl(href: string, base: string): string | null {
  const url = URL.parse(href, base);
  if (url === null || !['http:', 'https:'].includes(url.protocol)) return null;
  url.hash = '';
  return url.href;
}

/** A page's language copies, each language and URL once, in the order first declared. */
export function uniqueVersions(
  versions: readonly LocalizedVersion[],
): readonly LocalizedVersion[] {
  const seen = new Set<string>();
  return versions.filter(({ language, url }) => {
    const key = `${language} ${url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What a page declares about itself in its Link header (RFC 8288): its canonical URL and its language copies. */
export function linkDeclarations(page: ArticlePage): {
  readonly canonicalUrl: string | null;
  readonly localizedVersions: readonly LocalizedVersion[];
} {
  if (page.link === undefined)
    return { canonicalUrl: null, localizedVersions: [] };
  const links = LinkHeader.parse(page.link);
  const canonical = links
    .rel('canonical')
    .map(({ uri }) => declaredUrl(uri, page.url))
    .find((url) => url !== null);
  return {
    canonicalUrl: canonical ?? null,
    localizedVersions: links.rel('alternate').flatMap(({ uri, hreflang }) => {
      const url = declaredUrl(uri, page.url);
      return url === null || typeof hreflang !== 'string'
        ? []
        : [{ language: hreflang.toLowerCase(), url }];
    }),
  };
}
