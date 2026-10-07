// What discovery and version queries return, checked before use.
export function cellText(value: unknown, what: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`SQL Server returned no text for ${what}`);
  return value;
}

export function cellNullableText(value: unknown, what: string): string | null {
  return value === null ? null : cellText(value, what);
}

export function cellNumber(value: unknown, what: string): number {
  if (typeof value !== 'number')
    throw new TypeError(`SQL Server returned no number for ${what}`);
  return value;
}

export function cellBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean')
    throw new TypeError(`SQL Server returned no bit for ${what}`);
  return value;
}
