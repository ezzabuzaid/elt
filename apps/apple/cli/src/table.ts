const bytes = (value: Uint8Array) => `<${value.byteLength} bytes>`;

// Values as one line each: bytes are summarized, text stays within 60 columns.
function cell(value: unknown): string {
  if (value === null) return '';
  if (value instanceof Uint8Array) return bytes(value);
  const text = String(value).replaceAll(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export function table(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const cells = rows.map((row) => row.map(cell));
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

// JSON for scripts: 64-bit integers keep their digits as strings.
export function json(value: unknown, space: number): string {
  return JSON.stringify(
    value,
    (_, item) =>
      typeof item === 'bigint'
        ? item.toString()
        : item instanceof Uint8Array
          ? bytes(item)
          : item,
    space,
  );
}
