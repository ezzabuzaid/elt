// Postgres silently truncates identifiers past 63 bytes, so two long names
// could land on one table; reject them instead.
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
