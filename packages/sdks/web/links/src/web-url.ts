export function webUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`Expected HTTP(S) URL: ${url.href}`);
  url.hash = '';
  return url.href;
}
