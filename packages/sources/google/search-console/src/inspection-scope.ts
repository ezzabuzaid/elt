import { PACIFIC, today } from './search-analytics-query.ts';

// Google Search indexes documents, not fragments, so every #anchor of a page
// is the same inspection. Returns undefined for anything that is not an
// absolute http(s) URL.
export function pageUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = '';
  return url.href;
}

// URL inspection only accepts URLs under the property: a domain property
// (sc-domain:example.com) covers the host, its subdomains and both schemes;
// a URL-prefix property covers everything that starts with it.
export function underProperty(siteUrl: string, url: string): boolean {
  if (!siteUrl.startsWith('sc-domain:')) return url.startsWith(siteUrl);
  const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
  const { hostname } = new URL(url);
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// Per-day Google Cloud quotas reset at midnight Pacific Time, which moves
// between UTC-8 and UTC-7 with daylight saving.
export function nextPacificMidnight(now: Date): Date {
  const midnight = Temporal.PlainDate.from(today(now))
    .add({ days: 1 })
    .toZonedDateTime(PACIFIC);
  return new Date(midnight.epochMilliseconds);
}
