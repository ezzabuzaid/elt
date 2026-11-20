import { Identifiers } from '@eltjs/elt';

// Postgres keeps 63 bytes of a name and silently drops the rest, and refuses
// a column named like one of its system columns however it is quoted. The
// destination's own columns are loaded_at, which readers see, and the
// columns only its own SQL reads: committed_in and _elt_row_hash in each
// table, and replaced_in in each history. The naming rule already turns a
// field _elt_row_hash into elt_row_hash, so the list need not hold it.
class PostgresIdentifiers extends Identifiers {
  protected readonly maxBytes = 63;
  protected readonly ownColumns = [
    'loaded_at',
    'committed_in',
    'replaced_in',
    'tableoid',
    'cmax',
    'xmax',
    'cmin',
    'xmin',
    'ctid',
  ];

  // Quoted identifiers are case-sensitive.
  key(name: string): string {
    return name;
  }
}

export const identifiers = Object.freeze(new PostgresIdentifiers());

// The table in _warehouse that keeps the rows of the reader relation name:
// raw_<name>, under the naming rule of every relation (ADR 0010).
export const rawTable = (name: string) => identifiers.relation(`raw_${name}`);
