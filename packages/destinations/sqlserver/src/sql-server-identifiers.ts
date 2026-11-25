import { Identifiers } from '@eltjs/elt';

// SQL Server keeps 128 characters of a name, and the default collation of a
// database compares two names without case. The destination's own columns
// are loaded_at, which readers see, and the columns that only its own SQL
// reads: _elt_row, committed_in and _elt_row_hash in each table, replaced_in
// in each history, and _elt_key_hash of a key.
class SqlServerIdentifiers extends Identifiers {
  protected readonly maxBytes = 128;
  protected readonly ownColumns = [
    'loaded_at',
    'committed_in',
    'replaced_in',
    '_elt_row',
    '_elt_row_hash',
    '_elt_key_hash',
  ];

  key(name: string): string {
    return name.toLowerCase();
  }
}

export const identifiers = Object.freeze(new SqlServerIdentifiers());

// The table in _warehouse that keeps the rows of the reader relation name:
// raw_<name>, under the naming rule of every relation.
export const rawTable = (name: string) => identifiers.relation(`raw_${name}`);

export function quote(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`;
}

// A string as a Unicode string literal of T-SQL: in N'', with each ' inside
// doubled.
export function literal(text: string): string {
  return `N'${text.replaceAll("'", "''")}'`;
}
