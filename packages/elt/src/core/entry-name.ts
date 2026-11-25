// A space or a key of a checkpoint's entries: a well-formed string with no
// U+0000, which a store's text column refuses (ADR 0035). what names it in
// the error, such as "A space".
export function entryName(value: unknown, what: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${what} of checkpoint entries must be a string`);
  if (!value.isWellFormed())
    throw new TypeError(`${what} of checkpoint entries has a lone surrogate`);
  if (value.includes('\0'))
    throw new TypeError(`${what} of checkpoint entries has U+0000`);
  return value;
}

export function plainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
