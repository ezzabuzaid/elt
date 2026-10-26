export function webUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`Expected HTTP(S) URL: ${url.href}`);
  url.hash = '';
  return url.href;
}

/** The URL a page links to, or null when it is not an HTTP(S) URL. */
export function httpUrl(value: string, base: string): string | null {
  const url = URL.parse(value, base);
  return url && (url.protocol === 'https:' || url.protocol === 'http:')
    ? webUrl(url.href, base)
    : null;
}
