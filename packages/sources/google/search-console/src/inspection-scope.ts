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

const PACIFIC = 'America/Los_Angeles';

// Per-day Google Cloud quotas reset at midnight Pacific Time, which moves
// between UTC-8 and UTC-7 with daylight saving.
export function nextPacificMidnight(now: Date): Date {
  const { year, month, day } = pacificDate(now);
  const wall = Date.UTC(year, month - 1, day + 1);
  const guess = wall - pacificOffsetMinutes(new Date(wall)) * 60_000;
  return new Date(wall - pacificOffsetMinutes(new Date(guess)) * 60_000);
}

function pacificDate(at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

function pacificOffsetMinutes(at: Date): number {
  const name =
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC,
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (match === null)
    throw new TypeError(`Unexpected Pacific time zone offset ${name}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}
