import { Identifiers } from '@eltjs/elt';

// The columns that only the destination's own SQL reads: the commit that last
// wrote a row and the hash of its values in each table, the commit that
// replaced a row in each history, and _rowid_, the id SQLite gives each row,
// which a difference needs, as long as no column takes the name. No reader
// view, view of a position or SELECT as of a position shows them.
export const internalColumns: readonly string[] = [
  'committed_in',
  '_elt_row_hash',
  'replaced_in',
  '_rowid_',
];

// SQLite holds a name of any length and compares two without ASCII case: it
// folds A-Z only, so `É` and `é` stay two names.
class SQLiteIdentifiers extends Identifiers {
  protected readonly maxBytes = Infinity;
  protected readonly ownColumns = ['loaded_at', ...internalColumns];

  key(name: string): string {
    return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  }
}

export const identifiers = Object.freeze(new SQLiteIdentifiers());

// The table that keeps the rows of the reader relation name, beside it in the
// same file (ADR 0010): raw_<name>, under the naming rule of every relation.
export const rawTable = (name: string) => identifiers.relation(`raw_${name}`);

// SQLite quotes an identifier in double quotes and doubles each one inside it.
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
