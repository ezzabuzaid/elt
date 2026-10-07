import { createHash } from 'node:crypto';

function hash(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

// Airbyte's rule: decomposed marks dropped, every run of whitespace and every
// other character outside [A-Za-z0-9_] replaced by `_`, case kept, and a
// leading digit prefixed with `_`. A name starting with `_elt_` drops its
// first `_`, since elt names what it creates for itself that way.
function sanitize(name: string): string {
  const clean = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/gu, '_')
    .replace(/[^A-Za-z0-9_]/gu, '_')
    .replace(/^_(?=elt_)/i, '');
  if (clean === '') return '_';
  return /^[0-9]/.test(clean) ? `_${clean}` : clean;
}

// How a destination names the columns, tables and views it creates from a
// stream, so that no name it cannot hold, or holds for itself, fails a load.
export abstract class Identifiers {
  // The most UTF-8 bytes a name may take.
  protected abstract readonly maxBytes: number;
  // The column names the destination writes itself, which no field may take.
  protected abstract readonly ownColumns: readonly string[];

  // The form two names share when the destination takes them for one.
  abstract key(name: string): string;

  // Each column with its name, in field order: a sanitized name another
  // field already took is tried again with `_1`, `_2` and so on after the
  // field.
  columns<Column extends { readonly field: string }>(
    columns: readonly Column[],
  ): readonly (readonly [Column, string])[] {
    const taken = new Set(this.ownColumns.map((name) => this.key(name)));
    return columns.map((column) => {
      const { field } = column;
      let name = this.#fit(sanitize(field), field);
      for (let suffix = 1; taken.has(this.key(name)); suffix += 1)
        name = this.#fit(sanitize(`${field}_${suffix}`), `${field}_${suffix}`);
      taken.add(this.key(name));
      return [column, name] as const;
    });
  }

  // A table or view sees no other name to collide with, so one that
  // sanitizing changed keeps a hash of what it was asked for.
  relation(name: string): string {
    const clean = sanitize(name);
    return clean === name
      ? this.#fit(name, name)
      : this.#fit(`${clean}_${hash(name)}`, name);
  }

  // A sanitized name is ASCII, so cutting it by bytes keeps whole characters.
  #fit(name: string, original: string): string {
    if (Buffer.byteLength(name) <= this.maxBytes) return name;
    return `${name.slice(0, this.maxBytes - 9)}_${hash(original)}`;
  }
}
