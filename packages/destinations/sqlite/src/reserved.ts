/**
 * Whether the destination and its sync history own a table, index or view of
 * this name: each one whose name starts with `_elt_`, in any case, as SQLite
 * compares names. No stream, view or computed dataset has such a name, so a
 * reader that follows the data of a file skips these tables.
 */
export function isReserved(name: string): boolean {
  return /^_elt_/i.test(name);
}
