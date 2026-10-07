// A schema or published view is named by the caller's own SQL, so a name
// Postgres cannot hold, which it would silently cut to 63 bytes, is refused
// rather than renamed.
export function identifier(name: string, what: string): string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\0') ||
    Buffer.byteLength(name) > 63
  )
    throw new TypeError(`Invalid ${what}: ${JSON.stringify(name)}`);
  return name;
}

export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
