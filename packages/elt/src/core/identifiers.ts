import { hash } from 'node:crypto';

import { syncHistoryRelations } from '../state/sync-history-relations.ts';
import { readerCatalog } from './reader-relation.ts';

// The relations that a destination publishes for readers under a fixed name:
// the catalog and the views of the sync history. The naming rule already
// renames a name that starts with _elt_.
const published = [readerCatalog, ...Object.values(syncHistoryRelations)];

function shortHash(name: string): string {
  return hash('sha256', name).slice(0, 8);
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
      : this.#fit(`${clean}_${shortHash(name)}`, name);
  }

  // The name of the reader view of a target: name under the naming rule of
  // every relation. A reader view shares the schema of the relations that the
  // destination publishes, so it cannot take one of their names.
  reader(name: string): string {
    if (typeof name !== 'string')
      throw new TypeError('A table is named by a string');
    const view = this.relation(name);
    if (
      published.some((relation) => this.key(relation.name) === this.key(view))
    )
      throw new TypeError(
        `Reader name ${view} is a relation the destination makes`,
      );
    return view;
  }

  // A sanitized name is ASCII, so cutting it by bytes keeps whole characters.
  #fit(name: string, original: string): string {
    if (Buffer.byteLength(name) <= this.maxBytes) return name;
    return `${name.slice(0, this.maxBytes - 9)}_${shortHash(original)}`;
  }
}
